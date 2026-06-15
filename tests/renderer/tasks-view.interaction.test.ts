// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocPreloadApi } from '../../src/shared/ipc';
import type { ActiveTaskItem } from '../../src/shared/types';
import { TasksView } from '../../src/renderer/views/tasks/TasksView';
import { createLoadedState } from './view-test-helpers';

describe('TasksView interactions', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    window.roc = createMockPreloadApi();
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opens the create task modal after clicking 新建任务 in the empty state', async () => {
    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: []
          }),
          updateLoadedState: () => {},
          liveTaskRun: null,
          onNavigateToThread: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt: async () => ({ ok: true as const })
        })
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '新建任务');
    expect(trigger).not.toBeUndefined();
    expect(container.querySelector('[data-testid="task-create-dialog-panel"]')).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="task-create-dialog-backdrop"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-create-dialog-panel"]')).not.toBeNull();
  });

  it('submits the new task description through a task chat run', async () => {
    const preload = createMockPreloadApi();
    window.roc = preload;
    const onSubmitTaskPrompt = vi.fn().mockResolvedValue({ ok: true as const });

    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: [],
            selectedMcpServers: ['filesystem'],
            selectedSkills: ['task-planner'],
            workspace: {
              id: 'workspace-1',
              path: 'F:\\Code\\Roc',
              displayName: 'Roc',
              trustState: 'trusted',
              lastOpenedAt: '2026-05-21T00:00:00.000Z'
            }
          }),
          updateLoadedState: () => {},
          liveTaskRun: null,
          onNavigateToThread: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt
        })
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '新建任务');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    setTextareaValue('task-create-description', '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件');

    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(onSubmitTaskPrompt).toHaveBeenCalledTimes(1);
    expect(onSubmitTaskPrompt).toHaveBeenCalledWith({
      input: '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench',
      workspacePath: 'F:\\Code\\Roc'
    });
    expect(preload.chat.startRun).not.toHaveBeenCalled();
    expect(preload.tasks.createBackgroundTaskPreview).not.toHaveBeenCalled();
    expect(preload.tasks.createBackgroundTask).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="task-create-dialog-panel"]')).toBeNull();
  });

  it('deletes a cancelled background task from the detail drawer and reloads the task surface', async () => {
    const preload = createMockPreloadApi();
    window.roc = preload;
    const updateLoadedState = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: [
              {
                kind: 'background',
                threadId: 'thread-cancelled',
                taskId: 'background-cancelled',
                title: '已取消的新闻任务',
                goal: '已取消的新闻任务',
                status: 'cancelled',
                trigger: null,
                nextRunAt: null,
                lastRunAt: null,
                riskLevel: 'low',
                workspacePath: 'F:\\Code\\Roc',
                createdAt: '2026-05-20T00:00:00.000Z',
                updatedAt: '2026-05-20T00:00:00.000Z'
              }
            ],
            taskSnapshot: {
              generatedAt: '2026-05-20T00:00:00.000Z',
              recentEvents: [],
              counts: {
                total: 1,
                running: 0,
                failed: 0,
                pendingConfirmation: 0
              },
              threads: []
            }
          }),
          updateLoadedState,
          liveTaskRun: null,
          onNavigateToThread: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt: async () => ({ ok: true as const })
        })
      );
    });

    expect(container.querySelector('[data-testid="task-row-background-cancelled"]')).not.toBeNull();
    const deleteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '删除任务');
    expect(deleteButton).not.toBeUndefined();

    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(preload.tasks.deleteBackgroundTask).toHaveBeenCalledWith('background-cancelled');
    expect(preload.tasks.getSnapshot).toHaveBeenCalled();
    expect(preload.tasks.getActiveTasks).toHaveBeenCalled();
    expect(updateLoadedState).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTasks: []
      })
    );
  });

  it('filters tasks from the status rail and keeps paused tasks reachable after status changes', async () => {
    const runningTask = createActiveTask({
      taskId: 'background-running',
      threadId: 'thread-running',
      goal: '运行任务',
      status: 'running'
    });
    const scheduledTask = createActiveTask({
      taskId: 'background-scheduled',
      threadId: 'thread-scheduled',
      goal: '计划任务',
      status: 'running',
      nextRunAt: '2026-05-22T01:00:00.000Z'
    });
    const pausedTask = createActiveTask({
      taskId: 'background-paused',
      threadId: 'thread-paused',
      goal: '暂停任务',
      status: 'paused'
    });
    const baseProps = {
      updateLoadedState: () => {},
      liveTaskRun: null,
      onNavigateToThread: () => {},
      onSelectedTaskIdChange: () => {},
      onSubmitTaskPrompt: async () => ({ ok: true as const })
    };

    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          ...baseProps,
          state: createLoadedState({
            activeTasks: [runningTask, scheduledTask, pausedTask]
          })
        })
      );
    });

    await clickRailButton(container, '计划中');
    expect(taskTableTitle(container)).toBe('计划中任务');
    expect(container.querySelector('[data-testid="task-row-background-scheduled"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-row-background-running"]')).toBeNull();

    await clickRailButton(container, '已暂停');
    expect(taskTableTitle(container)).toBe('已暂停任务');
    expect(container.querySelector('[data-testid="task-row-background-paused"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-row-background-scheduled"]')).toBeNull();

    await clickRailButton(container, '运行中');
    expect(container.querySelector('[data-testid="task-row-background-running"]')).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          ...baseProps,
          state: createLoadedState({
            activeTasks: [{ ...runningTask, status: 'paused' }]
          })
        })
      );
    });

    expect(container.querySelector('[data-testid="task-row-background-running"]')).toBeNull();
    expect(container.textContent).toContain('当前筛选没有任务');
    expect(railButtonText(container, '已暂停')).toContain('1');
  });
});

