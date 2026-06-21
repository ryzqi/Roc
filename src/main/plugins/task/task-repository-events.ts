import { randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { BackgroundTask, TaskEvent } from '../../../shared/types';
import { findRun } from './task-repository-queries';

export function insertTaskEvent(
  db: DatabaseConnection,
  input: {
    threadId: string;
    runId: string;
    type: TaskEvent['type'];
    payload: unknown;
    createdAt: string;
  }
): TaskEvent {
  const event: TaskEvent = {
    id: `event_${randomUUID()}`,
    threadId: input.threadId,
    runId: input.runId,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt
  };
  db
    .prepare(
      `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(event.id, event.threadId, event.runId, event.type, JSON.stringify(event.payload), event.createdAt);
  return event;
}

export function recordAgentRunCompleted(
  db: DatabaseConnection,
  input: {
    runId: string;
    threadId: string;
    assistantMessage: string;
    providerId: string;
    modelId: string;
    durationMs: number;
    summary: string;
    finishReason: string;
  },
  task: BackgroundTask | null,
  updateBackgroundTaskLastRunStatus: (taskId: string, status: Exclude<BackgroundTask['lastRunStatus'], null>) => void
): TaskEvent | null {
  const run = findRun(db, input.runId);
  if (run !== null && run.status === 'completed') {
    return null;
  }
  let mirroredAssistantEvent: TaskEvent | null = null;
  if (run !== null) {
    const now = new Date().toISOString();
    db
      .transaction(() => {
        db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, run.threadId);
        db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('completed', now, input.runId);
        insertTaskEvent(db, {
          threadId: run.threadId,
          runId: input.runId,
          type: 'agent_update',
          payload: {
            providerId: input.providerId,
            modelId: input.modelId,
            durationMs: input.durationMs,
            finishReason: input.finishReason,
            summary: input.summary
          },
          createdAt: now
        });
        mirroredAssistantEvent = insertTaskEvent(db, {
          threadId: run.threadId,
          runId: input.runId,
          type: 'message',
          payload: {
            role: 'assistant',
            content: input.assistantMessage,
            providerId: input.providerId,
            modelId: input.modelId
          },
          createdAt: now
        });
      })();
  }

  if (task !== null) {
    updateBackgroundTaskLastRunStatus(task.id, 'success');
  }
  if (task !== null && (run === null || task.threadId !== run.threadId)) {
    return insertTaskEvent(db, {
      threadId: task.threadId,
      runId: input.runId,
      type: 'message',
      payload: {
        role: 'assistant',
        content: input.assistantMessage,
        providerId: input.providerId,
        modelId: input.modelId
      },
      createdAt: new Date().toISOString()
    });
  }
  return mirroredAssistantEvent;
}

export function recordAgentRunFailed(
  db: DatabaseConnection,
  input: {
    runId: string;
    threadId: string;
    providerId: string;
    modelId: string;
    error: string;
    code: string;
    retryable: boolean;
  },
  task: BackgroundTask | null,
  pauseBackgroundTaskAfterRunFailure: (taskId: string, now: string) => void
): TaskEvent | null {
  const run = findRun(db, input.runId);
  if (run !== null && run.status === 'failed') {
    return null;
  }
  let failureEvent: TaskEvent | null = null;
  const now = new Date().toISOString();
  if (run !== null) {
    db
      .transaction(() => {
        db.prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, run.threadId);
        db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE id = ?').run('failed', now, input.runId);
        failureEvent = insertTaskEvent(db, {
          threadId: run.threadId,
          runId: input.runId,
          type: 'agent_update',
          payload: {
            status: 'failed',
            providerId: input.providerId,
            modelId: input.modelId,
            code: input.code,
            error: input.error,
            retryable: input.retryable
          },
          createdAt: now
        });
      })();
  }

  if (task !== null) {
    pauseBackgroundTaskAfterRunFailure(task.id, now);
  }
  if (task !== null && (run === null || task.threadId !== run.threadId)) {
    return insertTaskEvent(db, {
      threadId: task.threadId,
      runId: input.runId,
      type: 'agent_update',
      payload: {
        status: 'failed',
        providerId: input.providerId,
        modelId: input.modelId,
        code: input.code,
        error: input.error,
        retryable: input.retryable
      },
      createdAt: now
    });
  }
  return failureEvent;
}

export function recordAgentTaskEvent(
  db: DatabaseConnection,
  input: {
    runId: string;
    threadId: string;
    type: TaskEvent['type'];
    payload: Record<string, unknown>;
    createdAt: string;
  }
): TaskEvent | null {
  const run = findRun(db, input.runId);
  if (run === null || run.threadId !== input.threadId) {
    return null;
  }
  if (input.type === 'approval_requested') {
    let approvalEvent: TaskEvent | null = null;
    db.transaction(() => {
      db
        .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
        .run('waiting_user', input.createdAt, input.threadId);
      db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('waiting_user', input.runId);
      insertTaskEvent(db, {
        threadId: input.threadId,
        runId: input.runId,
        type: 'agent_update',
        payload: {
          status: 'waiting_user'
        },
        createdAt: input.createdAt
      });
      approvalEvent = insertTaskEvent(db, {
        threadId: input.threadId,
        runId: input.runId,
        type: input.type,
        payload: input.payload,
        createdAt: input.createdAt
      });
    })();
    return approvalEvent;
  }
  if (input.type === 'approval_decision') {
    let decisionEvent: TaskEvent | null = null;
    db.transaction(() => {
      db
        .prepare('UPDATE task_threads SET status = ?, updated_at = ? WHERE id = ?')
        .run('running', input.createdAt, input.threadId);
      db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', input.runId);
      insertTaskEvent(db, {
        threadId: input.threadId,
        runId: input.runId,
        type: 'agent_update',
        payload: {
          status: 'running',
          resumed: true
        },
        createdAt: input.createdAt
      });
      decisionEvent = insertTaskEvent(db, {
        threadId: input.threadId,
        runId: input.runId,
        type: input.type,
        payload: input.payload,
        createdAt: input.createdAt
      });
    })();
    return decisionEvent;
  }
  return insertTaskEvent(db, {
    threadId: input.threadId,
    runId: input.runId,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt
  });
}
