import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractPrices, validatePriceTable, applyPricing, loadPrices } from '../src/pricing.js';
import { aggregate } from '../src/aggregate.js';

// Eleven entries copied verbatim from LiteLLM commit 721d39f4: the six Codex models, gpt-4o
// (no long-context rates), and four entries extraction must drop: sample_spec, an Azure copy
// of gpt-6-astra, an OpenAI embedding model, and openai/container, which is priced per session.
const SLICE = JSON.parse(readFileSync(new URL('fixtures/litellm-slice.json', import.meta.url), 'utf8'));

// The real document has thousands of entries. Padding the slice past the 100-entry floor with
// another provider's models leaves its OpenAI chat models unchanged.
const fullSize = (doc) => ({
  ...doc,
  ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [
    `other/model-${i}`, { litellm_provider: 'other', mode: 'chat', input_cost_per_token: 1, output_cost_per_token: 1 },
  ])),
});

// Round per-token rates keep the expected costs exact.
const RATES = { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 };
const priceTable = (models) => ({ source: 'litellm', sourceUrl: 'https://example.test/prices.json', models });

const usage = (inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens) => ({
  requests: 1, inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens,
  reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens,
});
const modelTable = (rows) => new Map(Object.entries(rows).map(([slug, buckets]) => [slug, new Map(Object.entries(buckets))]));
function reportOf(rows) {
  const period = () => ({ startDay: '2026-09-20', endDay: '2026-09-20', models: modelTable(rows), compaction: new Map() });
  return {
    periods: { rolling: { ...period(), days: new Map([['2026-09-20', modelTable(rows)]]) }, mtd: period(), allTime: period() },
    meta: {},
  };
}
const costOf = (priced, slug) => priced.periods.allTime.models.get(slug).cost;

test('keeps only OpenAI chat models that are priced per token', () => {
  assert.deepEqual(Object.keys(extractPrices(SLICE).models).sort(), [
    'gpt-4o', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-sol',
  ]);
  assert.equal(extractPrices(SLICE).sourceEntries, 11);
});

test('reads the four base rates for short and long context, never a tier variant', () => {
  // The fixture's _priority input rate is 0.00004 and its _flex rate 0.000005.
  assert.deepEqual(extractPrices(SLICE).models['gpt-6-astra'], {
    short: { input: 0.00001, cachedInput: 0.000001, cacheWrite: 0.0000125, output: 0.00005 },
    long: { input: 0.00002, cachedInput: 0.000002, cacheWrite: 0.000025, output: 0.000075 },
  });
});

test('a rate the model lacks is null, and so is long when it has no long-context rates', () => {
  const { models } = extractPrices(SLICE);
  assert.equal(models['gpt-5.5'].short.cacheWrite, null);
  assert.equal(models['gpt-5.5'].long.cacheWrite, null);
  assert.equal(models['gpt-4o'].long, null);
});

test('accepts a full-size document', () => {
  assert.deepEqual(validatePriceTable(extractPrices(fullSize(SLICE))), []);
});

test('rejects a truncated document', () => {
  assert.equal(validatePriceTable(extractPrices(SLICE)).length, 1);
});

test('rejects fewer than five OpenAI chat models', () => {
  const doc = fullSize(Object.fromEntries(Object.entries(SLICE).filter(([slug]) => !slug.startsWith('gpt-5'))));
  assert.equal(validatePriceTable(extractPrices(doc)).length, 1);
});

test('rejects an input or output rate that is not a positive number', () => {
  for (const [key, value] of [
    ['input_cost_per_token', 0], ['input_cost_per_token', -1], ['input_cost_per_token', '0.00001'],
    ['output_cost_per_token', null], ['output_cost_per_token_above_272k_tokens', 0],
  ]) {
    const doc = fullSize({ ...SLICE, 'gpt-6-astra': { ...SLICE['gpt-6-astra'], [key]: value } });
    assert.equal(validatePriceTable(extractPrices(doc)).length, 1, `${key} = ${JSON.stringify(value)}`);
  }
});

test('rejects a table in which no model id starts with gpt-', () => {
  const renamed = Object.fromEntries(Object.entries(SLICE).map(([slug, entry]) => [`model-${slug}`, entry]));
  assert.equal(validatePriceTable(extractPrices(fullSize(renamed))).length, 1);
});

test('turns a document that is not an object into an empty table that fails validation', () => {
  for (const doc of [null, [], 'text', 42]) {
    const table = extractPrices(doc);
    assert.deepEqual(table.models, {});
    assert.ok(validatePriceTable(table).length > 0);
  }
});

test('takes cache-write tokens out of the input term instead of charging them twice', () => {
  // 300 plain input at 10, 600 cached at 1, 100 cache writes at 12.5, 10 output at 50.
  const priced = applyPricing(reportOf({ 'gpt-x': { short: usage(1000, 600, 100, 10) } }), priceTable({ 'gpt-x': { short: RATES, long: null } }));
  assert.equal(costOf(priced, 'gpt-x'), 3000 + 600 + 1250 + 500);
});

test('clamps plain input at zero and notes the inconsistent counts', () => {
  const priced = applyPricing(reportOf({ 'gpt-x': { short: usage(100, 90, 20, 0) } }), priceTable({ 'gpt-x': { short: RATES, long: null } }));
  assert.equal(costOf(priced, 'gpt-x'), 90 * 1 + 20 * 12.5);
  assert.deepEqual(priced.pricing.notes, [{ model: 'gpt-x', issue: 'counts-inconsistent', tokens: 10 }]);
});

