import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregate } from './aggregate.js';
import { applyPricing, loadPrices } from './pricing.js';
import {
  clean, renderJson, renderMarkdown, renderNoRecords, renderNoSessions, renderTerminal, renderWarnings,
} from './render.js';
import { findRolloutFiles, resolveCodexHome, scanCounts } from './scan.js';

// The network statement below has exactly one other copy, the README section "What this sends
// over the network". Change both together.
const HELP = `npx codex-usage-report [options]

Reads your Codex session logs in ~/.codex/sessions and
~/.codex/archived_sessions (or the same two directories under CODEX_HOME) and
prices the token usage at OpenAI API rates.

  --out PREFIX    output prefix          (default: codex-usage)
  --days N        window, 1 to 365 days  (default: 7)
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
const MAX_DAYS = 365;
const WRITE_ERRORS = {
  ENOENT: 'its directory does not exist',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EISDIR: 'a directory has that name',
  EROFS: 'the file system is read-only',
  ENOSPC: 'the disk is full',
};

export async function main(argv) {
  // A reader that stops early, such as head, closes the pipe. That is not a failure, and the
  // report file still has to be written.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
      if (error.code !== 'EPIPE') throw error;
    });
  }
  let options;
  try {
    options = parseOptions(argv, process.env);
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

function parseOptions(argv, env) {
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
  const days = /^[1-9]\d*$/.test(values.days) ? Number(values.days) : NaN;
  if (!(days <= MAX_DAYS)) throw new Error(`--days takes a whole number from 1 to ${MAX_DAYS}, not "${values.days}"`);
  if (!values.out || /[\\/]$/.test(values.out)) throw new Error(`--out takes a file name prefix, not "${withoutHome(values.out)}"`);
  if (isInside(resolve(markdownPath(values.out)), resolveCodexHome(env))) {
    throw new Error('--out points inside the Codex directory, which this tool never writes to');
  }
  return { ...values, days };
}

// The path stays as the user gave it, so the message that echoes it never shows a resolved
// absolute path.
function markdownPath(out) {
  return `${out}.md`;
}

// macOS and Windows usually ignore case in paths, so compare without it there.
function isInside(path, dir) {
  const fold = (text) => (process.platform === 'linux' ? text : text.toLowerCase());
  const rest = relative(fold(dir), fold(path));
  return rest !== '' && rest.split(sep)[0] !== '..' && !isAbsolute(rest);
}

async function run(options) {
  // Under --json, stdout carries only the JSON, so every message for people goes to stderr.
  const say = options.json ? process.stderr : process.stdout;
  const { columns } = say;
  const counts = scanCounts();
  const files = await findRolloutFiles(resolveCodexHome(process.env), counts);
  if (!files.length) {
    say.write(renderNoSessions(whereItLooked(process.env), counts, { columns }));
    return;
  }
  const report = await aggregate(files, { days: options.days, counts });
  if (report.meta.usageRecordsRead === 0) {
    say.write(renderNoRecords(report.meta, { columns }));
    return;
  }
  const priced = applyPricing(report, await loadPrices({ offline: options.offline }));
  if (options.json) {
    process.stdout.write(renderJson(priced));
    say.write(renderWarnings(priced, { columns }));
  } else {
    say.write(renderTerminal(priced, { columns }));
  }

  const path = markdownPath(options.out);
  const shown = clean(withoutHome(path));
  try {
    await writeFile(path, renderMarkdown(priced));
  } catch (error) {
    const reason = WRITE_ERRORS[error.code] ?? error.code ?? 'unknown error';
    process.stderr.write(`codex-usage-report: could not write ${shown}, ${reason}\n`);
    process.exitCode = 1;
    return;
  }
  say.write(`${options.json ? '' : '\n'}wrote ${shown}\n`);
}

function whereItLooked(env) {
  if (!env.CODEX_HOME) return '~/.codex/sessions or ~/.codex/archived_sessions';
  return `sessions or archived_sessions under CODEX_HOME (${clean(withoutHome(env.CODEX_HOME))})`;
}

function withoutHome(text) {
  const home = homedir();
  return home.length > 1 ? text.split(home).join('~') : text;
}
