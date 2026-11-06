import { createHash, randomUUID } from 'node:crypto';
import type { Database as DatabaseConnection, RunResult } from 'better-sqlite3';
import type { RunCapabilityEffectClassV1, RunCapabilityReconcileStrategyV1 } from '../../../shared/types';
import type { CapabilityOperationReceipt } from '../../kernel/capability-operation-context';

export type ToolEffectStatus =
  | 'reserved'
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

export type ToolEffectOperationInput = ToolEffectKey & {
  threadId: string;
  toolName: string;
  canonicalToolIdentity: string;
  toolVersion: string;
  args: unknown;
  effectClass: Exclude<RunCapabilityEffectClassV1, 'none'>;
  reconcileStrategy: Exclude<RunCapabilityReconcileStrategyV1, 'none'>;
};

export type ToolEffectIdentityV1 = Readonly<{
  identityVersion: 1;
  canonicalizationVersion: 'roc-json-sort-v1';
  operationId: string;
  idempotencyKey: string;
  parameterHash: string;
}>;

export type ToolEffectLease = ToolEffectKey & ToolEffectIdentityV1 & {
  threadId: string;
  toolName: string;
  canonicalToolIdentity: string;
  toolVersion: string;
  attemptId: string;
  leaseGeneration: number;
};

export type ToolEffectStartResult =
  | { kind: 'execute'; lease: ToolEffectLease }
  | { kind: 'replay'; result: JsonValue; operationId: string };

export type RecordedToolReplay =
  | { kind: 'recorded'; result: JsonValue; operationId: string; receiptHash: string }
  | { kind: 'unavailable'; reason: 'not_found' | 'not_succeeded' | 'legacy_identity' | 'receipt_missing' | 'result_missing' | 'result_unverified' };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ToolEffectResolutionReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: 'resolution';
  source: 'operator' | 'provider' | 'filesystem_verifier';
  outcome: 'applied' | 'not_applied';
  operationId: string;
  reference: string;
  evidenceHash: string;
  recordedAt: string;
}>;

export type ToolEffectState = Readonly<{
  status: ToolEffectStatus;
  identityVersion: number;
  operationId: string | null;
  attemptId: string | null;
  leaseGeneration: number;
  attemptCount: number;
  receipt: CapabilityOperationReceipt | ToolEffectResolutionReceiptV1 | null;
  receiptHash: string | null;
  expectedVersion: string | null;
  resultHash: string | null;
}>;

type ToolEffectRow = {
  run_id: string;
  thread_id: string;
  execution_path: string;
  checkpoint_id: string;
  tool_call_id: string;
  tool_name: string;
  input_hash: string;
  effect_class: string;
  reconcile_strategy: string;
  status: Exclude<ToolEffectStatus, 'not_started'>;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  identity_version: number;
  canonical_tool_identity: string | null;
  canonicalization_version: string | null;
  tool_version: string | null;
  operation_id: string | null;
  idempotency_key: string | null;
  attempt_id: string | null;
  lease_generation: number;
  attempt_count: number;
  receipt_sequence: number;
  receipt_json: string | null;
  receipt_hash: string | null;
  expected_version: string | null;
  result_hash: string | null;
};

type ReconciliationRow = {
  sequence: number;
  run_id: string;
  execution_path: string;
  checkpoint_id: string;
  tool_call_id: string;
  input_hash: string;
  evidence: string;
  outcome: 'applied' | 'not_applied';
  created_at: string;
  operation_id: string | null;
  identity_version: number;
  lease_generation: number;
  receipt_json: string | null;
  receipt_hash: string | null;
};

