import { randomUUID } from 'node:crypto';
import type { TaskEvent } from '../../../shared/types';
import type { DatabaseService } from '../database-service';
import { getRun } from './task-run-management';

export function recordEvent(input: {
  database: DatabaseService;
  threadId: string;
  runId: string;
  type: TaskEvent['type'];
  payload: unknown;
}): TaskEvent {
  return recordEvents({ database: input.database, inputs: [input] })[0]!;
}

export function recordEvents(input: {
  database: DatabaseService;
  inputs: Array<{ threadId: string; runId: string; type: TaskEvent['type']; payload: unknown }>;
}): TaskEvent[] {
  if (input.inputs.length === 0) {
    return [];
  }
  const now = new Date().toISOString();
  const insert = input.database.db.prepare(
    `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const events: TaskEvent[] = [];

  input.database.db.transaction(() => {
    for (const entry of input.inputs) {
      const event: TaskEvent = {
        id: `event_${randomUUID()}`,
        threadId: entry.threadId,
        runId: entry.runId,
        type: entry.type,
        payload: entry.payload,
        createdAt: now
      };
      insert.run(event.id, event.threadId, event.runId, event.type, JSON.stringify(event.payload), event.createdAt);
      events.push(event);
    }
  })();

  return events;
}

export function recordApprovalRequested(input: { database: DatabaseService; runId: string; payload: unknown }): TaskEvent {
  const run = getRun({ database: input.database, id: input.runId });
  return recordEvent({
    database: input.database,
    threadId: run.threadId,
    runId: run.id,
    type: 'approval_requested',
    payload: input.payload
  });
}

export function recordApprovalDecision(input: { database: DatabaseService; runId: string; payload: unknown }): TaskEvent {
  const run = getRun({ database: input.database, id: input.runId });
  return recordEvent({
    database: input.database,
    threadId: run.threadId,
    runId: run.id,
    type: 'approval_decision',
    payload: input.payload
  });
}