test('doubling a model rates doubles its cost and leaves other models alone', () => {
  const report = reportOf({ 'gpt-x': { short: usage(5000, 3000, 200, 70) }, 'gpt-y': { short: usage(900, 100, 0, 30) } });
  const double = Object.fromEntries(Object.entries(RATES).map(([name, rate]) => [name, rate * 2]));
  const base = applyPricing(report, priceTable({ 'gpt-x': { short: RATES, long: null }, 'gpt-y': { short: RATES, long: null } }));
  const doubled = applyPricing(report, priceTable({ 'gpt-x': { short: double, long: null }, 'gpt-y': { short: RATES, long: null } }));
  assert.equal(costOf(doubled, 'gpt-x'), 2 * costOf(base, 'gpt-x'));
  assert.equal(costOf(doubled, 'gpt-y'), costOf(base, 'gpt-y'));
});

test('prices the long bucket at long rates, or at short rates when the model has none', () => {
  const long = { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 };
  const report = reportOf({
    'gpt-l': { short: usage(100, 0, 0, 1), long: usage(300000, 0, 0, 1) },
    'gpt-s': { long: usage(300000, 0, 0, 1) },
  });
  const priced = applyPricing(report, priceTable({ 'gpt-l': { short: RATES, long }, 'gpt-s': { short: RATES, long: null } }));
  assert.equal(costOf(priced, 'gpt-l'), (100 * 10 + 50) + (300000 * 20 + 75));
  assert.equal(costOf(priced, 'gpt-s'), 300000 * 10 + 50);
});

test('keeps the tokens of an unpriced model, costs it null and names it', () => {
  const report = reportOf({ 'gpt-x': { short: usage(10, 0, 0, 1) }, '<unknown>': { short: usage(40, 0, 0, 4) }, 'gpt-new': { short: usage(80, 0, 0, 8) } });
  const priced = applyPricing(report, priceTable({ 'gpt-x': { short: RATES, long: null } }));
  assert.equal(costOf(priced, '<unknown>'), null);
  assert.equal(priced.periods.allTime.models.get('gpt-new').inputTokens, 80);
  assert.deepEqual(priced.pricing.unpricedModels, ['<unknown>', 'gpt-new']);
  assert.equal(priced.periods.allTime.cost, 10 * 10 + 50);
});

test('prices cached and cache-write tokens at the input rate when those rates are missing, and notes it', () => {
  const priced = applyPricing(reportOf({ 'gpt-x': { short: usage(1000, 600, 100, 10) } }),
    priceTable({ 'gpt-x': { short: { ...RATES, cachedInput: null, cacheWrite: null }, long: null } }));
  assert.equal(costOf(priced, 'gpt-x'), 1000 * 10 + 10 * 50);
  assert.deepEqual(priced.pricing.notes, [
    { model: 'gpt-x', issue: 'no-cached-rate', tokens: 600 },
    { model: 'gpt-x', issue: 'no-cache-write-rate', tokens: 100 },
  ]);
});

test('prices a dated slug by its undated name, preferring an exact match', () => {
  const report = reportOf({ 'gpt-x-2026-09-01': { short: usage(10, 0, 0, 0) }, 'gpt-y-2026-01-01': { short: usage(10, 0, 0, 0) } });
  const priced = applyPricing(report, priceTable({
    'gpt-x': { short: RATES, long: null },
    'gpt-y': { short: RATES, long: null },
    'gpt-y-2026-01-01': { short: { ...RATES, input: 3 }, long: null },
  }));
  assert.equal(costOf(priced, 'gpt-x-2026-09-01'), 100);
  assert.equal(costOf(priced, 'gpt-y-2026-01-01'), 30);
});

test('never treats an inherited property as a model price', () => {
  const report = reportOf({ constructor: { short: usage(10, 0, 0, 1) }, toString: { short: usage(10, 0, 0, 1) } });
  const priced = applyPricing(report, priceTable({ 'gpt-x': { short: RATES, long: null } }));
  assert.equal(costOf(priced, 'constructor'), null);
  assert.deepEqual(priced.pricing.unpricedModels, ['constructor', 'toString']);
});

test('prices every table aggregate produces, including compaction and each day', async () => {
  const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url));
  const report = await aggregate([
    `${fixtures}rollout-2026-09-16T10-00-00-thread-a.jsonl`,
    `${fixtures}rollout-2026-08-31T19-00-00-thread-b.jsonl`,
  ], { timeZone: 'America/New_York', now: new Date('2026-09-20T16:00:00Z'), days: 7 });
  const priced = applyPricing(report, priceTable({ 'gpt-6-astra': { short: RATES, long: null } }));
  // r4, the compaction: 1,000 plain input, 7,000 cached, 80 output.
  assert.equal(priced.periods.allTime.compaction.get('gpt-6-astra').cost, 1000 * 10 + 7000 * 1 + 80 * 50);
  assert.equal(priced.periods.allTime.compactionCost, 21000);
  // r2 and r4 on 2026-09-18: 1,400 plain input, 8,600 cached, 100 output.
  assert.equal(priced.periods.rolling.days.get('2026-09-18').get('gpt-6-astra').cost, 1400 * 10 + 8600 * 1 + 100 * 50);
  assert.deepEqual(priced.pricing.unpricedModels, ['<unknown>', 'gpt-5.6-sol', 'gpt-9-imaginary']);
});

test('offline returns the bundled table, which passes validation', async () => {
  const table = await loadPrices({ offline: true });
  assert.equal(table.source, 'bundled');
  assert.equal(table.fallbackReason, 'offline');
  assert.match(table.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(validatePriceTable(table), []);
});