const IDENTITY_VERSION = 1 as const;
const CANONICALIZATION_VERSION = 'roc-json-sort-v1' as const;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class AgentToolEffectStore {
  constructor(private readonly db: DatabaseConnection) {}

  beginOperation(input: ToolEffectOperationInput): ToolEffectStartResult {
    validateOperationInput(input);
    const identity = createToolEffectIdentity(input);
    const now = new Date().toISOString();
    const newAttemptId = randomUUID();

    return this.db.transaction((): ToolEffectStartResult => {
      const row = this.findRow(input);
      if (row === undefined) {
        this.db.prepare(
          `INSERT INTO agent_tool_effects (
            run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
            effect_class, reconcile_strategy, status, result_json, error_json, created_at, updated_at,
            identity_version, canonical_tool_identity, canonicalization_version, tool_version,
            operation_id, idempotency_key, attempt_id, lease_generation, attempt_count,
            receipt_sequence, receipt_json, receipt_hash, expected_version, result_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, NULL, NULL)`
        ).run(
          input.runId,
          input.threadId,
          input.executionPath,
          input.checkpointId,
          input.toolCallId,
          input.toolName,
          identity.parameterHash,
          input.effectClass,
          input.reconcileStrategy,
          now,
          now,
          identity.identityVersion,
          input.canonicalToolIdentity,
          identity.canonicalizationVersion,
          input.toolVersion,
          identity.operationId,
          identity.idempotencyKey,
          newAttemptId
        );
        return { kind: 'execute', lease: createLease(input, identity, newAttemptId, 1) };
      }

      assertOperationMetadata(row, input, identity);
      if (row.identity_version !== IDENTITY_VERSION) throw new Error('agent_tool_effect_legacy_identity_unverified');
      assertStoredIdentity(row, identity);

      if (row.status === 'succeeded') {
        const recorded = this.replayRecordedOperation(input);
        if (recorded.kind !== 'recorded') throw new Error(`agent_tool_effect_${recorded.reason}`);
        return {kind: 'replay', result: recorded.result, operationId: recorded.operationId};
      }
      if (row.status === 'failed_retryable') {
        const nextGeneration = row.lease_generation + 1;
        const result = this.db.prepare(
          `UPDATE agent_tool_effects
           SET status = 'reserved', result_json = NULL, error_json = NULL, attempt_id = ?,
               lease_generation = ?, attempt_count = attempt_count + 1, updated_at = ?
           WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?
             AND operation_id = ? AND lease_generation = ? AND status = 'failed_retryable'`
        ).run(
          newAttemptId,
          nextGeneration,
          now,
          input.runId,
          input.executionPath,
          input.checkpointId,
          input.toolCallId,
          identity.operationId,
          row.lease_generation
        ) as RunResult;
        if (result.changes === 1) {
          return { kind: 'execute', lease: createLease(input, identity, newAttemptId, nextGeneration) };
        }
        throw new Error('agent_tool_effect_lease_lost');
      }
      throwEffectUnavailable(row);
    }).immediate();
  }

  markStarted(lease: ToolEffectLease): void {
    validateLease(lease);
    const result = this.db.prepare(
      `UPDATE agent_tool_effects SET status = 'in_progress', updated_at = ?
       WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?
         AND operation_id = ? AND attempt_id = ? AND lease_generation = ? AND status = 'reserved'`
    ).run(
      new Date().toISOString(),
      lease.runId,
      lease.executionPath,
      lease.checkpointId,
      lease.toolCallId,
      lease.operationId,
      lease.attemptId,
      lease.leaseGeneration
    ) as RunResult;
    if (result.changes !== 1) {
      throw new Error('agent_tool_effect_lease_lost');
    }
  }

  recordReceipt(lease: ToolEffectLease, receiptInput: CapabilityOperationReceipt): void {
    validateLease(lease);
    const receipt = parseCapabilityOperationReceipt(receiptInput);
    if (receipt.kind === 'capability' && receipt.idempotencyKey !== lease.idempotencyKey) {
      throw new Error('agent_tool_effect_receipt_mismatch');
    }
    const receiptJson = stableStringify(receipt);
    const receiptHash = hashToolInput(receipt);
    const expectedVersion = receipt.kind === 'workspace_write' ? receipt.expectedVersion : null;
    const resultHash = receipt.kind === 'workspace_write' ? receipt.resultHash : null;
    const result = this.db.prepare(
      `UPDATE agent_tool_effects
       SET receipt_sequence = receipt_sequence + 1, receipt_json = ?, receipt_hash = ?,
           expected_version = ?, result_hash = ?, updated_at = ?
       WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?
         AND operation_id = ? AND attempt_id = ? AND lease_generation = ? AND status = 'in_progress'`
    ).run(
      receiptJson,
      receiptHash,
      expectedVersion,
      resultHash,
      new Date().toISOString(),
      lease.runId,
      lease.executionPath,
      lease.checkpointId,
      lease.toolCallId,
      lease.operationId,
      lease.attemptId,
      lease.leaseGeneration
    ) as RunResult;
    if (result.changes !== 1) {
      throw new Error('agent_tool_effect_lease_lost');
    }
  }

  reconcile(input: {
    operation: ToolEffectOperationInput;
    expectedLeaseGeneration: number;
    receipt: ToolEffectResolutionReceiptV1;
    result?: unknown;
  }): void {
    validateOperationInput(input.operation);
    parseResolutionReceipt(input.receipt);
    if (!Number.isSafeInteger(input.expectedLeaseGeneration) || input.expectedLeaseGeneration < 0) {
      throw new Error('agent_tool_effect_reconcile_generation_invalid');
    }
    const identity = createToolEffectIdentity(input.operation);
    if (input.receipt.operationId !== identity.operationId) {
      throw new Error('agent_tool_effect_receipt_mismatch');
    }
    if (input.receipt.outcome === 'applied' && input.result === undefined) {
      throw new Error('agent_tool_effect_receipt_result_required');
    }

    this.db.transaction(() => {
      const row = this.readRow(input.operation);
      assertOperationMetadata(row, input.operation, identity);
      if (row.identity_version !== IDENTITY_VERSION) throw new Error('agent_tool_effect_legacy_identity_unverified');
      assertStoredIdentity(row, identity);
      if (row.status !== 'unknown') {
        throw new Error('agent_tool_effect_reconcile_not_unknown');
      }
      if (row.lease_generation !== input.expectedLeaseGeneration) {
        throw new Error('agent_tool_effect_reconcile_generation_drift');
      }

      const receiptJson = stableStringify(input.receipt);
      const receiptHash = hashToolInput(input.receipt);
      const now = new Date().toISOString();
      const nextStatus = input.receipt.outcome === 'applied' ? 'succeeded' : 'failed_retryable';
      const resultJson = input.receipt.outcome === 'applied' ? stableStringify(input.result) : null;
      const resultHash = input.receipt.outcome === 'applied' ? hashToolInput(input.result) : null;
      const updated = this.db.prepare(
        `UPDATE agent_tool_effects
         SET identity_version = ?, canonical_tool_identity = ?, canonicalization_version = ?, tool_version = ?,
             operation_id = ?, idempotency_key = ?, status = ?, result_json = ?, error_json = NULL,
             attempt_id = NULL, lease_generation = lease_generation + 1,
             receipt_sequence = receipt_sequence + 1, receipt_json = ?, receipt_hash = ?,
             result_hash = ?, updated_at = ?
         WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?
           AND lease_generation = ? AND status = 'unknown'`
      ).run(
        identity.identityVersion,
        input.operation.canonicalToolIdentity,
        identity.canonicalizationVersion,
        input.operation.toolVersion,
        identity.operationId,
        identity.idempotencyKey,
        nextStatus,
        resultJson,
        receiptJson,
        receiptHash,
        resultHash,
        now,
        input.operation.runId,
        input.operation.executionPath,
        input.operation.checkpointId,
        input.operation.toolCallId,
        input.expectedLeaseGeneration
      ) as RunResult;
      if (updated.changes !== 1) {
        throw new Error('agent_tool_effect_reconcile_generation_drift');
      }
      if (input.receipt.outcome === 'applied' && input.receipt.evidenceHash === resultHash) {
        this.saveResultReceipt(input.operation, input.result);
      }
      this.db.prepare(
        `INSERT INTO agent_tool_effect_reconciliations (
           run_id, execution_path, checkpoint_id, tool_call_id, input_hash, evidence, outcome, created_at,
           operation_id, identity_version, lease_generation, receipt_json, receipt_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.operation.runId,
        input.operation.executionPath,
        input.operation.checkpointId,
        input.operation.toolCallId,
        identity.parameterHash,
        receiptJson,
        input.receipt.outcome,
        now,
        identity.operationId,
        identity.identityVersion,
        input.expectedLeaseGeneration,
        receiptJson,
        receiptHash
      );
    }).immediate();
  }

  /** Read a verified recorded result without reserving an attempt or invoking a tool. */
  replayRecordedOperation(input: ToolEffectOperationInput): RecordedToolReplay {
    validateOperationInput(input);
    const row = this.findRow(input);
    if (row === undefined) return { kind: 'unavailable', reason: 'not_found' };
    const identity = createToolEffectIdentity(input);
    assertOperationMetadata(row, input, identity);
    if (row.identity_version !== IDENTITY_VERSION) return { kind: 'unavailable', reason: 'legacy_identity' };
    assertStoredIdentity(row, identity);
    if (row.status !== 'succeeded') return { kind: 'unavailable', reason: 'not_succeeded' };
    const saved = this.db.prepare('SELECT receipt_json,receipt_hash FROM agent_tool_effect_results WHERE operation_id = ?')
      .get(identity.operationId) as {receipt_json: string; receipt_hash: string} | undefined;
    if (saved === undefined) return {kind: 'unavailable', reason: 'receipt_missing'};
    const receipt = parseJsonValue(saved.receipt_json);
    if (!isRecord(receipt) || hashToolInput(receipt) !== saved.receipt_hash || receipt.schemaVersion !== 1 ||
        receipt.operationId !== identity.operationId || receipt.inputHash !== identity.parameterHash ||
        receipt.generation !== row.lease_generation || receipt.providerReceiptHash !== row.receipt_hash) throw new Error('agent_tool_effect_receipt_corrupt');
    if (row.receipt_json !== null) parseStoredReceipt(row.receipt_json, row.receipt_hash);
    if (row.result_json === null) return {kind: 'unavailable', reason: 'result_missing'};
    const result = parseJsonValue(row.result_json);
    if (receipt.resultHash !== hashToolInput(result)) throw new Error('agent_tool_effect_result_corrupt');
    return {kind: 'recorded', result, operationId: identity.operationId, receiptHash: saved.receipt_hash};
  }

  readState(input: ToolEffectKey): ToolEffectState {
    validateKey(input);
    const row = this.findRow(input);
    if (row === undefined) {
      return {
        status: 'not_started',
        identityVersion: 0,
        operationId: null,
        attemptId: null,
        leaseGeneration: 0,
        attemptCount: 0,
        receipt: null,
        receiptHash: null,
        expectedVersion: null,
        resultHash: null
      };
    }
    return {
      status: row.status,
      identityVersion: row.identity_version,
      operationId: row.operation_id,
      attemptId: row.attempt_id,
      leaseGeneration: row.lease_generation,
      attemptCount: row.attempt_count,
      receipt: row.receipt_json === null ? null : parseStoredReceipt(row.receipt_json, row.receipt_hash),
      receiptHash: row.receipt_hash,
      expectedVersion: row.expected_version,
      resultHash: row.result_hash
    };
  }

  markRestartedUnknown(runId: string): void {
    requireToolEffectKey(runId, 'agent_tool_effect_run_id_missing');
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE agent_tool_effects
         SET status = 'unknown', attempt_id = NULL, lease_generation = lease_generation + 1,
             error_json = COALESCE(error_json, ?), updated_at = ?
         WHERE run_id = ? AND (status = 'in_progress' OR (status = 'failed_retryable' AND reconcile_strategy = 'manual_confirmation'))`
      ).run(JSON.stringify({ code: 'agent_tool_effect_interrupted_at_restart' }), now, runId);
      this.db.prepare(
        `UPDATE agent_tool_effects
         SET status = 'failed_retryable', attempt_id = NULL, lease_generation = lease_generation + 1,
             error_json = COALESCE(error_json, ?), updated_at = ?
         WHERE run_id = ? AND status = 'reserved'`
      ).run(JSON.stringify({ code: 'agent_tool_effect_not_dispatched_at_restart' }), now, runId);
    }).immediate();
  }

  hasUnknown(runId: string): boolean {
    requireToolEffectKey(runId, 'agent_tool_effect_run_id_missing');
    const row = this.db
      .prepare("SELECT 1 AS found FROM agent_tool_effects WHERE run_id = ? AND status IN ('reserved','in_progress','unknown') LIMIT 1")
      .get(runId) as { found: number } | undefined;
    return row !== undefined;
  }

  restoreFrom(source: DatabaseConnection | null): void {
    if (source === null) {
      return;
    }
    const effectColumns = readSourceTableColumns(source, 'effects');
    if (effectColumns.size === 0) {
      return;
    }
    if (!effectColumns.has('identity_version') || !source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_tool_effect_results'").get()) {
      throw new Error('agent_tool_effect_restore_schema_invalid');
    }
    const effectRows = readEffectSourceRows(source);
    const resultReceipts = source.prepare('SELECT operation_id, receipt_json, receipt_hash FROM agent_tool_effect_results').all() as Array<{operation_id: string; receipt_json: string; receipt_hash: string}>;
    const reconciliationColumns = readSourceTableColumns(source, 'reconciliations');
    const reconciliationRows = reconciliationColumns.size === 0 ? [] : readReconciliationSourceRows(source);

    this.db.transaction(() => {
      const insertEffect = this.db.prepare(
        `INSERT OR IGNORE INTO agent_tool_effects (
          run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
          effect_class, reconcile_strategy, status, result_json, error_json, created_at, updated_at,
          identity_version, canonical_tool_identity, canonicalization_version, tool_version,
          operation_id, idempotency_key, attempt_id, lease_generation, attempt_count,
          receipt_sequence, receipt_json, receipt_hash, expected_version, result_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of effectRows) {
        if (row.identity_version !== 1) throw new Error('agent_tool_effect_legacy_identity_unverified');
        const status = normalizeRestoredStatus(row.status, row.reconcile_strategy);
        const leaseGeneration = row.status === 'succeeded' ? row.lease_generation : row.lease_generation + 1;
        const attemptId = null;
        const errorJson = status === row.status ? row.error_json : JSON.stringify({ code: 'agent_tool_effect_restored_unresolved' });
        insertEffect.run(
          row.run_id,
          row.thread_id,
          row.execution_path,
          row.checkpoint_id,
          row.tool_call_id,
          row.tool_name,
          row.input_hash,
          row.effect_class,
          row.reconcile_strategy,
          status,
          row.result_json,
          errorJson,
          row.created_at,
          row.updated_at,
          row.identity_version,
          row.canonical_tool_identity,
          row.canonicalization_version,
          row.tool_version,
          row.operation_id,
          row.idempotency_key,
          attemptId,
          leaseGeneration,
          row.attempt_count,
          row.receipt_sequence,
          row.receipt_json,
          row.receipt_hash,
          row.expected_version,
          row.result_hash
        );
      }

      for (const row of resultReceipts) {
        if (hashToolInput(parseJsonValue(row.receipt_json)) !== row.receipt_hash) throw new Error('agent_tool_effect_receipt_corrupt');
        const saved = this.db.prepare('SELECT receipt_hash FROM agent_tool_effect_results WHERE operation_id = ?').get(row.operation_id) as {receipt_hash: string} | undefined;
        if (saved !== undefined && saved.receipt_hash !== row.receipt_hash) throw new Error('agent_tool_effect_restore_conflict');
        this.db.prepare('INSERT OR IGNORE INTO agent_tool_effect_results(operation_id,receipt_json,receipt_hash) VALUES(?,?,?)')
          .run(row.operation_id, row.receipt_json, row.receipt_hash);
      }
      const insertReconciliation = this.db.prepare(
        `INSERT OR IGNORE INTO agent_tool_effect_reconciliations (
          sequence, run_id, execution_path, checkpoint_id, tool_call_id, input_hash, evidence, outcome, created_at,
          operation_id, identity_version, lease_generation, receipt_json, receipt_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of reconciliationRows) {
        insertReconciliation.run(
          row.sequence,
          row.run_id,
          row.execution_path,
          row.checkpoint_id,
          row.tool_call_id,
          row.input_hash,
          row.evidence,
          row.outcome,
          row.created_at,
          row.operation_id,
          row.identity_version,
          row.lease_generation,
          row.receipt_json,
          row.receipt_hash
        );
      }
    }).immediate();
  }

  deleteForRunIds(runIds: readonly string[]): number {
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length === 0) {
      return 0;
    }
    return this.db.transaction(() => {
      let deleted = 0;
      for (const runId of uniqueRunIds) {
        this.assertNoUnresolvedRun(runId);
        this.db.prepare('DELETE FROM agent_tool_effect_results WHERE operation_id IN (SELECT operation_id FROM agent_tool_effects WHERE run_id = ?)').run(runId);
        this.db.prepare('DELETE FROM agent_tool_effect_reconciliations WHERE run_id = ?').run(runId);
        deleted += this.db.prepare('DELETE FROM agent_tool_effects WHERE run_id = ?').run(runId).changes;
      }
      return deleted;
    }).immediate();
  }

  deleteForThread(threadId: string): number {
    requireToolEffectKey(threadId, 'agent_tool_effect_thread_id_missing');
    return this.db.transaction(() => {
      this.assertNoUnresolvedThread(threadId);
      this.db.prepare('DELETE FROM agent_tool_effect_results WHERE operation_id IN (SELECT operation_id FROM agent_tool_effects WHERE thread_id = ?)').run(threadId);
      this.db.prepare('DELETE FROM agent_tool_effect_reconciliations WHERE run_id IN (SELECT run_id FROM agent_tool_effects WHERE thread_id = ?)').run(threadId);
      return this.db.prepare('DELETE FROM agent_tool_effects WHERE thread_id = ?').run(threadId).changes;
    }).immediate();
  }

  finishSuccess(lease: ToolEffectLease, result: unknown): void {
    this.db.transaction(() => {
      this.finish(lease, 'succeeded', stableStringify(result), null);
      this.saveResultReceipt(lease, result);
    }).immediate();
  }

  private saveResultReceipt(key: ToolEffectKey, result: unknown): void {
    const row = this.readRow(key);
    if (row.identity_version !== 1 || row.operation_id === null) throw new Error('agent_tool_effect_legacy_identity_unverified');
    const receipt = {schemaVersion: 1, operationId: row.operation_id, inputHash: row.input_hash,
      generation: row.lease_generation, resultHash: hashToolInput(result), providerReceiptHash: row.receipt_hash};
    this.db.prepare('INSERT INTO agent_tool_effect_results(operation_id,receipt_json,receipt_hash) VALUES(?,?,?)')
      .run(row.operation_id, stableStringify(receipt), hashToolInput(receipt));
  }

  finishError(lease: ToolEffectLease, error: unknown, retryable: boolean): void {
    validateLease(lease);
    const row = this.readRow(lease);
    let status: 'unknown' | 'failed_retryable' | 'failed_final';
    if (!retryable) {
      status = 'failed_final';
    } else if (row.reconcile_strategy === 'manual_confirmation') {
      status = 'unknown';
    } else {
      status = 'failed_retryable';
    }
    this.finish(lease, status, null, stableStringify(serializeError(error)));
  }

  finishUnknown(lease: ToolEffectLease, error: unknown): void {
    this.finish(lease, 'unknown', null, stableStringify(serializeError(error)));
  }

  private finish(
    lease: ToolEffectLease,
    status: 'succeeded' | 'failed_retryable' | 'failed_final' | 'unknown',
    resultJson: string | null,
    errorJson: string | null
  ): void {
    validateLease(lease);
    const result = this.db.prepare(
      `UPDATE agent_tool_effects
       SET status = ?, result_json = ?, error_json = ?, attempt_id = NULL, updated_at = ?
       WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?
         AND operation_id = ? AND attempt_id = ? AND lease_generation = ? AND status = 'in_progress'`
    ).run(
      status,
      resultJson,
      errorJson,
      new Date().toISOString(),
      lease.runId,
      lease.executionPath,
      lease.checkpointId,
      lease.toolCallId,
      lease.operationId,
      lease.attemptId,
      lease.leaseGeneration
    ) as RunResult;
    if (result.changes !== 1) {
      throw new Error('agent_tool_effect_lease_lost');
    }
  }

  private assertNoUnresolvedRun(runId: string): void {
    const row = this.db.prepare("SELECT 1 AS found FROM agent_tool_effects WHERE run_id = ? AND status IN ('reserved','in_progress','unknown') LIMIT 1").get(runId);
    if (row !== undefined) {
      throw new Error('agent_tool_effect_pending_reconciliation');
    }
  }

  private assertNoUnresolvedThread(threadId: string): void {
    const row = this.db.prepare("SELECT 1 AS found FROM agent_tool_effects WHERE thread_id = ? AND status IN ('reserved','in_progress','unknown') LIMIT 1").get(threadId);
    if (row !== undefined) {
      throw new Error('agent_tool_effect_pending_reconciliation');
    }
  }

  private findRow(input: ToolEffectKey): ToolEffectRow | undefined {
    return this.db.prepare(
      `SELECT run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
              effect_class, reconcile_strategy, status, result_json, error_json, created_at, updated_at,
              identity_version, canonical_tool_identity, canonicalization_version, tool_version,
              operation_id, idempotency_key, attempt_id, lease_generation, attempt_count,
              receipt_sequence, receipt_json, receipt_hash, expected_version, result_hash
       FROM agent_tool_effects
       WHERE run_id = ? AND execution_path = ? AND checkpoint_id = ? AND tool_call_id = ?`
    ).get(input.runId, input.executionPath, input.checkpointId, input.toolCallId) as ToolEffectRow | undefined;
  }

  private readRow(input: ToolEffectKey): ToolEffectRow {
    const row = this.findRow(input);
    if (row === undefined) {
      throw new Error('agent_tool_effect_missing');
    }
    return row;
  }
}

