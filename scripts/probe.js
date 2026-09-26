'use strict';
// Prints the shape of the Codex session logs on this machine.
//
//   node probe.js

main().catch((error) => {
  // A message or a stack trace would name paths on this machine, so only the code is printed.
  console.error(`probe failed: ${error?.code ?? error?.name ?? 'unknown error'}`);
  process.exitCode = 1;
});

async function main() {
  const { createReadStream, readdirSync } = await import('node:fs');
  const { once } = await import('node:events');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { createInterface } = await import('node:readline');

  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const seen = Object.fromEntries([
    'codex_versions', 'originators', 'sources', 'models', 'efforts', 'plan_types', 'rate_limit_keys',
    'rate_limit_windows', 'limit_ids', 'context_windows', 'service_tiers', 'usage_field_names',
  ].map((key) => [key, new Set()]));
  const note = (key, value) => seen[key].add(scalar(value));
  const counts = {
    files: 0, usage_records: 0, cache_write_nonzero: 0, orphans: 0, max_input_tokens: 0, malformed_lines: 0,
    files_without_usage_records: 0, files_with_uncounted_usage: 0, unreadable_dirs: 0, unreadable_files: 0,
  };
  let latest = { at: '', client: undefined };

  // The same rules as the report's src/scan.js: both roots, no symlinks followed, and a root that
  // does not exist is not an error.
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') counts.unreadable_dirs++;
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  walk(join(codexHome, 'sessions'));
  walk(join(codexHome, 'archived_sessions'));

  for (const file of files.sort()) {
    counts.files++;
    const turnModels = new Map();
    const usageRecords = [];
    let uncounted = false;
    const input = createReadStream(file);
    try {
      await once(input, 'open');
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        const record = parseRecord(line);
        if (!record) {
          counts.malformed_lines++;
          continue;
        }
        const payload = record.payload ?? {};
        if (record.type === 'session_meta') {
          note('codex_versions', payload.cli_version);
          note('originators', payload.originator);
          note('sources', sourceShape(payload.source));
          // The newest session names the client in use now. Its timestamp is compared, never printed.
          if (payload.cli_version && (record.timestamp ?? '') >= latest.at) {
            const client = `${scalar(payload.originator) ?? 'unknown'} ${scalar(payload.cli_version)}`;
            latest = { at: record.timestamp ?? '', client };
          }
        } else if (record.type === 'turn_context') {
          turnModels.set(payload.turn_id, payload.model);
          note('models', payload.model);
          note('efforts', payload.effort);
        } else if (record.type === 'token_usage_record') {
          usageRecords.push(payload);
        } else if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
          note('service_tiers', payload.thread_settings?.service_tier);
        } else if (record.type === 'event_msg' && payload.type === 'token_count') {
          // Usage before the file's first token_usage_record comes from Codex 0.152 and earlier,
          // or from a thread's turns before an upgrade. The report leaves it out, by this rule.
          if (!usageRecords.length && payload.info?.last_token_usage?.input_tokens > 0) uncounted = true;
          const limits = payload.rate_limits;
          if (limits) {
            note('plan_types', limits.plan_type);
            for (const key of Object.keys(limits)) note('rate_limit_keys', key);
            for (const window of ['primary', 'secondary']) {
              const minutes = scalar(limits[window]?.window_minutes);
              if (minutes) note('rate_limit_windows', `${window}:${minutes}m`);
            }
            if (limits.limit_id) note('limit_ids', limits.limit_id);
          }
          if (payload.info?.model_context_window) note('context_windows', payload.info.model_context_window);
        }
      }
    } catch {
      counts.unreadable_files++;
    } finally {
      input.destroy();
    }

    if (!usageRecords.length) counts.files_without_usage_records++;
    if (uncounted) counts.files_with_uncounted_usage++;
    usageRecords.forEach((payload, index) => {
      counts.usage_records++;
      const usage = payload.usage ?? {};
      if (usage.cache_write_input_tokens > 0) counts.cache_write_nonzero++;
      if (Number.isFinite(usage.input_tokens)) counts.max_input_tokens = Math.max(counts.max_input_tokens, usage.input_tokens);
      if (!turnModels.has(payload.turn_id) && !turnModels.has(payload.root_turn_id)) counts.orphans++;
      if (index === 0) note('usage_field_names', Object.keys(usage).sort().join(','));
    });
  }

  let archivedDirExists = false;
  let archivedIsFlat = false;
  try {
    const entries = readdirSync(join(codexHome, 'archived_sessions'), { withFileTypes: true });
    archivedDirExists = true;
    archivedIsFlat = entries.every((entry) => !entry.isDirectory());
  } catch (error) {
    archivedDirExists = error.code !== 'ENOENT';
  }

  const sorted = (set) => [...set].filter((value) => value !== undefined).sort();
  console.log(JSON.stringify({
    ...Object.fromEntries(Object.entries(seen).map(([key, set]) => [key, sorted(set)])),
    ...counts,
    archived_dir_exists: archivedDirExists,
    archived_is_flat: archivedIsFlat,
    latest_codex_client: latest.client,
  }, null, 2));
}

function parseRecord(line) {
  try {
    const value = JSON.parse(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  return undefined;
}

function scalar(value) {
  if (value === undefined || value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return Array.isArray(value) ? '<array>' : '<object>';
}

function sourceShape(source) {
  if (source === undefined) return undefined;
  if (typeof source === 'string') return source;
  return `<object:${Object.keys(source ?? {}).sort().join('|')}>`;
}
