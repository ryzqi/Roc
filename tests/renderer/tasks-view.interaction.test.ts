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
          onOpenTaskDetail: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt: async () => ({ ok: true as const }),
          boardUiState: { railId: 'all', scrollTop: 0 },
          onBoardUiStateChange: () => {}
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

  it('submits the new task description through the existing task prompt contract and stays in the task domain', async () => {
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
          onOpenTaskDetail: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt,
          boardUiState: { railId: 'all', scrollTop: 0 },
          onBoardUiStateChange: () => {}
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

  it('renders four kanban columns and no left task rail', async () => {
    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: [
              createActiveTask({ taskId: 'pending-1', threadId: 'thread-pending-1', goal: '等待审批', status: 'pending_confirmation' }),
              createActiveTask({ taskId: 'running-1', threadId: 'thread-running-1', goal: '执行中', status: 'running' }),
              createActiveTask({ taskId: 'paused-1', threadId: 'thread-paused-1', goal: '暂停中', status: 'paused' }),
              createActiveTask({ taskId: 'done-1', threadId: 'thread-done-1', goal: '已完成', status: 'completed' })
            ]
          }),
          updateLoadedState: () => {},
          liveTaskRun: null,
          onOpenTaskDetail: () => {},
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt: async () => ({ ok: true as const }),
          boardUiState: { railId: 'all', scrollTop: 0 },
          onBoardUiStateChange: () => {}
        })
      );
    });

    expect(container.querySelector('[data-testid="task-status-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-待处理"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-进行中"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-已暂停"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-board-column-已结束"]')).not.toBeNull();
  });

  it('opens task detail when a kanban card is clicked', async () => {
    const onOpenTaskDetail = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TasksView, {
          state: createLoadedState({
            activeTasks: [createActiveTask({ taskId: 'running-1', threadId: 'thread-running-1', goal: '执行中', status: 'running' })]
          }),
          updateLoadedState: () => {},
          liveTaskRun: null,
          onOpenTaskDetail,
          onSelectedTaskIdChange: () => {},
          onSubmitTaskPrompt: async () => ({ ok: true as const }),
          boardUiState: { railId: 'all', scrollTop: 0 },
          onBoardUiStateChange: () => {}
        })
      );
    });

    const card = container.querySelector('[data-testid="task-board-card-running-1"]');
    expect(card).not.toBeNull();

    await act(async () => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenTaskDetail).toHaveBeenCalledWith('running-1', { railId: 'all', scrollTop: 0 });
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
