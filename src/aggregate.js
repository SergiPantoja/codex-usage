import { basename } from 'node:path';
import { readRecords, scanCounts } from './scan.js';

const LONG_CONTEXT_THRESHOLD = 272_000;
const UNKNOWN_MODEL = '<unknown>';

const USAGE_FIELDS = {
  inputTokens: 'input_tokens',
  cachedInputTokens: 'cached_input_tokens',
  cacheWriteTokens: 'cache_write_input_tokens',
  outputTokens: 'output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
  totalTokens: 'total_tokens',
};

// Reconciliation cannot see a field renamed in usage and thread_token_usage alike, because
// both sides then read 0. Counting the usage records that lack a field the cost depends on
// makes such a rename visible. Only an absent field counts, not a 0, so
// cache_write_input_tokens, which has been 0 in every record observed so far, stays silent on
// current logs and speaks up only on older logs or after a format change.
const COST_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];

export async function aggregate(files, options = {}) {
  const {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    now = new Date(),
    days = 7,
    counts = scanCounts(),
  } = options;
  const dayOf = dayFormatter(timeZone);
  const today = dayOf(now.toISOString());
  const windowDays = lastDays(today, days);

  const periods = {
    rolling: {
      startDay: windowDays[0], endDay: today, models: new Map(), compaction: new Map(),
      days: new Map(windowDays.map((day) => [day, new Map()])),
    },
    mtd: { startDay: `${today.slice(0, 7)}-01`, endDay: today, models: new Map(), compaction: new Map() },
    allTime: { startDay: null, endDay: null, models: new Map(), compaction: new Map() },
  };
  const meta = {
    timeZone, today, generatedAt: now.toISOString(), filesInspected: files.length,
    usageRecordsRead: 0, recordsCounted: 0, duplicatesSkipped: 0,
    unattributedRecords: 0, undatedRecords: 0, cacheWriteRecords: 0,
    missingUsageFields: Object.fromEntries(COST_FIELDS.map((field) => [field, 0])),
    reconciliation: [], rateLimits: new Map(), recordTypes: new Map(),
  };
  const found = {
    models: new Set(), efforts: new Set(), serviceTiers: new Set(),
    cliVersions: new Set(), originators: new Set(), sources: new Set(),
  };
  // Resumed and forked sessions replay records into a new file, so this spans all files.
  const responseIds = new Set();

  for (const file of files) {
    const thread = await readThread(file, counts, meta, found);
    if (thread.entries.length) meta.reconciliation.push(reconcile(file, thread.entries));

    for (const entry of thread.entries) {
      meta.usageRecordsRead++;
      if (entry.responseId != null && responseIds.has(entry.responseId)) {
        meta.duplicatesSkipped++;
        continue;
      }
      responseIds.add(entry.responseId);

      const compaction = thread.compactionIds.has(entry.responseId);
      const model = modelFor(entry, thread, compaction);
      const bucket = entry.usage.inputTokens > LONG_CONTEXT_THRESHOLD ? 'long' : 'short';
      const day = dayOf(entry.timestamp);

      meta.recordsCounted++;
      for (const field of entry.missingFields) meta.missingUsageFields[field]++;
      found.models.add(model);
      if (model === UNKNOWN_MODEL) meta.unattributedRecords++;
      if (entry.usage.cacheWriteTokens > 0) meta.cacheWriteRecords++;
      if (!day) meta.undatedRecords++;

      const tally = { model, bucket, day, compaction, usage: entry.usage };
      addToPeriod(periods.allTime, tally);
      if (day) {
        const { allTime } = periods;
        if (!allTime.startDay || day < allTime.startDay) allTime.startDay = day;
        if (!allTime.endDay || day > allTime.endDay) allTime.endDay = day;
        for (const period of [periods.rolling, periods.mtd]) {
          if (day >= period.startDay && day <= period.endDay) addToPeriod(period, tally);
        }
      }
    }
  }

  const sorted = (set) => [...set].filter((value) => value != null).sort();
  Object.assign(meta, counts, {
    models: sorted(found.models), efforts: sorted(found.efforts),
    serviceTiers: sorted(found.serviceTiers), cliVersions: sorted(found.cliVersions),
    originators: sorted(found.originators), sources: sorted(found.sources),
  });
  return { periods, meta };
}

