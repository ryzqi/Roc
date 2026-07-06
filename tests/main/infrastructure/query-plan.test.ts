import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema, applyTaskDatabaseSchema } from '../../../src/main/infrastructure/database-schemas';
import { assertUsesIndex, explainQueryPlan } from '../../../src/main/infrastructure/query-plan';

let agentDb: Database.Database;
let taskDb: Database.Database;

beforeEach(() => {
  agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  taskDb = new Database(':memory:');
  taskDb.pragma('foreign_keys = ON');
  applyAgentDatabaseSchema(agentDb, () => '2026-07-06T00:00:00.000Z');
  applyTaskDatabaseSchema(taskDb, () => '2026-07-06T00:00:00.000Z');
});

afterEach(() => {
  agentDb.close();
  taskDb.close();
});

describe('query plan helpers', () => {
  it('proves hot agent and task queries use their production indexes', () => {
    assertUsesIndex(
      explainQueryPlan(agentDb, 'SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY run_number DESC LIMIT ?', [
        'thread_1',
        20
      ]),
      'idx_agent_runs_thread_run_number'
    );
    assertUsesIndex(
      explainQueryPlan(
        taskDb,
        'SELECT * FROM scheduled_task_runs WHERE background_task_id = ? ORDER BY scheduled_at DESC LIMIT ?',
        ['task_1', 20]
      ),
      'idx_task_plugin_scheduled_task_runs_task_status'
    );
  });

  it('keeps session message FTS triggers searchable after inserts', () => {
    agentDb
      .prepare(
        `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('thread_1', 'chat', 'title', 'goal', 'completed', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z');
    agentDb
      .prepare(
        `INSERT INTO session_messages (id, thread_id, role, content, phase, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('smsg_1', 'thread_1', 'assistant', 'payment-service evidence', 'visible', '2026-07-06T00:00:00.000Z');

    expect(agentDb.prepare("SELECT COUNT(*) FROM session_messages_fts WHERE session_messages_fts MATCH 'payment'").pluck().get()).toBe(1);
  });

  it('throws explicit errors for empty SQL and missing expected indexes', () => {
    expect(() => explainQueryPlan(agentDb, '')).toThrow('query_plan_sql_empty');
    expect(() => assertUsesIndex([], 'idx_missing')).toThrow('query_plan_index_not_used:idx_missing');
    expect(() => assertUsesIndex([], '')).toThrow('query_plan_index_empty');
  });
});
