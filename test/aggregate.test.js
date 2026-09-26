import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../src/aggregate.js';

// Thread A spans three local days, has a malformed line mid-file and at the end, a usage
// record whose turn_context comes after it, an orphan, a compaction, and both sides of the
// long-context threshold. Thread B replays r1 from thread A, has a final thread_token_usage
// that is wrong on purpose, and holds records from before the rolling window and the month.
// Input token counts are powers of two, so every subset of records sums to a distinct total.
const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url));
const THREAD_A = `${fixtures}rollout-2026-09-16T10-00-00-thread-a.jsonl`;
const THREAD_B = `${fixtures}rollout-2026-08-31T19-00-00-thread-b.jsonl`;
// cached_input_tokens is renamed in usage, turn_token_usage and thread_token_usage alike, so
// the file still reconciles and only the missing-field count can show the rename. x2 also
// lacks cache_write_input_tokens everywhere, as logs from a Codex that never wrote it would.
const RENAMED_FIELD = `${fixtures}rollout-2026-09-20T07-59-00-renamed-field.jsonl`;
// c1 is a compaction before any turn_context, d1 has a turn_id and a root_turn_id naming
// different models, d2 has only its root_turn_id resolvable, and d3 has its turn_context after
// it and a root_turn_id that resolves nowhere. Input doubles each time.
const ATTRIBUTION = `${fixtures}rollout-2026-09-20T09-00-00-attribution.jsonl`;
// Fields missing from otherwise ordinary records: u1 has no timestamp, u2 an unreadable one, the
// next two no response_id, u5 no usage object, u6 a string for input_tokens, one event_msg no
// payload, one token_count no rate_limits and one whose rate_limits is null, a token_count
// before the first record whose info has no last_token_usage, a session_meta whose source is
// null and a thread_settings_applied with no thread_settings. u1 to u4 carry 1,000, 2,000,
// 4,000 and 8,000 input. Read per test, so that a record that throws fails the tests that read
// it rather than the whole file.
const SPARSE = `${fixtures}rollout-2026-09-20T10-00-00-sparse.jsonl`;
// One usage record, whose thread_token_usage disagrees with it on cached input only.
const SINGLE = `${fixtures}rollout-2026-09-20T11-00-00-single.jsonl`;
// The first four limit_ids have two rate-limit snapshots each, named after how their timestamps
// compare. One with no timestamp or "not-a-date" is undated. The first read reports 10% used,
// the second 20%. The newer window-dropped snapshot has another plan and leaves out the primary
// window the older one has, the newer secondary-dropped one leaves out its weekly window, and
// the newer windows-emptied one has both windows null. The newer older-plan-read-later snapshot
// comes first and has another plan. The last two have no limit_id, come after a codex one, and
// are read newest first.
const RATE_LIMITS = `${fixtures}rollout-2026-09-20T12-00-00-rate-limits.jsonl`;
// One snapshot each, with limit_id null or "" and 70% used, newer than every snapshot in
// RATE_LIMITS.
const NULL_LIMIT_ID = `${fixtures}rollout-2026-09-20T13-00-00-null-limit-id.jsonl`;
const EMPTY_LIMIT_ID = `${fixtures}rollout-2026-09-20T13-30-00-empty-limit-id.jsonl`;
// Codex 0.147.0 writes no token_usage_record, only token_count running totals. The first
// token_count carries rate limits and no usage, the next two 100,000 and then 300,000 input.
const OLDER = `${fixtures}rollout-2026-07-01T10-00-00-older.jsonl`;
// Started on Codex 0.152.0 with a first request of 100,000 input, none of it cached, and a
// compacted record with no id, then resumed on 0.155, which adds two usage records of 1,000 and
// 2,000 input. Their thread_token_usage starts from 0, so the file reconciles without the
// earlier usage. The first token_count with usage carries a premium rate-limit snapshot at 7%,
// the last one a codex snapshot at 12%.
const RESUMED = `${fixtures}rollout-2026-07-02T10-00-00-resumed.jsonl`;
// Current format, with two token_count snapshots that add no request before the first usage
// record. The first carries 50,000 input of totals from a parent thread. The second follows a
// first request that overflowed the context window, and sets only total_tokens.
const SNAPSHOTS_FIRST = `${fixtures}rollout-2026-09-20T14-00-00-snapshots-first.jsonl`;

