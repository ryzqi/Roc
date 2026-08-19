import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentDatabaseSchema(db);
});

afterEach(() => {
  db.close();
});

describe('RocSqliteCheckpointer', () => {
  it('does not create checkpoint tables during construction', () => {
    const isolatedDb = new Database(':memory:');
    try {
      new RocSqliteCheckpointer(isolatedDb);

      expect(tableExists(isolatedDb, 'langgraph_checkpoints')).toBe(false);
      expect(tableExists(isolatedDb, 'langgraph_checkpoint_writes')).toBe(false);
    } finally {
      isolatedDb.close();
    }
  });

  it('persists checkpoint data so another instance can read the same thread state', async () => {
    const first = new RocSqliteCheckpointer(db);
    const checkpoint = {
      v: 4,
      id: 'checkpoint_1',
      ts: '2026-07-03T00:00:00.000Z',
      channel_values: { messages: ['partial'] },
      channel_versions: { messages: 1 },
      versions_seen: {}
    };

    const config = await first.put(
      {
        configurable: {
          thread_id: 'thread_recovery_1',
          checkpoint_ns: '',
          checkpoint_id: 'parent_checkpoint_1'
        }
      },
      checkpoint,
      {
        source: 'input',
        step: 1,
        parents: {}
      },
      {}
    );

    const second = new RocSqliteCheckpointer(db);
    const loaded = await second.getTuple(config);

    expect(loaded?.checkpoint).toEqual(checkpoint);
    expect(loaded?.config.configurable?.thread_id).toBe('thread_recovery_1');
    expect(loaded?.config.configurable?.checkpoint_id).toBe('checkpoint_1');
    expect(loaded?.parentConfig?.configurable?.checkpoint_id).toBe('parent_checkpoint_1');
  });

  it('owns checkpoint restart evidence and checkpoint interrupt decoding', async () => {
    const checkpointer = new RocSqliteCheckpointer(db);

    expect(checkpointer.hasCheckpoint('thread_restart_evidence')).toBe(false);
    const config = await checkpointer.put(
      {
        configurable: {
          thread_id: 'thread_restart_evidence',
          checkpoint_ns: ''
        }
      },
      {
        v: 4,
        id: 'checkpoint_restart_evidence',
        ts: '2026-07-03T00:00:00.000Z',
        channel_values: {},
        channel_versions: {},
        versions_seen: {}
      },
      { source: 'input', step: 1, parents: {} },
      {}
    );
    await checkpointer.putWrites(
      config,
      [
        [
          '__interrupt__',
          [
            { id: 'interrupt_restart_evidence_1', value: { question: 'Continue?' } },
            { id: 'interrupt_restart_evidence_2', value: { question: 'Which workspace?' } }
          ]
        ]
      ],
      'task-restart-evidence'
    );

    expect(checkpointer.hasCheckpoint('thread_restart_evidence')).toBe(true);
    expect(checkpointer.readPendingInterrupts('thread_restart_evidence')).toEqual([
      {
        interruptId: 'interrupt_restart_evidence_1',
        payload: { question: 'Continue?' }
      },
      {
        interruptId: 'interrupt_restart_evidence_2',
        payload: { question: 'Which workspace?' }
      }
    ]);
  });

  it('deletes only LangGraph checkpoints and keeps Roc application history', async () => {
    const checkpointer = new RocSqliteCheckpointer(db);
    const now = '2026-07-06T00:00:00.000Z';
    insertAgentHistoryResidue({
      runId: 'run_delete_thread',
      threadId: 'thread_delete_thread',
      createdAt: now
    });

    expect(countRows('agent_threads')).toBe(1);
    expect(countRows('agent_runs')).toBe(1);
    expect(countRows('agent_events')).toBe(1);
    expect(countRows('session_messages')).toBe(1);
    expect(countRows('session_messages_fts')).toBe(1);
    expect(countRows('agent_pending_interrupts')).toBe(1);
    expect(countRows('agent_run_events')).toBe(1);
    expect(countRows('langgraph_checkpoints')).toBe(1);
    expect(countRows('langgraph_checkpoint_writes')).toBe(1);
    expect(countRows('agent_tool_effects')).toBe(1);
    expect(countRows('context_artifacts')).toBe(1);

    await checkpointer.deleteThread('thread_delete_thread');

    expect(countRows('agent_threads')).toBe(1);
    expect(countRows('agent_runs')).toBe(1);
    expect(countRows('agent_events')).toBe(1);
    expect(countRows('session_messages')).toBe(1);
    expect(countRows('session_messages_fts')).toBe(1);
    expect(countRows('agent_pending_interrupts')).toBe(1);
    expect(countRows('agent_run_events')).toBe(1);
    expect(countRows('langgraph_checkpoints')).toBe(0);
    expect(countRows('langgraph_checkpoint_writes')).toBe(0);
    expect(countRows('agent_tool_effects')).toBe(1);
    expect(countRows('context_artifacts')).toBe(1);
  });

  it('deletes excess checkpoints while preserving protected threads', async () => {
    const checkpointer = new RocSqliteCheckpointer(db);
    for (const threadId of ['retained_thread', 'protected_thread']) {
      for (let index = 1; index <= 3; index += 1) {
        const config = await checkpointer.put(
          { configurable: { thread_id: threadId, checkpoint_ns: '' } },
          {
            v: 4,
            id: `checkpoint_${threadId}_${index}`,
            ts: `2026-07-0${index}T00:00:00.000Z`,
            channel_values: {},
            channel_versions: {},
            versions_seen: {}
          },
          { source: 'input', step: index, parents: {} },
          {}
        );
        await checkpointer.putWrites(config, [['messages', `message-${index}`]], `task-${index}`);
      }
    }

    expect(
      checkpointer.deleteExcessCheckpoints({
        protectedThreadIds: ['protected_thread'],
        maxCheckpointsPerThread: 2
      })
    ).toEqual({ checkpoints: 1, checkpointWrites: 1 });
    expect(db.prepare("SELECT COUNT(*) FROM langgraph_checkpoints WHERE thread_id = 'retained_thread'").pluck().get()).toBe(2);
    expect(db.prepare("SELECT COUNT(*) FROM langgraph_checkpoints WHERE thread_id = 'protected_thread'").pluck().get()).toBe(3);
  });

  it('overwrites repeated special pending writes while preserving regular writes', async () => {
    const checkpointer = new RocSqliteCheckpointer(db);
    const checkpoint = {
      v: 4,
      id: 'checkpoint_writes_1',
      ts: '2026-07-03T00:00:00.000Z',
      channel_values: {},
      channel_versions: {},
      versions_seen: {}
    };
    const config = await checkpointer.put(
      {
        configurable: {
          thread_id: 'thread_writes_1',
          checkpoint_ns: ''
        }
      },
      checkpoint,
      {
        source: 'input',
        step: 1,
        parents: {}
      },
      {}
    );

    await checkpointer.putWrites(config, [
      ['messages', 'regular-first'],
      ['__interrupt__', { value: 'interrupt-first' }]
    ], 'task-writes-1');
    await checkpointer.putWrites(config, [
      ['messages', 'regular-second'],
      ['__interrupt__', { value: 'interrupt-second' }]
    ], 'task-writes-1');

    const loaded = await checkpointer.getTuple(config);

    expect(loaded?.pendingWrites).toEqual([
      ['task-writes-1', 'messages', 'regular-first'],
      ['task-writes-1', '__interrupt__', { value: 'interrupt-second' }]
    ]);
  });
});

