// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/renderer/app/AppShell';
import type { AppBootstrap } from '../../src/renderer/app/use-app-bootstrap';
import type { LoadedState } from '../../src/renderer/loaded-state';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import type { ActiveTaskItem, TaskDetail, TaskStatus } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

describe('AppShell', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, '', '/');
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
    globalThis.ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders navigation, window controls, selected view, and settings trigger', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.querySelector('[data-testid="roc-app"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="window-minimize"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="window-toggle-maximize"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="window-close"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-gear"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="active-view"]')).not.toBeNull();
    expect(container.textContent).toContain('任务工作台');
  });

  it('subscribes to task updates through the RocClient api', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(client.api.tasks.onUpdated).toHaveBeenCalledTimes(1);
  });

  it('opens the task workbench entry as the board page instead of chat', async () => {
    const client = createShellClient();
    window.roc = client.api;
    window.history.replaceState(null, '', `/?${new URLSearchParams({ page: 'tasks-board' }).toString()}`);

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.textContent).toContain('任务工作台');
    expect(container.querySelector('[data-testid="tasks-board-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();
  });

  it('does not keep queued task prompt state in the task workbench flow', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(container.textContent).not.toContain('请调用 propose_background_task 创建任务');
  });

  it('opens task detail after workbench task creation succeeds', async () => {
    const client = createShellClient();
    const createdTask = createActiveTask({ taskId: 'task-created', threadId: 'thread-created', goal: '每天晚上总结新闻' });
    let creationStarted = false;
    let activeTaskPollCount = 0;
    vi.mocked(client.api.chat.startRun).mockImplementation(async () => {
      creationStarted = true;
      return {
        ok: true,
        data: {
          runId: 'run-created',
          mode: 'task',
          threadId: 'run-thread',
          providerId: 'provider-openai',
          modelId: 'gpt-test',
          createdAt: '2026-05-21T00:00:00.000Z'
        }
      };
    });
    vi.mocked(client.api.tasks.getActiveTasks).mockImplementation(async () => {
      if (!creationStarted) {
        return { ok: true, data: [] };
      }
      activeTaskPollCount += 1;
      return { ok: true, data: activeTaskPollCount === 1 ? [] : [createdTask] };
    });
    vi.mocked(client.api.tasks.getTaskDetail).mockResolvedValue({ ok: true, data: createTaskDetail(createdTask) });
    vi.mocked(client.api.tasks.listScheduledRuns).mockResolvedValue({ ok: true, data: [] });
    window.roc = client.api;
    window.history.replaceState(null, '', `/?${new URLSearchParams({ page: 'tasks-board' }).toString()}`);

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await flushPromises();

    expect(client.api.chat.startRun).toHaveBeenCalledWith(expect.objectContaining({
      input: '每天晚上总结新闻',
      mode: 'task',
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    }));
    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).toContain('返回任务工作台');
  });

  it('starts ordinary chat submissions as chat runs', async () => {
    const client = createShellClient();
    vi.mocked(client.api.chat.startRun).mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-chat',
        mode: 'chat',
        threadId: 'thread-chat',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      }
    });
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    setTextareaValue('chat-input', '普通聊天输入');
    await act(async () => {
      queryButton('chat-task-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(client.api.chat.startRun).toHaveBeenCalledWith(expect.objectContaining({
      input: '普通聊天输入',
      mode: 'chat',
      threadId: null,
      workflowHint: null,
      taskSource: null
    }));
  });

  it('continues task detail follow-up in the task background thread', async () => {
    const client = createShellClient();
    const waitingTask = createActiveTask({
      taskId: 'task-waiting',
      threadId: 'thread-background',
      goal: '等待补充输入',
      status: 'waiting_user'
    });
    const taskDetail = createTaskDetail(waitingTask);
    vi.mocked(client.api.chat.startRun).mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-followup',
        mode: 'task',
        threadId: 'thread-background',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      }
    });
    vi.mocked(client.api.tasks.getActiveTasks).mockResolvedValue({ ok: true, data: [waitingTask] });
    vi.mocked(client.api.tasks.getTaskDetail).mockResolvedValue({ ok: true, data: taskDetail });
    vi.mocked(client.api.tasks.listScheduledRuns).mockResolvedValue({ ok: true, data: [] });
    window.roc = client.api;
    window.history.replaceState(null, '', `/?${new URLSearchParams({ page: 'tasks-board' }).toString()}`);

    await act(async () => {
      root.render(
        <AppShell
          bootstrap={createBootstrap({
            activeTasks: [waitingTask],
            taskDetail
          })}
          client={client}
        />
      );
    });

    await act(async () => {
      queryButton('task-board-card-task-waiting').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setTextareaValue('task-detail-followup-input', '继续处理这个任务');
    await act(async () => {
      queryButton('task-detail-followup-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(client.api.chat.startRun).toHaveBeenCalledWith(expect.objectContaining({
      input: '继续处理这个任务',
      mode: 'task',
      threadId: 'thread-background',
      workflowHint: 'background_task_change',
      taskSource: 'workbench'
    }));
  });
});

