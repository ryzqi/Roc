import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const options = { platform: 'node', external: ['better-sqlite3'], tempDir: join(process.cwd(), '.runtime/tmp') };
const { migrateExecutionDatabases } = await importTypeScriptModule('scripts/offline-execution-migration.ts', options);
const schemas = await importTypeScriptModule('src/main/infrastructure/database-schemas.ts', options);
const { applyDatabaseMigrations } = await importTypeScriptModule('src/main/infrastructure/database-migrations.ts', options);
const { DatabasePool } = await importTypeScriptModule('src/main/infrastructure/database-pool.ts', options);
const { runDatabaseFastProbe } = await importTypeScriptModule('src/main/infrastructure/database-fast-probe.ts', options);
const definitions = [['core', 1], ['agent', 6], ['memory', 2], ['task', 1], ['workspace', 1], ['diagnostics', 1], ['research', 4]];
const location = (root, name) => join(root, name === 'core' ? 'data/core.db' : `data/plugins/@roc/plugin-${name}.db`);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const now = () => '2026-11-08T00:00:00.000Z';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'roc-legacy-migration-'));
  const source = join(root, 'source');
  for (const [name, version] of definitions) {
    const file = location(source, name);
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    applyDatabaseMigrations(db, {
      dbName: ['core', 'agent', 'memory', 'task'].includes(name) ? name : `plugin:@roc/plugin-${name}`,
      migrations: schemas[`${name}Migrations`].slice(0, version)
    });
    db.close();
  }
  const agent = new Database(location(source, 'agent'));
  agent.prepare(`INSERT INTO langgraph_checkpoints VALUES ('thread','','checkpoint',NULL,'json',?,'json',?,?)`)
    .run(Buffer.from('{"checkpoint":"fixture"}'), Buffer.from('{}'), now());
  agent.prepare(`INSERT INTO langgraph_checkpoint_writes VALUES ('thread','','checkpoint','task',0,'channel','json',?,?,'path')`)
    .run(Buffer.from('{"write":"fixture"}'), now());
  agent.close();
  const research = new Database(location(source, 'research'));
  research.prepare(`INSERT INTO research_projects
    (id,title,description,workspace_path,status,current_stage,created_at,updated_at)
    VALUES ('project','Legacy project','Preserve me',NULL,'active','discovery',?,?)`).run(now(), now());
  research.prepare(`INSERT INTO research_stage_states VALUES ('project','discovery','pending',NULL,'[]',NULL,NULL,1,0,NULL)`).run();
  research.close();
  const hashes = Object.fromEntries(definitions.map(([name]) => [name, digest(location(source, name))]));
  return { root, source, destination: join(root, 'converted'), hashes, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('offline migration preserves v6/v4 projects and checkpoint bytes and passes a cold startup probe', async () => {
  const f = fixture();
  try {
    const report = await migrateExecutionDatabases({ ...f, stopped: true });
    assert.equal(report.status, 'complete');
    assert.equal(report.sourceApp, 'legacy-agent6-research4');
    for (const [name, version] of definitions) {
      assert.equal(digest(location(f.source, name)), f.hashes[name]);
      const backup = new Database(location(join(f.destination, 'backup'), name), { readonly: true });
      assert.equal(backup.prepare('SELECT current_version FROM schema_metadata').pluck().get(), version);
      backup.close();
    }
    for (const [name, table] of [['agent', 'langgraph_checkpoints'], ['agent', 'langgraph_checkpoint_writes'],
      ['research', 'research_projects'], ['research', 'research_stage_states']]) {
      const before = new Database(location(f.source, name), { readonly: true });
      const after = new Database(location(join(f.destination, 'current'), name), { readonly: true });
      try {
        assert.deepEqual(after.prepare(`SELECT * FROM ${table}`).all(), before.prepare(`SELECT * FROM ${table}`).all());
      } finally { before.close(); after.close(); }
    }
    const pool = new DatabasePool(join(f.destination, 'current'));
    try {
      const probe = runDatabaseFastProbe({ pool, now });
      assert.equal(probe.status, 'healthy', JSON.stringify(probe));
      assert.equal(pool.getConnection('@roc/plugin-agent').prepare('SELECT current_version FROM schema_metadata').pluck().get(), schemas.agentMigrations.length);
      assert.equal(pool.getConnection('@roc/plugin-research').prepare('SELECT current_version FROM schema_metadata').pluck().get(), schemas.researchMigrations.length);
    } finally { pool.closeAll(); }
  } finally { f.close(); }
});

for (const name of ['agent', 'research']) test(`v6/v4 migration rejects unsupported ${name} executions before creating output`, async () => {
  const f = fixture();
  try {
    const db = new Database(location(f.source, name));
    if (name === 'agent') {
      db.prepare("INSERT INTO agent_threads(id,kind,title,goal,status,created_at,updated_at) VALUES ('thread','chat','title','goal','active',?,?)").run(now(), now());
      db.prepare("INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,enabled_capabilities_json) VALUES ('run','thread',1,'input','completed',?,'{}')").run(now());
    } else {
      db.prepare("INSERT INTO research_stage_runs VALUES ('run','project','discovery','request',NULL,'completed','{}','{}')").run();
    }
    db.close();
    const before = digest(location(f.source, name));
    await assert.rejects(migrateExecutionDatabases({ ...f, stopped: true }), /offline_legacy_execution_unsupported/);
    assert.equal(digest(location(f.source, name)), before);
    assert.equal(existsSync(f.destination), false);
  } finally { f.close(); }
});

test('v6/v4 migration still rejects schema drift without changing the source', async () => {
  const f = fixture();
  try {
    const db = new Database(location(f.source, 'agent'));
    db.exec('CREATE TABLE unexpected (id TEXT)');
    db.close();
    const before = digest(location(f.source, 'agent'));
    await assert.rejects(migrateExecutionDatabases({ ...f, stopped: true }), /offline_source_schema_changed/);
    assert.equal(digest(location(f.source, 'agent')), before);
    assert.equal(existsSync(f.destination), false);
  } finally { f.close(); }
});