// Noon on 2026-09-20 in New York, which is UTC-4 in September.
const OPTIONS = { timeZone: 'America/New_York', now: new Date('2026-09-20T16:00:00Z'), days: 7 };
const report = await aggregate([THREAD_A, THREAD_B], OPTIONS);
const { rolling, mtd, allTime } = report.periods;
const UTC_OPTIONS = { timeZone: 'UTC', now: new Date('2026-09-20T18:00:00Z') };
const readSparse = () => aggregate([SPARSE], UTC_OPTIONS);

const cell = (table, model, bucket = 'short') => table.get(model)?.get(bucket);

const R1 = { requests: 1, inputTokens: 1000, cachedInputTokens: 800, cacheWriteTokens: 0, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 1010 };
const R3 = { requests: 1, inputTokens: 4000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 40, reasoningOutputTokens: 0, totalTokens: 4040 };
const R4 = { requests: 1, inputTokens: 8000, cachedInputTokens: 7000, cacheWriteTokens: 0, outputTokens: 80, reasoningOutputTokens: 40, totalTokens: 8080 };
const R5 = { requests: 1, inputTokens: 272000, cachedInputTokens: 270000, cacheWriteTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 272100 };
const R6 = { requests: 1, inputTokens: 272001, cachedInputTokens: 270000, cacheWriteTokens: 1000, outputTokens: 200, reasoningOutputTokens: 100, totalTokens: 272201 };
const R2_AND_R4 = { requests: 2, inputTokens: 10000, cachedInputTokens: 8600, cacheWriteTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 10100 };

function sumTable(table, into = {}) {
  for (const buckets of table.values()) {
    for (const totals of buckets.values()) {
      for (const [key, value] of Object.entries(totals)) into[key] = (into[key] ?? 0) + value;
    }
  }
  return into;
}

test('sums each request once, never the running totals or their mirrors', () => {
  // Summing thread_token_usage would give 872,001 input for thread A alone, turn_token_usage
  // 831,001. The token_count mirror of r1 and the usage copy inside `compacted` add nothing.
  assert.equal(sumTable(allTime.models).inputTokens, 607001);
  assert.deepEqual(cell(allTime.models, 'gpt-5.6-sol'), {
    requests: 3, inputTokens: 49000, cachedInputTokens: 30800, cacheWriteTokens: 0,
    outputTokens: 490, reasoningOutputTokens: 105, totalTokens: 49490,
  });
});

test('skips a response_id already counted from an earlier file', () => {
  assert.equal(report.meta.usageRecordsRead, 9);
  assert.equal(report.meta.recordsCounted, 8);
  assert.equal(report.meta.duplicatesSkipped, 1);
});

test('skips malformed lines and counts them by position', () => {
  assert.equal(report.meta.malformedMidFile, 1);
  assert.equal(report.meta.malformedTrailing, 1);
});

test('attributes a usage record whose turn_context appears after it', () => {
  assert.deepEqual(cell(allTime.models, 'gpt-6-astra'), R2_AND_R4);
});

test('keeps a record with no resolvable model under <unknown>', () => {
  assert.deepEqual(cell(allTime.models, '<unknown>'), R3);
  assert.equal(report.meta.unattributedRecords, 1);
});

test('counts a compaction into the active model and tallies it separately', () => {
  // r4 has no turn_context. The last one before it in the file names gpt-6-astra, not the
  // file's first model, gpt-5.6-sol.
  assert.deepEqual([...allTime.compaction.keys()], ['gpt-6-astra']);
  assert.deepEqual(cell(allTime.compaction, 'gpt-6-astra'), R4);
  assert.deepEqual(cell(allTime.models, 'gpt-6-astra'), R2_AND_R4);
});

test('counts a compaction replayed in another file once', async () => {
  const replayed = await aggregate([ATTRIBUTION, ATTRIBUTION], UTC_OPTIONS);
  assert.equal(replayed.meta.duplicatesSkipped, 4);
  assert.equal(cell(replayed.periods.allTime.compaction, 'model-first').requests, 1);
  assert.equal(cell(replayed.periods.allTime.models, 'model-first').requests, 2);
});

test('resolves a model by turn_id, then root_turn_id, and a compaction with neither by the file first model', async () => {
  const { periods } = await aggregate([ATTRIBUTION], UTC_OPTIONS);
  assert.deepEqual([...periods.allTime.models.keys()].sort(), ['model-first', 'model-second', 'model-third']);
  // d1 by its turn_id over its root_turn_id, d3 by a turn_context that comes after it.
  assert.equal(cell(periods.allTime.models, 'model-second').inputTokens, 2000);
  assert.equal(cell(periods.allTime.models, 'model-third').inputTokens, 8000);
  // d2 by its root_turn_id, and c1, which comes before any turn_context.
  assert.equal(cell(periods.allTime.models, 'model-first').inputTokens, 1000 + 4000);
  assert.deepEqual([...periods.allTime.compaction.keys()], ['model-first']);
  assert.equal(cell(periods.allTime.compaction, 'model-first').inputTokens, 1000);
});