function createBootstrap(statePartial: Partial<LoadedState> = {}): AppBootstrap {
  return {
    error: null,
    setError: vi.fn(),
    setState: vi.fn(),
    setWindowState: vi.fn(),
    state: createLoadedState(statePartial),
    windowState: {
      maximized: false,
      minimized: false,
      fullscreen: false
    }
  };
}

function createShellClient(): RocClient {
  const state = createLoadedState({});
  const api = {
    app: {
      getStatus: vi.fn().mockResolvedValue({ ok: true, data: state.appStatus }),
      onAppearanceUpdated: vi.fn().mockReturnValue(() => {}),
      onNavigate: vi.fn().mockReturnValue(() => {})
    },
    tasks: {
      getSnapshot: vi.fn().mockResolvedValue({ ok: true, data: state.taskSnapshot }),
      getActiveTasks: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      getSchedulerStatus: vi.fn().mockResolvedValue({ ok: true, data: state.schedulerStatus }),
      getTaskDetail: vi.fn().mockResolvedValue({ ok: true, data: null }),
      listScheduledRuns: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      onUpdated: vi.fn().mockReturnValue(() => {}),
      deleteThread: vi.fn().mockResolvedValue({ ok: true, data: { deleted: true } })
    },
    lifecycle: {
      getTraySummary: vi.fn().mockResolvedValue({ ok: true, data: state.traySummary })
    },
    chat: {
      startRun: vi.fn(),
      resumeRun: vi.fn(),
      onRunEvent: vi.fn().mockReturnValue(() => {})
    },
    agent: {
      getCapabilityPreview: vi.fn()
    },
    workspace: {
      selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: null })
    },
    window: {
      close: vi.fn().mockResolvedValue({ ok: true, data: { closed: true } }),
      minimize: vi.fn().mockResolvedValue({
        ok: true,
        data: { maximized: false, minimized: true, fullscreen: false }
      }),
      toggleMaximize: vi.fn().mockResolvedValue({
        ok: true,
        data: { maximized: true, minimized: false, fullscreen: false }
      })
    },
    files: {
      selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: null })
    }
  } as unknown as RocPreloadApi;
  return { api };
}

function createActiveTask(partial: { taskId: string; threadId: string; goal: string; status?: TaskStatus }): ActiveTaskItem {
  return {
    kind: 'background',
    threadId: partial.threadId,
    taskId: partial.taskId,
    title: partial.goal,
    goal: partial.goal,
    status: partial.status === undefined ? 'running' : partial.status,
    trigger: null,
    nextRunAt: null,
    lastRunAt: null,
    riskLevel: 'low',
    workspacePath: 'F:\\Code\\Roc',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z'
  };
}

function createTaskDetail(task: ActiveTaskItem): TaskDetail {
  return {
    threadId: task.threadId,
    taskId: task.taskId ?? 'task-created',
    lastRunId: 'run-created',
    schedulerRegistered: true,
    thread: {
      id: task.threadId,
      kind: 'background',
      title: task.title,
      goal: task.goal,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    },
    backgroundTask: null,
    runHistory: [],
    recentEvents: []
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
