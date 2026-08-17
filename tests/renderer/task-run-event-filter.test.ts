import { describe, expect, it } from 'vitest';

import type { ChatRunEvent } from '../../src/shared/types';
import {
  completeTaskRunEvent,
  shouldApplyTaskRunEvent
} from '../../src/renderer/app/task-run-event-filter';

describe('task run event filter', () => {
  it('classifies only task starts and their subsequent events', () => {
    const known = new Set<string>();
    const chatStart: ChatRunEvent = {
      type: 'run_started',
      runId: 'run-chat',
      mode: 'run',
      threadId: 'thread-chat',
      providerId: 'provider',
      modelId: 'model',
      createdAt: '2026-07-10T00:00:00.000Z'
    };
    const taskStart: ChatRunEvent = {
      type: 'run_started',
      runId: 'run-task',
      mode: 'task',
      threadId: 'thread-task',
      providerId: 'provider',
      modelId: 'model',
      createdAt: '2026-07-10T00:00:00.000Z'
    };

    expect(shouldApplyTaskRunEvent(known, chatStart)).toBe(false);
    expect(known).toEqual(new Set());
    expect(shouldApplyTaskRunEvent(known, taskStart)).toBe(true);
    expect(known).toEqual(new Set(['run-task']));
    expect(
      shouldApplyTaskRunEvent(known, {
        type: 'assistant_block',
        runId: 'run-chat',
        block: { kind: 'text', blockId: 'text-chat', phase: 'delta', text: 'token' }
      })
    ).toBe(false);
    expect(
      shouldApplyTaskRunEvent(known, {
        type: 'assistant_block',
        runId: 'run-task',
        block: { kind: 'text', blockId: 'text-task', phase: 'delta', text: 'token' }
      })
    ).toBe(true);
  });

  it('retains interrupted task runs for resume events', () => {
    const known = new Set(['run-task']);
    const interrupted: ChatRunEvent = {
      type: 'run_interrupted',
      runId: 'run-task',
      threadId: 'thread-task',
      interruptId: 'interrupt-task',
      payload: {
        kind: 'question',
        question: '继续吗？'
      }
    };

    expect(shouldApplyTaskRunEvent(known, interrupted)).toBe(true);
    completeTaskRunEvent(known, interrupted);
    expect(known).toEqual(new Set(['run-task']));
    expect(
      shouldApplyTaskRunEvent(known, {
        type: 'run_resumed',
        runId: 'run-task',
        threadId: 'thread-task',
        interruptId: 'interrupt-task'
      })
    ).toBe(true);
  });

  it.each(['run_completed', 'run_failed'] as const)('removes a task run only after applying %s', (type) => {
    const known = new Set(['run-task']);
    const event: ChatRunEvent =
      type === 'run_completed'
        ? {
            type,
            runId: 'run-task',
            threadId: 'thread-task',
            providerId: 'provider',
            modelId: 'model',
            createdAt: '2026-07-10T00:00:00.000Z',
            durationMs: 10,
            summary: 'done',
            assistantMessage: 'done'
          }
        : {
            type,
            runId: 'run-task',
            threadId: 'thread-task',
            code: 'failed',
            message: 'failed',
            retryable: false
          };

    expect(shouldApplyTaskRunEvent(known, event)).toBe(true);
    expect(known).toEqual(new Set(['run-task']));
    completeTaskRunEvent(known, event);
    expect(known).toEqual(new Set());
  });
});
