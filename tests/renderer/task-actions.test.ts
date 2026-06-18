import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskActions } from '../../src/renderer/views/tasks/use-task-actions';
import type { ActiveTaskItem } from '../../src/shared/types';

describe('createTaskActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes only task-domain mutation actions', () => {
    const actions = createTaskActions({
      refreshTaskSurface: vi.fn().mockResolvedValue(undefined)
    });

    expect(Object.keys(actions).sort()).toEqual(['cancelTask', 'deleteTask', 'pauseTask', 'resumeTask', 'runNow']);
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
          cancelBackgroundTask: vi.fn(),
          pauseBackgroundTask: vi.fn(),
          resumeBackgroundTask: vi.fn(),
          runBackgroundNow
        }
      }
    });

    const actions = createTaskActions({
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
          cancelBackgroundTask: vi.fn(),
          pauseBackgroundTask: vi.fn(),
          resumeBackgroundTask: vi.fn(),
          runBackgroundNow
        }
      }
    });

    const actions = createTaskActions({
      refreshTaskSurface
    });

    actions.runNow(createBackgroundItem({ taskId: 'task-2' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(runBackgroundNow).toHaveBeenCalledWith('task-2');
    expect(refreshTaskSurface).not.toHaveBeenCalled();
  });

  it('does not fall back to the selected detail task after delete clears the selection', async () => {
    const refreshTaskSurface = vi.fn().mockResolvedValue(undefined);
    const deleteBackgroundTask = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        deleted: true,
        taskId: 'task-2'
      }
    });
    vi.stubGlobal('window', {
      roc: {
        tasks: {
          deleteBackgroundTask
        }
      }
    });

    const actions = createTaskActions({
      refreshTaskSurface
    });

    actions.deleteTask(createBackgroundItem({ taskId: 'task-2' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteBackgroundTask).toHaveBeenCalledWith('task-2');
    expect(refreshTaskSurface).toHaveBeenCalledWith(null);
  });

  it('does not notify deletion when delete fails', async () => {
    const refreshTaskSurface = vi.fn().mockResolvedValue(undefined);
    const onTaskDeleted = vi.fn();
    const deleteBackgroundTask = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        message: '任务会话不存在或已被删除。'
      }
    });
    vi.stubGlobal('window', {
      roc: {
        tasks: {
          deleteBackgroundTask
        }
      }
    });

    const actions = createTaskActions({
      onTaskDeleted,
      refreshTaskSurface
    });

    actions.deleteTask(createBackgroundItem({ taskId: 'task-2' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteBackgroundTask).toHaveBeenCalledWith('task-2');
    expect(refreshTaskSurface).not.toHaveBeenCalled();
    expect(onTaskDeleted).not.toHaveBeenCalled();
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
