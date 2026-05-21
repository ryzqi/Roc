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

  it('opens long-running threads directly in chat without calling task IPC', () => {
    const navigateToChat = vi.fn();
    const refreshTaskSurface = vi.fn().mockResolvedValue(undefined);
    const openInChat = vi.fn();
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

    actions.openInChat(createLongRunningItem({ threadId: 'thread-long' }));

    expect(openInChat).not.toHaveBeenCalled();
    expect(navigateToChat).toHaveBeenCalledWith('thread-long');
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

function createLongRunningItem(partial: Partial<ActiveTaskItem>): ActiveTaskItem {
  return {
    ...createBackgroundItem({
      kind: 'long_running',
      taskId: null,
      workspacePath: null
    }),
    ...partial
  };
}
