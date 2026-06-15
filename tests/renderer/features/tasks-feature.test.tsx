// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksFeature } from '../../../src/renderer/features/tasks';
import { createTaskFeatureActions } from '../../../src/renderer/features/tasks/use-task-feature';
import type { RocClient } from '../../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../../src/shared/ipc';
import type { ActiveTaskItem } from '../../../src/shared/types';
import { createLoadedState } from '../view-test-helpers';

describe('task feature actions', () => {
  it('runs task mutations through the RocClient api', async () => {
    const client = createTasksClient();
    const refreshTaskSurface = vi.fn().mockResolvedValue(undefined);
    const navigateToChat = vi.fn();
    const actions = createTaskFeatureActions({
      client,
      navigateToChat,
      refreshTaskSurface
    });
    const item = createBackgroundItem({ taskId: 'task-1', threadId: 'thread-1' });

    actions.pauseTask(item);
    actions.resumeTask(item);
    actions.cancelTask(item);
    actions.runNow(item);
    actions.openInChat(item);
    actions.deleteTask(item);
    await flushPromises();

    expect(client.api.tasks.pauseBackgroundTask).toHaveBeenCalledWith('task-1');
    expect(client.api.tasks.resumeBackgroundTask).toHaveBeenCalledWith('task-1');
    expect(client.api.tasks.cancelBackgroundTask).toHaveBeenCalledWith('task-1');
    expect(client.api.tasks.runBackgroundNow).toHaveBeenCalledWith('task-1');
    expect(client.api.tasks.openInChat).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(client.api.tasks.deleteBackgroundTask).toHaveBeenCalledWith('task-1');
    expect(navigateToChat).toHaveBeenCalledWith('thread-opened', 'background_task_change');
  });
});

describe('TasksFeature', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('submits new task descriptions through the existing task prompt contract', async () => {
    const onSubmitTaskPrompt = vi.fn().mockResolvedValue({ ok: true as const });

    await act(async () => {
      root.render(
        <TasksFeature
          client={createTasksClient()}
          liveTaskRun={null}
          onNavigateToThread={() => {}}
          onSelectedTaskIdChange={() => {}}
          onSubmitTaskPrompt={onSubmitTaskPrompt}
          state={createLoadedState({
            activeTasks: [],
            workspace: {
              id: 'workspace-1',
              path: 'F:\\Code\\Roc',
              displayName: 'Roc',
              trustState: 'trusted',
              lastOpenedAt: '2026-05-21T00:00:00.000Z'
            }
          })}
          updateLoadedState={() => {}}
        />
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '新建任务');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setTextareaValue('task-create-description', '每天晚上总结新闻');
    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(onSubmitTaskPrompt).toHaveBeenCalledWith({
      input: '每天晚上总结新闻',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench',
      workspacePath: 'F:\\Code\\Roc'
    });
  });
});

function createTasksClient(): RocClient {
  const state = createLoadedState({});
  const api = {
    tasks: {
      pauseBackgroundTask: vi.fn().mockResolvedValue({ ok: true, data: createBackgroundTask('task-1') }),
      resumeBackgroundTask: vi.fn().mockResolvedValue({ ok: true, data: createBackgroundTask('task-1') }),
      cancelBackgroundTask: vi.fn().mockResolvedValue({ ok: true, data: createBackgroundTask('task-1') }),
      runBackgroundNow: vi.fn().mockResolvedValue({ ok: true, data: { taskId: 'task-1', runId: 'run-1' } }),
      openInChat: vi.fn().mockResolvedValue({ ok: true, data: { threadId: 'thread-opened' } }),
      deleteBackgroundTask: vi.fn().mockResolvedValue({ ok: true, data: { deleted: true, taskId: 'task-1' } }),
      getSnapshot: vi.fn().mockResolvedValue({ ok: true, data: state.taskSnapshot }),
      getActiveTasks: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      getSchedulerStatus: vi.fn().mockResolvedValue({ ok: true, data: state.schedulerStatus }),
      getTaskDetail: vi.fn(),
      listScheduledRuns: vi.fn()
    },
    lifecycle: {
      getTraySummary: vi.fn().mockResolvedValue({ ok: true, data: state.traySummary })
    }
  } as unknown as RocPreloadApi;
  return { api };
}

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

function createBackgroundTask(id: string): Record<string, unknown> {
  return {
    id,
    goal: '后台任务',
    status: 'running'
  };
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
