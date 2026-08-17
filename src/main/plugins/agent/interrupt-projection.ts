import type { HITLRequest } from 'langchain';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  ChatInterruptPayload,
  ChatRunEvent
} from '../../../shared/types';
import type {
  DeepAgents110V3Interrupt,
  DeepAgents110V3Run
} from '../../services/deep-agent/deep-agents-1-10-stream-adapter';
import { RocSqliteCheckpointer, type RocCheckpointInterrupt } from '../../services/deep-agent/sqlite-checkpointer';
import * as recordUtils from '../../services/deep-agent/record-utils';

export type PendingInterrupt = {
  interruptId: string;
  payload: ChatInterruptPayload;
};

export type PendingInterruptProjection = {
  runId: string;
  threadId: string;
  interrupts: PendingInterrupt[];
};

type PendingInterruptRow = {
  run_id: string;
  thread_id: string;
  interrupt_id: string;
  position: number;
  payload_json: string;
};

type InterruptCheckpointReader = Pick<RocSqliteCheckpointer, 'readPendingInterrupts'>;

export class AgentInterruptProjection {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly checkpointReader: InterruptCheckpointReader = new RocSqliteCheckpointer(db)
  ) {}

  record(input: {
    runId: string;
    threadId: string;
    interrupts: readonly PendingInterrupt[];
  }): void {
    if (input.interrupts.length > 0) {
      validatePendingInterrupts(input.interrupts);
    }
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ?').run(input.runId);
    const insert = this.db.prepare(
      `INSERT INTO agent_pending_interrupts
       (run_id, thread_id, interrupt_id, position, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [position, interrupt] of input.interrupts.entries()) {
      insert.run(
        input.runId,
        input.threadId,
        interrupt.interruptId,
        position,
        JSON.stringify(interrupt.payload),
        now,
        now
      );
    }
  }

  readPending(input: { runId: string; threadId: string }): PendingInterruptProjection {
    const rows = this.db
      .prepare(
        `SELECT run_id, thread_id, interrupt_id, position, payload_json
         FROM agent_pending_interrupts
         WHERE run_id = ?
         ORDER BY position ASC`
      )
      .all(input.runId) as PendingInterruptRow[];
    if (rows.some((row) => row.thread_id !== input.threadId)) {
      throw new Error('agent_pending_interrupt_thread_mismatch');
    }
    return {
      runId: input.runId,
      threadId: input.threadId,
      interrupts: rows.map((row) => ({
        interruptId: row.interrupt_id,
        payload: parsePendingInterruptPayload(row.payload_json)
      }))
    };
  }

  consume(input: { runId: string; interruptId: string }): void {
    const deleted = this.db
      .prepare('DELETE FROM agent_pending_interrupts WHERE run_id = ? AND interrupt_id = ?')
      .run(input.runId, input.interruptId).changes;
    if (deleted !== 1) {
      throw new Error('agent_pending_interrupt_missing');
    }
  }

  recoverFromCheckpoint(input: {
    runId: string;
    threadId: string;
    answeredInterruptIds: ReadonlySet<string> | null;
  }): PendingInterrupt[] | null {
    if (input.answeredInterruptIds === null) {
      return null;
    }
    const answeredInterruptIds = input.answeredInterruptIds;
    const checkpointInterrupts = this.checkpointReader.readPendingInterrupts(input.threadId);
    if (checkpointInterrupts === null) {
      return null;
    }
    let pendingInterrupts: PendingInterrupt[];
    try {
      const interrupts = checkpointInterrupts.map((interrupt: RocCheckpointInterrupt): PendingInterrupt => {
        return {
          interruptId: interrupt.interruptId,
          payload: normalizeChatInterruptPayload(interrupt.payload)
        };
      });
      validatePendingInterrupts(interrupts);
      pendingInterrupts = interrupts.filter((interrupt) => !answeredInterruptIds.has(interrupt.interruptId));
    } catch {
      return null;
    }
    if (pendingInterrupts.length === 0) {
      return null;
    }
    const existing = this.readExistingInterrupts(input);
    if (!pendingInterruptCollectionsEqual(existing, pendingInterrupts)) {
      this.db.transaction(() => {
        this.record({ runId: input.runId, threadId: input.threadId, interrupts: pendingInterrupts });
      })();
    }
    return pendingInterrupts;
  }

  private readExistingInterrupts(input: { runId: string; threadId: string }): PendingInterrupt[] {
    return this.readPending(input).interrupts;
  }
}

export function assertPendingInterrupts(interrupts: readonly PendingInterrupt[]): void {
  if (interrupts.length === 0) {
    throw new Error('agent_pending_interrupt_collection_empty');
  }
  validatePendingInterrupts(interrupts);
}

export function normalizeChatInterruptPayload(payload: unknown): ChatInterruptPayload {
  const questionPayload = readQuestionInterruptPayload(payload);
  if (questionPayload !== null) {
    return questionPayload;
  }
  if (isApprovalInterruptPayload(payload)) {
    return payload;
  }
  if (isApprovalRequest(payload)) {
    return {
      kind: 'approval',
      request: payload
    };
  }
  throw new Error('agent_interrupt_payload_invalid');
}

export function projectDeepAgentInterrupts(
  run: Pick<DeepAgents110V3Run, 'interrupts'>
): PendingInterrupt[] {
  if (run.interrupts.length === 0) {
    throw new Error('agent_interrupt_payload_missing');
  }
  return run.interrupts.map((interrupt: DeepAgents110V3Interrupt) => ({
    interruptId: interrupt.interruptId,
    payload: normalizeChatInterruptPayload(interrupt.payload)
  }));
}

export function createRunInterruptedEvents(
  runId: string,
  threadId: string,
  interrupts: readonly PendingInterrupt[]
): Array<Extract<ChatRunEvent, { type: 'run_interrupted' }>> {
  return interrupts.map((interrupt) => ({
    type: 'run_interrupted',
    runId,
    threadId,
    interruptId: interrupt.interruptId,
    payload: interrupt.payload
  }));
}

function parsePendingInterruptPayload(payloadJson: string): ChatInterruptPayload {
  try {
    return normalizeChatInterruptPayload(JSON.parse(payloadJson) as unknown);
  } catch {
    throw new Error('agent_pending_interrupt_payload_invalid');
  }
}

function validatePendingInterrupts(interrupts: readonly PendingInterrupt[]): void {
  const interruptIds = new Set<string>();
  for (const interrupt of interrupts) {
    const interruptId = interrupt.interruptId.trim();
    if (interruptId.length === 0) {
      throw new Error('agent_pending_interrupt_id_empty');
    }
    if (interruptIds.has(interruptId)) {
      throw new Error('agent_pending_interrupt_id_duplicate');
    }
    interruptIds.add(interruptId);
  }
}

function pendingInterruptCollectionsEqual(
  left: readonly PendingInterrupt[],
  right: readonly PendingInterrupt[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (interrupt, index) =>
        interrupt.interruptId === right[index]?.interruptId &&
        JSON.stringify(interrupt.payload) === JSON.stringify(right[index]?.payload)
    )
  );
}

function isApprovalInterruptPayload(value: unknown): value is ChatInterruptPayload {
  if (!recordUtils.isRecord(value) || recordUtils.readRecordValue(value, 'kind') !== 'approval') {
    return false;
  }
  return isApprovalRequest(recordUtils.readRecordValue(value, 'request'));
}

function readQuestionInterruptPayload(
  value: unknown
): Extract<ChatInterruptPayload, { kind: 'question' }> | null {
  if (!recordUtils.isRecord(value)) {
    return null;
  }
  if (recordUtils.readRecordValue(value, 'kind') !== 'question') {
    return null;
  }
  const question = recordUtils.readRecordValue(value, 'question');
  const context = recordUtils.readRecordValue(value, 'context');
  const suggestedResponses = recordUtils.readRecordValue(value, 'suggestedResponses');
  if (typeof question !== 'string') {
    return null;
  }
  if (context !== undefined && typeof context !== 'string') {
    return null;
  }
  if (
    suggestedResponses !== undefined &&
    (!Array.isArray(suggestedResponses) ||
      !suggestedResponses.every((response): response is string => typeof response === 'string'))
  ) {
    return null;
  }
  return {
    kind: 'question',
    question,
    ...(context === undefined ? {} : { context }),
    ...(suggestedResponses === undefined ? {} : { suggestedResponses })
  };
}

function isApprovalRequest(value: unknown): value is HITLRequest {
  if (!recordUtils.isRecord(value)) {
    return false;
  }
  return Array.isArray(recordUtils.readRecordValue(value, 'actionRequests')) && Array.isArray(recordUtils.readRecordValue(value, 'reviewConfigs'));
}
