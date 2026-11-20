import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { makeReport, saveReport, sha256, summarizeRows } from '../../scripts/performance/report-lib.mjs';

const { ConfigService: Current } = await importTypeScriptModule('src/main/services/config-service.ts', { platform: 'node' });
const frozen = await build({ stdin: { contents: fs.readFileSync('tests/fixtures/performance/legacy-config-service.ts', 'utf8'),
  resolveDir: resolve('src/main/services'), loader: 'ts' }, bundle: true, platform: 'node',
  format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
const { ConfigService: Legacy } = await import(`data:text/javascript;base64,${Buffer.from(frozen.outputFiles[0].text).toString('base64')}`);
function fixture(Constructor = Current) {
  const root = fs.mkdtempSync(join(tmpdir(), 'roc-config-snapshot-'));
  const paths = { configDir: join(root, 'config'), rtkDir: join(root, 'rtk') };
  fs.mkdirSync(paths.configDir); fs.mkdirSync(paths.rtkDir);
  const config = new Constructor(paths); config.initialize();
  return { config, paths, file: join(paths.configDir, 'settings.json'), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const provider = id => ({ id, name: id, type: 'openai_compatible', endpoint: 'https://fixture.invalid/v1',
  credentialRef: null, enabled: true, models: [{ id: 'model', displayName: 'model', enabled: true,
    supportsStreaming: true, supportsToolCalls: true, supportsImages: false }] });
function restoreMocks() { mock.restoreAll(); syncBuiltinESMExports(); }

test('concurrent field updates and provider upserts preserve every submitted change', async () => {
  const { config, file, close } = fixture();
  try {
    const settings = config.getSettings(); settings.startup.openAtLogin = true;
    const permissions = config.getPermissions(); permissions.mode = 'default';
    await Promise.all([config.saveSettingsAsync(settings), config.savePermissionsAsync(permissions),
      config.upsertProviderAsync(provider('one')), config.upsertProviderAsync(provider('two'))]);
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(document.settings.startup.openAtLogin, true);
    assert.equal(document.permissions.mode, 'default');
    assert.deepEqual(document.providers.providers.map(value => value.id), ['one', 'two']);
    assert.deepEqual(config.reloadSettingsDocument(), document);
  } finally { close(); }
});

test('snapshots remain immutable internally and caller-owned; explicit boundaries see external changes immediately', async () => {
  const { config, file, close } = fixture();
  try {
    const initial = config.reloadSettingsDocument(), revision = config.settingsDocumentRevision;
    const owned = config.getSettings(); owned.memory.charLimits.user = 42;
    assert.deepEqual(config.getSettings(), initial.settings);
    assert.equal(Object.isFrozen(config.settingsDocumentCache.settings.memory.charLimits), true);
    assert.equal(config.settingsDocumentRevision, revision);
    const changed = structuredClone(initial); changed.permissions.mode = 'default'; changed.settings.startup.openAtLogin = true;
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.deepEqual(config.reloadSettingsDocument(), changed);
    assert.notEqual(config.settingsDocumentRevision, revision);
    assert.deepEqual(await config.getSettingsAsync(), changed.settings);
    fs.writeFileSync(file, '{invalid');
    assert.throws(() => config.reloadSettingsDocument(), SyntaxError);
    assert.throws(() => config.getSettings(), SyntaxError);
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.deepEqual(config.reloadSettingsDocument(), changed);
  } finally { close(); }
});

test('ordinary reads keep the existing five-second visibility bound without re-parsing unchanged files', () => {
  const { config, file, close } = fixture();
  const read = fs.readFileSync; let reads = 0, time = Date.now();
  try {
    const original = config.getSettings(), document = config.reloadSettingsDocument();
    document.settings.startup.openAtLogin = true; fs.writeFileSync(file, JSON.stringify(document));
    mock.method(Date, 'now', () => time);
    mock.method(fs, 'readFileSync', (...args) => { if (args[0] === file) reads++; return read(...args); });
    syncBuiltinESMExports();
    assert.deepEqual(config.getSettings(), original); assert.equal(reads, 0);
    time += 5001; assert.equal(config.getSettings().startup.openAtLogin, true); assert.equal(reads, 1);
    time += 5001; config.getSettings(); assert.equal(reads, 1);
  } finally { restoreMocks(); close(); }
});

test('atomic async writes reject external conflicts and preserve the prior document on failure', async () => {
  const { config, file, paths, close } = fixture();
  let release;
  try {
    const original = config.reloadSettingsDocument(), settings = structuredClone(original.settings);
    settings.startup.openAtLogin = true;
    const write = fsp.writeFile; let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    mock.method(fsp, 'writeFile', async (...args) => { enter(); await gate; return await write(...args); });
    syncBuiltinESMExports();
    const pending = config.saveSettingsAsync(settings); await entered;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
    assert.throws(() => config.savePermissions(original.permissions), error => error.code === 'settings_write_in_progress');
    const external = structuredClone(original); external.permissions.mode = 'default';
    fs.writeFileSync(file, JSON.stringify(external)); release();
    await assert.rejects(() => pending, error => error.code === 'settings_file_changed');
    assert.deepEqual(config.reloadSettingsDocument(), external);
    restoreMocks();
    mock.method(fs, 'renameSync', () => { throw new Error('injected atomic publication failure'); });
    syncBuiltinESMExports();
    await assert.rejects(() => config.saveSettingsAsync(settings), /injected atomic publication failure/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), external);
    assert.deepEqual(fs.readdirSync(paths.configDir), ['settings.json']);
    restoreMocks();
    await config.saveSettingsAsync(settings);
    assert.equal(config.getSettings().startup.openAtLogin, true);
    assert.equal(config.getPermissions().mode, 'default');
  } finally { release?.(); restoreMocks(); close(); }
});

test('external providers survive synchronous mutations and stale asynchronous reads', async () => {
  const { config, file, close } = fixture();
  let release;
  try {
    config.upsertProvider(provider('one'));
    const external = config.reloadSettingsDocument();
    external.providers.providers.push(provider('two'));
    fs.writeFileSync(file, JSON.stringify(external));
    config.deleteProvider('one');
    assert.deepEqual(config.getProviders().providers.map(value => value.id), ['two']);
    const later = config.reloadSettingsDocument();
    later.providers.providers.push(provider('three'));
    fs.writeFileSync(file, JSON.stringify(later));
    config.setDefaultModel('three:model');
    assert.equal(config.getDefaultModelState().providerId, 'three');

    const old = fs.readFileSync(file, 'utf8'), read = fsp.readFile;
    config.settingsDocumentCacheLoadedAtMs = 0;
    const changed = JSON.parse(old); changed.permissions.mode = 'default';
    fs.writeFileSync(file, JSON.stringify(changed));
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    mock.method(fsp, 'readFile', async (...args) => {
      if (args[0] !== file) return await read(...args);
      enter(); await gate; return old;
    });
    syncBuiltinESMExports();
    const pending = config.getSettingsAsync(); await entered;
    config.savePermissions(changed.permissions);
    release(); await pending;
    assert.equal(config.getPermissions().mode, 'default');
  } finally { release?.(); restoreMocks(); close(); }
});

test('paired production settings reads avoid redundant synchronous reads and JSON clones', () => {
  const before = fixture(Legacy), after = fixture();
  const samples = { before: [], after: [] }, read = fs.readFileSync, parse = JSON.parse;
  let reads = 0, parses = 0, target;
  try {
    assert.deepEqual(before.config.reloadSettingsDocument(), after.config.reloadSettingsDocument());
    mock.method(fs, 'readFileSync', (...args) => { if (args[0] === target) reads++; return read(...args); });
    mock.method(JSON, 'parse', (...args) => { parses++; return parse(...args); });
    syncBuiltinESMExports();
    // Exercise both orders in regression runs; repeated timing samples belong to the report.
    const sampleCount = process.env.ROC_PERF_CONFIG_REPORT ? 20 : 2;
    for (let sample = 0; sample < sampleCount; sample++) for (const mode of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
      const fixture = mode === 'after' ? after : before; target = fixture.file; reads = 0; parses = 0;
      const started = performance.now(), cpuStarted = process.cpuUsage();
      for (let index = 0; index < 100; index++) {
        fixture.config.reloadSettingsDocument(); fixture.config.getSettings();
        fixture.config.getPermissions(); fixture.config.getProviders();
      }
      const cpu = process.cpuUsage(cpuStarted);
      samples[mode].push({ totalMs: performance.now() - started, cpuMicros: cpu.user + cpu.system,
        synchronousReads: reads, jsonParses: parses, ...process.memoryUsage() });
    }
    for (const sample of samples.before) assert.equal(sample.synchronousReads, 100);
    for (const sample of samples.after) {
      assert.equal(sample.synchronousReads, 0);
      assert.equal(sample.jsonParses, 0);
    }
    restoreMocks();
    if (process.env.ROC_PERF_CONFIG_REPORT) {
      const report = makeReport('config-snapshot', { iterations: 100, readsPerIteration: 4,
        corpusSha256: sha256(fs.readFileSync(before.file)) },
      ['src/main/services/config-service.ts', 'tests/fixtures/performance/legacy-config-service.ts', 'tests/unit/config-snapshot.test.mjs']);
      report.scenarios = Object.entries(samples).map(([id, values]) => ({ id, samples: values, summary: summarizeRows(values) }));
      report.limitations.push('Generated isolated settings; memory samples include both services and the test runtime, not exclusive footprint.',
        'Unchanged-file detection uses dev/inode/size/mtimeNs/ctimeNs; explicit permission/bootstrap boundaries still check immediately.');
      saveReport(process.env.ROC_PERF_CONFIG_REPORT, report);
    }
  } finally { restoreMocks(); before.close(); after.close(); }
});
