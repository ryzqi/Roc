import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema, applyMemoryDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
import { runDatabaseRetention } from '../../../src/main/infrastructure/database-retention';

let agentDb: Database.Database;
let memoryDb: Database.Database;

beforeEach(() => {
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  memoryDb = new Database(':memory:');
  memoryDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb, () => '2026-07-06T00:00:00.000Z');
  applyMemoryDatabaseSchema(memoryDb, () => '2026-07-06T00:00:00.000Z');
});

afterEach(() => {
  agentDb.close();
  memoryDb.close();
});

describe('runDatabaseRetention', () => {
  it('deletes old terminal run payloads while protecting active, recovering, and waiting-user state', () => {
    seedAgentRows();
    seedMemoryRows();

    const result = runDatabaseRetention({
      agentDb,
      memoryDb,
      policy: {
        terminalRunRetentionDays: 30,
        maxCheckpointsPerThread: 2,
        autoMemoryAuditRetentionDays: 30
      },
      now: new Date('2026-07-06T00:00:00.000Z')
    });

    expect(result.deleted).toEqual({
      agentEvents: 1,
      agentRunEvents: 1,
      checkpoints: 2,
      checkpointWrites: 2,
      toolEffects: 1,
      contextArtifacts: 1,
      memoryAudit: 1
    });
    expect(agentDb.prepare("SELECT COUNT(*) FROM agent_runs WHERE status = 'running'").pluck().get()).toBe(1);
    expect(agentDb.prepare("SELECT COUNT(*) FROM agent_runs WHERE status = 'recovering'").pluck().get()).toBe(1);
    expect(agentDb.prepare("SELECT COUNT(*) FROM agent_runs WHERE status = 'waiting_user'").pluck().get()).toBe(1);
    expect(agentDb.prepare('SELECT COUNT(*) FROM agent_pending_interrupts').pluck().get()).toBe(1);
    expect(agentDb.prepare("SELECT COUNT(*) FROM langgraph_checkpoints WHERE thread_id = 'active_thread'").pluck().get()).toBe(3);
    expect(agentDb.prepare("SELECT COUNT(*) FROM agent_events WHERE run_id = 'active_run'").pluck().get()).toBe(1);
    expect(agentDb.prepare("SELECT COUNT(*) FROM agent_events WHERE run_id = 'pending_terminal_run'").pluck().get()).toBe(1);
    expect(memoryDb.prepare('SELECT COUNT(*) FROM memory_auto_audit').pluck().get()).toBe(1);
  });
});

function seedAgentRows(): void {
  insertThread('old_thread', 'completed');
  insertThread('active_thread', 'running');
  insertThread('waiting_thread', 'waiting_user');
  insertRun('old_run', 'old_thread', 'completed', '2026-05-01T00:00:00.000Z');
  insertRun('active_run', 'active_thread', 'running', null);
  insertRun('recovering_run', 'active_thread', 'recovering', null);
  insertRun('waiting_run', 'waiting_thread', 'waiting_user', null);
  insertRun('pending_terminal_run', 'waiting_thread', 'completed', '2026-05-01T00:00:00.000Z');
  insertPendingInterrupt('pending_terminal_run', 'waiting_thread');
  insertRunPayloadRows('old_run', 'old_thread', '2026-05-01T00:00:00.000Z');
  insertRunPayloadRows('active_run', 'active_thread', '2026-07-01T00:00:00.000Z');
  insertRunPayloadRows('pending_terminal_run', 'waiting_thread', '2026-05-01T00:00:00.000Z');
  insertCheckpoints('old_thread', 4);
  insertCheckpoints('active_thread', 3);
}

function seedMemoryRows(): void {
  memoryDb
    .prepare(
      `INSERT INTO memory_auto_audit
       (id, action, memory_type, scope, confidence, memory_key, summary, source_run_id, reason, workspace_path, target_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('audit_old', 'upsert', 'fact', 'workspace', 'high', 'old', 'old', 'old_run', 'old', null, null, '2026-05-01T00:00:00.000Z');
  memoryDb
    .prepare(
      `INSERT INTO memory_auto_audit
       (id, action, memory_type, scope, confidence, memory_key, summary, source_run_id, reason, workspace_path, target_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('audit_recent', 'upsert', 'fact', 'workspace', 'high', 'recent', 'recent', 'active_run', 'recent', null, null, '2026-07-01T00:00:00.000Z');
}

function insertThread(threadId: string, status: string): void {
  agentDb
    .prepare(
      `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(threadId, 'chat', threadId, threadId, status, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
}

function insertRun(runId: string, threadId: string, status: string, endedAt: string | null): void {
  agentDb
    .prepare(
      `INSERT INTO agent_runs
       (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
        enabled_capabilities_json, workspace_path, task_source, workflow_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      threadId,
      1,
      runId,
      status,
      '2026-05-01T00:00:00.000Z',
      endedAt,
      'provider',
      'model',
      '{"mcpServers":[],"skills":[]}',
      null,
      null,
      null
    );
}

function insertPendingInterrupt(runId: string, threadId: string): void {
  agentDb
    .prepare(
      `INSERT INTO agent_pending_interrupts
       (run_id, thread_id, interrupt_id, payload_json, mode, task_source, workflow_hint,
        workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      threadId,
      'interrupt_1',
      '{"kind":"approval"}',
      'task',
      'workbench',
      null,
      'null',
      null,
      null,
      '2026-05-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z'
    );
}

function insertRunPayloadRows(runId: string, threadId: string, createdAt: string): void {
  agentDb
    .prepare('INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`event_${runId}`, threadId, runId, 1, 'agent_update', '{"status":"completed"}', createdAt);
  agentDb
    .prepare('INSERT INTO agent_run_events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, 1, '{"type":"run_completed"}', createdAt);
  agentDb
    .prepare(
      `INSERT INTO agent_tool_effects
       (run_id, thread_id, tool_call_id, tool_name, input_hash, status, result_json, error_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(runId, threadId, `tool_${runId}`, 'read_file', `hash_${runId}`, 'success', '{}', null, createdAt, createdAt);
  agentDb
    .prepare(
      `INSERT INTO context_artifacts
       (id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars, preview, content, workspace_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`ctx_${runId}`, runId, threadId, 'tool_result', `tool_${runId}`, 'read_file', `sha_${runId}`, 10, 'preview', 'content', null, createdAt);
}

function insertCheckpoints(threadId: string, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    const checkpointId = `checkpoint_${threadId}_${index}`;
    const createdAt = `2026-05-0${index}T00:00:00.000Z`;
    agentDb
      .prepare(
        `INSERT INTO langgraph_checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint_blob, metadata_type, metadata_blob, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, '', checkpointId, null, 'json', Buffer.from('{}'), 'json', Buffer.from('{}'), createdAt);
    agentDb
      .prepare(
        `INSERT INTO langgraph_checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, '', checkpointId, `task_${checkpointId}`, 0, 'messages', 'json', Buffer.from('{}'), createdAt);
  }
}
