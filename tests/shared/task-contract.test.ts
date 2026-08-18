import { describe, expect, it } from 'vitest';

import {
  backgroundTaskPreviewRequestSchema,
  backgroundTaskSchema,
  taskMessageHistoryPageSchema,
  updateBackgroundTaskRequestSchema
} from '../../src/shared/schemas/ipc-core';

const timestamp = '2026-08-18T10:00:00.000Z';

describe('shared task contracts', () => {
  it('requires positive integer history sequence bounds', () => {
    expect(() => taskMessageHistoryPageSchema.parse({
      items: [],
      oldestSequence: 1.5,
      newestSequence: 2,
      hasMoreBefore: false,
      hasMoreAfter: false
    })).toThrow();
  });

  it('rejects blank preview fields and invalid trigger timestamps', () => {
    expect(() => backgroundTaskPreviewRequestSchema.parse({
      goal: '   ',
      trigger: {
        type: 'once',
        description: 'run once',
        nextRunAt: 'tomorrow'
      },
      workspacePath: 'C:\\workspace',
      allowedActions: ['read'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    })).toThrow();
  });

  it('requires non-blank update identifiers and reasons', () => {
    expect(() => updateBackgroundTaskRequestSchema.parse({
      taskId: ' ',
      patch: {},
      reason: ' '
    })).toThrow();
  });

  it('requires valid timestamps and a non-negative integer run count', () => {
    const task = {
      id: 'task_1',
      threadId: 'thread_1',
      runId: 'run_1',
      goal: 'Inspect workspace',
      status: 'running',
      scheduled: true,
      triggerType: 'once',
      triggerDescription: 'run once',
      nextRunAt: timestamp,
      cronExpression: null,
      workspacePath: 'C:\\workspace',
      allowedActions: ['read'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      riskLevel: 'low',
      requiresConfirmation: false,
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      enabledCapabilities: null
    };

    expect(backgroundTaskSchema.parse(task)).toEqual(task);
    expect(() => backgroundTaskSchema.parse({ ...task, runCount: -1 })).toThrow();
    expect(() => backgroundTaskSchema.parse({ ...task, updatedAt: 'today' })).toThrow();
  });
});
