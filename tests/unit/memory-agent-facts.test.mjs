import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import Database from 'better-sqlite3';

/**
 * `memory.status` used to answer these three questions with constants:
 *
 *     sessionMessages: { totalRows: 0, oldestAt: null },
 *     fullTextIndex:   { healthy: true, status: 'ready' },
 *
 * which reads as "the session archive is empty and its index is fine" regardless of what is in
 * the agent database. `AgentMemoryStatsContract` is the contract that makes them real; these
 * tests pin that it reads the database and that index health is a **probe**, not an existence
 * lookup.
 */

let facts;
let schemas;
let tempDir;

function createAgentDb() {
  const db = new Database(':memory:');
  schemas.applyAgentDatabaseSchema(db, () => '2020-01-01T00:00:00.000Z');
  return db;
}

function insertThread(db, id) {
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, 'chat', ?, ?, 'idle', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, id, id);
}

function insertMessage(db, id, threadId, createdAt) {
  db.prepare(
    `INSERT INTO session_messages (id, thread_id, role, content, created_at)
     VALUES (?, ?, 'assistant', ?, ?)`
  ).run(id, threadId, `content for ${id}`, createdAt);
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-memory-facts-'));
  // `better-sqlite3` is native and stays external, so the temp dir needs a resolver path back to
  // the project's packages.
  symlinkSync(join(process.cwd(), 'node_modules'), join(tempDir, 'node_modules'), 'dir');
  const build = (entry, outfile) =>
    esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      packages: 'external',
      logLevel: 'silent'
    });
  await build('src/main/plugins/agent/agent-memory-stats-contract.ts', join(tempDir, 'facts.mjs'));
  await build('src/main/infrastructure/database-schemas.ts', join(tempDir, 'schemas.mjs'));
  facts = await import(join(tempDir, 'facts.mjs'));
  schemas = await import(join(tempDir, 'schemas.mjs'));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('an empty agent database reports zero rows and no oldest message', () => {
  const db = createAgentDb();
  const contract = new facts.AgentMemoryStatsContract(db);
  assert.deepEqual(contract.readSessionStats(), { totalRows: 0, oldestAt: null });
  db.close();
});

test('session stats count the real rows and the real oldest instant', () => {
  const db = createAgentDb();
  insertThread(db, 'thread-1');
  insertMessage(db, 'msg-new', 'thread-1', '2026-05-02T00:00:00.000Z');
  insertMessage(db, 'msg-old', 'thread-1', '2026-04-01T00:00:00.000Z');
  insertMessage(db, 'msg-mid', 'thread-1', '2026-04-15T00:00:00.000Z');

  const contract = new facts.AgentMemoryStatsContract(db);
  assert.deepEqual(contract.readSessionStats(), {
    totalRows: 3,
    oldestAt: '2026-04-01T00:00:00.000Z'
  });
  db.close();
});

test('a migrated agent database reports the index as ready', () => {
  const db = createAgentDb();
  const contract = new facts.AgentMemoryStatsContract(db);
  assert.deepEqual(contract.readFullTextIndexHealth(), { healthy: true, status: 'ready' });
  db.close();
});

test('a missing index reports unavailable instead of a false "healthy"', () => {
  const db = createAgentDb();
  db.exec('DROP TABLE session_messages_fts');
  const contract = new facts.AgentMemoryStatsContract(db);
  assert.deepEqual(contract.readFullTextIndexHealth(), { healthy: false, status: 'unavailable' });
  db.close();
});

test('an index that is listed but cannot answer MATCH is unavailable, not healthy', () => {
  const db = createAgentDb();
  // Same name, still in `sqlite_master`, but no FTS behaviour: an existence lookup would call
  // this healthy, which is the failure mode the probe exists to catch.
  db.exec('DROP TABLE session_messages_fts');
  db.exec('CREATE TABLE session_messages_fts (content TEXT)');
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'session_messages_fts'").pluck().get(),
    1,
    'the table is still listed'
  );

  const contract = new facts.AgentMemoryStatsContract(db);
  assert.deepEqual(contract.readFullTextIndexHealth(), { healthy: false, status: 'unavailable' });
  db.close();
});
