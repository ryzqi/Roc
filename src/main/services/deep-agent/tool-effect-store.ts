import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection, RunResult } from 'better-sqlite3';
import type { RunCapabilityEffectClassV1, RunCapabilityReconcileStrategyV1 } from '../../../shared/types';

export type ToolEffectStatus =
  | 'not_started'
  | 'in_progress'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_final'
  | 'unknown';

export type ToolEffectKey = {
  runId: string;
  executionPath: string;
  checkpointId: string;
  toolCallId: string;
};

type ToolEffectRow = {
  input_hash: string;
  status: Exclude<ToolEffectStatus, 'not_started'>;
  result_json: string | null;
  reconcile_strategy: Exclude<RunCapabilityReconcileStrategyV1, 'none'>;
};

export type ReusableToolEffect = { status: 'succeeded'; result: unknown };

export class AgentToolEffectStore {
  constructor(private readonly db: DatabaseConnection) {}

  start(input: ToolEffectKey & {
    threadId: string;
    toolName: string;
    inputHash: string;
    effectClass: Exclude<RunCapabilityEffectClassV1, 'none' | 'network_read'> | 'network_read';
    reconcileStrategy: Exclude<RunCapabilityReconcileStrategyV1, 'none'>;
  }): void {
    validateEffectInput(input);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_tool_effects
         (run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
          effect_class, reconcile_strategy, status, result_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`
      )
      .run(
        input.runId,
        input.threadId,
        input.executionPath,
        input.checkpointId,
        input.toolCallId,
        input.toolName,
        input.inputHash,
        input.effectClass,
        input.reconcileStrategy,
        now,
        now
      ) as RunResult;
    if (result.changes === 1) {
      return;
    }

    const state = this.readRow(input);
    assertInputHash(state, input.inputHash);
    if (state.status === 'failed_retryable') {
      const retry = this.db
        .prepare(
          `UPDATE agent_tool_effects
           SET status = 'in_progress', result_json = NULL, error_json = NULL, updated_at = ?
           WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?
             AND status = 'failed_retryable'`
        )
        .run(now, input.runId, input.executionPath, input.checkpointId, input.toolCallId) as RunResult;
      if (retry.changes === 1) {
        return;
      }
    }
    if (state.status === 'succeeded') {
      throw new Error('agent_tool_effect_already_completed');
    }
    throwEffectUnavailable(state);
  }

  readReusable(input: ToolEffectKey & { inputHash: string }): ReusableToolEffect | null {
    validateKey(input);
    requireToolEffectKey(input.inputHash, 'agent_tool_effect_input_hash_missing');
    const row = this.findRow(input);
    if (row === undefined) {
      return null;
    }
    assertInputHash(row, input.inputHash);
    if (row.status === 'succeeded') {
      if (row.result_json === null) {
        throw new Error('agent_tool_effect_result_missing');
      }
      return {
        status: 'succeeded',
        result: JSON.parse(row.result_json) as unknown
      };
    }
    if (row.status === 'failed_retryable') {
      return null;
    }
    throwEffectUnavailable(row);
  }

  readState(input: ToolEffectKey): { status: ToolEffectStatus } {
    validateKey(input);
    const row = this.findRow(input);
    return { status: row === undefined ? 'not_started' : row.status };
  }

  finishSuccess(input: ToolEffectKey & { result: unknown }): void {
    this.finish({
      ...input,
      status: 'succeeded',
      resultJson: JSON.stringify(input.result),
      errorJson: null
    });
  }

  finishError(input: ToolEffectKey & { error: unknown; retryable: boolean }): void {
    this.finish({
      ...input,
      status: input.retryable ? 'failed_retryable' : 'failed_final',
      resultJson: null,
      errorJson: JSON.stringify(serializeError(input.error))
    });
  }

  finishUnknown(input: ToolEffectKey & { error: unknown }): void {
    this.finish({
      ...input,
      status: 'unknown',
      resultJson: null,
      errorJson: JSON.stringify(serializeError(input.error))
    });
  }

  private finish(input: ToolEffectKey & {
    status: 'succeeded' | 'failed_retryable' | 'failed_final' | 'unknown';
    resultJson: string | null;
    errorJson: string | null;
  }): void {
    validateKey(input);
    const result = this.db
      .prepare(
        `UPDATE agent_tool_effects
         SET status = ?, result_json = ?, error_json = ?, updated_at = ?
         WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?
           AND status = 'in_progress'`
      )
      .run(
        input.status,
        input.resultJson,
        input.errorJson,
        new Date().toISOString(),
        input.runId,
        input.executionPath,
        input.checkpointId,
        input.toolCallId
      ) as RunResult;
    if (result.changes !== 1) {
      throw new Error('agent_tool_effect_transition_invalid');
    }
  }

  private findRow(input: ToolEffectKey): ToolEffectRow | undefined {
    return this.db
      .prepare(
        `SELECT input_hash, status, result_json, reconcile_strategy
         FROM agent_tool_effects
         WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?`
      )
      .get(input.runId, input.executionPath, input.checkpointId, input.toolCallId) as ToolEffectRow | undefined;
  }

  private readRow(input: ToolEffectKey): ToolEffectRow {
    const row = this.findRow(input);
    if (row === undefined) {
      throw new Error('agent_tool_effect_missing');
    }
    return row;
  }
}

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function validateEffectInput(input: Parameters<AgentToolEffectStore['start']>[0]): void {
  validateKey(input);
  requireToolEffectKey(input.threadId, 'agent_tool_effect_thread_id_missing');
  requireToolEffectKey(input.toolName, 'agent_tool_effect_tool_name_missing');
  requireToolEffectKey(input.inputHash, 'agent_tool_effect_input_hash_missing');
}

function validateKey(input: ToolEffectKey): void {
  requireToolEffectKey(input.runId, 'agent_tool_effect_run_id_missing');
  requireToolEffectKey(input.executionPath, 'agent_tool_effect_execution_path_missing');
  requireToolEffectKey(input.checkpointId, 'agent_tool_effect_checkpoint_id_missing');
  requireToolEffectKey(input.toolCallId, 'agent_tool_effect_call_id_missing');
}

function assertInputHash(row: ToolEffectRow, inputHash: string): void {
  if (row.input_hash !== inputHash) {
    throw new Error('agent_tool_effect_input_drift');
  }
}

function throwEffectUnavailable(row: ToolEffectRow): never {
  if (row.status === 'in_progress') {
    throw new Error('agent_tool_effect_in_progress');
  }
  if (row.status === 'unknown') {
    throw new Error(`agent_tool_effect_unknown_${row.reconcile_strategy}`);
  }
  if (row.status === 'failed_final') {
    throw new Error('agent_tool_effect_failed_final');
  }
  throw new Error('agent_tool_effect_unavailable');
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
  if (typeof value !== 'string' || value.length === 0) {
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
