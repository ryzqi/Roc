import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection, RunResult } from 'better-sqlite3';

type ToolEffectRow = {
  input_hash: string;
  status: string;
  result_json: string | null;
};

export type ReusableToolEffect = { status: 'success'; result: unknown };

export class AgentToolEffectStore {
  constructor(private readonly db: DatabaseConnection) {
    applyAgentToolEffectSchema(db);
  }

  start(input: {
    runId: string;
    threadId: string;
    toolCallId: string;
    toolName: string;
    inputHash: string;
  }): void {
    requireToolEffectKey(input.runId, 'agent_tool_effect_run_id_missing');
    requireToolEffectKey(input.threadId, 'agent_tool_effect_thread_id_missing');
    requireToolEffectKey(input.toolCallId, 'agent_tool_effect_call_id_missing');
    requireToolEffectKey(input.toolName, 'agent_tool_effect_tool_name_missing');
    requireToolEffectKey(input.inputHash, 'agent_tool_effect_input_hash_missing');

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_tool_effects
         (run_id, thread_id, tool_call_id, tool_name, input_hash, status, result_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`
      )
      .run(input.runId, input.threadId, input.toolCallId, input.toolName, input.inputHash, now, now) as RunResult;
    if (result.changes === 1) {
      return;
    }

    const reusable = this.readReusable({
      runId: input.runId,
      toolCallId: input.toolCallId,
      inputHash: input.inputHash
    });
    if (reusable !== null) {
      throw new Error('agent_tool_effect_already_completed');
    }
    throw new Error('agent_tool_effect_unavailable');
  }

  readReusable(input: { runId: string; toolCallId: string; inputHash: string }): ReusableToolEffect | null {
    requireToolEffectKey(input.runId, 'agent_tool_effect_run_id_missing');
    requireToolEffectKey(input.toolCallId, 'agent_tool_effect_call_id_missing');
    requireToolEffectKey(input.inputHash, 'agent_tool_effect_input_hash_missing');

    const row = this.db
      .prepare(
        `SELECT input_hash, status, result_json
         FROM agent_tool_effects
         WHERE run_id = ? AND tool_call_id = ?`
      )
      .get(input.runId, input.toolCallId) as ToolEffectRow | undefined;
    if (row === undefined) {
      return null;
    }
    if (row.input_hash !== input.inputHash) {
      throw new Error('agent_tool_effect_input_drift');
    }
    if (row.status === 'in_progress') {
      throw new Error('agent_tool_effect_in_progress');
    }
    if (row.status === 'success') {
      if (row.result_json === null) {
        throw new Error('agent_tool_effect_result_missing');
      }
      return {
        status: 'success',
        result: JSON.parse(row.result_json) as unknown
      };
    }
    return null;
  }

  finishSuccess(input: { runId: string; toolCallId: string; result: unknown }): void {
    this.finish({
      runId: input.runId,
      toolCallId: input.toolCallId,
      status: 'success',
      resultJson: JSON.stringify(input.result),
      errorJson: null
    });
  }

  finishError(input: { runId: string; toolCallId: string; error: unknown }): void {
    this.finish({
      runId: input.runId,
      toolCallId: input.toolCallId,
      status: 'error',
      resultJson: null,
      errorJson: JSON.stringify(serializeError(input.error))
    });
  }

  private finish(input: {
    runId: string;
    toolCallId: string;
    status: 'success' | 'error';
    resultJson: string | null;
    errorJson: string | null;
  }): void {
    requireToolEffectKey(input.runId, 'agent_tool_effect_run_id_missing');
    requireToolEffectKey(input.toolCallId, 'agent_tool_effect_call_id_missing');
    const result = this.db
      .prepare(
        `UPDATE agent_tool_effects
         SET status = ?, result_json = ?, error_json = ?, updated_at = ?
         WHERE run_id = ? AND tool_call_id = ?`
      )
      .run(input.status, input.resultJson, input.errorJson, new Date().toISOString(), input.runId, input.toolCallId) as RunResult;
    if (result.changes !== 1) {
      throw new Error('agent_tool_effect_missing');
    }
  }
}

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export function applyAgentToolEffectSchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tool_effects (
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress','success','error','unknown')),
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, tool_call_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tool_effects_thread_updated
      ON agent_tool_effects(thread_id, updated_at DESC);
  `);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue(value[key]);
  }
  return sorted;
}

function requireToolEffectKey(value: unknown, code: string): string {
  if (typeof value !== 'string') {
    throw new Error(code);
  }
  if (value.length === 0) {
    throw new Error(code);
  }
  return value;
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
