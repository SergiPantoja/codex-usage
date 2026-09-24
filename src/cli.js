import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregate } from './aggregate.js';
import { applyPricing, loadPrices } from './pricing.js';
import {
  clean, renderJson, renderMarkdown, renderNoRecords, renderNoSessions, renderSvg, renderTerminal, renderWarnings,
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
  const codexHome = resolveCodexHome(env);
  if (outputPaths(values.out).some(([path]) => isInside(resolve(path), codexHome))) {
    throw new Error('--out points inside the Codex directory, which this tool never writes to');
  }
  return { ...values, days };
}

// The paths stay as the user gave them, so the messages that echo them never show a resolved
// absolute path.
function outputPaths(out) {
  return [[`${out}.md`, renderMarkdown], [`${out}.svg`, renderSvg]];
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

  const written = [];
  let failure = null;
  for (const [path, render] of outputPaths(options.out)) {
    const content = render(priced);
    try {
      await writeFile(path, content);
    } catch (error) {
      failure = `could not write ${clean(withoutHome(path))}, ${WRITE_ERRORS[error.code] ?? error.code ?? 'unknown error'}`;
      break;
    }
    written.push(path);
  }
  if (written.length) say.write(`${options.json ? '' : '\n'}wrote ${written.map((path) => clean(withoutHome(path))).join(' and ')}\n`);
  if (failure) {
    process.stderr.write(`codex-usage-report: ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  if (!options.json) openImage(written.find((path) => path.endsWith('.svg')), process.env);
}

// Only a person at this machine's own screen wants a window. Over SSH the image would open on a
// screen nobody is looking at, and a Linux machine with no display has nothing to show it on.
function openImage(path, env) {
  if (!process.stdout.isTTY || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return;
  const file = resolve(path);
  let command;
  if (process.platform === 'darwin') command = ['open', [file]];
  else if (process.platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) command = ['xdg-open', [file]];
  // start is a cmd.exe builtin, not a program, and it takes a first quoted argument as the window
  // title, hence the empty one. Verbatim arguments keep Node from quoting that "" again.
  else if (process.platform === 'win32') {
    command = ['cmd', ['/c', 'start', '""', `"${file}"`], { windowsVerbatimArguments: true, windowsHide: true }];
  } else return;
  const [program, args, options] = command;
  try {
    const child = spawn(program, args, { ...options, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // A missing or failing opener is not worth a message. The report and the files are done.
  }
}

function whereItLooked(env) {
  if (!env.CODEX_HOME) return '~/.codex/sessions or ~/.codex/archived_sessions';
  return `sessions or archived_sessions under CODEX_HOME (${clean(withoutHome(env.CODEX_HOME))})`;
}

function withoutHome(text) {
  const home = homedir();
  return home.length > 1 ? text.split(home).join('~') : text;
}
