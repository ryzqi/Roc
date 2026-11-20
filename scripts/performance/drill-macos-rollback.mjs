#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { importTypeScriptModule } from '../lib/bundle-ts.mjs';
import { projectRoot } from '../lib/project-paths.mjs';

assert.equal(process.platform, 'darwin', 'Rollback acceptance requires macOS.');
assert.equal(process.arch, 'arm64', 'Rollback acceptance requires arm64.');
assert.ok(process.argv.length <= 3, 'Usage: drill-macos-rollback.mjs [report.json]');
const outputPath = resolve(process.argv[2] ?? '.artifacts/mac-performance/rollback.json');
const runtimeRoot = join(projectRoot, '.runtime/mac-rollback');
mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(dirname(outputPath), { recursive: true });
const runRoot = mkdtempSync(join(runtimeRoot, 'run-'));
const backupRoot = join(dirname(outputPath), `rollback-backups-${runRoot.split('/').at(-1)}`);
const cliPath = join(projectRoot, 'dist/main/database-maintenance-cli.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => '2026-11-15T00:00:00.000Z';
const bundleOptions = { platform: 'node', external: ['better-sqlite3', '@langchain/*'],
  tempDir: join(projectRoot, '.runtime/performance') };
const sources = [
  'scripts/performance/drill-macos-rollback.mjs', 'tests/smoke/lib/performance-profile-seed.ts',
  'src/main/infrastructure/database-backup.ts', 'src/main/infrastructure/database-schema.ts',
  'src/main/infrastructure/database-schemas.ts', 'src/main/services/deep-agent/sqlite-checkpointer.ts',
  'dist/main/database-maintenance-cli.js'
];
const report = {
  schemaVersion: 1, passed: false, startedAt: new Date().toISOString(), cwd: projectRoot,
  source: { gitSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim(),
    lockSha256: hash(readFileSync(join(projectRoot, 'pnpm-lock.yaml'))),
    hashes: Object.fromEntries(sources.map(path => [path, hash(readFileSync(join(projectRoot, path)))])) },
  host: { platform: process.platform, arch: process.arch, node: process.version, osRelease: release(),
    cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  profiles: [], refusals: [], diagnostics: [], commands: [], backupRoot,
  limitations: [
    'Only generated isolated profiles are used. Native backup files are retained as local artifacts.',
    'The Core manifest row is persisted after its native backup; restored Core matches the pre-backup snapshot.',
    'No automatic historical schema migration exists. Incompatible DDL/version/checksum must be refused.',
    'This drill checks logical data and checkpoint recovery; it does not measure exclusive physical footprint.'
  ]
};
let poolApi, definitions, Checkpointer, Store, Knowledge;

function cli(args, { status = 0, error } = {}) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot, encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  });
  report.commands.push({ command: process.execPath, args: [cliPath, ...args], cwd: projectRoot,
    exitCode: result.status, signal: result.signal, durationMs: performance.now() - start,
    stdoutSha256: hash(result.stdout ?? ''), stderr: result.stderr?.trim() ?? '',
    spawnError: result.error?.message ?? null });
  assert.equal(result.status, status, result.stderr || result.error?.message || result.stdout);
  if (error !== undefined) assert.match(result.stderr, error);
  return status === 0 ? JSON.parse(result.stdout) : null;
}

function paths(dataRoot) { return new poolApi.DatabasePool(join(dataRoot, 'plugin-data')); }

function snapshot(dataRoot) {
  const pool = paths(dataRoot);
  return definitions.map(definition => {
    const path = pool.getDatabasePath(definition.dbName);
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      definition.applySchema(db, () => { throw new Error('Existing schema must reopen without writes.'); });
      assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }], definition.dbName);
      assert.deepEqual(db.pragma('foreign_key_check'), [], definition.dbName);
      const shadow = new Set(db.prepare("SELECT name FROM pragma_table_list WHERE type='shadow'").pluck().all());
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .pluck().all().filter(name => !shadow.has(name)).map(name => {
          const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row =>
            JSON.stringify(Object.entries(row).map(([key, value]) => [key,
              Buffer.isBuffer(value) ? { base64: value.toString('base64') } : value]))).sort();
          return { name, rows: rows.length, sha256: hash(JSON.stringify(rows)) };
        });
      return { dbName: definition.dbName, schema: db.prepare('SELECT * FROM schema_metadata').get(),
        tables, logicalSha256: hash(JSON.stringify(tables)), integrity: 'ok', foreignKeyViolations: 0 };
    } finally { db.close(); }
  });
}

function dataHashes(dataRoot) {
  const root = join(dataRoot, 'plugin-data/data');
  const rows = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else { assert.ok(entry.isFile()); rows.push([child.slice(root.length + 1), hash(readFileSync(child))]); }
    }
  }
  visit(root);
  return rows;
}

