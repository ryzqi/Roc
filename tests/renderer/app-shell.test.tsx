// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { waitUntil } from './view-test-helpers';

describe('AppShell', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeAll(async () => {
    await import('../../src/renderer/features/tasks');
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
      unobserve(): void {}
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

  it('keeps every workbench and control entry inside the pinned sidebar dock', async () => {
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    const dock = container.querySelector('.sidebar-dock');
    if (dock === null) {
      throw new Error('Expected the sidebar dock to render');
    }
    for (const testId of ['nav-tasks-board', 'nav-diagnostics', 'nav-memory', 'nav-mcp', 'nav-skills', 'settings-gear']) {
      expect(dock.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
  });

  it('resets sidebar scroll without resetting the chat canvas', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const client = createShellClient();
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });
    const sidebar = container.querySelector<HTMLElement>('.sidebar');
    const chatCanvas = container.querySelector<HTMLElement>('.canvas--chat .canvas-scroll');
    if (sidebar === null || chatCanvas === null) {
      throw new Error('Expected chat scroll surfaces to render');
    }
    const sidebarScrollTop = vi.fn();
    const chatScrollTop = vi.fn();
    Object.defineProperty(sidebar, 'scrollTop', { configurable: true, get: () => 120, set: sidebarScrollTop });
    Object.defineProperty(chatCanvas, 'scrollTop', { configurable: true, get: () => 480, set: chatScrollTop });

    await act(async () => {
      frames.splice(0).forEach((callback) => callback(0));
    });

    expect(sidebarScrollTop).toHaveBeenCalledWith(0);
    expect(chatScrollTop).not.toHaveBeenCalled();
  });

  it('restores focus to the settings opener after Escape closes the modal', async () => {
    const client = createShellClient();
    window.roc = client.api;
    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });
    const opener = queryButton('settings-gear');
    opener.focus();
    await act(async () => {
      opener.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();
    expect(container.querySelector('[data-testid="settings-modal"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // 焦点在模态退出动画结束后才归还，必须等真正卸载而不是等固定时长。
    await waitUntil(() => container.querySelector('[data-testid="settings-modal"]') === null);

    expect(document.activeElement).toBe(opener);
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
    await waitUntil(() => container.querySelector('[data-testid="task-detail-view"]') !== null);

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
    expect(vi.mocked(client.api.chat.startRun).mock.calls[0]?.[0]).not.toHaveProperty('workspacePath');
  });

  it('does not refresh task state for ordinary chat terminal events but refreshes task runs', async () => {
    const client = createShellClient();
    const runEventListeners: Array<(event: ChatRunEvent) => void> = [];
    vi.mocked(client.api.chat.onRunEvent).mockImplementation((listener) => {
      runEventListeners.push(listener);
      return () => {
        const index = runEventListeners.indexOf(listener);
        if (index !== -1) {
          runEventListeners.splice(index, 1);
        }
      };
    });
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });
    if (runEventListeners.length === 0) {
      throw new Error('missing_run_event_listener');
    }
    const emitRunEvent = (event: ChatRunEvent): void => {
      for (const listener of runEventListeners) {
        listener(event);
      }
    };
    const baselineSnapshotRequests = vi.mocked(client.api.tasks.getSnapshot).mock.calls.length;

    await act(async () => {
      emitRunEvent({
        type: 'run_completed',
        runId: 'run-chat',
        threadId: 'thread-chat',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-07-10T00:00:00.000Z',
        durationMs: 10,
        summary: 'chat done',
        assistantMessage: 'chat done'
      });
      await flushPromises();
    });

    expect(client.api.tasks.getSnapshot).toHaveBeenCalledTimes(baselineSnapshotRequests);

    await act(async () => {
      emitRunEvent({
        type: 'run_started',
        runId: 'run-task',
        mode: 'task',
        threadId: 'thread-task',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-07-10T00:00:00.000Z'
      });
      emitRunEvent({
        type: 'run_completed',
        runId: 'run-task',
        threadId: 'thread-task',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-07-10T00:00:01.000Z',
        durationMs: 10,
        summary: 'task done',
        assistantMessage: 'task done'
      });
      await flushPromises();
    });

    expect(client.api.tasks.getSnapshot).toHaveBeenCalledTimes(baselineSnapshotRequests + 1);
  });

  it('executes a completed proposed plan as a clean chat run', async () => {
    const client = createShellClient();
    const runEventListeners: Array<(event: ChatRunEvent) => void> = [];
    vi.mocked(client.api.chat.onRunEvent).mockImplementation((listener) => {
      runEventListeners.push(listener);
      return () => {
        const index = runEventListeners.indexOf(listener);
        if (index !== -1) {
          runEventListeners.splice(index, 1);
        }
      };
    });
    vi.mocked(client.api.chat.startRun).mockImplementation(async (request) => ({
      ok: true,
      data: {
        runId: request.mode === 'plan' ? 'run-plan' : 'run-execute',
        mode: request.mode,
        threadId: request.mode === 'plan' ? 'thread-plan' : 'thread-execute',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      }
    }));
    window.roc = client.api;

    await act(async () => {
      root.render(<AppShell bootstrap={createBootstrap()} client={client} />);
    });

    const planModeButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Plan');
    await act(async () => {
      planModeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    setTextareaValue('chat-input', 'Plan this');
    await act(async () => {
      queryButton('chat-task-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(runEventListeners.length).toBeGreaterThan(0);
    await act(async () => {
      const startedEvent: ChatRunEvent = {
        type: 'run_started',
        runId: 'run-plan',
        mode: 'plan',
        threadId: 'thread-plan',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:00.000Z'
      };
      const completedEvent: ChatRunEvent = {
        type: 'run_completed',
        runId: 'run-plan',
        threadId: 'thread-plan',
        providerId: 'provider-openai',
        modelId: 'gpt-test',
        createdAt: '2026-05-21T00:00:01.000Z',
        durationMs: 100,
        summary: '完成计划。',
        assistantMessage: 'notes\n<proposed_plan>\n# Plan\n- implement\n</proposed_plan>'
      };
      for (const listener of runEventListeners) {
        listener(startedEvent);
        listener(completedEvent);
      }
    });
    await flushPromises();
    await act(async () => {
      queryButton('chat-plan-execute').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    const secondRequest = vi.mocked(client.api.chat.startRun).mock.calls[1]?.[0];
    expect(secondRequest).toMatchObject({
      input: '# Plan\n- implement',
      mode: 'chat',
      threadId: null,
      workflowHint: null,
      taskSource: null
    });
    expect(secondRequest).not.toHaveProperty('workspacePath');
    expect(secondRequest?.input).not.toContain('Plan this');
  });

  it('continues task detail follow-up in the task background thread', async () => {
    const client = createShellClient();
    const waitingTask = createActiveTask({
      taskId: 'task-waiting',
      threadId: 'thread-background',
      goal: '等待补充输入',
      status: 'waiting_user',
      workspacePath: 'G:\\Saved\\Task'
    });
    const taskDetail = createBackgroundTaskDetail(waitingTask);
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
      taskSource: 'workbench',
      workspacePath: 'G:\\Saved\\Task'
    }));
  });

  it('returns to the task board after deleting the open task detail without refreshing the deleted detail', async () => {
    const client = createShellClient();
    let taskUpdateListener: ((event: TaskUpdateEvent | null) => void) | null = null;
    const task = createActiveTask({
      taskId: 'task-delete',
      threadId: 'thread-delete',
      goal: '删除后返回任务工作台',
      status: 'failed'
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

  it('returns to the task board when a deletion-started update hides the selected task', async () => {
    const client = createShellClient();
    let taskUpdateListener: ((event: TaskUpdateEvent | null) => void) | null = null;
    const task = createActiveTask({
      taskId: 'task-delete-started',
      threadId: 'thread-delete-started',
      goal: '删除开始后移除任务详情',
      status: 'running'
    });
    vi.mocked(client.api.tasks.onUpdated).mockImplementation((listener) => {
      taskUpdateListener = listener;
      return () => {
        taskUpdateListener = null;
      };
    });
    let deletionStarted = false;
    vi.mocked(client.api.tasks.getActiveTasks).mockImplementation(async () => ({
      ok: true,
      data: deletionStarted ? [] : [task]
    }));
    vi.mocked(client.api.tasks.getTaskDetail).mockImplementation(async () =>
      deletionStarted
        ? {
            ok: false,
            error: {
              code: 'task_not_found',
              message: '任务会话不存在或已被删除。',
              category: 'not_found',
              retryable: false
            }
          }
        : { ok: true, data: createBackgroundTaskDetail(task) }
    );
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
      queryButton('task-board-card-task-delete-started').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    vi.mocked(client.api.tasks.getTaskDetail).mockClear();
    deletionStarted = true;
    await act(async () => {
      taskUpdateListener?.({ kind: 'thread_deletion_started', threadId: task.threadId });
      await flushPromises();
    });

    expect(client.api.tasks.getTaskDetail).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="tasks-board-view"]')).not.toBeNull();
    expect(container.textContent).not.toContain('task detail failed');
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
