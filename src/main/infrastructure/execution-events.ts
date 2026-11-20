import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { executionEventEnvelopeSchema, type ExecutionEventEnvelope } from '../../shared/schemas/execution-events';

export function executionPayloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createExecutionEvent(input: Omit<ExecutionEventEnvelope, 'schemaVersion' | 'eventId' | 'payloadHash' | 'payloadRef'>): ExecutionEventEnvelope {
  const payloadHash = executionPayloadHash(input.payload);
  const envelope = executionEventEnvelopeSchema.parse({...input, schemaVersion: 1,
    eventId: executionPayloadHash([input.streamId, input.sequence, input.eventType, input.actor, input.correlationId, input.causationId, input.projectId, input.taskId, input.runId, payloadHash, input.createdAt]), payloadHash, payloadRef: null});
  if (Buffer.byteLength(JSON.stringify(envelope)) > 1024 * 1024) throw new Error('execution_event_too_large');
  return envelope;
}

export function parseExecutionEvent(raw: string): ExecutionEventEnvelope {
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('execution_event_too_large');
  const envelope = executionEventEnvelopeSchema.parse(JSON.parse(raw));
  const expected = createExecutionEvent(envelope);
  if (envelope.payloadHash !== expected.payloadHash || envelope.eventId !== expected.eventId) throw new Error('execution_event_hash_invalid');
  return envelope;
}

/** Registered on every connection, including offline maintenance and isolated fixtures. */
export function registerExecutionEventFunctions(db: Database): void {
  db.function('roc_payload_hash', {deterministic: true}, raw => {
    if (typeof raw !== 'string') throw new Error('execution_event_input_invalid');
    try { return executionPayloadHash(JSON.parse(raw)); }
    catch (cause) { throw new Error('execution_event_input_invalid', {cause}); }
  });
  db.function('roc_task_event', {deterministic: true}, (sequence, taskId, projectId, runId, eventType, payload, createdAt) => {
    if (typeof projectId !== 'string' || (runId !== null && typeof runId !== 'string') ||
        typeof sequence !== 'number' || typeof taskId !== 'string' || typeof eventType !== 'string' ||
        typeof payload !== 'string' || typeof createdAt !== 'string') throw new Error('execution_event_input_invalid');
    return JSON.stringify(createExecutionEvent({streamId: `task:${taskId}`, projectId, taskId, runId, sequence, eventType,
      actor: {kind: 'main', id: 'task-ledger'}, correlationId: taskId, causationId: null,
      payload: JSON.parse(payload), createdAt}));
  });
}
