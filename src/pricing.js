import { readFileSync } from 'node:fs';

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const RATE_KEYS = {
  input: 'input_cost_per_token',
  cachedInput: 'cache_read_input_token_cost',
  cacheWrite: 'cache_creation_input_token_cost',
  output: 'output_cost_per_token',
};
const LONG_SUFFIX = '_above_272k_tokens';

export async function loadPrices({ offline = false, timeoutMs = 5000 } = {}) {
  if (offline) return bundledPrices('offline');
  let doc;
  try {
    const response = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return bundledPrices(`HTTP ${response.status}`);
    doc = await response.json();
  } catch (error) {
    return bundledPrices(fetchFailure(error));
  }
  const table = extractPrices(doc);
  const problems = validatePriceTable(table);
  if (problems.length) return bundledPrices(`validation failed: ${problems.join('; ')}`);
  return { source: 'litellm', sourceUrl: LITELLM_URL, fetchedAt: new Date().toISOString(), ...table };
}

// Node 22 reports a timeout that fires during the body read as AbortError, Node 24 as
// TimeoutError. Nothing else aborts this request.
function fetchFailure(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
  if (error.name === 'SyntaxError') return 'malformed JSON';
  return error.cause?.code ? `network error (${error.cause.code})` : 'network error';
}

function bundledPrices(fallbackReason) {
  const bundled = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8'));
  return { source: 'bundled', ...bundled, fallbackReason };
}

export function extractPrices(doc) {
  if (!isObject(doc)) return { sourceEntries: 0, models: {} };
  // Entries priced another way, such as openai/container per session, have no token rates.
  const models = Object.entries(doc)
    .filter(([, entry]) => isObject(entry) && entry.litellm_provider === 'openai'
      && entry.mode === 'chat' && Object.hasOwn(entry, RATE_KEYS.input))
    .map(([slug, entry]) => [slug, {
      short: readRates(entry, ''),
      long: Object.hasOwn(entry, RATE_KEYS.input + LONG_SUFFIX) ? readRates(entry, LONG_SUFFIX) : null,
    }]);
  return { sourceEntries: Object.keys(doc).length, models: Object.fromEntries(models) };
}

function readRates(entry, suffix) {
  return Object.fromEntries(Object.entries(RATE_KEYS).map(([name, key]) => {
    const value = entry[key + suffix];
    return [name, typeof value === 'number' && Number.isFinite(value) ? value : null];
  }));
}

export function validatePriceTable(table) {
  const problems = [];
  if (!(table.sourceEntries > 100)) {
    problems.push(`the document has ${table.sourceEntries} entries, expected more than 100`);
  }
  const slugs = Object.keys(table.models);
  if (slugs.length < 5) problems.push(`${slugs.length} OpenAI chat models, expected at least 5`);
  for (const slug of slugs) {
    for (const [variant, rates] of Object.entries(table.models[slug])) {
      if (rates && !(rates.input > 0 && rates.output > 0)) {
        problems.push(`${slug} has no positive ${variant} input and output rate`);
      }
    }
  }
  // A pattern rather than a list of known models, so a new flagship never fails this check.
  if (!slugs.some((slug) => slug.startsWith('gpt-'))) problems.push('no model id starts with gpt-');
  return problems;
}

export function applyPricing(report, table) {
  const { models: prices, sourceEntries, ...provenance } = table;
  const ratesFor = (slug) => lookup(prices, slug);
  const priceTable = (modelTable) =>
    new Map([...modelTable].map(([slug, buckets]) => [slug, priceRow(buckets, ratesFor(slug))]));

  const periods = {};
  for (const [name, period] of Object.entries(report.periods)) {
    const models = priceTable(period.models);
    const compaction = priceTable(period.compaction);
    periods[name] = { ...period, models, compaction, cost: sumCosts(models), compactionCost: sumCosts(compaction) };
    if (period.days) {
      periods[name].days = new Map([...period.days].map(([day, dayTable]) => [day, priceTable(dayTable)]));
    }
  }

  const allTime = report.periods.allTime.models;
  const unpricedModels = [...allTime.keys()].filter((slug) => !ratesFor(slug)).sort();
  return {
    periods,
    meta: report.meta,
    pricing: { ...provenance, unpricedModels, notes: pricingNotes(allTime, ratesFor) },
  };
}

// Codex could log a dated slug, such as gpt-x-2026-09-01, that the table lists only undated.
function lookup(prices, slug) {
  if (Object.hasOwn(prices, slug)) return prices[slug];
  const undated = slug.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return Object.hasOwn(prices, undated) ? prices[undated] : null;
}

const bucketRates = (model, bucket) => (bucket === 'long' && model.long) || model.short;

function priceRow(buckets, model) {
  const row = {};
  let cost = model ? 0 : null;
  for (const [bucket, totals] of buckets) {
    for (const [key, value] of Object.entries(totals)) row[key] = (row[key] ?? 0) + value;
    if (model) cost += bucketCost(totals, bucketRates(model, bucket));
  }
  return { ...row, cost };
}

// Cache-write tokens are part of input_tokens and bill at their own rate instead of the input
// rate, so they come out of the plain input term rather than being charged on top of it.
function bucketCost(totals, rates) {
  const plainInput = Math.max(0, totals.inputTokens - totals.cachedInputTokens - totals.cacheWriteTokens);
  return plainInput * rates.input
    + totals.cachedInputTokens * (rates.cachedInput ?? rates.input)
    + totals.cacheWriteTokens * (rates.cacheWrite ?? rates.input)
    + totals.outputTokens * rates.output;
}

function sumCosts(pricedTable) {
  let sum = 0;
  for (const row of pricedTable.values()) sum += row.cost ?? 0;
  return sum;
}

function pricingNotes(models, ratesFor) {
  const notes = new Map();
  const note = (model, issue, tokens) => {
    if (tokens <= 0) return;
    const key = `${model}\n${issue}`;
    if (notes.has(key)) notes.get(key).tokens += tokens;
    else notes.set(key, { model, issue, tokens });
  };
  for (const [slug, buckets] of models) {
    const model = ratesFor(slug);
    if (!model) continue;
    for (const [bucket, totals] of buckets) {
      const rates = bucketRates(model, bucket);
      if (rates.cachedInput == null) note(slug, 'no-cached-rate', totals.cachedInputTokens);
      if (rates.cacheWrite == null) note(slug, 'no-cache-write-rate', totals.cacheWriteTokens);
      note(slug, 'counts-inconsistent', totals.cachedInputTokens + totals.cacheWriteTokens - totals.inputTokens);
    }
  }
  return [...notes.values()];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
