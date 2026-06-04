#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const logsPath = join(homedir(), '.roc', 'logs', 'app.jsonl');
const args = process.argv.slice(2);
const filters = {
  level: null,
  service: null,
  traceId: null,
  runId: null,
  since: null,
  grep: null
};

for (let index = 0; index < args.length; index += 2) {
  const option = args[index];
  const value = args[index + 1];
  if (option === undefined || !option.startsWith('--')) {
    throw new Error(`Invalid option: ${String(option)}`);
  }
  if (value === undefined) {
    throw new Error(`Missing value for ${option}.`);
  }
  const key = option.slice(2);
  if (!Object.prototype.hasOwnProperty.call(filters, key)) {
    throw new Error(`Unsupported filter: ${option}.`);
  }
  filters[key] = value;
}

const content = readFileSync(logsPath, 'utf8').trim();
const lines = content.length === 0 ? [] : content.split('\n');
const since = filters.since === null ? null : new Date(filters.since);

const filtered = lines
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((log) => log !== null)
  .filter((log) => {
    const timestamp = typeof log.timestamp === 'string' ? log.timestamp : log.createdAt;
    const message = typeof log.message === 'string' ? log.message : '';
    if (filters.level !== null && log.level !== filters.level) return false;
    if (filters.service !== null && log.service !== filters.service) return false;
    if (filters.traceId !== null && log.traceId !== filters.traceId) return false;
    if (filters.runId !== null && log.runId !== filters.runId) return false;
    if (since !== null && new Date(timestamp) < since) return false;
    if (filters.grep !== null && !message.includes(filters.grep)) return false;
    return true;
  });

console.log(`Found ${filtered.length} matching logs:\n`);
for (const log of filtered) {
  const timestamp = typeof log.timestamp === 'string' ? log.timestamp : log.createdAt;
  console.log(`[${timestamp}] ${String(log.level).toUpperCase()} ${log.message}`);
  if (log.service !== undefined) console.log(`  Service: ${log.service}`);
  if (log.traceId !== undefined) console.log(`  TraceID: ${log.traceId}`);
  if (log.runId !== undefined) console.log(`  RunID: ${log.runId}`);
  if (log.error !== undefined) console.log(`  Error: ${log.error.code} - ${log.error.message}`);
  console.log('');
}