function tableExists(connection: Database.Database, tableName: string): boolean {
  const row = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return row !== undefined;
}

function countRows(tableName: string): number {
  return db.prepare(`SELECT COUNT(*) FROM ${tableName}`).pluck().get() as number;
}

function insertAgentHistoryResidue(input: { runId: string; threadId: string; createdAt: string }): void {
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(input.threadId, 'chat', 'Delete thread', 'Delete thread', 'completed', input.createdAt, input.createdAt);
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
      enabled_capabilities_json, workspace_path, task_source, workflow_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.threadId,
    1,
    'Delete thread',
    'completed',
    input.createdAt,
    input.createdAt,
    null,
    'model',
    '{"mcpServers":[],"skills":[]}',
    null,
    null,
    null
  );
  db.prepare(
    `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('event_delete_thread', input.threadId, input.runId, 1, 'message', '{"role":"assistant","content":"delete"}', input.createdAt);
  db.prepare(
    `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('smsg_delete_thread', input.threadId, 'assistant', 'delete thread residue', 10, 'visible', 'workspace_hash', input.createdAt);
  db.prepare(
    `INSERT INTO agent_pending_interrupts
     (run_id, thread_id, interrupt_id, position, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(input.runId, input.threadId, 'interrupt_delete_thread', 0, '{}', input.createdAt, input.createdAt);
  db.prepare('INSERT INTO agent_run_events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run(input.runId, 1, '{"type":"started"}', input.createdAt);
  db.prepare(
    `INSERT INTO langgraph_checkpoints
     (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint_blob, metadata_type, metadata_blob, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.threadId, '', 'checkpoint_delete_thread', null, 'json', Buffer.from('{}'), 'json', Buffer.from('{}'), input.createdAt);
  db.prepare(
    `INSERT INTO langgraph_checkpoint_writes
     (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value_type, value_blob, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.threadId, '', 'checkpoint_delete_thread', 'task_delete_thread', 0, 'messages', 'json', Buffer.from('[]'), input.createdAt);
  db.prepare(
    `INSERT INTO agent_tool_effects
     (run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
      effect_class, reconcile_strategy, status, result_json, error_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.threadId,
    'main',
    'checkpoint_delete_thread',
    'tool_delete_thread',
    'shell',
    'hash_delete_thread',
    'host_execution',
    'manual_confirmation',
    'succeeded',
    '{}',
    null,
    input.createdAt,
    input.createdAt
  );
  db.prepare(
    `INSERT INTO context_artifacts
     (id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars, preview, content, workspace_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'ctx_delete_thread',
    input.runId,
    input.threadId,
    'tool_result',
    'tool_delete_thread',
    'shell',
    'sha_delete_thread',
    19,
    'delete thread residue',
    'delete thread residue',
    'workspace_hash',
    input.createdAt
  );
}
