import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskActions } from '../../src/renderer/views/tasks/use-task-actions';
import type { ActiveTaskItem } from '../../src/shared/types';

describe('createTaskActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the returned task thread in chat after openInChat succeeds', async () => {
    const navigateToChat = vi.fn();
    const refreshTaskSurface = vi.fn().mockResolvedValue(undefined);
    const openInChat = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        threadId: 'thread-2'
      }
    });
    vi.stubGlobal('window', {
      roc: {
        tasks: {
          openInChat,
          cancelBackgroundTask: vi.fn(),
          pauseBackgroundTask: vi.fn(),
          resumeBackgroundTask: vi.fn(),
          runBackgroundNow: vi.fn()
        }
      }
    });

    const actions = createTaskActions({
      navigateToChat,
      refreshTaskSurface
    });

    actions.openInChat(createBackgroundItem({ taskId: 'task-2', threadId: 'thread-1' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(openInChat).toHaveBeenCalledWith({ taskId: 'task-2' });
    expect(navigateToChat).toHaveBeenCalledWith('thread-2');
    expect(refreshTaskSurface).not.toHaveBeenCalled();
  });

  it('refreshes the task surface after runNow succeeds', async () => {
    const refreshTaskSurface = vi.fn().mockResolvedValue(undefined);
    const runBackgroundNow = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        taskId: 'task-2',
        runId: 'run-2'
      }
    });
    vi.stubGlobal('window', {
      roc: {
        tasks: {
          openInChat: vi.fn(),
          cancelBackgroundTask: vi.fn(),
          pauseBackgroundTask: vi.fn(),
          resumeBackgroundTask: vi.fn(),
          runBackgroundNow
        }
      }
    });

    const actions = createTaskActions({
      navigateToChat: vi.fn(),
      refreshTaskSurface
    });

    actions.runNow(createBackgroundItem({ taskId: 'task-2' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(runBackgroundNow).toHaveBeenCalledWith('task-2');
    expect(refreshTaskSurface).toHaveBeenCalledWith('task-2');
  });

  it('does not refresh the task surface after runNow fails', async () => {
    const refreshTaskSurface = vi.fn().mockResolvedValue(undefined);
    const runBackgroundNow = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        message: '后台任务没有启动新的运行。'
      }
    });
    vi.stubGlobal('window', {
      roc: {
        tasks: {
          openInChat: vi.fn(),
          cancelBackgroundTask: vi.fn(),
          pauseBackgroundTask: vi.fn(),
          resumeBackgroundTask: vi.fn(),
          runBackgroundNow
        }
      }
    });

    const actions = createTaskActions({
      navigateToChat: vi.fn(),
      refreshTaskSurface
    });

    actions.runNow(createBackgroundItem({ taskId: 'task-2' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(runBackgroundNow).toHaveBeenCalledWith('task-2');
    expect(refreshTaskSurface).not.toHaveBeenCalled();
  });
});

function createBackgroundItem(partial: Partial<ActiveTaskItem>): ActiveTaskItem {
  return {
    kind: 'background',
    threadId: 'thread-1',
    taskId: 'task-1',
    title: '后台任务',
    goal: '后台任务',
    status: 'running',
    trigger: null,
    nextRunAt: null,
    lastRunAt: null,
    riskLevel: 'low',
    workspacePath: 'F:\\Code\\Roc',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...partial
  };
}
