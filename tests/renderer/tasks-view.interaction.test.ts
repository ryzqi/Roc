// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocPreloadApi } from '../../src/shared/ipc';
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
    const submittedPrompt = onSubmitTaskPrompt.mock.calls[0]?.[0] as string;
    for (const fragment of [
      '每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件',
      'propose_background_task',
      'trigger.type 只能是 manual、once 或 cron',
      'cronExpression',
      'nextRunAt',
      'F:\\Code\\Roc'
    ]) {
      expect(submittedPrompt).toContain(fragment);
    }
    expect(submittedPrompt).toContain('每天晚上 7:40 抓取 AI 最新新闻，并将结果写入当前工作目录下的 docx 文件');
    expect(submittedPrompt).toContain('不要添加 allowedActions、forbiddenActions、notificationPolicy、enabledCapabilities 或 failurePolicy');
    expect(submittedPrompt).not.toReferenceForbiddenField();
    expect(submittedPrompt).not.toContain('"notificationPolicy"');
    expect(submittedPrompt).not.toContain('"allowedActions"');
    expect(submittedPrompt).not.toContain('"forbiddenActions"');
    expect(submittedPrompt).not.toContain('"enabledCapabilities"');
    expect(submittedPrompt).not.toContain('审批提议');
    expect(submittedPrompt).not.toContain('用户批准前不要创建任务');
    expect(preload.chat.startRun).not.toHaveBeenCalled();
    expect(preload.tasks.createBackgroundTaskPreview).not.toHaveBeenCalled();
    expect(preload.tasks.createBackgroundTask).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="task-create-dialog-panel"]')).toBeNull();
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
      runBackgroundNow: vi.fn()
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
