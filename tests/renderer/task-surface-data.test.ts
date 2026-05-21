import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTaskSurfaceData } from '../../src/renderer/app/data-loading';

describe('loadTaskSurfaceData', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads active tasks, detail, scheduled runs, scheduler status, and tray summary from task IPC', async () => {
    vi.stubGlobal('window', {
      roc: {
        tasks: {
          getActiveTasks: vi.fn().mockResolvedValue({
            ok: true,
            data: [
              {
                kind: 'background',
                threadId: 'thread-1',
                taskId: 'task-1',
                title: '每日检查',
                goal: '每日检查',
                status: 'running',
                trigger: null,
                nextRunAt: null,
                lastRunAt: null,
                riskLevel: 'low',
                workspacePath: 'F:\\Code\\Roc',
                createdAt: '2026-05-21T00:00:00.000Z',
                updatedAt: '2026-05-21T00:00:00.000Z'
              }
            ]
          }),
          getTaskDetail: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              threadId: 'thread-1',
              taskId: 'task-1',
              thread: {
                id: 'thread-1',
                kind: 'background',
                title: '每日检查',
                goal: '每日检查',
                status: 'running',
                createdAt: '2026-05-21T00:00:00.000Z',
                updatedAt: '2026-05-21T00:00:00.000Z'
              },
              backgroundTask: null,
              lastRunId: null,
              runHistory: [],
              recentEvents: [],
              schedulerRegistered: true
            }
          }),
          listScheduledRuns: vi.fn().mockResolvedValue({
            ok: true,
            data: [
              {
                id: 'scheduled-1',
                backgroundTaskId: 'task-1',
                taskRunId: null,
                scheduledAt: '2026-05-21T00:00:00.000Z',
                triggeredAt: null,
                status: 'pending',
                skipReason: null
              }
            ]
          }),
          getSchedulerStatus: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              running: true,
              registeredTaskCount: 1,
              nextFireAt: '2026-05-21T01:00:00.000Z',
              recentSkippedCount: 0,
              lastError: null
            }
          })
        },
        lifecycle: {
          getTraySummary: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              residentEnabled: true,
              backgroundPaused: false,
              backgroundTasks: {
                total: 1,
                running: 1,
                failed: 0,
                pendingConfirmation: 0,
                nextRunAt: null
              },
              nextRunAt: null,
              updatedAt: '2026-05-21T00:00:00.000Z'
            }
          })
        }
      }
    });

    const result = await loadTaskSurfaceData();

    expect(result).toEqual({
      activeTasks: [
        expect.objectContaining({
          threadId: 'thread-1',
          taskId: 'task-1'
        })
      ],
      taskDetail: expect.objectContaining({
        taskId: 'task-1',
        schedulerRegistered: true
      }),
      scheduledRuns: [
        expect.objectContaining({
          id: 'scheduled-1',
          backgroundTaskId: 'task-1'
        })
      ],
      schedulerStatus: expect.objectContaining({
        running: true,
        registeredTaskCount: 1
      }),
      traySummary: expect.objectContaining({
        residentEnabled: true
      })
    });
  });
});
