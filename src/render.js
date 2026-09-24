const ISSUES_URL = 'https://github.com/SergiPantoja/codex-usage/issues';
const UNKNOWN_MODEL = '<unknown>';
const FALLBACK_COLUMNS = 80;
const GAP = '   ';
const FAST_BUG = 'Fast mode is not logged (openai/codex#30413). It costs 2x the rates used here.';

// Model slugs, plan types, limit ids, versions and record types come from log files, so a
// crafted log could otherwise write terminal escape sequences.
export function clean(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

export function renderTerminal(priced, { columns } = {}) {
  const { periods, meta, pricing } = priced;
  const width = columns > 0 ? columns : FALLBACK_COLUMNS;
  const days = periods.rolling.days.size;
  const lines = [
    ...joinWrapped(['codex-usage-report', `last ${days} ${days === 1 ? 'day' : 'days'}`, clean(meta.timeZone)], ' · ', width),
    '',
    ...modelTable(periods.rolling, width, days),
    '',
    ...joinWrapped([`month to date  ${money(knownCost(periods.mtd.models, periods.mtd.cost))}`,
      `all time  ${money(knownCost(periods.allTime.models, periods.allTime.cost))}`],
      '      ', width),
    '',
    ...rateLimitLines(meta, width),
    '',
    ...wrap(pricingLine(pricing, meta.timeZone), width),
    ...wrap(validationLine(meta), width),
    ...wrap(FAST_BUG, width),
  ];
  const warnings = warningLines(priced, days);
  if (warnings.length) lines.push('', ...warnings.flatMap((warning) => wrap(warning, width)));
  return `${lines.join('\n')}\n`;
}

export function renderNoRecords(meta, { columns } = {}) {
  const width = columns > 0 ? columns : FALLBACK_COLUMNS;
  const types = [...meta.recordTypes].sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `${type === undefined ? '(none)' : clean(type)} ${int(count)}`);
  const versions = meta.cliVersions.map(clean);
  const lines = [
    `found ${int(meta.filesInspected)} Codex session ${plural(meta.filesInspected, 'file', 'files')} `
      + `but no token usage records in ${plural(meta.filesInspected, 'it', 'them')}. `
      + 'Codex may have changed its log format.',
    `record types seen: ${types.join(', ') || 'none'}`,
    `Codex versions: ${versions.join(', ') || 'unknown'}`,
    `Please open an issue at ${ISSUES_URL} and paste these lines.`,
  ];
  const lost = lostDataWarning(meta, 'so some usage may have been missed');
  if (lost) lines.push('', lost);
  return `${lines.flatMap((line) => wrap(line, width)).join('\n')}\n`;
}

export function renderNoSessions(where, meta, { columns } = {}) {
  const width = columns > 0 ? columns : FALLBACK_COLUMNS;
  const lines = [`found no Codex session logs in ${where}`];
  const lost = lostDataWarning(meta, 'so logs may be there that this tool could not see');
  if (lost) lines.push(lost);
  return `${lines.flatMap((line) => wrap(line, width)).join('\n')}\n`;
}

function modelTable(period, width, days) {
  const rows = [...period.models].map(([slug, row]) => ({ label: clean(slug), ...row }));
  if (!rows.length) return [`no requests in the last ${days} ${days === 1 ? 'day' : 'days'}`];
  rows.sort(byCost);
  const total = { label: 'total', ...sumRows(period.models.values()), cost: knownCost(period.models, period.cost) };
  const compaction = period.compaction.size
    ? { label: '  compaction', ...sumRows(period.compaction.values()), cost: knownCost(period.compaction, period.compactionCost) }
    : null;

  const all = [...rows, total, ...(compaction ? [compaction] : [])];
  const widths = new Map(TABLE_COLUMNS.map((column) =>
    [column, Math.max(column.header.length, ...all.map((row) => column.value(row).length))]));
  let columnsShown = TABLE_COLUMNS;
  let labelWidth = Math.max('model'.length, ...all.map((row) => row.label.length));
  const tableWidth = () => labelWidth + columnsShown.reduce((sum, column) => sum + GAP.length + widths.get(column), 0);
  // Narrow terminals lose the least telling columns first, then the model names get cut.
  for (const drop of DROP_ORDER) {
    if (tableWidth() <= width) break;
    columnsShown = columnsShown.filter((column) => column.key !== drop);
  }
  if (tableWidth() > width) labelWidth = Math.max(8, labelWidth - (tableWidth() - width));

  const line = (label, cells) => fit(label, labelWidth).padEnd(labelWidth)
    + columnsShown.map((column, i) => GAP + cells[i].padStart(widths.get(column))).join('');
  const rule = '─'.repeat(tableWidth());
  const render = (row) => line(row.label, columnsShown.map((column) => column.value(row)));
  return [
    line('model', columnsShown.map((column) => column.header)),
    rule,
    ...rows.map(render),
    rule,
    render(total),
    ...(compaction ? [render(compaction)] : []),
  ];
}