async function readThread(file, counts, meta, found) {
  const thread = { entries: [], turnModels: new Map(), firstModel: undefined, compactionIds: new Set() };
  let latestModel;

  for await (const record of readRecords(file, counts)) {
    const payload = record.payload ?? {};
    meta.recordTypes.set(record.type, (meta.recordTypes.get(record.type) ?? 0) + 1);

    if (record.type === 'token_usage_record') {
      // Only payload.usage is per request. turn_token_usage and thread_token_usage are running
      // totals, so adding them up inflates the result. thread_token_usage is kept only to
      // reconcile the file.
      thread.entries.push({
        responseId: payload.response_id,
        turnId: payload.turn_id,
        rootTurnId: payload.root_turn_id,
        timestamp: record.timestamp,
        usage: readUsage(payload.usage),
        missingFields: COST_FIELDS.filter((field) => !Number.isFinite(payload.usage?.[field])),
        threadUsage: readUsage(payload.thread_token_usage),
        latestModel,
      });
    } else if (record.type === 'turn_context') {
      thread.turnModels.set(payload.turn_id, payload.model);
      thread.firstModel ??= payload.model;
      latestModel = payload.model;
      found.efforts.add(payload.effort);
    } else if (record.type === 'compacted') {
      thread.compactionIds.add(payload.compaction_response_id);
    } else if (record.type === 'session_meta') {
      found.cliVersions.add(payload.cli_version);
      found.originators.add(payload.originator);
      found.sources.add(sourceShape(payload.source));
    } else if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      found.serviceTiers.add(payload.thread_settings?.service_tier);
    } else if (record.type === 'event_msg' && payload.type === 'token_count' && payload.rate_limits) {
      keepLatestRateLimits(meta.rateLimits, payload.rate_limits, record.timestamp);
    }
  }
  return thread;
}

// A compaction request runs outside any user turn, so it has no turn_context. It goes to the
// model of the most recent turn_context before it, or the file's first one if none precedes it.
function modelFor(entry, thread, compaction) {
  const model = thread.turnModels.get(entry.turnId) ?? thread.turnModels.get(entry.rootTurnId);
  if (model) return model;
  if (compaction) return entry.latestModel ?? thread.firstModel ?? UNKNOWN_MODEL;
  return UNKNOWN_MODEL;
}

function addToPeriod(period, { model, bucket, day, compaction, usage }) {
  addToTable(period.models, model, bucket, usage);
  if (compaction) addToTable(period.compaction, model, bucket, usage);
  const dayTable = period.days?.get(day);
  if (dayTable) addToTable(dayTable, model, bucket, usage);
}

function addToTable(table, model, bucket, usage) {
  if (!table.has(model)) table.set(model, new Map());
  const buckets = table.get(model);
  if (!buckets.has(bucket)) buckets.set(bucket, { requests: 0, ...readUsage({}) });
  const totals = buckets.get(bucket);
  totals.requests++;
  for (const key of Object.keys(USAGE_FIELDS)) totals[key] += usage[key];
}

function readUsage(usage) {
  const totals = {};
  for (const [key, field] of Object.entries(USAGE_FIELDS)) {
    totals[key] = Number.isFinite(usage?.[field]) ? usage[field] : 0;
  }
  return totals;
}

function reconcile(file, entries) {
  const actual = readUsage({});
  for (const entry of entries) {
    for (const key of Object.keys(USAGE_FIELDS)) actual[key] += entry.usage[key];
  }
  const expected = entries.at(-1).threadUsage;
  const ok = Object.keys(USAGE_FIELDS).every((key) => expected[key] === actual[key]);
  return { file: basename(file), ok, expected, actual };
}

// A dated snapshot always beats an undated one. When time cannot order two, the one read later
// wins, since each file holds its snapshots in time order.
function keepLatestRateLimits(snapshots, limits, timestamp) {
  const previous = snapshots.get(limits.limit_id);
  const time = Date.parse(timestamp);
  const previousTime = Date.parse(previous?.observedAt);
  if (previous && (Number.isNaN(time) ? !Number.isNaN(previousTime) : time < previousTime)) return;
  snapshots.set(limits.limit_id, {
    planType: limits.plan_type ?? null,
    primary: limits.primary ?? null,
    secondary: limits.secondary ?? null,
    credits: limits.credits ?? null,
    observedAt: timestamp,
  });
}

// For subagent threads, source is an object holding agent_path and agent_nickname, which the
// user chose. Only its shape is recorded.
function sourceShape(source) {
  if (source === undefined) return undefined;
  if (typeof source === 'string') return source;
  return `<object:${Object.keys(source ?? {}).sort().join('|')}>`;
}

// Built from parts so the key is YYYY-MM-DD whatever a locale's date pattern is.
function dayFormatter(timeZone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return (timestamp) => {
    const time = Date.parse(timestamp);
    if (Number.isNaN(time)) return undefined;
    const parts = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

function lastDays(today, count) {
  const [year, month, day] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(year, month - 1, day - count + 1 + i)).toISOString().slice(0, 10));
}
