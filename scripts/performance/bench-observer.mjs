import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { makeReport, readArguments, saveReport, summarizeRows } from './report-lib.mjs';

const { PerformanceObserverService } = await importTypeScriptModule('src/main/services/performance-observer-service.ts', { platform: 'node' });
const { observeDatabase } = await importTypeScriptModule('src/main/infrastructure/observe-database.ts', { platform: 'node' });
const options = readArguments('.artifacts/mac-performance/observer.json');
const fixture = { rows: 10000, rowsPerQuery: 100, queriesPerSample: 200, responseBytes: 20000, sqlSampleEvery: 64 };
const report = makeReport('observer-overhead', fixture, [
  'src/main/services/performance-observer-service.ts', 'src/main/infrastructure/observe-database.ts'
]);
const databases = [new Database(':memory:'), new Database(':memory:')];
const observer = new PerformanceObserverService();
try {
  for (const db of databases) {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, payload TEXT)');
    const insert = db.prepare('INSERT INTO items VALUES (?, ?)');
    db.transaction(() => { for (let id = 0; id < fixture.rows; id++) insert.run(id, JSON.stringify({ id, value: `fixture-${id}` })); })();
  }
  observeDatabase(databases[1], 'fixture', observer);
  const statements = databases.map(db => db.prepare('SELECT id, payload FROM items WHERE id >= ? AND id < ? ORDER BY id'));
  const samples = [[], []];
  let checksum = 0;
  const response = { body: 'x'.repeat(fixture.responseBytes) };
  // Alternate order so a single warm-up or temperature trend does not favor instrumentation.
  for (let sample = -2; sample < options.samples; sample++) {
    for (const index of sample % 2 === 0 ? [0, 1] : [1, 0]) {
      const started = performance.now();
      for (let query = 0; query < fixture.queriesPerSample; query++) {
        const offset = query % 90 * 100;
        const rows = statements[index].all(offset, offset + fixture.rowsPerQuery);
        for (const row of rows) checksum += JSON.parse(row.payload).id;
        if (index === 1) observer.sampleIpcResponse(response);
      }
      if (sample >= 0) samples[index].push({ durationMs: performance.now() - started, rssBytes: process.memoryUsage().rss });
    }
  }
  report.scenarios = samples.map((values, index) => ({
    id: index === 0 ? 'unobserved' : 'observed', samples: values, summary: summarizeRows(values)
  }));
  const snapshot = observer.getSnapshot();
  assert.ok(snapshot.samples.length <= 500 && snapshot.sql.length <= 128);
  assert.equal(snapshot.sql[0].calls, (options.samples + 2) * fixture.queriesPerSample);
  report.observer = { retainedSamples: snapshot.samples.length, retainedTemplates: snapshot.sql.length,
    calls: snapshot.sql[0].calls, sampledCalls: snapshot.sql[0].sampledCalls, checksum,
    p95OverheadPercent: (report.scenarios[1].summary.durationMs.p95 / report.scenarios[0].summary.durationMs.p95 - 1) * 100 };
  report.limitations.push('Same-process alternating paired workload. RSS includes both fixture databases and is not per-observer footprint.',
    'SQL calls count executed methods; iterate counts native cursor steps. Timing is sampled every 64 calls.',
    'IPC size/encode time is sampled V8 serialization of a 20kB response, not Chromium wire bytes or actual transport time.');
  saveReport(options.outputPath, report);
  console.log(JSON.stringify(report.observer));
} finally { for (const db of databases) db.close(); }
