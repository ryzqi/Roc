import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { waitForAppReady } from '../../tests/smoke/lib/assertions.mjs';
import { sampleElectronProcesses } from './electron-metrics.mjs';
import { makeReport, readArguments, saveReport, sha256, summarizeRows } from './report-lib.mjs';
import { compareReports } from './compare-reports.mjs';

const options = readArguments('.artifacts/mac-performance/mac-readonly-query.json');
const receiptPath = resolve(process.env.ROC_PERF_QUERY_CORPUS_RECEIPT ??
  '.runtime/performance/pr12-measure-corpus/receipt.json');
const receipt = JSON.parse(readFileSync(receiptPath));
const scratch = mkdtempSync(join(resolve('.runtime/performance'), 'readonly-query-'));
const profiles = mkdtempSync(join(tmpdir(), 'roc-readonly-query-bench-'));
const bridge = join(scratch, 'bridge.cjs');
const sourceFiles = [
  'src/main/plugins/research/readonly-search-service.ts', 'src/main/plugins/research/knowledge-repository.ts',
  'src/main/workers/research-query-client.ts', 'src/main/workers/research-query-worker.ts',
  'tests/fixtures/performance/readonly-query-bridge.ts', 'dist/main/index.js', 'dist/main/research-query-worker.js'
];
const fixture = {
  corpusSha256: receipt.sourceSha256, chunks: receipt.chunkCount, pairs: options.samples,
  cacheKiB: 16384, query: 'topic7', queryVectorSha256: sha256(Buffer.from(receipt.queryBlob)),
  limit: 20, clock: '2026-11-06T00:00:00.000Z', order: 'AB/BA alternating',
  mainPath: 'optimized repository', workerPath: 'production readonly service and built Worker'
};
const reports = ['main', 'worker'].map(() => makeReport('production-readonly-query', fixture, sourceFiles));
for (const report of reports) report.host.sqlite = receipt.sqliteVersion;
const rows = { main: { cold: [], warm: [], small: [] }, worker: { cold: [], warm: [], small: [] } };
const expected = new Map();
let app;
try {
  await build({
    entryPoints: ['tests/fixtures/performance/readonly-query-bridge.ts'],
    outfile: bridge, bundle: true, platform: 'node', format: 'cjs',
    external: ['better-sqlite3', 'sqlite-vec'], logLevel: 'silent'
  });
  const { seedPerformanceProfiles } = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts', {
    platform: 'node', external: ['better-sqlite3'], tempDir: scratch
  });
  const roots = { empty: join(profiles, 'empty'), profile1000: join(profiles, '1000'), profile10000: join(profiles, '10000') };
  seedPerformanceProfiles(roots);
  app = await electron.launch({
    args: [`--user-data-dir=${join(profiles, 'chromium')}`, resolve('dist/main/index.js')],
    env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: roots.empty }
  });
  const page = await app.firstWindow();
  await waitForAppReady(page, 'readonly-query', resolve('.artifacts/mac-performance'));
  const paths = { bridge, corpus: receipt.path, small: join(roots.empty, 'plugin-data/data/plugins/@roc/plugin-research.db'),
    worker: resolve('dist/main/research-query-worker.js') };
  const input = { request: { query: 'topic7', projectId: null, limit: 20, embeddingConfigId: 'bench', rerank: 'none' },
    vector: { configId: 'bench', configRevision: 1, blob: receipt.queryBlob } };
  const smallInput = { request: { query: 'no-match', projectId: null, limit: 5, embeddingConfigId: null, rerank: 'none' }, vector: null };
  const processSamples = [];
  for (let pair = 0; pair < options.samples; pair++) {
    for (const mode of pair % 2 === 0 ? ['main', 'worker'] : ['worker', 'main']) {
      for (const dataset of ['large', 'small']) {
        await app.evaluate((_, { mode, paths, dataset }) => {
          const requireModule = process.getBuiltinModule('module').createRequire(paths.bridge);
          globalThis.__rocReadonlyBenchmark = requireModule(paths.bridge).createReadonlyQueryRunner(
            mode, dataset === 'large' ? paths.corpus : paths.small, paths.worker);
        }, { mode, paths, dataset });
        try {
          for (const phase of dataset === 'large' ? ['cold', 'warm'] : ['small']) {
            const before = await sampleElectronProcesses(app);
            const operation = app.evaluate(async (_, input) => {
              await new Promise(done => setTimeout(done, 10));
              const startedAt = Date.now(), at = performance.now(), cpuAt = process.cpuUsage();
              const timer = new Promise(done => setTimeout(() => done(performance.now() - at), 0));
              const result = await globalThis.__rocReadonlyBenchmark.query({
                ...input, vector: input.vector === null ? null : { ...input.vector, blob: Buffer.from(input.vector.blob) }
              });
              const totalMs = performance.now() - at, endedAt = Date.now(), timerDelayMs = await timer;
              const cpu = process.cpuUsage(cpuAt);
              return { ...result, totalMs, timerDelayMs, startedAt, endedAt,
                mainCpuMicros: cpu.user + cpu.system, mainRssBytes: process.memoryUsage.rss() };
            }, dataset === 'large' ? input : smallInput);
            const probe = page.evaluate(async () => {
              await new Promise(done => setTimeout(done, 30));
              const sentAt = Date.now(), at = performance.now();
              const result = await window.roc.app.getStatus();
              return { sentAt, ipcMs: performance.now() - at, ok: result.ok };
            });
            const [result, ipc] = await Promise.all([operation, probe]);
            assert.ok(ipc.ok);
            if (dataset === 'large') assert.ok(ipc.sentAt >= result.startedAt && ipc.sentAt <= result.endedAt, 'status_probe_must_overlap_query');
            const bytes = JSON.stringify(result.result), key = dataset;
            if (!expected.has(key)) expected.set(key, bytes);
            assert.equal(bytes, expected.get(key), 'complete_result_and_receipt_parity');
            const after = await sampleElectronProcesses(app);
            const { result: value, startedAt, endedAt, ...metrics } = result;
            const row = { ...metrics, ipcMs: ipc.ipcMs, resultBytes: Buffer.byteLength(bytes),
              beforeWorkingSetSumBytes: before.processes.reduce((sum, item) => sum + item.workingSetBytes, 0),
              afterWorkingSetSumBytes: after.processes.reduce((sum, item) => sum + item.workingSetBytes, 0) };
            rows[mode][phase].push(row);
            processSamples.push({ pair: pair + 1, mode, phase, before, after });
            console.log(JSON.stringify({ pair: pair + 1, mode, phase, ...row }));
          }
        } finally {
          await app.evaluate(async () => { await globalThis.__rocReadonlyBenchmark.close(); delete globalThis.__rocReadonlyBenchmark; });
        }
      }
    }
  }
  await app.evaluate((_, paths) => {
    const requireModule = process.getBuiltinModule('module').createRequire(paths.bridge);
    globalThis.__rocReadonlyBenchmark = requireModule(paths.bridge).createReadonlyQueryRunner('worker', paths.corpus, paths.worker);
  }, paths);
  await app.evaluate(async (_, input) => {
    await globalThis.__rocReadonlyBenchmark.query({ ...input, vector: { ...input.vector, blob: Buffer.from(input.vector.blob) } });
  }, input);
  const idle = [{ elapsedSeconds: 0, processes: await sampleElectronProcesses(app),
    worker: await app.evaluate(() => globalThis.__rocReadonlyBenchmark.snapshot()) }];
  for (const milliseconds of [15_000, 15_100]) {
    await page.waitForTimeout(milliseconds);
    idle.push({ elapsedSeconds: idle.length === 1 ? 15 : 30.1, processes: await sampleElectronProcesses(app),
      worker: await app.evaluate(() => globalThis.__rocReadonlyBenchmark.snapshot()) });
  }
  assert.equal(idle.at(-1).worker.workers, 0, 'idle_worker_must_exit');
  assert.equal(idle.at(-1).worker.starts, idle.at(-1).worker.exits);
  await app.evaluate(async () => { await globalThis.__rocReadonlyBenchmark.close(); delete globalThis.__rocReadonlyBenchmark; });
  for (const [index, mode] of ['main', 'worker'].entries()) {
    const report = reports[index];
    report.variant = mode;
    report.scenarios = Object.entries(rows[mode]).map(([id, samples]) => ({ id, samples, summary: summarizeRows(samples),
      outputSha256: sha256(expected.get(id === 'small' ? 'small' : 'large')) }));
    report.idle = idle;
    report.limitations.push(
      'Twenty paired cold/warm uses alternate variants in one isolated production Electron application; OS file caches and allocators remain shared.',
      'Cold includes first lazy Worker startup; warm retains the same connection and Worker. Main and Worker use the same 16MiB SQLite cache.',
      'Large status probes overlap actual queries; small probes measure ordinary status IPC after a bypassed small workload.',
      'Main CPU/RSS include the Node Worker thread; working-set sums include shared pages and are not exclusive physical footprint.',
      'Full search JSON, including ranking receipts and field order, is compared before every timing row is accepted.',
      'The small fixture is an empty production database and cannot characterize every workload below the 10000-chunk threshold.'
    );
    saveReport(options.outputPath.replace(/\.json$/u, `-${mode}.json`), report);
  }
  const comparison = compareReports(reports[0], reports[1], { reportOnly: ['workers', 'readyMs', 'validationMs'] });
  const output = makeReport('readonly-query-comparison', fixture, sourceFiles);
  output.comparison = comparison;
  output.idle = idle;
  output.rawProcessArtifact = options.outputPath.replace(/\.json$/u, '-processes.json');
  saveReport(output.rawProcessArtifact, { ...output, processSamples });
  saveReport(options.outputPath, output);
  console.log(JSON.stringify({ comparison: comparison.regressionCandidates, idleExit: idle.at(-1).worker }));
} finally {
  if (app) await app.close();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(profiles, { recursive: true, force: true });
}
