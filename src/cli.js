import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { aggregate } from './aggregate.js';
import { applyPricing, loadPrices } from './pricing.js';
import { clean, renderNoRecords, renderNoSessions, renderTerminal } from './render.js';
import { findRolloutFiles, resolveCodexHome, scanCounts } from './scan.js';

// The network statement below has exactly one other copy, the README section "What this sends
// over the network". Change both together.
const HELP = `npx codex-usage-report [options]

Reads your Codex session logs in ~/.codex/sessions and
~/.codex/archived_sessions (or the same two directories under CODEX_HOME) and
prices the token usage at OpenAI API rates.

  --out PREFIX    output prefix          (default: codex-usage)
  --days N        rolling window length  (default: 7)
  --json          full aggregate to stdout, suppresses the table
  --offline       never touch the network, use bundled prices
  --help          this message

What this sends over the network

  It makes one unauthenticated GET request to raw.githubusercontent.com for
  the LiteLLM public price table.

  It sends no log contents, no file paths, no identifiers, and nothing about
  your account. The URL is a fixed constant with nothing interpolated into it.
  Passing --offline skips the request and uses the price table bundled with
  the package.

  If the request fails for any reason, the report says so and names the prices
  it used instead.
`;

export async function main(argv) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    process.stderr.write(`codex-usage-report: ${clean(error.message)}\n`
      + 'Run codex-usage-report --help to see the options.\n');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    await run(options);
  } catch (error) {
    process.stderr.write(`codex-usage-report: unexpected error: ${clean(withoutHome(error?.message ?? String(error)))}\n`);
    process.exitCode = 1;
  }
}

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        out: { type: 'string', default: 'codex-usage' },
        days: { type: 'string', default: '7' },
        json: { type: 'boolean', default: false },
        offline: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    // Node's advice about positional arguments does not apply, since this command takes none.
    const sentences = error.message.replace(/\s+/g, ' ').split(/(?<=[.?]) /);
    throw new Error(sentences.filter((sentence) => !sentence.includes('positional')).join(' '));
  }
  if (values.help) return values;
  if (!/^[1-9]\d*$/.test(values.days) || !Number.isSafeInteger(Number(values.days))) {
    throw new Error(`--days takes a positive whole number, not "${values.days}"`);
  }
  return { ...values, days: Number(values.days) };
}

async function run(options) {
  if (options.json) {
    process.stderr.write('codex-usage-report: --json is not implemented yet\n');
    process.exitCode = 1;
    return;
  }
  const { columns } = process.stdout;
  const counts = scanCounts();
  const files = await findRolloutFiles(resolveCodexHome(process.env), counts);
  if (!files.length) {
    process.stdout.write(renderNoSessions(whereItLooked(process.env), counts, { columns }));
    return;
  }
  const report = await aggregate(files, { days: options.days, counts });
  if (report.meta.usageRecordsRead === 0) {
    process.stdout.write(renderNoRecords(report.meta, { columns }));
    return;
  }
  const priced = applyPricing(report, await loadPrices({ offline: options.offline }));
  process.stdout.write(renderTerminal(priced, { columns }));
}

function whereItLooked(env) {
  if (!env.CODEX_HOME) return '~/.codex/sessions or ~/.codex/archived_sessions';
  return `sessions or archived_sessions under CODEX_HOME (${clean(withoutHome(env.CODEX_HOME))})`;
}

function withoutHome(text) {
  const home = homedir();
  return home.length > 1 ? text.split(home).join('~') : text;
}