const TABLE_COLUMNS = [
  { key: 'requests', header: 'reqs', value: (row) => int(row.requests) },
  { key: 'input', header: 'input', value: (row) => int(row.inputTokens) },
  { key: 'cached', header: 'cached', value: (row) => int(row.cachedInputTokens) },
  { key: 'output', header: 'output', value: (row) => int(row.outputTokens) },
  { key: 'cachedShare', header: 'cached', value: (row) => percent(row.cachedInputTokens, row.inputTokens) },
  { key: 'cost', header: 'cost', value: (row) => money(row.cost) },
];
const DROP_ORDER = ['cached', 'output', 'requests', 'input'];

// Highest cost first. Unpriced models have no cost to rank by, so they follow, by input.
function byCost(a, b) {
  if ((a.cost == null) !== (b.cost == null)) return a.cost == null ? 1 : -1;
  const difference = a.cost == null ? b.inputTokens - a.inputTokens : b.cost - a.cost;
  return difference || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

// A total made only of unpriced models is unknown, not zero.
function knownCost(table, cost) {
  const priced = [...table.values()].some((row) => row.cost != null);
  return priced || !table.size ? cost : null;
}

function sumRows(rows) {
  const sum = { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const row of rows) for (const key of Object.keys(sum)) sum[key] += row[key];
  return sum;
}

function rateLimitLines(meta, width) {
  const now = Date.parse(meta.generatedAt);
  const buckets = [...meta.rateLimits]
    .filter(([, snapshot]) => isWindow(snapshot.primary) || isWindow(snapshot.secondary))
    .sort(([a], [b]) => (a == null) - (b == null) || String(a).localeCompare(String(b)));
  if (!buckets.length) return ['rate limits not found in the logs'];

  return buckets.flatMap(([limitId, snapshot]) => {
    const head = [limitId ? clean(limitId) : null, snapshot.planType != null ? `plan: ${clean(snapshot.planType)}` : null]
      .filter(Boolean).join(' ');
    const windows = [['primary', snapshot.primary], ['secondary', snapshot.secondary]]
      .filter(([, window]) => isWindow(window))
      .map(([name, window]) => windowText(window, name, now));
    const observed = localTime(snapshot.observedAt, meta.timeZone);
    const when = observed ? `as of ${observed}` : 'as of an unknown time';
    return joinWrapped([head, ...windows, when].filter(Boolean), ' · ', width);
  });
}

function isWindow(window) {
  return window !== null && typeof window === 'object';
}

function windowText(window, name, now) {
  const label = `${windowLabel(window.window_minutes, name)} window`;
  if (Number.isFinite(window.resets_at) && window.resets_at * 1000 <= now) return `${label} reset since`;
  if (!Number.isFinite(window.used_percent)) return `${label} usage unknown`;
  const used = window.used_percent;
  return `${label} ${Number.isInteger(used) ? used : used.toFixed(1)}% used`;
}

function windowLabel(minutes, name) {
  if (!Number.isInteger(minutes) || minutes <= 0) return name;
  if (minutes === 10_080) return 'weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function pricingLine(pricing, timeZone) {
  if (pricing.source === 'litellm') return `prices from LiteLLM, fetched ${localTime(pricing.fetchedAt, timeZone)}`;
  const captured = localTime(pricing.capturedAt, timeZone)?.slice(0, 10) ?? 'an unknown date';
  const suffix = pricing.fallbackReason === 'offline' ? ', --offline' : '';
  return `prices from the LiteLLM table bundled with this package, captured ${captured}${suffix}`;
}

function validationLine(meta) {
  const files = meta.reconciliation.length;
  const reconciled = meta.reconciliation.filter((entry) => entry.ok).length;
  return [
    `checked ${int(meta.filesInspected)} ${plural(meta.filesInspected, 'file', 'files')}`,
    `${int(meta.recordsCounted)} ${plural(meta.recordsCounted, 'request', 'requests')}`,
    `${int(meta.duplicatesSkipped)} ${plural(meta.duplicatesSkipped, 'duplicate', 'duplicates')}`,
    reconciled === files
      ? `${files === 1 ? 'the file reconciles' : `all ${int(files)} files reconcile`}`
      : `${int(reconciled)} of ${int(files)} files reconcile`,
  ].join(' · ');
}

function warningLines({ meta, pricing }, days) {
  const warnings = [];
  const tiers = meta.serviceTiers.filter((tier) => tier !== 'default');
  if (tiers.length) {
    warnings.push(`WARNING: the logs show service tier ${listed(tiers.map((tier) => `"${clean(tier)}"`))}. `
      + 'This report prices every request at standard rates. Fast mode costs 2x, so the real cost '
      + 'can be about double this estimate.');
  }

  const lost = lostDataWarning(meta);
  if (lost) warnings.push(lost);

  const mismatched = meta.reconciliation.filter((entry) => !entry.ok);
  if (mismatched.length) {
    const names = mismatched.slice(0, 3).map((entry) => clean(entry.file));
    if (mismatched.length > 3) names.push(`${mismatched.length - 3} more`);
    warnings.push(`warning: in ${mismatched.length} of ${meta.reconciliation.length} files the per-request `
      + `usage does not add up to Codex's own running total, so totals may be wrong (${names.join(', ')})`);
  }

  const missing = Object.entries(meta.missingUsageFields).filter(([, count]) => count > 0);
  if (missing.length) {
    const fields = missing.map(([field, count]) => `${field} in ${int(count)} ${plural(count, 'request', 'requests')}`);
    warnings.push(`warning: the logs lack ${listed(fields)}. They do not match the format this tool was built `
      + 'for, so those costs may be wrong.');
  }

  if (meta.undatedRecords > 0) {
    const count = meta.undatedRecords;
    warnings.push(`warning: ${int(count)} ${plural(count, 'request has', 'requests have')} no readable `
      + `timestamp. They count in all time only, so the last ${days} ${days === 1 ? 'day' : 'days'} `
      + 'and month to date may be low.');
  }

  if (pricing.fallbackReason && pricing.fallbackReason !== 'offline') {
    const captured = pricing.capturedAt?.slice(0, 10) ?? 'an unknown date';
    warnings.push(`warning: could not fetch current prices, ${clean(pricing.fallbackReason)}. This report uses `
      + `the bundled table captured ${captured}.`);
  }

  const unpriced = pricing.unpricedModels.filter((model) => model !== UNKNOWN_MODEL).map(clean);
  if (unpriced.length) {
    const they = unpriced.length === 1 ? 'it shows N/A and is' : 'they show N/A and are';
    warnings.push(`warning: no published price for ${listed(unpriced)}, so ${they} left out of the cost totals`);
  }
  if (meta.unattributedRecords > 0) {
    const count = meta.unattributedRecords;
    warnings.push(`note: the logs name no model for ${int(count)} ${plural(count, 'request', 'requests')}, `
      + `so ${plural(count, 'it is', 'they are')} listed as ${UNKNOWN_MODEL} and left out of the cost totals`);
  }

  for (const { model, issue, tokens } of pricing.notes) {
    const name = clean(model);
    if (issue === 'no-cached-rate') {
      warnings.push(`note: ${name} has no cached-input price, so its ${int(tokens)} cached tokens are priced `
        + 'at the full input rate');
    } else if (issue === 'no-cache-write-rate') {
      warnings.push(`note: ${name} has no cache-write price, so its ${int(tokens)} cache-write tokens are `
        + 'priced at the input rate');
    } else if (issue === 'counts-inconsistent') {
      warnings.push(`warning: ${name} logs ${int(tokens)} more cached and cache-write tokens than input `
        + 'tokens, so its cost may be wrong');
    }
  }

  if (meta.cacheWriteRecords > 0) {
    const count = meta.cacheWriteRecords;
    warnings.push(`note: ${int(count)} ${plural(count, 'request carries', 'requests carry')} cache-write tokens, `
      + 'which this tool had not seen before. It prices them at the cache-write rate as part of input. '
      + `If the cost looks wrong, please open an issue at ${ISSUES_URL}`);
  }
  return warnings;
}

// A lost directory, a file cut short or a broken line can each drop usage, and reconciliation
// cannot see any of them.
function lostDataWarning(meta, consequence = 'so totals may be low') {
  const parts = [];
  if (meta.dirsFailed > 0) {
    parts.push(`${int(meta.dirsFailed)} ${plural(meta.dirsFailed, 'directory', 'directories')} could not be read`);
  }
  if (meta.filesFailed > 0) {
    parts.push(`${int(meta.filesFailed)} ${plural(meta.filesFailed, 'file', 'files')} could not be read completely`);
  }
  if (meta.malformedMidFile > 0) {
    parts.push(`${int(meta.malformedMidFile)} ${plural(meta.malformedMidFile, 'line', 'lines')} in the middle `
      + `of a file could not be parsed`);
  }
  return parts.length ? `warning: ${listed(parts)}, ${consequence}` : null;
}

function localTime(timestamp, timeZone) {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function int(value) {
  return value.toLocaleString('en-US');
}

function money(value) {
  if (value == null) return 'N/A';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(part, whole) {
  return whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : '-';
}

function plural(count, one, many) {
  return count === 1 ? one : many;
}

function listed(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function fit(text, width) {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function joinWrapped(parts, separator, width) {
  const lines = [];
  let current = '';
  for (const part of parts) {
    const next = current ? `${current}${separator}${part}` : part;
    if (current && next.length > width) {
      lines.push(current);
      current = `  ${part}`;
    } else {
      current = next;
    }
  }
  return [...lines, current];
}

function wrap(text, width) {
  return joinWrapped(text.split(' '), ' ', width);
}