test('keeps a record with a missing or unreadable timestamp in all time only, and counts it', async () => {
  const { periods, meta } = await readSparse();
  assert.equal(meta.undatedRecords, 2);
  assert.equal(sumTable(periods.allTime.models).inputTokens, 15000);
  assert.equal(sumTable(periods.mtd.models).inputTokens, 12000);
  assert.equal(sumTable(periods.rolling.models).inputTokens, 12000);
});

test('counts every record that has no response_id, none of them as a duplicate', async () => {
  const { meta } = await readSparse();
  assert.deepEqual([meta.usageRecordsRead, meta.recordsCounted, meta.duplicatesSkipped], [6, 6, 0]);
});

test('reads a missing usage object or a count that is not a number as 0, and counts it as missing', async () => {
  const { periods, meta } = await readSparse();
  // u6 carries input_tokens as the string '64000'.
  assert.equal(cell(periods.allTime.models, 'gpt-5.6-sol').inputTokens, 15000);
  assert.deepEqual(meta.missingUsageFields, {
    input_tokens: 2, cached_input_tokens: 1, cache_write_input_tokens: 1, output_tokens: 1,
  });
});

test('splits long context per request, strictly above 272,000 input tokens', () => {
  assert.deepEqual(cell(allTime.models, 'gpt-9-imaginary', 'short'), R5);
  assert.deepEqual(cell(allTime.models, 'gpt-9-imaginary', 'long'), R6);
});

test('buckets by each record local day, not the UTC day or the file name', () => {
  assert.deepEqual([...rolling.days.keys()], [
    '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20',
  ]);
  // r1 is 03:30 UTC on the 18th, which is 23:30 on the 17th in New York.
  assert.deepEqual(cell(rolling.days.get('2026-09-17'), 'gpt-5.6-sol'), R1);
  assert.deepEqual([...rolling.days.get('2026-09-18').keys()].sort(), ['<unknown>', 'gpt-6-astra']);
  assert.deepEqual([...rolling.days.get('2026-09-19').keys()], ['gpt-9-imaginary']);
  assert.deepEqual(cell(rolling.days.get('2026-09-19'), 'gpt-9-imaginary', 'long'), R6);
  for (const day of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-20']) {
    assert.equal(rolling.days.get(day).size, 0, day);
  }
});

test('daily buckets add up to the rolling window totals', () => {
  const fromDays = {};
  for (const table of rolling.days.values()) sumTable(table, fromDays);
  assert.deepEqual(fromDays, sumTable(rolling.models));
});

test('rolling, month to date and all time each include only their own days', () => {
  assert.deepEqual([rolling.startDay, rolling.endDay], ['2026-09-14', '2026-09-20']);
  assert.deepEqual([mtd.startDay, mtd.endDay], ['2026-09-01', '2026-09-20']);
  assert.deepEqual([allTime.startDay, allTime.endDay], ['2026-08-31', '2026-09-19']);
  // gpt-5.6-sol has r1 on the 17th, q2 on the 13th and q1 on 31 August.
  assert.equal(cell(rolling.models, 'gpt-5.6-sol').requests, 1);
  assert.equal(cell(mtd.models, 'gpt-5.6-sol').requests, 2);
  assert.equal(cell(allTime.models, 'gpt-5.6-sol').requests, 3);
});

test('takes today from the time zone, not from the UTC date', async () => {
  // 02:00 UTC on the 20th is 22:00 on the 19th in New York.
  const late = await aggregate([THREAD_A, THREAD_B], { ...OPTIONS, now: new Date('2026-09-20T02:00:00Z') });
  assert.equal(late.meta.today, '2026-09-19');
  assert.deepEqual([late.periods.rolling.startDay, late.periods.rolling.endDay], ['2026-09-13', '2026-09-19']);
  assert.equal(late.periods.mtd.endDay, '2026-09-19');
});

