import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { seedHistoricalResearch } from '../fixtures/research-historical-database.mjs';
import { fingerprintTable } from '../../scripts/database/research-migration-lib.mjs';

const options = { platform: 'node', external: ['better-sqlite3', 'pino'], tempDir: resolve('.runtime/database-migration-tests') };
const [{ migrateDatabasesOnStartup, researchLegacyChecksums }, schemas, schemaHelpers, { KernelRuntime }] = await Promise.all([
  importTypeScriptModule('src/main/infrastructure/database-migrations.ts', options),
  importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options),
  importTypeScriptModule('src/main/infrastructure/database-schema.ts', options),
  importTypeScriptModule('src/main/kernel/kernel-runtime.ts', options)
]);

function fixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'roc-auto-migrate-'));
  const pluginData = join(root, 'plugin-data');
  const pluginDir = join(pluginData, 'data/plugins/@roc');
  mkdirSync(pluginDir, { recursive: true });
  const path = join(pluginDir, 'plugin-research.db');
  seedHistoricalResearch(path, version).close();
  return { root, pluginData, path, dispose() { rmSync(root, { recursive: true, force: true }); } };
}

const preserved = ['research_projects', 'research_artifacts', 'research_wiki_pages',
  'research_knowledge_chunks', 'research_knowledge_keywords', 'research_experiment_runs'];

for (const version of [71, 72, 73, 74, 75]) {
  test(`v${version} research database upgrades automatically, preserving all old rows and index matches`, async () => {
    const f = fixture(version);
    try {
      const source = new Database(f.path, { readonly: true });
      const before = Object.fromEntries(preserved.map(name => [name, fingerprintTable(source, name)]));
      const wikiCount = source.prepare("SELECT count(*) FROM research_wiki_fts WHERE research_wiki_fts MATCH 'historicaltoken'").pluck().get();
      source.close();
      await migrateDatabasesOnStartup(f.pluginData);
      const current = new Database(f.path);
      try {
        schemas.applyResearchDatabaseSchema(current);
        assert.equal(current.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 76);
        for (const name of preserved) assert.deepEqual(fingerprintTable(current, name), before[name], name);
        assert.equal(current.prepare("SELECT count(*) FROM research_wiki_fts WHERE research_wiki_fts MATCH 'historicaltoken'").pluck().get(), wikiCount);
        assert.deepEqual(current.pragma('foreign_key_check'), []);
        assert.equal(current.pragma('integrity_check', { simple: true }), 'ok');
      } finally {
        current.close();
      }
      const backupBase = join(f.pluginData, 'schema-backups');
      const directories = readdirSync(backupBase);
      assert.equal(directories.length, 1);
      const backupDir = join(backupBase, directories[0]);
      const receipt = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
      assert.equal(receipt.status, 'complete');
      assert.deepEqual(receipt.backups.map(item => [item.fromVersion, item.toVersion]), [[version, 76]]);
      const old = new Database(join(backupDir, receipt.backups[0].fileName), { readonly: true });
      try { assert.equal(old.prepare('SELECT current_version FROM schema_metadata').pluck().get(), version); }
      finally { old.close(); }
      await migrateDatabasesOnStartup(f.pluginData);
      assert.deepEqual(readdirSync(backupBase), directories, 'reopening must not create a second backup');
    } finally {
      f.dispose();
    }
  });
}

test('kernel upgrades a historical database before the seven-database fast probe and plugin load', async () => {
  const f = fixture(74);
  const runtime = new KernelRuntime({
    rootDir: f.pluginData, createPlugins: () => [], safeStorage: {}
  });
  try {
    await runtime.start();
    assert.equal(runtime.getStatus().started, true);
    await runtime.shutdown();
    const db = new Database(f.path, { readonly: true });
    try { assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(), 76); }
    finally { db.close(); }
  } finally {
    if (runtime.getStatus().started) await runtime.shutdown();
    f.dispose();
  }
});

