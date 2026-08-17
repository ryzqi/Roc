import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRunEventLog } from '../../../../src/main/plugins/agent/run-event-log';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('thread_1', 'chat', 'Run event test', 'Run event test', 'waiting_next_turn', '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z');
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
      enabled_capabilities_json, workspace_path, task_source, workflow_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'run_1',
    'thread_1',
    1,
    'Run event test',
    'waiting_next_turn',
    '2026-07-03T00:00:00.000Z',
    null,
    'openai',
    'openai:gpt-4.1',
    '{"mcpServers":[],"skills":[]}',
    null,
    null,
    null
  );
});

afterEach(() => {
  db.close();
});

describe('AgentRunEventLog', () => {
  it('does not create run event tables during construction', () => {
    const isolatedDb = new Database(':memory:');
    try {
      new AgentRunEventLog(isolatedDb);

      expect(tableExists(isolatedDb, 'agent_run_events')).toBe(false);
    } finally {
      isolatedDb.close();
    }
  });

  it('assigns increasing per-run sequence numbers and replays after a sequence', () => {
    const log = new AgentRunEventLog(db);
    const first = log.recordRunEvent({
      type: 'run_started',
      runId: 'run_1',
      mode: 'chat',
      threadId: 'thread_1',
      providerId: 'openai',
      modelId: 'openai:gpt-4.1',
      createdAt: '2026-07-03T00:00:00.000Z'
    });
    const second = log.recordRunEvent({
      type: 'assistant_block',
      runId: 'run_1',
      block: {
        kind: 'text',
        blockId: 'text-run_1',
        phase: 'delta',
        text: 'partial'
      }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(
      db.prepare('SELECT next_sequence FROM agent_run_event_cursors WHERE run_id = ?').get('run_1')
    ).toEqual({ next_sequence: 3 });
    expect(log.listRunEvents({ runId: 'run_1', afterSequence: 1 })).toEqual([second]);
  });

  it('restores persisted sequences and advances the append cursor', () => {
    const log = new AgentRunEventLog(db);
    log.restoreRunEvent({
      runId: 'run_1',
      sequence: 7,
      eventJson: JSON.stringify({
        type: 'assistant_block',
        runId: 'run_1',
        block: { kind: 'text', blockId: 'restored', phase: 'delta', text: 'restored' }
      }),
      createdAt: '2026-07-03T00:00:07.000Z'
    });

    const appended = log.recordRunEvent({
      type: 'assistant_block',
      runId: 'run_1',
      block: { kind: 'text', blockId: 'appended', phase: 'delta', text: 'appended' }
    });

    expect(appended.sequence).toBe(8);
    expect(log.listRunEvents({ runId: 'run_1', afterSequence: 0 }).map((event) => event.sequence)).toEqual([7, 8]);
  });

  it('deletes run events and their cursors through the owner API', () => {
    const log = new AgentRunEventLog(db);
    log.recordRunEvent({
      type: 'assistant_block',
      runId: 'run_1',
      block: { kind: 'text', blockId: 'deleted', phase: 'delta', text: 'deleted' }
    });

    expect(log.deleteForRunIds(['run_1'])).toBe(1);
    expect(log.listRunEvents({ runId: 'run_1', afterSequence: 0 })).toEqual([]);
    expect(db.prepare('SELECT next_sequence FROM agent_run_event_cursors WHERE run_id = ?').get('run_1')).toBeUndefined();
  });
});

function tableExists(connection: Database.Database, tableName: string): boolean {
  const row = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return row !== undefined;
}