export function createToolEffectIdentity(input: ToolEffectOperationInput): ToolEffectIdentityV1 {
  const parameterHash = hashToolInput({ args: input.args, name: input.toolName });
  const operationId = hashToolInput({
    identityVersion: IDENTITY_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    runId: input.runId,
    threadId: input.threadId,
    executionPath: input.executionPath,
    checkpointId: input.checkpointId,
    toolCallId: input.toolCallId,
    canonicalToolIdentity: input.canonicalToolIdentity,
    toolVersion: input.toolVersion,
    parameterHash
  });
  return Object.freeze({
    identityVersion: IDENTITY_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    operationId,
    idempotencyKey: `roc-tool-effect-v${IDENTITY_VERSION}:${operationId}`,
    parameterHash
  });
}

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function createLease(
  input: ToolEffectOperationInput,
  identity: ToolEffectIdentityV1,
  attemptId: string,
  leaseGeneration: number
): ToolEffectLease {
  return Object.freeze({
    runId: input.runId,
    threadId: input.threadId,
    executionPath: input.executionPath,
    checkpointId: input.checkpointId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    canonicalToolIdentity: input.canonicalToolIdentity,
    toolVersion: input.toolVersion,
    ...identity,
    attemptId,
    leaseGeneration
  });
}

function assertOperationMetadata(row: ToolEffectRow, input: ToolEffectOperationInput, identity: ToolEffectIdentityV1): void {
  if (row.thread_id !== input.threadId || row.tool_name !== input.toolName || row.input_hash !== identity.parameterHash) {
    throw new Error('agent_tool_effect_input_drift');
  }
  if (row.effect_class !== input.effectClass || row.reconcile_strategy !== input.reconcileStrategy) {
    throw new Error('agent_tool_effect_identity_drift');
  }
}

