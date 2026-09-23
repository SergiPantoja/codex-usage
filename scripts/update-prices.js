#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractPrices, validatePriceTable } from '../src/pricing.js';

const REPO = 'BerriAI/litellm';
const FILE = 'model_prices_and_context_window.json';
const OUT = new URL('../src/prices.json', import.meta.url);

const commit = await latestCommit();
const sourceUrl = `https://raw.githubusercontent.com/${REPO}/${commit}/${FILE}`;
const table = extractPrices(await getJson(sourceUrl));
const problems = validatePriceTable(table);
if (problems.length) {
  console.error(`validation failed at ${commit}: ${problems.join('; ')}`);
  // Exit code 2 separates bad data from a failed download (1), which is not worth an issue.
  process.exit(2);
}

const models = Object.fromEntries(Object.keys(table.models).sort().map((slug) => [slug, table.models[slug]]));
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).models : null;
const changes = previous ? compareModels(previous, models) : [];
// LiteLLM commits to this file several times an hour, so only a price change rewrites it.
if (previous && !changes.length) {
  console.log(`prices unchanged at ${commit.slice(0, 8)}, src/prices.json left as is`);
  process.exit(0);
}

const bundled = { sourceUrl, litellmCommit: commit, capturedAt: new Date().toISOString(), sourceEntries: table.sourceEntries, models };
writeFileSync(OUT, `${JSON.stringify(bundled, null, 2)}\n`);
console.log(`wrote src/prices.json: ${Object.keys(models).length} models from ${table.sourceEntries} entries at ${commit.slice(0, 8)}`);
for (const change of changes) console.log(`  ${change}`);

async function latestCommit() {
  const commits = await getJson(`https://api.github.com/repos/${REPO}/commits?path=${FILE}&per_page=1`);
  const sha = commits?.[0]?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`no commit found for ${FILE}`);
  return sha;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

function compareModels(before, after) {
  const changes = [];
  for (const slug of Object.keys(after)) {
    if (!Object.hasOwn(before, slug)) changes.push(`added   ${slug}`);
    else if (JSON.stringify(before[slug]) !== JSON.stringify(after[slug])) changes.push(`changed ${slug}`);
  }
  for (const slug of Object.keys(before)) {
    if (!Object.hasOwn(after, slug)) changes.push(`removed ${slug}`);
  }
  return changes;
}