async function checkpointTuple(dataRoot, scale) {
  const pool = paths(dataRoot);
  try {
    return await new Checkpointer(pool.getConnection('@roc/plugin-agent')).getTuple({
      configurable: { thread_id: `thread-profile-${scale}`, checkpoint_ns: 'release',
        checkpoint_id: `checkpoint-${scale}-child` }
    });
  } finally { pool.closeAll(); }
}

async function seedEvidence(dataRoot, scale) {
  const pool = paths(dataRoot);
  try {
    pool.getCoreConnection().prepare('INSERT INTO plugin_config VALUES (?,?,?,?)')
      .run('release-fixture', 'marker', '{"text":"保留原文"}', now());
    const memory = new Store(pool.getConnection('@roc/plugin-memory'));
    for (const namespace of [['project', 'a'], ['project', 'a', 'b'], ['project', 'ab'], ['中文', '记忆']]) {
      for (let n = 0; n < 4; n++) await memory.put(namespace, String(n), {
        number: n, text: '中文 evidence', nested: { b: 2, a: 1 }, boolean: n % 2 === 0
      });
    }
    const db = pool.getConnection('@roc/plugin-research');
    const knowledge = new Knowledge(db, () => {}, now);
    for (let index = 0; index < 3; index++) {
      const chunks = Array.from({ length: 4 }, (_, n) => ({ content: `rollbackneedle 中文 evidence ${index} ${n}`, locator: `page:${n + 1}` }));
      knowledge.upsertKnowledgeDocument({ id: `rollback-document-${index}`, projectId: `project-performance-${scale}`,
        sourceType: 'file', sourceId: `rollback-source-${index}`, title: `Rollback fixture ${index}`,
        content: chunks.map(chunk => chunk.content).join('\n'), chunks, embeddingConfigId: null });
    }
    if (scale !== 0) {
      const saver = new Checkpointer(pool.getConnection('@roc/plugin-agent'));
      let config = { configurable: { thread_id: `thread-profile-${scale}`, checkpoint_ns: 'release' } };
      for (const [id, step] of [[`checkpoint-${scale}-parent`, 0], [`checkpoint-${scale}-child`, 1]]) {
        config = await saver.put(config, { v: 1, id, ts: now(), channel_values: { evidence: ['中文', scale] },
          channel_versions: { evidence: step + 1 }, versions_seen: {}, updated_channels: ['evidence'] },
        { source: 'loop', step, parents: {} }, { evidence: step + 1 });
      }
      await saver.putWrites(config, [['evidence', 'later']], 'task-b', 'path-2');
      await saver.putWrites(config, [['evidence', 'root']], 'task-c', '');
      await saver.putWrites(config, [['__interrupt__', { id: 'release-approval', value: 'retained' }]], 'task-a', 'path-1');
      const tuple = await saver.getTuple(config);
      assert.equal(tuple.parentConfig.configurable.checkpoint_id, `checkpoint-${scale}-parent`);
      assert.deepEqual(tuple.pendingWrites.map(([task]) => task), ['task-c', 'task-a', 'task-b']);
    }
  } finally { pool.closeAll(); }
}

async function withFlag(flag, value, work) {
  const previous = process.env[flag];
  if (value === undefined) delete process.env[flag]; else process.env[flag] = value;
  try { return await work(); }
  finally { if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous; }
}

async function capture(work) {
  try { return { output: await work() }; }
  catch (error) { return { error: { name: error.name, message: error.message } }; }
}

async function diagnosticParity(dataRoot, scale) {
  const pool = paths(dataRoot);
  try {
    const operations = [
      store => store.search(['project', 'a'], { filter: { number: { $gte: 2 } }, offset: 1, limit: 2 }),
      store => store.search(['中文'], { query: '中文', limit: 10 }),
      store => store.listNamespaces({ prefix: ['project', '*'], suffix: ['b'], maxDepth: 3 }),
      store => store.search(['project'], { filter: { number: { $unsupported: 1 } } })
    ];
    const readMemory = () => {
      const store = new Store(pool.getConnection('@roc/plugin-memory'));
      return Promise.all(operations.map(operation => capture(() => operation(store))));
    };
    const memory = await withFlag('ROC_PERF_MEMORY_SQL_V2', undefined, readMemory);
    assert.deepEqual(await withFlag('ROC_PERF_MEMORY_SQL_V2', '0', readMemory), memory);
    report.diagnostics.push({ flag: 'ROC_PERF_MEMORY_SQL_V2', value: '0', cases: operations.length,
      outputSha256: hash(JSON.stringify(memory)), parity: true });
    const readKnowledge = () => {
      const knowledge = new Knowledge(pool.getConnection('@roc/plugin-research'), () => {}, now);
      return ['rollbackneedle', '中文', 'Rollback fixture 1', 'absent'].map(query => knowledge.searchKnowledge({
        request: { query, projectId: `project-performance-${scale}`, limit: 10, embeddingConfigId: null, rerank: 'none' },
        vector: null
      }));
    };
    const rag = await withFlag('ROC_PERF_RAG_BATCH_HYDRATION', undefined, readKnowledge);
    assert.deepEqual(await withFlag('ROC_PERF_RAG_BATCH_HYDRATION', '0', readKnowledge), rag);
    report.diagnostics.push({ flag: 'ROC_PERF_RAG_BATCH_HYDRATION', value: '0', cases: rag.length,
      outputSha256: hash(JSON.stringify(rag)), parity: true });
  } finally { pool.closeAll(); }
}