test('counts a record on the first and on the last day of the window, and none after today', async () => {
  // A two-day window of the 17th and 18th: r1 is on the 17th, r2 to r4 on the 18th, and r5 and
  // r6 on the 19th, which is after today.
  const short = await aggregate([THREAD_A, THREAD_B], { ...OPTIONS, now: new Date('2026-09-18T16:00:00Z'), days: 2 });
  const { rolling: window, mtd: month } = short.periods;
  assert.deepEqual([window.startDay, window.endDay], ['2026-09-17', '2026-09-18']);
  assert.deepEqual([...window.models.keys()].sort(), ['<unknown>', 'gpt-5.6-sol', 'gpt-6-astra']);
  assert.deepEqual(cell(window.models, 'gpt-5.6-sol'), R1);
  assert.deepEqual(cell(window.models, 'gpt-6-astra'), R2_AND_R4);
  assert.ok(!month.models.has('gpt-9-imaginary'));
});

test('reconciles each file before deduplication and flags a mismatch', () => {
  const [a, b] = report.meta.reconciliation;
  assert.equal(a.file, 'rollout-2026-09-16T10-00-00-thread-a.jsonl');
  assert.equal(a.ok, true);
  assert.deepEqual(a.expected, a.actual);
  assert.equal(b.file, 'rollout-2026-08-31T19-00-00-thread-b.jsonl');
  assert.equal(b.ok, false);
  assert.equal(b.expected.inputTokens, 50000);
  assert.equal(b.actual.inputTokens, 49000);
});

test('reconciles a file with a single usage record, on every field', async () => {
  const { meta } = await aggregate([SINGLE], UTC_OPTIONS);
  assert.equal(meta.reconciliation.length, 1);
  const [single] = meta.reconciliation;
  assert.equal(single.ok, false);
  assert.equal(single.expected.inputTokens, single.actual.inputTokens);
  assert.deepEqual([single.expected.cachedInputTokens, single.actual.cachedInputTokens], [600, 500]);
});

test('counts usage records that lack a field the cost depends on', async () => {
  const renamed = await aggregate([RENAMED_FIELD], { timeZone: 'UTC', now: new Date('2026-09-20T18:00:00Z') });
  assert.deepEqual(renamed.meta.missingUsageFields, {
    input_tokens: 0, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 0,
  });
});

test('does not count a field that is present with the value 0', () => {
  // r3 and q1 carry cached_input_tokens: 0, and every record but r6 has cache_write_input_tokens: 0.
  assert.deepEqual(report.meta.missingUsageFields, {
    input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0,
  });
});

test('flags each file with usage only in token_count once, and adds none of that usage', async () => {
  // OLDER has two token_count events with usage and RESUMED one. Only the usage records of
  // RESUMED and SNAPSHOTS_FIRST count, 3,000 and 4,000 input.
  const { periods, meta } = await aggregate([OLDER, RESUMED, SNAPSHOTS_FIRST], UTC_OPTIONS);
  assert.equal(meta.filesWithUncountedUsage, 2);
  assert.equal(sumTable(periods.allTime.models).inputTokens, 7000);
});

test('flags a thread resumed after upgrading Codex, and still counts and reconciles its usage records', async () => {
  const { periods, meta } = await aggregate([RESUMED], UTC_OPTIONS);
  assert.equal(meta.filesWithUncountedUsage, 1);
  assert.equal(sumTable(periods.allTime.models).inputTokens, 3000);
  assert.deepEqual(meta.reconciliation.map(({ file, ok }) => [file, ok]), [['rollout-2026-07-02T10-00-00-resumed.jsonl', true]]);
});

test('reads rate limits from a flagged file, from before and after the upgrade', async () => {
  const { meta } = await aggregate([RESUMED], UTC_OPTIONS);
  assert.equal(meta.rateLimits.get('premium').primary.used_percent, 7);
  assert.equal(meta.rateLimits.get('codex').primary.used_percent, 12);
});

test('does not flag a token_count after a usage record, with no usage, or that adds no request', async () => {
  const { meta } = await aggregate([SNAPSHOTS_FIRST, THREAD_A, THREAD_B, RATE_LIMITS], UTC_OPTIONS);
  assert.equal(meta.filesWithUncountedUsage, 0);
});

test('records the latest rate-limit snapshot per limit_id by timestamp', async () => {
  // Thread B is read last but its codex snapshot is older than thread A's.
  assert.deepEqual([...report.meta.rateLimits.keys()].sort(), ['codex', 'premium']);
  const codex = report.meta.rateLimits.get('codex');
  assert.equal(codex.observedAt, '2026-09-18T03:30:01.000Z');
  assert.equal(codex.primary.used_percent, 1);
  assert.equal(codex.planType, 'plus');
  const premium = report.meta.rateLimits.get('premium');
  assert.equal(premium.primary, null);
  assert.equal(premium.secondary, null);
  const { meta } = await aggregate([RATE_LIMITS], UTC_OPTIONS);
  const replanned = meta.rateLimits.get('older-plan-read-later');
  assert.equal(replanned.planType, 'pro');
  assert.equal(replanned.primary.used_percent, 20);
});

