import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentLangSmithTraceSessionRepository } from '../../../../src/main/plugins/agent/langsmith-trace-session-repository';
import { applyAgentDatabaseSchema as applyAgentPluginSchema } from '../../../../src/main/infrastructure/database-schemas';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyAgentPluginSchema(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES ('thread_trace_session', 'chat', 'Trace', 'Trace', 'waiting_user', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO agent_runs
     (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
     VALUES ('run_trace_session', 'thread_trace_session', 1, 'Trace', 'waiting_user', ?, '{}')`
  ).run(now);
});

afterEach(() => {
  db.close();
});

describe('AgentLangSmithTraceSessionRepository', () => {
  it('round-trips and deletes one strict trace session by Roc run id', () => {
    const repository = new AgentLangSmithTraceSessionRepository(db);
    const session = createSession();

    repository.create(session, '2026-07-26T00:00:01.000Z');

    expect(repository.get(session.runId)).toEqual(session);
    expect(
      db.prepare(
        'SELECT schema_version, created_at, updated_at FROM agent_langsmith_trace_sessions WHERE run_id = ?'
      ).get(session.runId)
    ).toEqual({
      schema_version: 1,
      created_at: '2026-07-26T00:00:01.000Z',
      updated_at: '2026-07-26T00:00:01.000Z'
    });

    repository.delete(session.runId);
    expect(repository.get(session.runId)).toBeNull();
  });

  it('fails closed for corrupt persisted trace identity', () => {
    db.prepare(
      `INSERT INTO agent_langsmith_trace_sessions
       (run_id, schema_version, session_json, created_at, updated_at)
       VALUES ('run_trace_session', 1, '{not-json', ?, ?)`
    ).run('2026-07-26T00:00:01.000Z', '2026-07-26T00:00:01.000Z');

    expect(() => new AgentLangSmithTraceSessionRepository(db).get('run_trace_session')).toThrow(
      'agent_langsmith_trace_session_corrupt'
    );
  });

  it('rejects a session whose root and trace identities diverge', () => {
    const repository = new AgentLangSmithTraceSessionRepository(db);

    expect(() => repository.create({
      ...createSession(),
      traceId: '22222222-2222-4222-8222-222222222222'
    }, '2026-07-26T00:00:01.000Z')).toThrow('agent_langsmith_trace_session_invalid');
    expect(repository.get('run_trace_session')).toBeNull();
  });

  it.each(['cancelled', 'completed', 'failed', 'interrupted'] as const)(
    'lists a %s run with a persisted trace session for startup cleanup',
    (status) => {
      const repository = new AgentLangSmithTraceSessionRepository(db);
      repository.create(createSession(), '2026-07-26T00:00:01.000Z');
      db.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run(status, 'run_trace_session');

      expect(repository.listTerminalRuns()).toEqual([{ runId: 'run_trace_session', status }]);
    }
  );
});

function createSession() {
  return {
    schemaVersion: 1 as const,
    runId: 'run_trace_session',
    threadId: 'thread_trace_session',
    runOrigin: 'chat' as const,
    manifestHash: 'a'.repeat(64),
    appVersion: '0.1.0',
    projectName: 'roc-production',
    rootId: '11111111-1111-4111-8111-111111111111',
    traceId: '11111111-1111-4111-8111-111111111111',
    dottedOrder: '20260726T000000000Z11111111-1111-4111-8111-111111111111',
    startTime: 1_753_488_000_000
  };
}
