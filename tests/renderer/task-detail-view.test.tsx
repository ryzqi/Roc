// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailView } from '../../src/renderer/views/tasks/TaskDetailView';
import { createLoadedState } from './view-test-helpers';

describe('TaskDetailView', () => {
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
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders the transcript and back action for an existing task', async () => {
    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={null}
          onApprovalDecision={vi.fn()}
          onBackToBoard={() => {}}
          onSubmitTaskInput={vi.fn()}
          state={createLoadedState({
            taskDetail: createTaskDetail({
              recentEvents: [
                {
                  id: 'message-user',
                  threadId: 'thread-1',
                  runId: 'run-1',
                  type: 'message',
                  payload: { role: 'user', content: '请整理工作区变更' },
                  createdAt: '2026-05-16T07:00:00.000Z'
                },
                {
                  id: 'message-assistant',
                  threadId: 'thread-1',
                  runId: 'run-1',
                  type: 'message',
                  payload: { role: 'assistant', content: '已经整理完成' },
                  createdAt: '2026-05-16T07:05:00.000Z'
                }
              ]
            })
          })}
          taskActions={createTaskActionsMock()}
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).toContain('返回任务工作台');
    expect(container.textContent).toContain('已经整理完成');
    expect(container.querySelector('.task-detail-page-head')).not.toBeNull();
    expect(container.querySelector('.task-detail-content-shell')).not.toBeNull();
    expect(container.querySelector('.task-detail-transcript-shell')).not.toBeNull();
  });

  it('submits inline continue input for waiting_user tasks', async () => {
    const onSubmitTaskInput = vi.fn().mockResolvedValue({ ok: true as const });

    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={null}
          onApprovalDecision={vi.fn()}
          onBackToBoard={() => {}}
          onSubmitTaskInput={onSubmitTaskInput}
          state={createLoadedState({
            taskDetail: createTaskDetail({
              thread: {
                id: 'thread-1',
                kind: 'background',
                title: '等待输入',
                goal: '等待输入',
                status: 'waiting_user',
                createdAt: '2026-05-16T07:00:00.000Z',
                updatedAt: '2026-05-16T07:05:00.000Z'
              }
            })
          })}
          taskActions={createTaskActionsMock()}
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    expect(queryTextarea('task-detail-followup-input').getAttribute('placeholder')).toBe('继续说明任务需要的信息...');
    setTextareaValue('task-detail-followup-input', '继续处理');
    await act(async () => {
      queryButton('task-detail-followup-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(onSubmitTaskInput).toHaveBeenCalledWith({ input: '继续处理', taskId: 'task-1', threadId: 'thread-1' });
  });

  it('renders task-domain controls and invokes task actions for the detail task', async () => {
    const taskActions = {
      cancelTask: vi.fn(),
      deleteTask: vi.fn(),
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      runNow: vi.fn()
    };
    const detail = createTaskDetail({
      backgroundTask: {
        id: 'task-1',
        threadId: 'thread-1',
        runId: 'run-1',
        goal: '整理工作区变更',
        status: 'running',
        scheduled: true,
        triggerType: 'manual',
        triggerDescription: '手动触发',
        nextRunAt: null,
        cronExpression: null,
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations',
        riskLevel: 'low',
        requiresConfirmation: false,
        lastRunAt: null,
        lastRunStatus: null,
        runCount: 0,
        createdAt: '2026-05-16T07:00:00.000Z',
        updatedAt: '2026-05-16T07:05:00.000Z',
        enabledCapabilities: null
      }
    });

    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={null}
          onApprovalDecision={vi.fn()}
          onBackToBoard={() => {}}
          onSubmitTaskInput={vi.fn()}
          state={createLoadedState({ taskDetail: detail })}
          taskActions={taskActions}
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="task-detail-actions"]')?.className).toContain('task-detail-actions');
    await act(async () => {
      queryButton('task-detail-action-pause').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      queryButton('task-detail-action-run-now').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      queryButton('task-detail-action-cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      queryButton('task-detail-action-delete').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(taskActions.pauseTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', threadId: 'thread-1' }));
    expect(taskActions.runNow).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', threadId: 'thread-1' }));
    expect(taskActions.cancelTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', threadId: 'thread-1' }));
    expect(taskActions.deleteTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', threadId: 'thread-1' }));
  });

  it('renders resume action for paused tasks', async () => {
    const taskActions = {
      cancelTask: vi.fn(),
      deleteTask: vi.fn(),
      pauseTask: vi.fn(),
      resumeTask: vi.fn(),
      runNow: vi.fn()
    };
    const detail = createTaskDetail({
      thread: {
        id: 'thread-1',
        kind: 'background',
        title: '暂停任务',
        goal: '暂停任务',
        status: 'paused',
        createdAt: '2026-05-16T07:00:00.000Z',
        updatedAt: '2026-05-16T07:05:00.000Z'
      },
      backgroundTask: {
        id: 'task-1',
        threadId: 'thread-1',
        runId: 'run-1',
        goal: '暂停任务',
        status: 'paused',
        scheduled: true,
        triggerType: 'manual',
        triggerDescription: '手动触发',
        nextRunAt: null,
        cronExpression: null,
        workspacePath: 'F:\\Code\\Roc',
        allowedActions: [],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations',
        riskLevel: 'low',
        requiresConfirmation: false,
        lastRunAt: null,
        lastRunStatus: null,
        runCount: 0,
        createdAt: '2026-05-16T07:00:00.000Z',
        updatedAt: '2026-05-16T07:05:00.000Z',
        enabledCapabilities: null
      }
    });

    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={null}
          onApprovalDecision={vi.fn()}
          onBackToBoard={() => {}}
          onSubmitTaskInput={vi.fn()}
          state={createLoadedState({ taskDetail: detail })}
          taskActions={taskActions}
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    await act(async () => {
      queryButton('task-detail-action-resume').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(taskActions.resumeTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', threadId: 'thread-1' }));
  });
});

function createTaskDetail(partial: Partial<NonNullable<ReturnType<typeof createLoadedState>['taskDetail']>>) {
  return {
    threadId: 'thread-1',
    taskId: 'task-1',
    lastRunId: 'run-1',
    schedulerRegistered: true,
    thread: {
      id: 'thread-1',
      kind: 'background',
      title: '整理工作区变更',
      goal: '整理工作区变更',
      status: 'running',
      createdAt: '2026-05-16T07:00:00.000Z',
      updatedAt: '2026-05-16T07:05:00.000Z'
    },
    backgroundTask: null,
    runHistory: [],
    recentEvents: [],
    ...partial
  } as NonNullable<ReturnType<typeof createLoadedState>['taskDetail']>;
}

function createTaskActionsMock() {
  return {
    cancelTask: vi.fn(),
    deleteTask: vi.fn(),
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
    runNow: vi.fn()
  };
}

function queryButton(testId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

function queryTextarea(testId: string): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(textarea).not.toBeNull();
  return textarea as HTMLTextAreaElement;
}

function setTextareaValue(testId: string, value: string): void {
  const textarea = queryTextarea(testId);
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
