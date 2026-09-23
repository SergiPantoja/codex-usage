import { createReadStream } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Same rule as Codex's find_codex_home: an empty value counts as unset, `~` is not expanded,
// and a set value is never replaced by ~/.codex, even if it does not exist.
export function resolveCodexHome(env = process.env) {
  return env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex');
}

export function scanCounts() {
  return { dirsFailed: 0, filesFailed: 0, malformedTrailing: 0, malformedMidFile: 0 };
}

export async function findRolloutFiles(codexHome, counts = scanCounts()) {
  const files = [];
  // Archiving a session moves its file out of sessions/, so both roots are required.
  for (const root of ['sessions', 'archived_sessions']) {
    await walk(join(codexHome, root), files, counts);
  }
  return files.sort();
}

async function walk(dir, files, counts) {
  let entries;
  try {
    entries = await opendir(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') counts.dirsFailed++;
    return;
  }
  try {
    for await (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, files, counts);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  } catch {
    counts.dirsFailed++;
  }
}

export async function* readRecords(file, counts = scanCounts()) {
  const input = createReadStream(file);
  try {
    await once(input, 'open');
  } catch {
    counts.filesFailed++;
    return;
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  let previousMalformed = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (previousMalformed) {
        counts.malformedMidFile++;
        previousMalformed = false;
      }
      const record = parseRecord(line);
      if (record) yield record;
      else previousMalformed = true;
    }
    if (previousMalformed) counts.malformedTrailing++;
  } catch {
    counts.filesFailed++;
  } finally {
    input.destroy();
  }
}

function parseRecord(line) {
  try {
    const value = JSON.parse(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  return undefined;
}
