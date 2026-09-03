import { describe, it, expect } from 'vitest';
import { DefaultTaskOutboxProjectionStrategy } from '../../../../src/main/plugins/task/task-outbox-projection-strategy';
import type { AgentOutboxEvent, BackgroundTask } from '../../../../src/shared/types';

describe('DefaultTaskOutboxProjectionStrategy', () => {
  const strategy = new DefaultTaskOutboxProjectionStrategy();

  const mockTask: BackgroundTask = {
    id: 'task-1',
    runId: 'run-123',
    threadId: 'thread-1',
    goal: 'Test Task',
    status: 'running',
    scheduled: false,
    triggerType: 'manual',
    triggerDescription: 'Manual trigger',
    nextRunAt: null,
    cronExpression: null,
    workspacePath: '/workspace',
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    riskLevel: 'low',
    requiresConfirmation: false,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 1,
    createdAt: '2026-09-03T12:00:00Z',
    updatedAt: '2026-09-03T12:00:00Z',
    enabledCapabilities: null
  };

  it('task 为 null 时返回 no_op', () => {
    const event: AgentOutboxEvent = {
      id: 'evt-1',
      sequence: 1,
      eventType: 'run_completed',
      runId: 'run-123',
      threadId: 'thread-1',
      payload: {
        assistantMessage: 'Done',
        durationMs: 1000,
        finishReason: 'stop',
        modelId: 'claude-opus-5',
        providerId: 'anthropic',
        summary: 'Task completed'
      },
      createdAt: '2026-09-03T12:05:00Z'
    };

    const transition = strategy.applyEvent(null, event);
    expect(transition).toEqual({ type: 'no_op' });
  });

  it('runId 不匹配时返回 no_op', () => {
    const event: AgentOutboxEvent = {
      id: 'evt-2',
      sequence: 2,
      eventType: 'run_completed',
      runId: 'run-999', // 不同的 runId
      threadId: 'thread-1',
      payload: {
        assistantMessage: 'Done',
        durationMs: 1000,
        finishReason: 'stop',
        modelId: 'claude-opus-5',
        providerId: 'anthropic',
        summary: 'Task completed'
      },
      createdAt: '2026-09-03T12:05:00Z'
    };

    const transition = strategy.applyEvent(mockTask, event);
    expect(transition).toEqual({ type: 'no_op' });
  });

  it('run_completed + isLatestRun → update_status success', () => {
    const event: AgentOutboxEvent = {
      id: 'evt-3',
      sequence: 3,
      eventType: 'run_completed',
      runId: 'run-123',
      threadId: 'thread-1',
      payload: {
        assistantMessage: 'Done',
        durationMs: 1000,
        finishReason: 'stop',
        modelId: 'claude-opus-5',
        providerId: 'anthropic',
        summary: 'Task completed'
      },
      createdAt: '2026-09-03T12:05:00Z'
    };

    const transition = strategy.applyEvent(mockTask, event);
    expect(transition).toEqual({
      type: 'update_status',
      taskId: 'task-1',
      status: 'success',
      timestamp: '2026-09-03T12:05:00Z'
    });
  });

  it('run_failed + isLatestRun → pause_after_failure', () => {
    const event: AgentOutboxEvent = {
      id: 'evt-4',
      sequence: 4,
      eventType: 'run_failed',
      runId: 'run-123',
      threadId: 'thread-1',
      payload: {
        code: 'timeout',
        error: 'Request timeout',
        modelId: 'claude-opus-5',
        providerId: 'anthropic',
        retryable: true
      },
      createdAt: '2026-09-03T12:10:00Z'
    };

    const transition = strategy.applyEvent(mockTask, event);
    expect(transition).toEqual({
      type: 'pause_after_failure',
      taskId: 'task-1',
      timestamp: '2026-09-03T12:10:00Z'
    });
  });

  it('run_cancelled + isLatestRun → update_status cancelled', () => {
    const event: AgentOutboxEvent = {
      id: 'evt-5',
      sequence: 5,
      eventType: 'run_cancelled',
      runId: 'run-123',
      threadId: 'thread-1',
      payload: { reason: 'user_cancelled' },
      createdAt: '2026-09-03T12:15:00Z'
    };

    const transition = strategy.applyEvent(mockTask, event);
    expect(transition).toEqual({
      type: 'update_status',
      taskId: 'task-1',
      status: 'cancelled',
      timestamp: '2026-09-03T12:15:00Z'
    });
  });

  it('run_deleted 总是返回 no_op', () => {
    const event: AgentOutboxEvent = {
      id: 'evt-6',
      sequence: 6,
      eventType: 'run_deleted',
      runId: 'run-123',
      threadId: 'thread-1',
      payload: {},
      createdAt: '2026-09-03T12:20:00Z'
    };

    const transition = strategy.applyEvent(mockTask, event);
    expect(transition).toEqual({ type: 'no_op' });
  });
});
