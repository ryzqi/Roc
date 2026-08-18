// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRunState } from '../../src/renderer/chat-run-state';
import { TaskDetailView } from '../../src/renderer/views/tasks/TaskDetailView';
import { createLoadedState } from './view-test-helpers';

vi.mock('../../src/renderer/chat/streaming-markdown-view', () => ({
  StreamingMarkdownView: ({ text }: { text: string }) => text
}));

describe('TaskDetailView', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
    window.roc = {
      tasks: {
        getThreadMessages: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            items: [
              {
                id: 'message-user',
                threadId: 'thread-1',
                runId: 'run-1',
                type: 'message',
                payload: { role: 'user', content: '请整理工作区变更' },
                createdAt: '2026-05-16T07:00:00.000Z',
                sequence: 1
              },
              {
                id: 'message-assistant',
                threadId: 'thread-1',
                runId: 'run-1',
                type: 'message',
                payload: { role: 'assistant', content: '已经整理完成', providerId: 'test-provider', modelId: 'test-model' },
                createdAt: '2026-05-16T07:05:00.000Z',
                sequence: 2
              }
            ],
            oldestSequence: 1,
            newestSequence: 2,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        })
      }
    } as never;
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
                  payload: { role: 'assistant', content: '已经整理完成', providerId: 'test-provider', modelId: 'test-model' },
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
    await waitForText(container, '已经整理完成');
    expect(container.textContent).toContain('已经整理完成');
    expect(container.querySelector('.task-detail-page-head')).not.toBeNull();
    expect(container.querySelector('.task-detail-content-shell')).not.toBeNull();
    expect(container.querySelector('.task-detail-transcript-shell')).not.toBeNull();
  });

  it('merges the current task live subagent run into the detail transcript', async () => {
    vi.mocked(window.roc.tasks.getThreadMessages).mockResolvedValue({
      ok: true,
      data: {
        items: [],
        oldestSequence: null,
        newestSequence: null,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    });
    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={createLiveTaskRun({ threadId: 'thread-1' })}
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
                  payload: { role: 'user', content: '请分派子代理调查' },
                  createdAt: '2026-05-16T07:00:00.000Z'
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

    const subagent = container.querySelector<HTMLDetailsElement>('[data-testid="chat-activity-subagent"]');
    expect(subagent).not.toBeNull();
    expect(subagent?.open).toBe(true);
    expect(container.textContent).toContain('Subagent · general-purpose');
    await waitForText(container, '正在调查仓库状态');
    expect(container.textContent).toContain('正在调查仓库状态');
    expect(container.textContent).toContain('读取关键文件');
    expect(container.textContent).toContain('read_file');
    expect(container.textContent).not.toContain('task shell should stay hidden');
  });

  it('does not merge another thread live subagent run into the current task detail', async () => {
    await act(async () => {
      root.render(
        <TaskDetailView
          client={{ api: window.roc } as never}
          liveTaskRun={createLiveTaskRun({ threadId: 'thread-other' })}
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
                  payload: { role: 'user', content: '请分派子代理调查' },
                  createdAt: '2026-05-16T07:00:00.000Z'
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

    expect(container.querySelector('[data-testid="chat-activity-subagent"]')).toBeNull();
    expect(container.textContent).not.toContain('正在调查仓库状态');
  });

  it('renders the control console summary and metadata from the task detail', async () => {
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
              backgroundTask: {
                id: 'task-1',
                threadId: 'thread-1',
                runId: 'run-1',
                goal: '每天整理工作区变更并输出日报',
                status: 'running',
                scheduled: true,
                triggerType: 'cron',
                triggerDescription: '每天 09:00',
                nextRunAt: '2026-05-17T01:00:00.000Z',
                cronExpression: '0 9 * * *',
                workspacePath: 'F:\\\\Code\\\\Roc',
                allowedActions: ['读取工作区', '写入日报'],
                forbiddenActions: ['删除文件'],
                failurePolicy: 'pause_and_report',
                notificationPolicy: 'failures_and_confirmations',
                riskLevel: 'medium',
                requiresConfirmation: true,
                lastRunAt: '2026-05-16T01:00:00.000Z',
                lastRunStatus: 'success',
                runCount: 7,
                createdAt: '2026-05-15T07:00:00.000Z',
                updatedAt: '2026-05-16T07:05:00.000Z',
                enabledCapabilities: null
              },
              runHistory: [
                {
                  id: 'run-1',
                  threadId: 'thread-1',
                  runNumber: 7,
                  userInput: '执行日报任务',
                  status: 'completed',
                  startedAt: '2026-05-16T01:00:00.000Z',
                  endedAt: '2026-05-16T01:05:00.000Z',
                  modelId: 'gpt-5.4',
                  enabledCapabilities: {
                    mcpServers: ['filesystem'],
                    skills: ['task-planner']
                  }
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

    expect(container.querySelector('[data-testid="task-detail-summary-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-detail-meta-panel"]')).not.toBeNull();
    expect(container.textContent).toContain('每天整理工作区变更并输出日报');
    expect(container.textContent).toContain('running');
    expect(container.querySelector('.task-detail-head-pills')).toBeNull();
    expect(container.textContent).not.toContain('风险 medium');
    expect(container.textContent).not.toContain('调度器已注册');
    expect(container.textContent).toContain('F:\\\\Code\\\\Roc');
    expect(container.textContent).toContain('每天 09:00');
    expect(container.textContent).toContain('0 9 * * *');
    expect(container.textContent).toContain('2026-05-17 01:00');
    expect(container.textContent).toContain('运行 7 次');
    expect(container.textContent).toContain('需要确认');
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

    expect(onSubmitTaskInput).toHaveBeenCalledWith({
      input: '继续处理',
      taskId: 'task-1',
      threadId: 'thread-1',
      workspacePath: null
    });
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

function createLiveTaskRun({ threadId }: { threadId: string }): ChatRunState {
  return {
    runId: 'run-live',
    mode: 'task',
    threadId,
    providerId: 'openai',
    modelId: 'gpt-5.4',
    createdAt: '2026-05-16T07:00:01.000Z',
    status: 'running',
    assistantMessage: '',
    activityBlocks: [
      {
        id: 'tool-run-live-task',
        kind: 'tool_call',
        callId: 'call-run-live-task',
        name: 'task',
        status: 'start',
        input: { description: 'task shell should stay hidden' },
        output: null,
        error: null
      }
    ],
    durationMs: null,
    summary: null,
    errorCode: null,
    errorMessage: null,
    recoveryAttempt: null,
    retryable: false,
    pendingInterrupts: [],
    resumeBusy: false,
    todos: [],
    subagents: [
      {
        identity: {
          subagentId: 'subagent-live-0',
          parentSubagentId: null,
          name: 'general-purpose',
          depth: 0,
          path: ['general-purpose#0'],
          execution: 'sync',
          taskInput: 'task shell should stay hidden'
        },
        status: 'running',
        summary: null,
        error: null,
        blocks: [
          {
            id: 'subagent-live-0-text',
            kind: 'text',
            content: '正在调查仓库状态'
          },
          {
            id: 'subagent-live-0-reasoning',
            kind: 'reasoning',
            content: '读取关键文件'
          },
          {
            id: 'subagent-live-0-tool',
            kind: 'tool_call',
            callId: 'call-subagent-live-0-tool',
            name: 'read_file',
            status: 'end',
            input: { path: 'README.md' },
            output: { bytes: 128 },
            error: null
          }
        ],
        children: []
      }
    ]
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

async function waitForText(element: HTMLElement, text: string): Promise<void> {
  const startedAt = Date.now();
  while (!element.textContent?.includes(text)) {
    if (Date.now() - startedAt > 2000) {
      throw new Error(`Timed out waiting for text: ${text}`);
    }
    await flushPromises();
  }
}
