import { describe, expect, it } from 'vitest';
import { emptyTaskSurfaceData } from '../../src/renderer/app/empty-states';

describe('renderer empty startup states', () => {
  it('keeps task surface data empty until the tasks or tray view requests it', () => {
    expect(emptyTaskSurfaceData()).toEqual({
      backgroundTask: null,
      backgroundTasks: [],
      traySummary: {
        residentEnabled: true,
        backgroundPaused: false,
        backgroundTasks: {
          total: 0,
          running: 0,
          failed: 0,
          pendingConfirmation: 0,
          nextRunAt: null
        },
        nextRunAt: null,
        updatedAt: ''
      }
    });
  });
});
