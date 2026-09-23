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

// Noon on 2026-09-20 in New York, which is UTC-4 in September.
const report = await aggregate([THREAD_A, THREAD_B], {
  timeZone: 'America/New_York',
  now: new Date('2026-09-20T16:00:00Z'),
  days: 7,
});
const { rolling, mtd, allTime } = report.periods;

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

test('records the latest rate-limit snapshot per limit_id by timestamp', () => {
  // Thread B is read last but its codex snapshot is older than thread A's.
  const codex = report.meta.rateLimits.get('codex');
  assert.equal(codex.observedAt, '2026-09-18T03:30:01.000Z');
  assert.equal(codex.primary.used_percent, 1);
  assert.equal(codex.planType, 'plus');
  const premium = report.meta.rateLimits.get('premium');
  assert.equal(premium.primary, null);
  assert.equal(premium.secondary, null);
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