function assertStoredIdentity(row: ToolEffectRow, identity: ToolEffectIdentityV1): void {
  if (row.identity_version !== identity.identityVersion || row.operation_id !== identity.operationId ||
      row.idempotency_key !== identity.idempotencyKey || row.canonicalization_version !== identity.canonicalizationVersion) {
    throw new Error('agent_tool_effect_identity_drift');
  }
}

function validateOperationInput(input: ToolEffectOperationInput): void {
  validateKey(input);
  requireToolEffectKey(input.threadId, 'agent_tool_effect_thread_id_missing');
  requireToolEffectKey(input.toolName, 'agent_tool_effect_tool_name_missing');
  requireToolEffectKey(input.canonicalToolIdentity, 'agent_tool_effect_canonical_identity_missing');
  requireToolEffectKey(input.toolVersion, 'agent_tool_effect_tool_version_missing');
}

function validateLease(lease: ToolEffectLease): void {
  validateKey(lease);
  requireToolEffectKey(lease.operationId, 'agent_tool_effect_operation_id_missing');
  requireToolEffectKey(lease.idempotencyKey, 'agent_tool_effect_idempotency_key_missing');
  requireToolEffectKey(lease.attemptId, 'agent_tool_effect_attempt_id_missing');
  if (!Number.isSafeInteger(lease.leaseGeneration) || lease.leaseGeneration < 1) {
    throw new Error('agent_tool_effect_lease_generation_invalid');
  }
}