function cloneBackup(manifest, dataRoot) {
  const pool = paths(dataRoot);
  for (const entry of manifest.databases) {
    const target = pool.getDatabasePath(entry.dbName);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(manifest.backupDir, entry.fileName), target);
  }
}

function refusalDrills(manifest) {
  for (const [kind, sql] of [
    ['ddl', "CREATE TABLE unexpected (value TEXT); INSERT INTO unexpected VALUES ('retained')"],
    ['version', 'UPDATE schema_metadata SET current_version=0'],
    ['checksum', "UPDATE schema_metadata SET schema_checksum='unsupported'"],
    ['hash', null]
  ]) {
    const current = join(runRoot, `refusal-${kind}`);
    cloneBackup(manifest, current);
    const badBackupDir = join(runRoot, `backup-${kind}`);
    mkdirSync(badBackupDir);
    const badManifest = structuredClone(manifest);
    badManifest.id = `refusal-${kind}`; badManifest.backupDir = badBackupDir;
    for (const entry of badManifest.databases) copyFileSync(join(manifest.backupDir, entry.fileName), join(badBackupDir, entry.fileName));
    const core = badManifest.databases.find(entry => entry.dbName === 'core');
    const badCore = join(badBackupDir, core.fileName);
    if (sql === null) {
      const bytes = readFileSync(badCore); bytes[bytes.length - 1] ^= 1; writeFileSync(badCore, bytes);
    } else {
      for (const target of [paths(current).getDatabasePath('core'), badCore]) {
        const db = new Database(target);
        try { db.exec(sql); } finally { db.close(); }
      }
      core.sha256 = hash(readFileSync(badCore));
      core.sizeBytes = readFileSync(badCore).byteLength;
      if (kind === 'version') core.schemaVersion = 0;
      const before = dataHashes(current);
      cli(['backup', '--data-root', current, '--backup-root', backupRoot, '--id', `refused-${kind}`],
        { status: 1, error: /database_fast_probe_unhealthy/u });
      assert.deepEqual(dataHashes(current), before, `${kind}: refused backup changed data`);
    }
    writeFileSync(join(badBackupDir, 'manifest.json'), JSON.stringify(badManifest));
    const before = dataHashes(current);
    cli(['restore', '--data-root', current, '--backup-dir', badBackupDir],
      { status: 1, error: sql === null ? /database_backup_hash_mismatch/u : /database_schema_current_required/u });
    assert.deepEqual(dataHashes(current), before, `${kind}: refused restore changed data`);
    assert.ok(!readdirSync(join(current, 'plugin-data')).some(name => name.startsWith('data.rollback-')));
    report.refusals.push({ kind, backupRefused: sql !== null, restoreRefused: true,
      dataUnchanged: true, filesSha256: hash(JSON.stringify(before)) });
  }
}

async function restoredStartup(dataRoot) {
  const env = { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('ROC_PERF_')) delete env[key];
  const application = await electron.launch({
    executablePath: electronPath,
    args: [join(projectRoot, 'dist/main/index.js'), `--user-data-dir=${join(runRoot, 'chromium')}`],
    env, timeout: 90_000
  });
  try {
    const page = await application.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-testid="roc-app"]').waitFor({ timeout: 30_000 });
    const result = await page.evaluate(async () => ({
      status: await window.roc.app.getStatus(), projects: await window.roc.research.listProjects()
    }));
    assert.equal(result.status.ok, true, JSON.stringify(result.status));
    assert.equal(result.projects.ok, true, JSON.stringify(result.projects));
    assert.ok(result.projects.data.some(project => project.id === 'project-performance-10000'));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(dirname(outputPath), 'rollback-restored.png') });
    return { passed: true, events: 10_000, projectId: 'project-performance-10000', rendererErrors: errors };
  } finally { await application.close(); }
}