test('unsafe historical environment receipts and executions stop without writing or creating a backup', async () => {
  for (const kind of ['receipt', 'python', 'r', 'julia']) {
    const f = fixture(75);
    try {
      const db = new Database(f.path);
      if (kind === 'receipt') {
        db.prepare(`INSERT INTO research_python_environment_selections
          (id,project_id,request_id,snapshot_json,snapshot_hash,created_at)
          VALUES('old-python','p','old','{}','old','old')`).run();
      } else {
        db.prepare(`INSERT INTO research_experiment_runs
          (id,project_id,label,command,parameters_json,environment_json,status,outputs_json,started_at,ended_at)
          VALUES('legacy','p','legacy','[]','{}','{}','completed','[]','old','old')`).run();
        db.prepare(`INSERT INTO research_experiment_executions
          (run_id,project_id,request_id,status,snapshot_json,root_path,created_at)
          VALUES('legacy','p','legacy','completed',?,'/historical','old')`)
          .run(JSON.stringify({request:{engine:kind}}));
      }
      const before = db.serialize();
      db.close();
      await assert.rejects(migrateDatabasesOnStartup(f.pluginData), /require_archive|requires_review/u);
      const unchanged = new Database(f.path);
      try { assert.deepEqual(unchanged.serialize(), before); }
      finally { unchanged.close(); }
      assert.throws(() => readdirSync(join(f.pluginData, 'schema-backups')), /ENOENT/u);
    } finally { f.dispose(); }
  }
});

test('tampered schema, wrong identity and newer versions refuse without modification', async () => {
  for (const change of [
    "UPDATE schema_metadata SET schema_checksum='changed'",
    "UPDATE schema_metadata SET db_name='agent'",
    "UPDATE schema_metadata SET current_version=999",
    'DROP INDEX research_wiki_project'
  ]) {
    const f = fixture(75);
    try {
      const db = new Database(f.path);
      db.exec(change);
      const before = db.serialize();
      db.close();
      await assert.rejects(migrateDatabasesOnStartup(f.pluginData), /database_migration_/u);
      const unchanged = new Database(f.path);
      try { assert.deepEqual(unchanged.serialize(), before); }
      finally { unchanged.close(); }
    } finally { f.dispose(); }
  }
});

test('published schema changes require an explicit contract/migration review', () => {
  const frozen = {
    core: [1, '3339b0d3de2d30e4bcb8037395d1ea058698f94129778fb87bda4fe7951d078e'],
    agent: [25, 'b7d2f5514c780bd41c2f95e123065ae393757def37705d14ae7e9f2391fcc8a8'],
    memory: [2, '12a4789f2347e8bde25cd9a9773c31d8a2825c2d8ec7cafc6bcbc80907b8dde5'],
    task: [1, '61e9b86f932f3da4b9e577705e6b001122f30ad31890a5fa79470512ad552654'],
    workspace: [1, 'eef6de66960c0c28c113712c668e95ea6da6ac5a135ad725514e403808496f1d'],
    diagnostics: [1, 'd7798722d73b5302a0fad697ca1a58a1c6fe7b7b958bf0640e8e541d0a7c28da'],
    research: [76, '1241f753c8a2dec38f2829a15e9955f4af5d99556b3f1ec154e09757f1f63f7f']
  };
  const names = { core:'core', agent:'agent', memory:'memory', task:'task',
    workspace:'plugin:@roc/plugin-workspace', diagnostics:'plugin:@roc/plugin-diagnostics',
    research:'plugin:@roc/plugin-research' };
  for (const [key, [version, checksum]] of Object.entries(frozen)) {
    assert.equal(schemas[key + 'Schema'].version, version, `${key}: new version requires a migration`);
    const actual = schemaHelpers.expectedSchemaObjects(schemas[key + 'Schema'].sql);
    assert.equal(schemaHelpers.checksumSchemaObjects(names[key], version, actual), checksum,
      `${key}: changed DDL requires a new schema version and migration`);
  }
  assert.equal(Object.keys(researchLegacyChecksums).length, 5);
});