function createMockPreloadApi(): RocPreloadApi {
  const state = createLoadedState({});
  return {
    tasks: {
      getSnapshot: vi.fn().mockResolvedValue({
        ok: true as const,
        data: state.taskSnapshot
      }),
      getActiveTasks: vi.fn().mockResolvedValue({ ok: true as const, data: [] }),
      getSchedulerStatus: vi.fn().mockResolvedValue({
        ok: true as const,
        data: state.schedulerStatus
      }),
      getTaskDetail: vi.fn(),
      listScheduledRuns: vi.fn(),
      createBackgroundTaskPreview: vi.fn(),
      createBackgroundTask: vi.fn(),
      cancelBackgroundTask: vi.fn(),
      openInChat: vi.fn(),
      pauseBackgroundTask: vi.fn(),
      resumeBackgroundTask: vi.fn(),
      runBackgroundNow: vi.fn(),
      deleteBackgroundTask: vi.fn().mockResolvedValue({
        ok: true as const,
        data: {
          deleted: true as const,
          taskId: 'background-cancelled'
        }
      })
    },
    chat: {
      startRun: vi.fn().mockResolvedValue({
        ok: true as const,
        data: {
          runId: 'run-1',
          mode: 'task' as const,
          threadId: 'thread-1',
          providerId: 'provider-1',
          modelId: 'model-1',
          createdAt: '2026-05-22T00:00:00.000Z'
        }
      }),
      cancelRun: vi.fn(),
      resumeRun: vi.fn(),
      onRunEvent: vi.fn()
    },
    lifecycle: {
      getTraySummary: vi.fn().mockResolvedValue({
        ok: true as const,
        data: state.traySummary
      })
    }
  } as unknown as RocPreloadApi;
}

function queryButton(testId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function setTextareaValue(testId: string, value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(textarea).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  expect(setter).not.toBeUndefined();
  setter?.call(textarea, value);
  textarea?.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

function createActiveTask(input: {
  taskId: string;
  threadId: string;
  goal: string;
  status: ActiveTaskItem['status'];
  nextRunAt?: string | null;
}): ActiveTaskItem {
  return {
    kind: 'background',
    threadId: input.threadId,
    taskId: input.taskId,
    title: input.goal,
    goal: input.goal,
    status: input.status,
    trigger: input.nextRunAt === undefined || input.nextRunAt === null
      ? null
      : {
          type: 'cron',
          description: '每天 09:00',
          cronExpression: '0 9 * * *',
          nextRunAt: input.nextRunAt
        },
    nextRunAt: input.nextRunAt ?? null,
    lastRunAt: null,
    riskLevel: 'low',
    workspacePath: 'F:\\Code\\Roc',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z'
  };
}

async function clickRailButton(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="task-status-rail"] button')).find((item) =>
    item.textContent?.includes(label)
  );
  expect(button).not.toBeUndefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function railButtonText(container: HTMLElement, label: string): string {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="task-status-rail"] button')).find((item) =>
    item.textContent?.includes(label)
  );
  expect(button).not.toBeUndefined();
  return button?.textContent ?? '';
}

function taskTableTitle(container: HTMLElement): string {
  const title = container.querySelector('.task-table-head .section-title');
  expect(title).not.toBeNull();
  return title?.textContent ?? '';
}
