import { describe, expect, it } from 'vitest';

import type { ChatRunEvent, TaskEvent } from '../../src/shared/types';
import {
  applyPendingInterruptProjection,
  readPersistedInterruptProjection,
  readLiveInterruptProjection
} from '../../src/renderer/chat/interrupt-projection';

describe('chat interrupt projection', () => {
  it('normalizes live and persisted approval interrupts to one domain item', () => {
    const live = readLiveInterruptProjection({
      type: 'run_interrupted',
      runId: 'run-1',
      threadId: 'thread-1',
      interruptId: 'interrupt-1',
      payload: {
        kind: 'approval',
        request: {
          actionRequests: [{ name: 'run_shell_command', args: { command: 'git status' } }],
          reviewConfigs: [{ actionName: 'run_shell_command', allowedDecisions: ['approve', 'reject'] }]
        }
      }
    } satisfies ChatRunEvent);
    const persisted = readPersistedInterruptProjection({
      id: 'event-1',
      threadId: 'thread-1',
      runId: 'run-1',
      type: 'approval_requested',
      payload: {
        interruptId: 'interrupt-1',
        actionRequests: [{ name: 'run_shell_command', args: { command: 'git status' } }],
        reviewConfigs: [{ actionName: 'run_shell_command', allowedDecisions: ['approve', 'reject'] }]
      },
      createdAt: '2026-08-16T00:00:00.000Z'
    } satisfies TaskEvent);

    expect(live).toEqual(persisted);
    expect(live).toEqual({
      kind: 'record',
      interrupt: {
        kind: 'approval',
        interruptId: 'interrupt-1',
        actionRequests: [{ name: 'run_shell_command', args: { command: 'git status' } }],
        reviewConfigs: [{ actionName: 'run_shell_command', allowedDecisions: ['approve', 'reject'] }]
      }
    });
  });

  it('upserts records and consumes only the matching interrupt', () => {
    const record = readLiveInterruptProjection({
      type: 'run_interrupted',
      runId: 'run-2',
      threadId: 'thread-2',
      interruptId: 'interrupt-question',
      payload: { kind: 'question', question: 'Which branch?' }
    } satisfies ChatRunEvent);
    if (record === null) {
      throw new Error('expected_interrupt_record');
    }

    let interrupts = applyPendingInterruptProjection([], record);
    interrupts = applyPendingInterruptProjection(interrupts, record);
    expect(interrupts).toEqual([
      {
        kind: 'question',
        interruptId: 'interrupt-question',
        question: 'Which branch?'
      }
    ]);

    const consumed = readLiveInterruptProjection({
      type: 'run_resumed',
      runId: 'run-2',
      threadId: 'thread-2',
      interruptId: 'interrupt-question'
    } satisfies ChatRunEvent);
    if (consumed === null) {
      throw new Error('expected_interrupt_consumption');
    }
    expect(applyPendingInterruptProjection(interrupts, consumed)).toEqual([]);
  });
});
