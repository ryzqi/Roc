import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { waitForAppReady } from '../../tests/smoke/lib/assertions.mjs';
import { sampleElectronProcesses } from './electron-metrics.mjs';
import { makeReport, readArguments, saveReport, sha256, summarizeRows } from './report-lib.mjs';

const options = readArguments('.artifacts/mac-performance/mac-schema-hash.json');
const baseline = 'f1a4e638';
const scratch = mkdtempSync(join(resolve('.runtime/performance'), 'schema-hash-'));
const profiles = mkdtempSync(join(tmpdir(), 'roc-schema-hash-'));
const files = ['src/main/plugins/research/document-capabilities.ts', 'src/main/plugins/research/knowledge-repository.ts'];
const fixture = { pairs: options.samples, order: 'AB/BA alternating', iterations: 1000,
  documentIds: Array.from({length: 500}, (_, index) => `synthetic-document-${index}`),
  request: {id: 'benchmark-document', projectId: null, sourceType: 'file', sourceId: 'generated.md',
    title: 'Synthetic selected excerpts', content: 'controlled synthetic document body '.repeat(31_000),
    embeddingConfigId: null,
    chunks: Array.from({length: 100}, (_, index) => ({
      content: `Synthetic evidence excerpt ${index}, original data are generated and reproducible.`, locator: `block:${index}`
    }))} };
const reportFixture = {...fixture, request: {...fixture.request, content: undefined},
  documentBodyBytes: Buffer.byteLength(fixture.request.content), documentBodySha256: sha256(fixture.request.content)};
const report = makeReport('schema-hash-electron-main', reportFixture,
  [...files, 'src/main/kernel/capability-registry.ts', 'src/main/plugins/research/capability-provider.ts',
    'tests/fixtures/performance/schema-hash-bridge.ts', 'scripts/performance/bench-schema-hash.mjs', 'dist/main/index.js']);
report.baseline = { gitSha: baseline, sourceHashes: {} };
let app;
try {
  const modules = {};
  for (const mode of ['before', 'after']) {
    modules[mode] = join(scratch, `${mode}.cjs`);
    const frozen = mode === 'before' ? new Map(files.map(path => {
      const source = execFileSync('git', ['show', `${baseline}:${path}`], {encoding: 'utf8'});
      report.baseline.sourceHashes[path] = sha256(source);
      return [resolve(path), source];
    })) : new Map();
    await build({
      entryPoints: ['tests/fixtures/performance/schema-hash-bridge.ts'], outfile: modules[mode],
      bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'],
      logLevel: 'silent',
      plugins: [{name: 'frozen-boundaries', setup(builder) {
        builder.onLoad({filter: /(?:document-capabilities|knowledge-repository)\.ts$/}, args =>
          frozen.has(args.path) ? {contents: frozen.get(args.path), loader: 'ts'} : null);
      }}]
    });
  }
  const { seedPerformanceProfiles } = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts', {
    platform: 'node', external: ['better-sqlite3'], tempDir: scratch
  });
  const roots = {empty: join(profiles, 'empty'), profile1000: join(profiles, '1000'), profile10000: join(profiles, '10000')};
  seedPerformanceProfiles(roots);
  app = await electron.launch({args: [`--user-data-dir=${join(profiles, 'chromium')}`, resolve('dist/main/index.js')],
    env: {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: roots.empty}});
  await waitForAppReady(await app.firstWindow(), 'schema-hash', resolve('.artifacts/mac-performance'));
  const result = await app.evaluate(async (_, {modules, scratch, fixture}) => {
    const requireModule = process.getBuiltinModule('module').createRequire(modules.after);
    const runners = Object.fromEntries(Object.entries(modules).map(([mode, path]) => {
      const api = requireModule(path);
      return [mode, {schema: api.createSchemaRunner(), hash: api.createHashRunner(`${scratch}/${mode}.sqlite`, fixture.request)}];
    }));
    const rows = {before: {small: [], large: [], hash: []}, after: {small: [], large: [], hash: []}};
    try {
      for (const mode of ['before', 'after']) { await runners[mode].schema.run(100, fixture.documentIds); runners[mode].hash.run(); }
      for (let pair = 0; pair < fixture.pairs; pair++) for (const mode of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        for (const scene of ['small', 'large', 'hash']) {
          const at = performance.now(), cpuAt = process.cpuUsage();
          const timer = new Promise(done => setTimeout(() => done(performance.now() - at), 0));
          const result = scene === 'hash' ? runners[mode].hash.run() :
            await runners[mode].schema.run(fixture.iterations, scene === 'small' ? null : fixture.documentIds);
          const totalMs = performance.now() - at, cpu = process.cpuUsage(cpuAt), timerDelayMs = await timer;
          rows[mode][scene].push({totalMs, timerDelayMs, cpuMicros: cpu.user + cpu.system,
            mainRssBytes: process.memoryUsage.rss(), ...result});
        }
      }
      return rows;
    } finally { for (const runner of Object.values(runners)) { runner.schema.close(); runner.hash.close(); } }
  }, {modules, scratch, fixture});
  for (let pair = 0; pair < fixture.pairs; pair++) {
    assert.equal(result.before.hash[pair].outputSha256, result.after.hash[pair].outputSha256);
    assert.equal(result.before.hash[pair].documentHashCalls, 101);
    assert.equal(result.after.hash[pair].documentHashCalls, 1);
    for (const scene of ['small', 'large']) {
      assert.equal(result.before[scene][pair].parses, fixture.iterations * 2);
      assert.equal(result.after[scene][pair].parses, fixture.iterations);
      assert.equal(result.before[scene][pair].handled, fixture.iterations);
      assert.equal(result.after[scene][pair].handled, fixture.iterations);
    }
  }
  report.scenarios = Object.entries(result).flatMap(([mode, scenes]) => Object.entries(scenes)
    .map(([scene, samples]) => ({id: `${mode}/${scene}`, samples, summary: summarizeRows(samples)})));
  report.processSample = await sampleElectronProcesses(app);
  report.limitations.push(
    'Same real Electron Main, production Registry/document wrapper/request schema; batch domain handler is a bounded no-effect stub.',
    'Real native SQLite/WAL publication transactions on separate isolated databases; every persisted document/chunk/structure/semantic output hash is identical.',
    'Timing includes output snapshot hashing, common to both variants; instrumentation counts actual native SHA update calls and input bytes.',
    'Main RSS snapshots include the application, both loaded variants and OS allocator retention; they are not exclusive footprint or per-operation peaks.',
    'Ready registration is measured; first lazy initialization deliberately retains its post-await validation and is covered separately by regression tests.'
  );
  console.log(saveReport(options.outputPath, report));
} finally {
  if (app) await app.close();
  rmSync(scratch, {recursive: true, force: true});
  rmSync(profiles, {recursive: true, force: true});
}