function validateKey(input: ToolEffectKey): void {
  requireToolEffectKey(input.runId, 'agent_tool_effect_run_id_missing');
  requireToolEffectKey(input.executionPath, 'agent_tool_effect_execution_path_missing');
  requireToolEffectKey(input.checkpointId, 'agent_tool_effect_checkpoint_id_missing');
  requireToolEffectKey(input.toolCallId, 'agent_tool_effect_call_id_missing');
}

function throwEffectUnavailable(row: ToolEffectRow): never {
  if (row.status === 'reserved' || row.status === 'in_progress') {
    throw new Error('agent_tool_effect_in_progress');
  }
  if (row.status === 'unknown') {
    throw new Error(`agent_tool_effect_unknown_${row.reconcile_strategy}`);
  }
  if (row.status === 'succeeded') {
    throw new Error('agent_tool_effect_already_completed');
  }
  if (row.status === 'failed_final') {
    throw new Error('agent_tool_effect_failed_final');
  }
  throw new Error('agent_tool_effect_unavailable');
}

function parseCapabilityOperationReceipt(input: unknown): CapabilityOperationReceipt {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw new Error('agent_tool_effect_receipt_invalid');
  }
  if (input.kind === 'workspace_write' &&
      (input.phase === 'prepared' || input.phase === 'published' || input.phase === 'durable') &&
      typeof input.path === 'string' && input.path.length > 0 && input.path.length <= 4096 &&
      (input.expectedVersion === null || isSha256(input.expectedVersion)) && isSha256(input.resultHash)) {
    return {
      schemaVersion: 1,
      kind: 'workspace_write',
      phase: input.phase,
      path: input.path,
      expectedVersion: input.expectedVersion,
      resultHash: input.resultHash
    };
  }
  if (input.kind === 'capability' &&
      (input.phase === 'request_sent' || input.phase === 'provider_confirmed') &&
      typeof input.capabilityName === 'string' && input.capabilityName.length > 0 &&
      typeof input.capabilityVersion === 'string' && input.capabilityVersion.length > 0 &&
      typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 &&
      (input.providerReceiptId === null || typeof input.providerReceiptId === 'string') &&
      (input.evidenceHash === null || isSha256(input.evidenceHash))) {
    return {
      schemaVersion: 1,
      kind: 'capability',
      phase: input.phase,
      capabilityName: input.capabilityName,
      capabilityVersion: input.capabilityVersion,
      idempotencyKey: input.idempotencyKey,
      providerReceiptId: input.providerReceiptId,
      evidenceHash: input.evidenceHash
    };
  }
  throw new Error('agent_tool_effect_receipt_invalid');
}

