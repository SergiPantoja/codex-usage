const ISSUES_URL = 'https://github.com/SergiPantoja/codex-usage/issues';
const README_NETWORK_URL = 'https://github.com/SergiPantoja/codex-usage#what-this-sends-over-the-network';
const UNKNOWN_MODEL = '<unknown>';
const FALLBACK_COLUMNS = 80;
const GAP = '   ';
const FAST_BUG = 'Fast mode is not logged (openai/codex#30413). It costs 2x the rates used here.';

// Model slugs, plan types, limit ids, versions and record types come from log files, so a
// crafted log could otherwise write terminal escape sequences.
export function clean(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

// Markdown also reads |, <, * and the like, so a slug could otherwise break a table or vanish as
// an HTML tag.
function md(value) {
  return clean(value).replace(/[\\`*_[\]<>|~#!&{}()]/g, '\\$&');
}

// XML 1.0 forbids most control characters even as character references, so clean replaces them
// before escaping. Lone surrogates, U+FFFE and U+FFFF are not XML characters either.
function xml(value) {
  return clean(value).toWellFormed().replace(/[\ufffe\uffff]/g, '?').replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
}
const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

// A rollout file name ends in the session's thread id, which no report needs.
function fileLabel(name) {
  return String(name).replace(/-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/\.jsonl$/, '');
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
  const files = meta.filesInspected;
  const uncounted = meta.filesWithUncountedUsage;
  const which = uncounted === files
    ? plural(files, 'It logs', 'They log')
    : `${int(uncounted)} of them ${plural(uncounted, 'logs', 'log')}`;
  const lines = [
    `found ${int(files)} Codex session ${plural(files, 'file', 'files')} `
      + `but no token usage records in ${plural(files, 'it', 'them')}. `
      + (uncounted > 0
        ? `${which} token usage only as running totals, as Codex 0.152 and earlier did, and this tool cannot count that.`
        : 'Codex may have changed its log format.'),
    `record types seen: ${types.join(', ') || 'none'}`,
    `Codex versions: ${versions.join(', ') || 'unknown'}`,
    uncounted > 0
      ? `If these logs come from Codex 0.153 or newer, please open an issue at ${ISSUES_URL} and paste these lines.`
      : `Please open an issue at ${ISSUES_URL} and paste these lines.`,
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

// Under --json, stdout carries only the JSON, so the warnings go to stderr on their own.
export function renderWarnings(priced, { columns } = {}) {
  const width = columns > 0 ? columns : FALLBACK_COLUMNS;
  const lines = warningLines(priced, priced.periods.rolling.days.size).flatMap((warning) => wrap(warning, width));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// The Map keyed null for snapshots with no limit_id would become the string "null", which reads
// as a name, so rate limits become a list.
export function renderJson(priced) {
  const rateLimits = [...priced.meta.rateLimits].map(([limitId, snapshot]) => ({ limitId, ...snapshot }));
  const reconciliation = priced.meta.reconciliation.map((entry) => ({ ...entry, file: fileLabel(entry.file) }));
  const report = { ...priced, meta: { ...priced.meta, rateLimits, reconciliation } };
  return `${JSON.stringify(report, (_, value) => (value instanceof Map ? Object.fromEntries(value) : value), 2)}\n`;
}

export function renderMarkdown(priced) {
  const { periods, meta, pricing } = priced;
  const days = periods.rolling.days.size;
  const generated = localTime(meta.generatedAt, meta.timeZone);
  const sections = [
    '# Codex usage report',
    `Generated ${generated} (${md(meta.timeZone)}) by codex-usage-report from the Codex session logs on `
      + 'this machine. Costs are what the same tokens would have cost at OpenAI API rates.',
    ...markdownPeriod(`Last ${days} ${days === 1 ? 'day' : 'days'}`, periods.rolling),
    ...markdownPeriod('Month to date', periods.mtd),
    ...markdownPeriod('All time', periods.allTime),
    '## Rate limits',
    ...markdownRateLimits(meta),
    '## Prices',
    markdownPrices(pricing, meta.timeZone),
    '## Checks',
    markdownChecks(meta),
  ];
  const warnings = warningSentences(priced, days, md).map((warning) => `- ${warning}`);
  if (warnings.length) sections.push('## Warnings', warnings.join('\n'));
  sections.push(
    '## Accuracy',
    [
      '- This is not a bill. Codex is a subscription, and these are the costs of the same tokens through the API.',
      '- Fast mode is not visible in the logs ([openai/codex#30413](https://github.com/openai/codex/issues/30413)). '
        + 'Requests made in Fast mode cost 2x these rates.',
      '- Cached input is priced at the cached rate, which assumes the API would have cached the same requests. '
        + 'OpenAI documents no difference in caching between subscription and API use.',
      '- Cached input is part of input, and reasoning is part of output.',
    ].join('\n'),
    '## Privacy',
    'This report holds token counts, costs, model names, rate-limit percentages and Codex version strings. '
      + 'It holds no conversation text, no file paths, no thread names and no agent nicknames. For what the '
      + `tool sends over the network, see [What this sends over the network](${README_NETWORK_URL}) in the README.`,
  );
  return `${sections.join('\n\n')}\n`;
}

function markdownPeriod(title, period) {
  const range = period.startDay ? `${period.startDay} to ${period.endDay}` : 'No dated requests.';
  const rows = sortedRows(period.models, md);
  if (!rows.length) return [`## ${title}`, range, 'No requests in this period.'];
  const cells = (row) => [int(row.requests), int(row.inputTokens), int(row.cachedInputTokens), int(row.outputTokens),
    int(row.reasoningOutputTokens), percent(row.cachedInputTokens, row.inputTokens), money(row.cost)];
  const total = { ...sumRows(period.models.values()), cost: knownCost(period.models, period.cost) };
  const table = [
    '| Model | Requests | Input | Cached input | Output | Reasoning | Cached share | Cost |',
    '|---|--:|--:|--:|--:|--:|--:|--:|',
    ...rows.map((row) => `| ${row.label} | ${cells(row).join(' | ')} |`),
    `| **Total** | ${cells(total).map((cell) => `**${cell}**`).join(' | ')} |`,
  ].join('\n');
  const blocks = [`## ${title}`, range, table];
  if (period.compaction.size) {
    const compaction = sumRows(period.compaction.values());
    const cost = knownCost(period.compaction, period.compactionCost);
    blocks.push(`Compaction made ${int(compaction.requests)} of these requests, with ${int(compaction.inputTokens)} `
      + `input tokens${cost == null ? '' : ` and ${money(cost)} of the cost`}.`);
  }
  return blocks;
}

function markdownRateLimits(meta) {
  if (!meta.rateLimits.size) return ['Codex logged no rate-limit data.'];
  const now = Date.parse(meta.generatedAt);
  const rows = [];
  const buckets = [...meta.rateLimits].sort(([a], [b]) => (a == null) - (b == null) || String(a).localeCompare(String(b)));
  for (const [limitId, snapshot] of buckets) {
    const bucket = limitId ? md(limitId) : '';
    const plan = snapshot.planType != null ? md(snapshot.planType) : '';
    const observed = localTime(snapshot.observedAt, meta.timeZone) ?? 'unknown';
    const windows = [['primary', snapshot.primary], ['secondary', snapshot.secondary]].filter(([, window]) => isWindow(window));
    if (!windows.length) rows.push(`| ${bucket} | ${plan} | none reported | | | ${observed} |`);
    for (const [name, window] of windows) {
      const resets = Number.isFinite(window.resets_at)
        ? localTime(new Date(window.resets_at * 1000).toISOString(), meta.timeZone) : '';
      rows.push(`| ${bucket} | ${plan} | ${windowLabel(window.window_minutes, name)} | ${windowUse(window, now) ?? 'unknown'} `
        + `| ${resets ?? ''} | ${observed} |`);
    }
  }
  return [
    `The latest snapshot Codex logged for each bucket, not a total for any period. Times are in ${md(meta.timeZone)}.`,
    ['| Bucket | Plan | Window | Used | Resets | As of |', '|---|---|---|--:|---|---|', ...rows].join('\n'),
  ];
}

function markdownPrices(pricing, timeZone) {
  if (pricing.source === 'litellm') {
    return `Prices come from the LiteLLM public price table, fetched ${localTime(pricing.fetchedAt, timeZone)}.`;
  }
  const captured = localTime(pricing.capturedAt, timeZone)?.slice(0, 10) ?? 'an unknown date';
  const commit = pricing.litellmCommit ? ` from LiteLLM commit ${md(pricing.litellmCommit.slice(0, 7))}` : '';
  const why = pricing.fallbackReason === 'offline'
    ? 'This run used it because --offline was passed.'
    : `This run used it because the live table could not be fetched, ${md(pricing.fallbackReason)}.`;
  return `Prices come from the LiteLLM table bundled with this package, captured ${captured}${commit}. ${why}`;
}

function markdownChecks(meta) {
  const files = meta.reconciliation.length;
  const failed = meta.reconciliation.filter((entry) => !entry.ok).map((entry) => md(fileLabel(entry.file)));
  const missing = Object.entries(meta.missingUsageFields).filter(([, count]) => count > 0)
    .map(([field, count]) => `${md(field)} in ${int(count)}`);
  const seen = (values) => (values.length ? values.map(md).join(', ') : 'none');
  return [
    `- ${int(meta.filesInspected)} ${plural(meta.filesInspected, 'file', 'files')} read, `
      + `${int(meta.recordsCounted)} ${plural(meta.recordsCounted, 'request', 'requests')} counted, `
      + `${int(meta.duplicatesSkipped)} ${plural(meta.duplicatesSkipped, 'duplicate', 'duplicates')} skipped.`,
    failed.length
      ? `- ${int(files - failed.length)} of ${int(files)} files reconcile. These do not: ${failed.join(', ')}.`
      : `- ${files === 1 ? 'The file with usage reconciles' : `All ${int(files)} files with usage reconcile`}, `
        + "meaning the per-request usage adds up to Codex's own running total.",
    `- ${int(meta.dirsFailed)} ${plural(meta.dirsFailed, 'directory', 'directories')} and ${int(meta.filesFailed)} `
      + `${plural(meta.filesFailed, 'file', 'files')} could not be read. ${int(meta.malformedMidFile)} malformed `
      + `${plural(meta.malformedMidFile, 'line', 'lines')} in the middle of a file, ${int(meta.malformedTrailing)} `
      + 'at the end of one.',
    `- ${int(meta.unattributedRecords)} ${plural(meta.unattributedRecords, 'request', 'requests')} with no model, `
      + `${int(meta.undatedRecords)} with no readable timestamp, ${int(meta.cacheWriteRecords)} with cache-write tokens.`,
    `- Usage fields missing: ${missing.length ? missing.join(', ') : 'none'}.`,
    `- Models: ${seen(meta.models)}.`,
    `- Codex versions: ${seen(meta.cliVersions)}. Clients: ${seen(meta.originators)}. `
      + `Session sources: ${seen(meta.sources)}.`,
    `- Reasoning efforts: ${seen(meta.efforts)}. Service tiers: ${seen(meta.serviceTiers)}.`,
  ].join('\n');
}

const SVG_WIDTH = 960;
const SVG_PAD = 40;
const SVG_FONT = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const INK = { surface: '#fcfcfb', primary: '#0b0b0b', secondary: '#52514e', grid: '#e1e0d9', axis: '#c3c2b7' };
// The dataviz reference palette in its validated order. Each pair of neighbours stays distinct
// under protanopia and deuteranopia, so the stack takes the slots in sequence, never skipping.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const SEGMENT_GAP = 2;
// Characters per line of notes. At 12.5px, a run of lowercase letters averages about 7 units each.
const SVG_LINE = 115;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function renderSvg(priced) {
  const { periods, meta, pricing } = priced;
  const { rolling } = periods;
  const days = rolling.days.size;
  const span = `${days} ${days === 1 ? 'day' : 'days'}`;
  const inner = SVG_WIDTH - 2 * SVG_PAD;
  const rows = sortedRows(rolling.models, clean);
  const series = chartSeries(rows);
  const out = [];
  let y = SVG_PAD;

  out.push(svgText(SVG_PAD, y + 20, 'Codex usage at API rates', { size: 22, weight: 600 }));
  y += 46;
  out.push(svgText(SVG_PAD, y, 'What these Codex sessions would have cost through the OpenAI API.',
    { size: 14, ink: 'secondary' }));
  y += 24;

  const tileGap = 16;
  const tileWidth = (inner - 2 * tileGap) / 3;
  const tileHeight = 124;
  [[`Last ${span}`, rolling], ['Month to date', periods.mtd], ['All time', periods.allTime]].forEach(([label, period], i) => {
    const x = SVG_PAD + i * (tileWidth + tileGap);
    const total = sumRows(period.models.values());
    const detail = total.requests
      ? `${int(total.requests)} ${plural(total.requests, 'request', 'requests')}, `
        + `${percent(total.cachedInputTokens, total.inputTokens)} of input cached`
      : 'no requests';
    out.push(`<rect x="${num(x)}" y="${num(y)}" width="${num(tileWidth)}" height="${tileHeight}" rx="8" `
      + `fill="${INK.surface}" stroke="${INK.primary}" stroke-opacity="0.1"/>`);
    out.push(svgText(x + 16, y + 26, label, { ink: 'secondary' }));
    out.push(svgText(x + 16, y + 64, money(knownCost(period.models, period.cost)), { size: 30, weight: 600 }));
    out.push(svgText(x + 16, y + 88, detail, { size: 12, ink: 'secondary' }));
    out.push(svgText(x + 16, y + 106, period.startDay ? dayRange(period) : 'no dated requests',
      { size: 12, ink: 'secondary' }));
  });
  y += tileHeight + 40;

  out.push(svgText(SVG_PAD, y, `Cost per day, ${dayRange(rolling)}`, { size: 15, weight: 600 }));
  y += 30;
  const plot = { left: SVG_PAD + 56, right: SVG_WIDTH - SVG_PAD, top: y, height: 220 };
  out.push(...dailyChart(rolling, rows, series, plot, span));
  y += plot.height + 58;

  out.push(svgText(SVG_PAD, y, `By model, last ${span}`, { size: 15, weight: 600 }));
  y += 28;
  if (rows.length) {
    y = svgModelTable(out, rolling, rows, series, y);
  } else {
    out.push(svgText(SVG_PAD, y, `No requests in the last ${span}.`, { ink: 'secondary' }));
    y += 20;
  }

  const warnings = warningSentences(priced, days, clean);
  if (warnings.length) {
    y += 14;
    for (const line of warnings.flatMap((warning) => wrapPlain(warning, SVG_LINE))) {
      out.push(svgText(SVG_PAD, y, line, { size: 12.5 }));
      y += 18;
    }
  }

  y += 16;
  out.push(`<line x1="${SVG_PAD}" y1="${num(y)}" x2="${SVG_WIDTH - SVG_PAD}" y2="${num(y)}" stroke="${INK.grid}"/>`);
  y += 22;
  const footer = [
    `Generated ${localTime(meta.generatedAt, meta.timeZone)} (${meta.timeZone}) by codex-usage-report`,
    capitalised(pricingLine(pricing, meta.timeZone)),
    capitalised(validationLine(meta)),
    FAST_BUG,
  ];
  for (const line of footer.flatMap((text) => wrapPlain(text, SVG_LINE))) {
    out.push(svgText(SVG_PAD, y, line, { size: 12, ink: 'secondary' }));
    y += 18;
  }

  const height = Math.ceil(y - 18 + SVG_PAD);
  const title = `Codex usage at API rates, ${money(knownCost(rolling.models, rolling.cost))} in the last ${span}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}" `
      + `role="img" aria-labelledby="title" font-family="${SVG_FONT}">`,
    `<title id="title">${xml(title)}</title>`,
    `<rect width="${SVG_WIDTH}" height="${height}" fill="${INK.surface}"/>`,
    ...out,
    '</svg>',
    '',
  ].join('\n');
}

// Only priced models can stack, since the bar height is cost. They take the slots in the table's
// order. Past the eighth, models share the last slot rather than a made-up colour.
function chartSeries(rows) {
  const series = [];
  rows.filter((row) => row.cost != null).forEach((row, i) => {
    if (i < SERIES.length) series.push({ color: SERIES[i], slugs: [row.slug] });
    else series.at(-1).slugs.push(row.slug);
  });
  return series;
}

function dailyChart(period, rows, series, plot, span) {
  const out = [];
  const bars = [...period.days].map(([day, table]) => {
    const segments = series
      .map(({ color, slugs }) => ({ color, value: slugs.reduce((sum, slug) => sum + (table.get(slug)?.cost ?? 0), 0) }))
      .filter(({ value }) => value > 0);
    return { day, table, segments, total: segments.reduce((sum, { value }) => sum + value, 0) };
  });
  const width = plot.right - plot.left;
  const band = width / bars.length;
  const barWidth = Math.min(24, band * 0.6);
  const bottom = plot.top + plot.height;
  const peak = Math.max(0, ...bars.map((bar) => bar.total));

  let scale = () => bottom;
  if (peak > 0) {
    const step = niceStep(peak / 4);
    const ticks = Math.ceil(peak / step - 1e-9);
    const top = ticks * step;
    scale = (value) => plot.top + plot.height * (1 - value / top);
    for (let i = 1; i <= ticks; i += 1) {
      const tickY = num(scale(i * step));
      out.push(`<line x1="${plot.left}" y1="${tickY}" x2="${plot.right}" y2="${tickY}" stroke="${INK.grid}"/>`);
    }
    for (let i = 0; i <= ticks; i += 1) {
      out.push(svgText(plot.left - 10, scale(i * step) + 4, tickMoney(i * step, step),
        { size: 12, ink: 'secondary', anchor: 'end', numeric: true }));
    }
  } else {
    const message = rows.length ? `No priced requests in the last ${span}` : `No requests in the last ${span}`;
    out.push(svgText(plot.left + width / 2, plot.top + plot.height / 2, message, { ink: 'secondary', anchor: 'middle' }));
  }

  bars.forEach(({ day, table, segments, total }, i) => {
    const bandX = plot.left + i * band;
    const x = bandX + (band - barWidth) / 2;
    const lines = [`${day} · ${money(total)}`,
      ...sortedRows(table, clean).map((row) => `${fit(row.label, 40)} ${money(row.cost)}`)];
    out.push('<g>', `<title>${lines.map(xml).join('\n')}</title>`,
      `<rect x="${num(bandX)}" y="${plot.top}" width="${num(band)}" height="${plot.height}" fill="${INK.surface}" fill-opacity="0"/>`);
    let base = 0;
    segments.forEach(({ color, value }, j) => {
      const low = scale(base);
      base += value;
      const high = scale(base);
      // The segment below each boundary gives up two pixels, so a surface gap separates the colours.
      if (j === segments.length - 1) out.push(roundedTop(x, high, barWidth, low - high, color));
      else if (low - high > SEGMENT_GAP) {
        out.push(`<rect x="${num(x)}" y="${num(high + SEGMENT_GAP)}" width="${num(barWidth)}" `
          + `height="${num(low - high - SEGMENT_GAP)}" fill="${color}"/>`);
      }
    });
    out.push('</g>');
  });

  out.push(`<line x1="${plot.left}" y1="${bottom}" x2="${plot.right}" y2="${bottom}" stroke="${INK.axis}"/>`);
  if (peak > 0) {
    const index = bars.findIndex((bar) => bar.total === peak);
    const x = Math.min(Math.max(plot.left + (index + 0.5) * band, plot.left + 28), plot.right - 28);
    out.push(svgText(x, scale(peak) - 8, money(peak), { size: 12, anchor: 'middle', numeric: true }));
  }
  // Labels count back from the last day, so today always has one.
  const every = Math.ceil(52 / band);
  bars.forEach(({ day }, i) => {
    if ((bars.length - 1 - i) % every) return;
    out.push(svgText(plot.left + (i + 0.5) * band, bottom + 20, shortDay(day), { size: 12, ink: 'secondary', anchor: 'middle' }));
  });
  return out;
}

function svgModelTable(out, period, rows, series, top) {
  const right = SVG_WIDTH - SVG_PAD;
  const columns = [
    ['Requests', right - 530, (row) => int(row.requests)],
    ['Input', right - 420, (row) => int(row.inputTokens)],
    ['Cached input', right - 305, (row) => int(row.cachedInputTokens)],
    ['Output', right - 205, (row) => int(row.outputTokens)],
    ['Cached share', right - 100, (row) => percent(row.cachedInputTokens, row.inputTokens)],
    ['Cost', right, (row) => money(row.cost)],
  ];
  const colorOf = new Map(series.flatMap(({ color, slugs }) => slugs.map((slug) => [slug, color])));
  const line = (y, color = INK.grid) =>
    `<line x1="${SVG_PAD}" y1="${num(y)}" x2="${right}" y2="${num(y)}" stroke="${color}"/>`;
  const cells = (row, y, style) => columns.map(([, x, value]) => svgText(x, y, value(row), { ...style, anchor: 'end', numeric: true }));

  let y = top;
  out.push(svgText(SVG_PAD, y, 'Model', { size: 12, ink: 'secondary' }),
    ...columns.map(([header, x]) => svgText(x, y, header, { size: 12, ink: 'secondary', anchor: 'end' })));
  out.push(line(y + 9));
  y += 30;
  for (const row of rows) {
    const color = colorOf.get(row.slug);
    if (color) out.push(`<rect x="${SVG_PAD}" y="${num(y - 10)}" width="10" height="10" rx="2" fill="${color}"/>`);
    out.push(svgText(SVG_PAD + 18, y, fit(row.label, 34)), ...cells(row, y, {}));
    y += 26;
  }
  out.push(line(y - 17, INK.axis));
  y += 4;
  const total = { ...sumRows(period.models.values()), cost: knownCost(period.models, period.cost) };
  out.push(svgText(SVG_PAD + 18, y, 'Total', { weight: 600 }), ...cells(total, y, { weight: 600 }));
  y += 26;
  if (period.compaction.size) {
    const compaction = { ...sumRows(period.compaction.values()), cost: knownCost(period.compaction, period.compactionCost) };
    out.push(svgText(SVG_PAD + 18, y, 'of which compaction', { ink: 'secondary' }),
      ...cells(compaction, y, { ink: 'secondary' }));
    y += 26;
  }
  return y;
}

function svgText(x, y, content, { size = 13, weight, ink = 'primary', anchor, numeric } = {}) {
  const attributes = [`x="${num(x)}"`, `y="${num(y)}"`, `font-size="${size}"`, `fill="${INK[ink]}"`];
  if (weight) attributes.push(`font-weight="${weight}"`);
  if (anchor) attributes.push(`text-anchor="${anchor}"`);
  if (numeric) attributes.push('style="font-variant-numeric: tabular-nums"');
  return `<text ${attributes.join(' ')}>${xml(content)}</text>`;
}

// Square at the baseline, rounded where the bar ends.
function roundedTop(x, y, width, height, fill) {
  const r = Math.min(4, width / 2, height);
  return `<path d="M${num(x)} ${num(y + height)}V${num(y + r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + r)} ${num(y)}`
    + `H${num(x + width - r)}A${num(r)} ${num(r)} 0 0 1 ${num(x + width)} ${num(y + r)}V${num(y + height)}Z" fill="${fill}"/>`;
}

function niceStep(rough) {
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 2.5, 5, 10].find((multiple) => multiple * power >= rough * (1 - 1e-9)) * power;
}

function tickMoney(value, step) {
  let decimals = 0;
  while (decimals < 6 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-6) decimals += 1;
  if (decimals > 0) decimals = Math.max(decimals, 2);
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function dayRange({ startDay, endDay }) {
  return startDay === endDay ? startDay : `${startDay} to ${endDay}`;
}

function shortDay(day) {
  const [, month, date] = day.split('-').map(Number);
  return `${MONTHS[month - 1]} ${date}`;
}

function num(value) {
  return String(Math.round(value * 100) / 100);
}

function capitalised(text) {
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

// SVG text does not wrap, and a slug has no spaces to wrap at, so a word longer than a line breaks.
function wrapPlain(text, width) {
  const words = text.split(' ').flatMap((word) => word.match(new RegExp(`.{1,${width}}`, 'gu')) ?? ['']);
  return joinWrapped(words, ' ', width).map((line) => line.trimStart());
}

function modelTable(period, width, days) {
  const rows = sortedRows(period.models, clean);
  if (!rows.length) return [`no requests in the last ${days} ${days === 1 ? 'day' : 'days'}`];
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

function sortedRows(table, escape) {
  return [...table].map(([slug, row]) => ({ slug, label: escape(slug), ...row })).sort(byCost);
}

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
  const sum = { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
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
  const use = windowUse(window, now);
  const text = use == null ? 'usage unknown' : use === 'reset since' ? use : `${use} used`;
  return `${windowLabel(window.window_minutes, name)} window ${text}`;
}

function windowUse(window, now) {
  if (Number.isFinite(window.resets_at) && window.resets_at * 1000 <= now) return 'reset since';
  if (!Number.isFinite(window.used_percent)) return null;
  const used = window.used_percent;
  return `${Number.isInteger(used) ? used : used.toFixed(1)}%`;
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

function warningLines({ meta, pricing }, days, escape = clean) {
  const warnings = [];
  const tiers = meta.serviceTiers.filter((tier) => tier !== 'default');
  if (tiers.length) {
    warnings.push(`WARNING: the logs show service tier ${listed(tiers.map((tier) => `"${escape(tier)}"`))}. `
      + 'This report prices every request at standard rates. Fast mode costs 2x, so the real cost '
      + 'can be about double this estimate.');
  }

  const lost = lostDataWarning(meta);
  if (lost) warnings.push(lost);

  if (meta.filesWithUncountedUsage > 0) {
    const count = meta.filesWithUncountedUsage;
    warnings.push(`warning: ${int(count)} ${plural(count, 'file logs', 'files log')} token usage only as running `
      + 'totals, as Codex 0.152 and earlier did. This tool cannot count that usage, so the totals leave it out. '
      + 'In a thread resumed after upgrading Codex, the missing part is the turns from before the upgrade.');
  }

  const mismatched = meta.reconciliation.filter((entry) => !entry.ok);
  if (mismatched.length) {
    const names = mismatched.slice(0, 3).map((entry) => escape(fileLabel(entry.file)));
    if (mismatched.length > 3) names.push(`${mismatched.length - 3} more`);
    warnings.push(`warning: in ${mismatched.length} of ${meta.reconciliation.length} files the per-request `
      + `usage does not add up to Codex's own running total, so totals may be wrong (${names.join(', ')})`);
  }

  const missing = Object.entries(meta.missingUsageFields).filter(([, count]) => count > 0);
  if (missing.length) {
    const fields = missing.map(([field, count]) => `${escape(field)} in ${int(count)} ${plural(count, 'request', 'requests')}`);
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
    warnings.push(`warning: could not fetch current prices, ${escape(pricing.fallbackReason)}. This report uses `
      + `the bundled table captured ${captured}.`);
  }

  const unpriced = pricing.unpricedModels.filter((model) => model !== UNKNOWN_MODEL).map(escape);
  if (unpriced.length) {
    const they = unpriced.length === 1 ? 'it shows N/A and is' : 'they show N/A and are';
    warnings.push(`warning: no published price for ${listed(unpriced)}, so ${they} left out of the cost totals`);
  }
  if (meta.unattributedRecords > 0) {
    const count = meta.unattributedRecords;
    warnings.push(`note: the logs name no model for ${int(count)} ${plural(count, 'request', 'requests')}, `
      + `so ${plural(count, 'it is', 'they are')} listed as ${escape(UNKNOWN_MODEL)} and left out of the cost totals`);
  }

  for (const { model, issue, tokens } of pricing.notes) {
    const name = escape(model);
    if (issue === 'no-cached-rate') {
      warnings.push(`note: the price table has no cached-input rate for ${name}, so its ${int(tokens)} cached `
        + 'tokens are priced at the full input rate');
    } else if (issue === 'no-cache-write-rate') {
      warnings.push(`note: the price table has no cache-write rate for ${name}, so its ${int(tokens)} cache-write `
        + 'tokens are priced at the input rate');
    } else if (issue === 'counts-inconsistent') {
      warnings.push(`warning: the logs give ${name} ${int(tokens)} more cached and cache-write tokens than input `
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

// The Markdown and the SVG give the terminal's warnings as sentences.
function warningSentences(priced, days, escape) {
  return warningLines(priced, days, escape).map((warning) => {
    const text = warning.replace(/^(WARNING|warning|note): /, '');
    return `${capitalised(text)}${text.endsWith('.') ? '' : '.'}`;
  });
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
