// @vitest-environment jsdom
import React, { act } from 'react';
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
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    expect(container.querySelector('[data-testid="task-detail-view"]')).not.toBeNull();
    expect(container.textContent).toContain('返回任务工作台');
    expect(container.textContent).toContain('已经整理完成');
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
          taskId="task-1"
          updateLoadedState={() => {}}
        />
      );
    });

    setTextareaValue('task-detail-followup-input', '继续处理');
    await act(async () => {
      queryButton('task-detail-followup-submit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushPromises();

    expect(onSubmitTaskInput).toHaveBeenCalledWith({ input: '继续处理', taskId: 'task-1' });
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