function parseResolutionReceipt(input: unknown): ToolEffectResolutionReceiptV1 {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.kind !== 'resolution' ||
      (input.source !== 'operator' && input.source !== 'provider' && input.source !== 'filesystem_verifier') ||
      (input.outcome !== 'applied' && input.outcome !== 'not_applied') ||
      !isSha256(input.operationId) || typeof input.reference !== 'string' || input.reference.trim().length === 0 || input.reference.length > 4000 ||
      !isSha256(input.evidenceHash) || typeof input.recordedAt !== 'string' || Number.isNaN(Date.parse(input.recordedAt))) {
    throw new Error('agent_tool_effect_receipt_invalid');
  }
  return {
    schemaVersion: 1,
    kind: 'resolution',
    source: input.source,
    outcome: input.outcome,
    operationId: input.operationId,
    reference: input.reference,
    evidenceHash: input.evidenceHash,
    recordedAt: input.recordedAt
  };
}

function parseStoredReceipt(receiptJson: string, expectedHash: string | null): CapabilityOperationReceipt | ToolEffectResolutionReceiptV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptJson) as unknown;
  } catch {
    throw new Error('agent_tool_effect_receipt_corrupt');
  }
  if (expectedHash !== null && hashToolInput(parsed) !== expectedHash) {
    throw new Error('agent_tool_effect_receipt_corrupt');
  }
  return isRecord(parsed) && parsed.kind === 'resolution'
    ? parseResolutionReceipt(parsed)
    : parseCapabilityOperationReceipt(parsed);
}