test('prefers a dated rate-limit snapshot to an undated one, whichever is read first', async () => {
  const { meta } = await aggregate([RATE_LIMITS], UTC_OPTIONS);
  const kept = meta.rateLimits.get('undated-then-dated');
  assert.equal(kept.primary.used_percent, 20);
  assert.equal(kept.observedAt, '2026-09-20T12:01:00.000Z');
  const held = meta.rateLimits.get('dated-then-undated');
  assert.equal(held.primary.used_percent, 10);
  assert.equal(held.observedAt, '2026-09-20T12:02:00.000Z');
});

test('keeps the later-read rate-limit snapshot when timestamps cannot order two', async () => {
  const { meta } = await aggregate([RATE_LIMITS], UTC_OPTIONS);
  assert.equal(meta.rateLimits.get('both-undated').primary.used_percent, 20);
  assert.equal(meta.rateLimits.get('same-time').primary.used_percent, 20);
});

test('stores the latest rate-limit snapshot whole, and a window it leaves out as null', async () => {
  const { meta } = await aggregate([RATE_LIMITS], UTC_OPTIONS);
  const latest = meta.rateLimits.get('window-dropped');
  assert.equal(latest.planType, 'pro');
  assert.equal(latest.primary, null);
  assert.equal(latest.secondary.used_percent, 30);
  const weeklyDropped = meta.rateLimits.get('secondary-dropped');
  assert.equal(weeklyDropped.primary.used_percent, 20);
  assert.equal(weeklyDropped.secondary, null);
  const emptied = meta.rateLimits.get('windows-emptied');
  assert.deepEqual([emptied.primary, emptied.secondary], [null, null]);
});

test('keeps rate-limit snapshots with no limit_id in one slot keyed null, latest first', async () => {
  const { meta } = await aggregate([RATE_LIMITS], UTC_OPTIONS);
  const used = [...meta.rateLimits.values()].map((snapshot) => snapshot.primary?.used_percent);
  assert.equal(meta.rateLimits.get(null).primary.used_percent, 40);
  assert.ok(!used.includes(50));
  assert.equal(meta.rateLimits.get('codex').primary.used_percent, 60);
});

test('puts a rate-limit snapshot whose limit_id is null or empty in the slot of those with none', async () => {
  for (const file of [NULL_LIMIT_ID, EMPTY_LIMIT_ID]) {
    const { meta } = await aggregate([RATE_LIMITS, file], UTC_OPTIONS);
    const used = [...meta.rateLimits.values()].map((snapshot) => snapshot.primary?.used_percent);
    assert.equal(meta.rateLimits.get(null).primary.used_percent, 70, file);
    assert.ok(!used.includes(40), file);
  }
});

test('collects models, efforts, service tiers, versions and source shapes', () => {
  const { meta } = report;
  assert.deepEqual(meta.models, ['<unknown>', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-9-imaginary']);
  assert.deepEqual(meta.efforts, ['high', 'low', 'medium', 'xhigh']);
  assert.deepEqual(meta.serviceTiers, ['default', 'priority']);
  assert.deepEqual(meta.cliVersions, ['0.154.0-alpha.6.2', '0.155.0-alpha.2.6']);
  assert.deepEqual(meta.sources, ['<object:subagent>', 'cli']);
  assert.equal(meta.cacheWriteRecords, 1);
});

test('puts no path, nickname, cwd or conversation text in the report', () => {
  const json = JSON.stringify(report, (key, value) =>
    value instanceof Map ? Object.fromEntries(value) : value);
  for (const secret of ['Nickname-Sagan', 'secret_agent_path', '/root/', '/Users/someone', 'SECRET', fixtures]) {
    assert.ok(!json.includes(secret), `report contains ${secret}`);
  }
});

test('an empty list of files gives empty periods, not an error', async () => {
  const empty = await aggregate([], { timeZone: 'UTC', now: new Date('2026-09-20T12:00:00Z'), days: 3 });
  assert.equal(empty.periods.allTime.models.size, 0);
  assert.deepEqual([empty.periods.allTime.startDay, empty.periods.allTime.endDay], [null, null]);
  assert.equal(empty.periods.rolling.days.size, 3);
  assert.equal(empty.meta.recordsCounted, 0);
});
