import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EnabledCapabilities } from '../../../../src/shared/types';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import { AgentSessionRepository } from '../../../../src/main/plugins/agent/session-repository';

let db: Database.Database;

const enabledCapabilities: EnabledCapabilities = {
  mcpServers: ['filesystem'],
  skills: ['typescript']
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('AgentSessionRepository', () => {
  it('applies the migrated agent tables with current column names', () => {
    applyAgentPluginSchema(db);

    expect(columnNames('task_runs')).toContain('thread_id');
    expect(columnNames('task_events')).toContain('run_id');
    expect(columnNames('task_events')).toContain('payload_json');
    expect(columnNames('session_messages')).toContain('phase');
  });

  it('reads and writes task threads, task runs, task events, and session messages', () => {
    applyAgentPluginSchema(db);
    const repository = new AgentSessionRepository(db);

    const run = repository.createTaskRun({
      enabledCapabilities,
      modelId: 'openai:gpt-4.1',
      userInput: 'Summarize this workspace'
    });
    const event = repository.recordEvent({
      payload: { delta: 'Working' },
      runId: run.id,
      threadId: run.threadId,
      type: 'message_delta'
    });
    const message = repository.recordSessionMessage({
      content: 'Compaction note',
      phase: 'pre_compaction_flush',
      role: 'system',
      threadId: run.threadId,
      tokenCount: 12
    });

    expect(repository.getRun(run.id)).toEqual(run);
    const events = repository.listThreadEvents(run.threadId);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      payload: {
        content: 'Summarize this workspace',
        enabledCapabilities,
        role: 'user'
      },
      runId: run.id,
      threadId: run.threadId,
      type: 'message'
    });
    expect(events[1]).toEqual(event);
    expect(repository.listSessionMessages({ threadId: run.threadId })).toEqual([message]);
    expect(rawRow('task_runs', run.id)).toMatchObject({
      enabled_capabilities_json: JSON.stringify(enabledCapabilities),
      model_id: 'openai:gpt-4.1',
      thread_id: run.threadId
    });
    expect(rawRow('task_events', event.id)).toMatchObject({
      payload_json: JSON.stringify({ delta: 'Working' }),
      run_id: run.id,
      thread_id: run.threadId
    });
    expect(rawRow('session_messages', message.id)).toMatchObject({
      phase: 'pre_compaction_flush',
      thread_id: run.threadId,
      token_count: 12
    });
  });
});

function columnNames(tableName: string): string[] {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function rawRow(tableName: string, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as Record<string, unknown>;
}