function parseJsonValue(json: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error('agent_tool_effect_result_corrupt');
  }
  try {
    return sortJsonValue(parsed);
  } catch {
    throw new Error('agent_tool_effect_result_corrupt');
  }
}


function isSha256(value: unknown): value is string {
  return typeof value === 'string' && HEX_SHA256_PATTERN.test(value);
}

function normalizeRestoredStatus(status: string, reconcileStrategy: string): ToolEffectRow['status'] {
  if (status === 'reserved') {
    return 'failed_retryable';
  }
  if (status === 'in_progress' || (status === 'failed_retryable' && reconcileStrategy === 'manual_confirmation')) {
    return 'unknown';
  }
  if (['succeeded', 'failed_retryable', 'failed_final', 'unknown'].includes(status)) {
    return status as ToolEffectRow['status'];
  }
  throw new Error('agent_tool_effect_restore_status_invalid');
}

function stableStringify(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) {
    throw new Error('agent_tool_effect_value_not_serializable');
  }
  return serialized;
}

function sortJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('agent_tool_effect_value_not_serializable');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry === undefined ? null : sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    throw new Error('agent_tool_effect_value_not_serializable');
  }
  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCanonicalKeys)) {
    const entry: unknown = value[key];
    if (entry !== undefined) sorted[key] = sortJsonValue(entry);
  }
  return sorted;
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireToolEffectKey(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(code);
  }
  return value;
}

