import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import Database from 'better-sqlite3';

/**
 * Retention is a measured fact, not a displayed window.
 *
 * `settings.memory.sessionRetentionDays` was shown in the memory panel ("保留 90 天") while
 * nothing pruned `session_messages` by age — the setting was inert. These tests pin the two
 * properties that make the window honest:
 *
 *   1. it deletes **only** messages older than its own cutoff (not the run-retention cutoff);
 *   2. it leaves the transcripts of threads with live or interrupted runs alone, because deleting
 *      the history of a run that can still continue would be data loss, not retention.
 *
 * The retention pass itself is only reachable on a timer (5 min initial delay), so these run it
 * directly against in-memory databases built from the real migration SQL.
 */

let retention;
let schemas;
let tempDir;

const now = new Date('2026-06-01T00:00:00.000Z');

const policy = {
  terminalRunRetentionDays: 90,
  maxCheckpointsPerThread: 100,
  autoMemoryAuditRetentionDays: 30,
  sessionMessageRetentionDays: 45
};

function isoDaysAgo(days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function createAgentDb() {
  const db = new Database(':memory:');
  schemas.applyAgentDatabaseSchema(db, () => '2020-01-01T00:00:00.000Z');
  return db;
}

function createMemoryDb() {
  const db = new Database(':memory:');
  schemas.applyMemoryDatabaseSchema(db, () => '2020-01-01T00:00:00.000Z');
  return db;
}

function insertThread(db, id, createdAt = isoDaysAgo(400)) {
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, 'chat', ?, ?, 'idle', ?, ?)`
  ).run(id, id, id, createdAt, createdAt);
}

function insertMessage(db, id, threadId, createdAt) {
  db.prepare(
    `INSERT INTO session_messages (id, thread_id, role, content, created_at)
     VALUES (?, ?, 'user', ?, ?)`
  ).run(id, threadId, `content for ${id}`, createdAt);
}

function insertRun(db, id, threadId, status, startedAt) {
  db.prepare(
    `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at,
        enabled_capabilities_json, state_version)
     VALUES (?, ?, 1, 'input', ?, ?, ?, '{"mcpServers":[],"skills":[]}', 1)`
  ).run(id, threadId, status, startedAt, status === 'running' ? null : startedAt);
}

function countMessages(db) {
  return db.prepare('SELECT COUNT(*) FROM session_messages').pluck().get();
}

const EMPTY_DBS = () => ({ agent: createAgentDb(), memory: createMemoryDb() });

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-retention-'));
  // The bundle keeps node_modules external (better-sqlite3 is native and must not be bundled),
  // so the temp dir needs a resolver path back to the project's packages.
  symlinkSync(join(process.cwd(), 'node_modules'), join(tempDir, 'node_modules'), 'dir');
  const build = (entry, outfile) =>
    esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // Only local source is bundled; node_modules (and node builtins) load at test time.
      packages: 'external',
      logLevel: 'silent'
    });
  await build('src/main/infrastructure/database-retention.ts', join(tempDir, 'retention.mjs'));
  await build('src/main/infrastructure/database-schemas.ts', join(tempDir, 'schemas.mjs'));
  retention = await import(join(tempDir, 'retention.mjs'));
  schemas = await import(join(tempDir, 'schemas.mjs'));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('session messages age out by their own window, not the run window', () => {
  const { agent, memory } = EMPTY_DBS();
  insertThread(agent, 'thread-old');
  insertMessage(agent, 'msg-stale', 'thread-old', isoDaysAgo(60));
  insertMessage(agent, 'msg-fresh', 'thread-old', isoDaysAgo(10));

  const result = retention.runDatabaseRetention({ agentDb: agent, memoryDb: memory, policy, now });

  assert.equal(result.deleted.sessionMessages, 1);
  const remaining = agent.prepare('SELECT id FROM session_messages ORDER BY id').pluck().all();
  assert.deepEqual(remaining, ['msg-fresh']);
  agent.close();
  memory.close();
});

test('a transcript inside the window is untouched even when everything else is old', () => {
  const { agent, memory } = EMPTY_DBS();
  insertThread(agent, 'thread-fresh');
  insertMessage(agent, 'msg-1', 'thread-fresh', isoDaysAgo(44));
  insertMessage(agent, 'msg-2', 'thread-fresh', isoDaysAgo(1));

  const result = retention.runDatabaseRetention({ agentDb: agent, memoryDb: memory, policy, now });

  assert.equal(result.deleted.sessionMessages, 0);
  assert.equal(countMessages(agent), 2);
  agent.close();
  memory.close();
});

test('a live run protects its thread transcript, an idle one does not', () => {
  const { agent, memory } = EMPTY_DBS();
  insertThread(agent, 'thread-running');
  insertRun(agent, 'run-running', 'thread-running', 'running', isoDaysAgo(200));
  insertMessage(agent, 'msg-live', 'thread-running', isoDaysAgo(200));

  insertThread(agent, 'thread-idle');
  insertMessage(agent, 'msg-idle', 'thread-idle', isoDaysAgo(200));

  const result = retention.runDatabaseRetention({ agentDb: agent, memoryDb: memory, policy, now });

  assert.equal(result.deleted.sessionMessages, 1);
  const remaining = agent.prepare('SELECT id FROM session_messages ORDER BY id').pluck().all();
  assert.deepEqual(remaining, ['msg-live'], 'the running thread keeps its history');
  agent.close();
  memory.close();
});

test('audit records follow the audit window while sessions follow theirs', () => {
  const { agent, memory } = EMPTY_DBS();
  const insertAudit = (id, createdAt) =>
    memory
      .prepare(
        `INSERT INTO memory_auto_audit
           (id, action, memory_type, scope, confidence, memory_key, summary, source_run_id, reason, created_at)
         VALUES (?, 'accepted', 'workspace_fact', 'global', 'high', ?, ?, 'run-1', 'test', ?)`
      )
      .run(id, `key-${id}`, `summary ${id}`, createdAt);

  insertAudit('audit-stale', isoDaysAgo(60));
  insertAudit('audit-fresh', isoDaysAgo(10));
  insertThread(agent, 'thread-old');
  insertMessage(agent, 'msg-stale', 'thread-old', isoDaysAgo(60));

  const result = retention.runDatabaseRetention({ agentDb: agent, memoryDb: memory, policy, now });

  assert.equal(result.deleted.memoryAudit, 1);
  assert.equal(result.deleted.sessionMessages, 1);
  const audits = memory.prepare('SELECT id FROM memory_auto_audit ORDER BY id').pluck().all();
  assert.deepEqual(audits, ['audit-fresh']);
  agent.close();
  memory.close();
});

test('the result reports every counter, so a caller cannot read a missing field as zero work', () => {
  const { agent, memory } = EMPTY_DBS();
  const result = retention.runDatabaseRetention({ agentDb: agent, memoryDb: memory, policy, now });
  assert.deepEqual(Object.keys(result.deleted).sort(), [
    'agentEvents',
    'agentOutbox',
    'agentRunEvents',
    'checkpointWrites',
    'checkpoints',
    'contextArtifacts',
    'memoryAudit',
    'runTelemetry',
    'sessionMessages',
    'toolEffects'
  ]);
  agent.close();
  memory.close();
});

test('a negative session window is refused instead of silently deleting everything', () => {
  const { agent, memory } = EMPTY_DBS();
  assert.throws(
    () =>
      retention.runDatabaseRetention({
        agentDb: agent,
        memoryDb: memory,
        policy: { ...policy, sessionMessageRetentionDays: -1 },
        now
      }),
    /database_retention_session_days_invalid/u
  );
  agent.close();
  memory.close();
});
