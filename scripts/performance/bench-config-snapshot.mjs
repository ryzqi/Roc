import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { waitForAppReady } from '../../tests/smoke/lib/assertions.mjs';
import { makeReport, saveReport, sha256, summarizeRows } from './report-lib.mjs';
import { sampleElectronProcesses } from './electron-metrics.mjs';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const root = mkdtempSync(join(tmpdir(), 'roc-config-main-'));
const output = process.argv[2] ?? '.artifacts/mac-performance/mac-config-main.json';
const files = ['src/main/services/config-service.ts', 'tests/fixtures/performance/legacy-config-service.ts',
  'scripts/performance/bench-config-snapshot.mjs'];
const report = makeReport('config-snapshot-electron-main', { iterations: 100, pairs: 20,
  corpusSha256: sha256(readFileSync('src/main/services/config/defaults.ts')) }, files);
let app;
try {
  const modules = {};
  for (const [mode, file] of [['before', files[1]], ['after', files[0]]]) {
    const outfile = join(root, `${mode}.cjs`);
    await build({ stdin: { contents: readFileSync(file, 'utf8'), resolveDir: resolve('src/main/services'), loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile, logLevel: 'silent' });
    modules[mode] = outfile;
  }
  const { seedPerformanceProfiles } = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts',
    { platform: 'node', external: ['better-sqlite3'], tempDir: resolve('.runtime/performance') });
  const dataRoot = join(root, 'profile');
  seedPerformanceProfiles({ empty: dataRoot, profile1000: join(root, 'unused-1000'), profile10000: join(root, 'unused-10000') });
  app = await electron.launch({ args: [`--user-data-dir=${join(root, 'chromium')}`, resolve('dist/main/index.js')],
    env: { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot } });
  const page = await app.firstWindow();
  await waitForAppReady(page, 'config-main', resolve('.artifacts/mac-performance'));
  const result = await app.evaluate(async (_, { root, modules }) => {
    const { mkdirSync } = process.getBuiltinModule('fs');
    const { join } = process.getBuiltinModule('path');
    const requireModule = process.getBuiltinModule('module').createRequire(join(root, 'benchmark.cjs'));
    const services = {}, rows = { before: [], after: [] };
    for (const mode of ['before', 'after']) {
      const paths = { configDir: join(root, mode, 'config'), rtkDir: join(root, mode, 'rtk') };
      mkdirSync(paths.configDir, { recursive: true }); mkdirSync(paths.rtkDir, { recursive: true });
      const { ConfigService } = requireModule(modules[mode]);
      services[mode] = new ConfigService(paths); services[mode].initialize();
    }
    let beforeResult, afterResult;
    for (let pair = 0; pair < 20; pair++) for (const mode of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
      const config = services[mode], started = performance.now(), cpuStart = process.cpuUsage();
      const probe = new Promise(done => setTimeout(() => done(performance.now() - started), 0));
      for (let index = 0; index < 100; index++) {
        const document = config.reloadSettingsDocument();
        config.getSettings(); config.getPermissions(); config.getProviders();
        if (mode === 'before') beforeResult = document; else afterResult = document;
      }
      const workMs = performance.now() - started, cpu = process.cpuUsage(cpuStart);
      const eventLoopProbeMs = await probe;
      rows[mode].push({ workMs, eventLoopProbeMs, cpuMicros: cpu.user + cpu.system, ...process.memoryUsage() });
    }
    return { rows, beforeResult, afterResult };
  }, { root, modules });
  assert.deepEqual(result.beforeResult, result.afterResult);
  report.scenarios = Object.entries(result.rows).map(([id, samples]) => ({ id, samples, summary: summarizeRows(samples) }));
  report.processSample = await sampleElectronProcesses(app);
  report.limitations.push('Actual Electron Main runs frozen/current ConfigService on isolated settings in alternating pairs.',
    'Timer probes include operating-system scheduling; this is bounded workload delay, not a percentile of all production IPC.',
    'Memory snapshots include the running application and both test services; they do not measure exclusive footprint or operation allocation peaks.');
  saveReport(output, report);
} finally {
  if (app) await app.close();
  rmSync(root, { recursive: true, force: true });
}