try {
  const seedApi = await importTypeScriptModule('tests/smoke/lib/performance-profile-seed.ts', bundleOptions);
  poolApi = await importTypeScriptModule('src/main/infrastructure/database-pool.ts', bundleOptions);
  ({ managedDatabaseDefinitions: definitions } = await importTypeScriptModule('src/main/infrastructure/database-fast-probe.ts', bundleOptions));
  ({ RocSqliteCheckpointer: Checkpointer } = await importTypeScriptModule('src/main/services/deep-agent/sqlite-checkpointer.ts', bundleOptions));
  ({ RocSqliteStore: Store } = await importTypeScriptModule('src/main/services/memory/sqlite-store.ts', bundleOptions));
  ({ ResearchKnowledgeRepository: Knowledge } = await importTypeScriptModule('src/main/plugins/research/knowledge-repository.ts', bundleOptions));
  const roots = { empty: join(runRoot, 'empty'), profile1000: join(runRoot, 'profile-1000'), profile10000: join(runRoot, 'profile-10000') };
  seedApi.seedPerformanceProfiles(roots);
  let lastManifest;
  for (const [scale, dataRoot] of [[0, roots.empty], [1000, roots.profile1000], [10000, roots.profile10000]]) {
    await seedEvidence(dataRoot, scale);
    const initial = snapshot(dataRoot);
    const initialTuple = scale === 0 ? null : await checkpointTuple(dataRoot, scale);
    await diagnosticParity(dataRoot, scale);
    assert.deepEqual(snapshot(dataRoot), initial, 'Diagnostic reads must preserve every table.');
    const manifest = cli(['backup', '--data-root', dataRoot, '--backup-root', backupRoot, '--id', `profile-${scale}`]);
    assert.equal(manifest.databases.length, 7);
    for (const entry of manifest.databases) assert.equal(hash(readFileSync(join(manifest.backupDir, entry.fileName))), entry.sha256);
    const pool = paths(dataRoot);
    try {
      pool.getCoreConnection().prepare('UPDATE plugin_config SET value_json=? WHERE plugin_id=?')
        .run('{"text":"post-backup"}', 'release-fixture');
      pool.getConnection('@roc/plugin-research').prepare('UPDATE research_projects SET title=? WHERE id=?')
        .run('Post-backup mutation', `project-performance-${scale}`);
      if (scale !== 0) pool.getConnection('@roc/plugin-agent').prepare('DELETE FROM langgraph_checkpoint_writes').run();
    } finally { pool.closeAll(); }
    const changed = snapshot(dataRoot);
    assert.notDeepEqual(changed, initial);
    const restored = cli(['restore', '--data-root', dataRoot, '--backup-dir', manifest.backupDir]);
    assert.equal(restored.restored, true);
    assert.deepEqual(snapshot(dataRoot), initial, `profile ${scale}: logical data changed on restore`);
    const rollbackRoot = join(runRoot, `retained-${scale}`);
    const retainedPool = paths(rollbackRoot);
    for (const definition of definitions) {
      const relativePath = retainedPool.getDatabasePath(definition.dbName).split('/plugin-data/data/')[1];
      const target = retainedPool.getDatabasePath(definition.dbName);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(restored.rollbackDataDir, relativePath), target);
    }
    assert.deepEqual(snapshot(rollbackRoot), changed, 'The retained rollback generation must preserve the displaced state.');
    if (scale !== 0) assert.deepEqual(await checkpointTuple(dataRoot, scale), initialTuple);
    report.profiles.push({ events: scale, databases: initial, manifest, retainedGeneration: true,
      logicalDataIdentical: true, checkpointSha256: initialTuple === null ? null : hash(JSON.stringify(initialTuple)),
      checkpointIdentical: initialTuple !== null });
    lastManifest = manifest;
    console.log(JSON.stringify({ rollback: 'passed', events: scale, databases: 7, retainedGeneration: true }));
  }
  report.restoredStartup = await restoredStartup(roots.profile10000);
  assert.equal(hash(JSON.stringify(await checkpointTuple(roots.profile10000, 10000))),
    report.profiles.find(profile => profile.events === 10000).checkpointSha256,
    'Application startup must preserve the restored checkpoint and ordered pending writes.');
  refusalDrills(lastManifest);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.ok(realpathSync(runRoot).startsWith(`${realpathSync(runtimeRoot)}/run-`));
  rmSync(runRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, outputPath, profiles: report.profiles.length,
  databases: report.profiles.reduce((sum, profile) => sum + profile.databases.length, 0),
  refusals: report.refusals.length, diagnostics: report.diagnostics.length }));
