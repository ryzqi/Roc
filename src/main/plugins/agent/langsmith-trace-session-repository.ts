import type { Database as DatabaseConnection } from 'better-sqlite3';

import { agentLangSmithTraceSessionSchema } from '../../../shared/schemas/agent';
import type { AgentLangSmithTraceSessionV1 } from '../../../shared/types';

type TraceSessionRow = {
  run_id: string;
  schema_version: number;
  session_json: string;
};

type TerminalTraceSessionRow = {
  run_id: string;
  status: 'cancelled' | 'completed' | 'failed' | 'interrupted';
};

export class AgentLangSmithTraceSessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(value: unknown, createdAt: string): AgentLangSmithTraceSessionV1 {
    const parsed = agentLangSmithTraceSessionSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error('agent_langsmith_trace_session_invalid');
    }
    this.db
      .prepare(
        `INSERT INTO agent_langsmith_trace_sessions
         (run_id, schema_version, session_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(parsed.data.runId, parsed.data.schemaVersion, JSON.stringify(parsed.data), createdAt, createdAt);
    return parsed.data;
  }

  get(runId: string): AgentLangSmithTraceSessionV1 | null {
    const row = this.db
      .prepare(
        `SELECT run_id, schema_version, session_json
         FROM agent_langsmith_trace_sessions
         WHERE run_id = ?`
      )
      .get(runId) as TraceSessionRow | undefined;
    if (row === undefined) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(row.session_json) as unknown;
    } catch {
      throw new Error('agent_langsmith_trace_session_corrupt');
    }
    const parsed = agentLangSmithTraceSessionSchema.safeParse(value);
    if (
      !parsed.success ||
      row.schema_version !== 1 ||
      parsed.data.schemaVersion !== row.schema_version ||
      parsed.data.runId !== row.run_id ||
      row.run_id !== runId
    ) {
      throw new Error('agent_langsmith_trace_session_corrupt');
    }
    return parsed.data;
  }

  listTerminalRuns(): Array<{ runId: string; status: TerminalTraceSessionRow['status'] }> {
    const rows = this.db
      .prepare(
        `SELECT trace_session.run_id, run.status
         FROM agent_langsmith_trace_sessions AS trace_session
         INNER JOIN agent_runs AS run ON run.id = trace_session.run_id
         WHERE run.status IN ('cancelled', 'completed', 'failed', 'interrupted')
         ORDER BY trace_session.created_at ASC, trace_session.run_id ASC`
      )
      .all() as TerminalTraceSessionRow[];
    return rows.map((row) => ({ runId: row.run_id, status: row.status }));
  }

  delete(runId: string): void {
    this.db.prepare('DELETE FROM agent_langsmith_trace_sessions WHERE run_id = ?').run(runId);
  }
}
