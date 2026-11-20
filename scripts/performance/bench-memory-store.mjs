import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { makeReport, protocol, readArguments, saveReport, sha256, summarizeRows } from './report-lib.mjs';

const worker = process.argv[2] === '--worker';
const options = worker ? null : readArguments('.artifacts/mac-performance/memory-before.json');

async function measureScale(count, samples) {
  const [{ RocSqliteStore }, { applyMemoryDatabaseSchema }] = await Promise.all([
    importTypeScriptModule('src/main/services/memory/sqlite-store.ts', { platform: 'node',
      external: ['@langchain/langgraph/store'], tempDir: resolve('.runtime/performance') }),
    importTypeScriptModule('src/main/infrastructure/database-schemas.ts', { platform: 'node',
      external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') })
  ]);
  const root = mkdtempSync(join(tmpdir(), 'roc-memory-performance-'));
  const db = new Database(join(root, 'memory.sqlite'));
  try {
    applyMemoryDatabaseSchema(db);
    const insert = db.prepare(`INSERT INTO langgraph_store_items VALUES (?, ?, ?, ?, ?, ?)`);
    const digest = [];
    const now = '2026-11-14T00:00:00.000Z';
    db.transaction(() => {
      for (let index = 0; index < count; index++) {
        const namespace = ['project', `p${String(index % protocol.memory.namespaces).padStart(4, '0')}`, '记忆'];
        const value = JSON.stringify({ text: `evidence ${index} 机器学习`, number: index, nested: { b: 2, a: 1 } });
        insert.run(namespace.join('\x1f'), JSON.stringify(namespace), String(index).padStart(8, '0'), value, now, now);
        if (index < 10 || index === count - 1) digest.push([namespace, value]);
      }
    })();
    const store = new RocSqliteStore(db);
    const scenes = [];
    for (const [id, action] of [
      ['prefix', () => store.search(['project', 'p0007'], { limit: protocol.memory.limit })],
      ['filtered-prefix', () => store.search(['project', 'p0007'], { filter: { number: { $gte: count / 2 } }, limit: protocol.memory.limit })],
      ['namespaces', () => store.listNamespaces({ prefix: ['project', 'p0007'], limit: protocol.memory.limit })]
    ]) {
      const rows = [], outputHashes = new Set();
      for (let iteration = 0; iteration < samples; iteration++) {
        const cpu = process.cpuUsage(), start = performance.now();
        const result = await action();
        const durationMs = performance.now() - start, used = process.cpuUsage(cpu), memory = process.memoryUsage();
        if (id !== 'namespaces') assert.ok(result.every(item => item.namespace[1] === 'p0007'));
        outputHashes.add(sha256(JSON.stringify(result)));
        rows.push({ durationMs, cpuUserMicros: used.user, cpuSystemMicros: used.system, rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers });
      }
      assert.equal(outputHashes.size, 1, 'memory_output_changed_between_samples');
      scenes.push({ id: `${count}/${id}`, outputSha256: [...outputHashes][0], summary: summarizeRows(rows), samples: rows });
    }
    return { count, fixtureSha256: sha256(JSON.stringify(digest)), sqlite: db.prepare('SELECT sqlite_version()').pluck().get(),
      indexes: db.prepare("PRAGMA index_list('langgraph_store_items')").all(),
      prefixQueryPlan: db.prepare(`EXPLAIN QUERY PLAN SELECT key FROM langgraph_store_items
        WHERE namespace_key = ? OR (namespace_key >= ? AND namespace_key < ?) ORDER BY namespace_key, key`)
        .all('project\x1fp0007', 'project\x1fp0007\x1f', 'project\x1fp0007\x20'),
      peakRssBytes: process.resourceUsage().maxRSS * 1024, scenarios: scenes };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (worker) {
  console.log(JSON.stringify(await measureScale(Number(process.argv[3]), Number(process.argv[4]))));
} else {
  const report = makeReport('memory-store', { ...protocol.memory, samples: options.samples, seed: protocol.seed },
    ['src/main/services/memory/sqlite-store.ts', 'src/main/infrastructure/database-schemas.ts']);
  report.scales = [];
  for (const count of protocol.memory.scales) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', String(count), String(options.samples)],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false });
    if (result.status !== 0) {
      throw new Error(`memory_benchmark_failed:${count}:${result.stderr.replace(/data:text\/javascript;base64,[^\s]+/gu, '[benchmark bundle]')}`);
    }
    const scale = JSON.parse(result.stdout);
    report.host.sqlite = scale.sqlite;
    report.scales.push({ ...scale, scenarios: undefined });
    report.scenarios.push(...scale.scenarios);
    saveReport(options.outputPath, report);
    console.log(JSON.stringify({ count, summary: scale.scenarios.map(scene => ({ id: scene.id, durationMs: scene.summary.durationMs })) }));
  }
  report.limitations.push('Whole-worker peak RSS includes seeding, imports and SQLite cache. Each scale uses a new child/profile.');
  saveReport(options.outputPath, report);
}
