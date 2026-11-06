import {executionPayloadHash, parseExecutionEvent} from './execution-events';
import {researchTaskEventSchema} from '../../shared/schemas/research-tasks';

export interface TaskReplayProjection {
  status: string | null;
  executions: Record<string, string>;
  calls: Record<string, string | null>;
  facts: Array<{eventId: string; type: string; payloadHash: string}>;
}
export type TaskReplayReport =
  | {kind: 'complete'; mode: 'projection'; throughSequence: number; eventHash: string; projectionHash: string; projection: TaskReplayProjection}
  | {kind: 'unavailable'; reason: 'gap' | 'duplicate' | 'out_of_order' | 'corrupt' | 'scope_mismatch' | 'limit'; sequence: number};

/** Pure verification of a complete retained Task stream. Never a checkpoint or I/O dispatcher. */
export function verifyTaskReplay(input: {projectId: string; taskId: string; nextSequence: number; events: string[]}): TaskReplayReport {
  const unavailable = (reason: Extract<TaskReplayReport, {kind: 'unavailable'}>['reason'], sequence: number): TaskReplayReport =>
    ({kind: 'unavailable', reason, sequence});
  if (input.events.length > 10000 || input.events.reduce((bytes, raw) => bytes + Buffer.byteLength(raw), 0) > 16 * 1024 * 1024) return unavailable('limit', 0);
  if (!Number.isSafeInteger(input.nextSequence) || input.nextSequence < 1) return unavailable('corrupt', 0);
  const projection: TaskReplayProjection = {status: null, executions: {}, calls: {}, facts: []};
  const identities = new Set<string>();
  const sequences = new Set<number>();
  const hashes: string[] = [];
  let expected = 1;
  for (const raw of input.events) {
    let event;
    try { event = researchTaskEventSchema.parse(parseExecutionEvent(raw)); }
    catch { return unavailable('corrupt', expected); }
    if (event.projectId !== input.projectId || event.taskId !== input.taskId || event.streamId !== `task:${input.taskId}` || event.payload.taskId !== input.taskId) return unavailable('scope_mismatch', event.sequence);
    if (identities.has(event.eventId) || sequences.has(event.sequence)) return unavailable('duplicate', event.sequence);
    if (event.sequence < expected) return unavailable('out_of_order', event.sequence);
    if (event.sequence > expected) return unavailable('gap', expected);
    identities.add(event.eventId); sequences.add(event.sequence); hashes.push(event.eventId); expected++;
    const payload = event.payload;
    if (event.eventType === 'task_created' || event.eventType === 'task_status') projection.status = payload.state;
    if (event.eventType === 'execution_linked' && payload.executionKind !== null && payload.executionId !== null) {
      projection.executions[JSON.stringify([payload.executionKind,payload.executionId])] = event.payloadHash;
    }
    if (event.eventType.startsWith('call_') && payload.callId !== null) {
      projection.calls[JSON.stringify([payload.executionKind,payload.executionId,payload.callId])] = payload.state;
    }
    if (!['task_created','task_status','execution_linked','call_linked','call_reserved','call_settled','call_unknown'].includes(event.eventType)) {
      projection.facts.push({eventId: event.eventId, type: event.eventType, payloadHash: event.payloadHash});
    }
  }
  if (expected !== input.nextSequence) return unavailable('gap', expected);
  return {kind: 'complete', mode: 'projection', throughSequence: expected - 1,
    eventHash: executionPayloadHash(hashes), projectionHash: executionPayloadHash(projection), projection};
}