function serializeError(error: unknown): JsonValue {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  try {
    return sortJsonValue(error);
  } catch {
    return String(error);
  }
}

function readSourceTableColumns(source: DatabaseConnection, table: 'effects' | 'reconciliations'): Set<string> {
  const rows = (table === 'effects'
    ? source.prepare('PRAGMA table_info(agent_tool_effects)')
    : source.prepare('PRAGMA table_info(agent_tool_effect_reconciliations)')).all();
  return new Set(rows.map((row: unknown) => {
    if (!isRecord(row) || typeof row.name !== 'string') {
      throw new Error('agent_tool_effect_restore_schema_invalid');
    }
    return row.name;
  }));
}

function readEffectSourceRows(source: DatabaseConnection): ToolEffectRow[] {
  const rows = readSourceRows(source, 'effects');
  return rows.map((row) => ({
    run_id: readRequiredString(row, 'run_id'),
    thread_id: readRequiredString(row, 'thread_id'),
    execution_path: readRequiredString(row, 'execution_path'),
    checkpoint_id: readRequiredString(row, 'checkpoint_id'),
    tool_call_id: readRequiredString(row, 'tool_call_id'),
    tool_name: readRequiredString(row, 'tool_name'),
    input_hash: readRequiredString(row, 'input_hash'),
    effect_class: readRequiredString(row, 'effect_class'),
    reconcile_strategy: readRequiredString(row, 'reconcile_strategy'),
    status: readStoredStatus(readRequiredString(row, 'status')),
    result_json: readNullableString(row, 'result_json'),
    error_json: readNullableString(row, 'error_json'),
    created_at: readRequiredString(row, 'created_at'),
    updated_at: readRequiredString(row, 'updated_at'),
    identity_version: readInteger(row, 'identity_version'),
    canonical_tool_identity: readNullableString(row, 'canonical_tool_identity'),
    canonicalization_version: readNullableString(row, 'canonicalization_version'),
    tool_version: readNullableString(row, 'tool_version'),
    operation_id: readNullableString(row, 'operation_id'),
    idempotency_key: readNullableString(row, 'idempotency_key'),
    attempt_id: readNullableString(row, 'attempt_id'),
    lease_generation: readInteger(row, 'lease_generation'),
    attempt_count: readInteger(row, 'attempt_count'),
    receipt_sequence: readInteger(row, 'receipt_sequence'),
    receipt_json: readNullableString(row, 'receipt_json'),
    receipt_hash: readNullableString(row, 'receipt_hash'),
    expected_version: readNullableString(row, 'expected_version'),
    result_hash: readNullableString(row, 'result_hash')
  }));
}

function readReconciliationSourceRows(source: DatabaseConnection): ReconciliationRow[] {
  const rows = readSourceRows(source, 'reconciliations');
  return rows.map((row) => {
    const outcome = readRequiredString(row, 'outcome');
    if (outcome !== 'applied' && outcome !== 'not_applied') {
      throw new Error('agent_tool_effect_restore_outcome_invalid');
    }
    return {
      sequence: readInteger(row, 'sequence'),
      run_id: readRequiredString(row, 'run_id'),
      execution_path: readRequiredString(row, 'execution_path'),
      checkpoint_id: readRequiredString(row, 'checkpoint_id'),
      tool_call_id: readRequiredString(row, 'tool_call_id'),
      input_hash: readRequiredString(row, 'input_hash'),
      evidence: readRequiredString(row, 'evidence'),
      outcome,
      created_at: readRequiredString(row, 'created_at'),
      operation_id: readNullableString(row, 'operation_id'),
      identity_version: readInteger(row, 'identity_version'),
      lease_generation: readInteger(row, 'lease_generation'),
      receipt_json: readNullableString(row, 'receipt_json'),
      receipt_hash: readNullableString(row, 'receipt_hash')
    };
  });
}

function readSourceRows(source: DatabaseConnection, table: 'effects' | 'reconciliations'): Record<string, unknown>[] {
  const rows = (table === 'effects'
    ? source.prepare('SELECT * FROM agent_tool_effects')
    : source.prepare('SELECT * FROM agent_tool_effect_reconciliations')).all();
  return rows.map((row: unknown) => {
    if (!isRecord(row)) {
      throw new Error('agent_tool_effect_restore_row_invalid');
    }
    return row;
  });
}

function readRequiredString(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new Error('agent_tool_effect_restore_row_invalid');
  }
  return value;
}

function readNullableString(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('agent_tool_effect_restore_row_invalid');
  }
  return value;
}

function readInteger(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent_tool_effect_restore_row_invalid');
  }
  return value;
}

function readStoredStatus(value: string): ToolEffectRow['status'] {
  if (value === 'reserved' || value === 'in_progress' || value === 'succeeded' || value === 'failed_retryable' || value === 'failed_final' || value === 'unknown') {
    return value;
  }
  throw new Error('agent_tool_effect_restore_status_invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
