// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/renderer/app/AppShell';
import type { ChatRunEvent, TaskUpdateEvent } from '../../src/shared/types';
import {
  createActiveTask,
  createBackgroundTaskDetail,
  createBootstrap,
  createShellClient,
  createTaskDetail,
  flushPromises,
  queryButton,
  setTextareaValue
} from './app-shell-test-helpers';

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
    vi.useRealTimers();
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

  it('subscribes to task and workspace updates through the RocClient api', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    expect(client.api.tasks.onUpdated).toHaveBeenCalledTimes(1);
    expect(client.api.workspace.onChanged).toHaveBeenCalledTimes(1);
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
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      workflowHint: 'propose_background_task',
      taskSource: 'workbench',
      workspacePath: 'F:\\Code\\Roc'
    }));
    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).toContain('返回任务工作台');
  });

  it('does not report missing task detail while the workbench task creation run is still active', async () => {
    vi.useFakeTimers();
    const client = createShellClient();
    vi.mocked(client.api.chat.startRun).mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-created',
        mode: 'task',
        threadId: 'run-thread',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      }
    });
    vi.mocked(client.api.tasks.getActiveTasks).mockResolvedValue({ ok: true, data: [] });
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('创建任务后未找到对应的任务详情。');
    expect(container.textContent).toContain('提交中');
  });

  it('waits for the created task to surface after the workbench creation run completes', async () => {
    vi.useFakeTimers();
    const client = createShellClient();
    const createdTask = createActiveTask({ taskId: 'task-created', threadId: 'thread-created', goal: '每天晚上总结新闻' });
    let runEventListener: ((event: ChatRunEvent) => void) | null = null;
    let activeTaskRequestCount = 0;
    vi.mocked(client.api.chat.onRunEvent).mockImplementation((listener) => {
      runEventListener = listener;
      return () => {
        runEventListener = null;
      };
    });
    vi.mocked(client.api.chat.startRun).mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-created',
        mode: 'task',
        threadId: 'run-thread',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      }
    });
    vi.mocked(client.api.tasks.getActiveTasks).mockImplementation(async () => {
      activeTaskRequestCount += 1;
      if (activeTaskRequestCount === 3) {
        if (runEventListener === null) {
          throw new Error('missing_run_event_listener');
        }
        runEventListener({
          type: 'run_completed',
          runId: 'run-created',
          threadId: 'run-thread',
          providerId: 'provider-openai',
          modelId: 'gpt-test',
          createdAt: '2026-05-21T00:00:00.000Z',
          durationMs: 120,
          summary: '已创建后台任务。',
          assistantMessage: '已创建后台任务。'
        });
        return { ok: true, data: [] };
      }
      return { ok: true, data: activeTaskRequestCount >= 4 ? [createdTask] : [] };
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).not.toContain('任务创建流程已结束，但没有创建后台任务。');
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

  it('returns to the task board after deleting the open task detail without refreshing the deleted detail', async () => {
    const client = createShellClient();
    let taskUpdateListener: ((event: TaskUpdateEvent | null) => void) | null = null;
    const task = createActiveTask({
      taskId: 'task-delete',
      threadId: 'thread-delete',
      goal: '删除后返回任务工作台',
      status: 'running'
    });
    vi.mocked(client.api.tasks.onUpdated).mockImplementation((listener) => {
      taskUpdateListener = listener;
      return () => {
        taskUpdateListener = null;
      };
    });
    let taskDeleted = false;
    vi.mocked(client.api.tasks.getActiveTasks).mockImplementation(async () => ({ ok: true, data: taskDeleted ? [] : [task] }));
    vi.mocked(client.api.tasks.getTaskDetail).mockResolvedValue({ ok: true, data: createBackgroundTaskDetail(task) });
    vi.mocked(client.api.tasks.deleteBackgroundTask).mockImplementation(async () => {
      taskDeleted = true;
      taskUpdateListener?.(null);
      return { ok: true, data: { deleted: true, taskId: 'task-delete' } };
    });
    window.roc = client.api;
    window.history.replaceState(null, '', `/?${new URLSearchParams({ page: 'tasks-board' }).toString()}`);

    await act(async () => {
      root.render(
        <AppShell
          bootstrap={createBootstrap({
            activeTasks: [task],
            taskDetail: createBackgroundTaskDetail(task)
          })}
          client={client}
        />
      );
    });

    await act(async () => {
      queryButton('task-board-card-task-delete').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    vi.mocked(client.api.tasks.getTaskDetail).mockClear();
    vi.mocked(client.api.tasks.getTaskDetail).mockImplementation(async () => ({
      ok: false,
      error: {
        code: 'task_not_found',
        message: '任务会话不存在或已被删除。',
        category: 'not_found',
        retryable: false
      }
    }));
    await act(async () => {
      queryButton('task-detail-action-delete').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(client.api.tasks.deleteBackgroundTask).toHaveBeenCalledWith('task-delete');
    expect(client.api.tasks.getTaskDetail).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="tasks-board-view"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Roc 启动失败');
  });

  it('starts workbench background task creation with the current MCP and skill selections', async () => {
    const client = createShellClient();
    vi.mocked(client.api.chat.startRun).mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-created',
        mode: 'task',
        threadId: 'run-thread',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      }
    });
    vi.mocked(client.api.tasks.getActiveTasks).mockResolvedValue({ ok: true, data: [] });
    window.roc = client.api;
    window.history.replaceState(null, '', `/?${new URLSearchParams({ page: 'tasks-board' }).toString()}`);

    await act(async () => {
      root.render(
        <AppShell
          bootstrap={createBootstrap({
            selectedMcpServers: ['exa-hosted'],
            selectedSkills: ['deep-review']
          })}
          client={client}
        />
      );
    });

    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === '新建任务');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setTextareaValue('task-create-description', '每天同步金价');
    await act(async () => {
      queryButton('task-create-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(client.api.chat.startRun).toHaveBeenCalledWith(expect.objectContaining({
      input: '每天同步金价',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: ['deep-review']
      },
      workflowHint: 'propose_background_task',
      taskSource: 'workbench',
      workspacePath: 'F:\\Code\\Roc'
    }));
  });
});
