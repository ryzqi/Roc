import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticsLifecycleAdapter } from '../../../../src/main/plugins/diagnostics/lifecycle-adapter';

describe('diagnostics lifecycle adapter', () => {
  it('pauses and resumes background execution through the scheduler adapter', () => {
    const scheduler = {
      suspendAll: vi.fn(),
      resumeAll: vi.fn()
    };
    const lifecycle = createDiagnosticsLifecycleAdapter({
      getBackgroundTaskSummary: () => ({
        total: 3,
        running: 2,
        failed: 1,
        pendingConfirmation: 0,
        nextRunAt: '2026-06-04T10:00:00.000Z'
      }),
      scheduler
    });

    const paused = lifecycle.pauseBackgroundExecution();
    const resumed = lifecycle.resumeBackgroundExecution();

    expect(scheduler.suspendAll).toHaveBeenCalledTimes(1);
    expect(scheduler.resumeAll).toHaveBeenCalledTimes(1);
    expect(paused).toMatchObject({
      residentEnabled: true,
      backgroundPaused: true,
      nextRunAt: '2026-06-04T10:00:00.000Z',
      backgroundTasks: {
        total: 3,
        running: 2,
        failed: 1,
        pendingConfirmation: 0
      }
    });
    expect(resumed).toMatchObject({
      residentEnabled: true,
      backgroundPaused: false,
      nextRunAt: '2026-06-04T10:00:00.000Z'
    });
  });
});
