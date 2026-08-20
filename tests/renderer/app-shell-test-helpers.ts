import { act } from 'react';
import { expect, vi } from 'vitest';
import type { AppBootstrap } from '../../src/renderer/app/use-app-bootstrap';
import type { LoadedState } from '../../src/renderer/loaded-state';
import type { RocClient } from '../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../src/shared/ipc';
import { backgroundTaskSchema } from '../../src/shared/schemas/ipc-core';
import type { ActiveTaskItem, TaskDetail, TaskStatus } from '../../src/shared/types';
import { createLoadedState } from './view-test-helpers';

export function createBootstrap(statePartial: Partial<LoadedState> = {}): AppBootstrap {
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

export function createShellClient(): RocClient {
  const state = createLoadedState({});
  const api = {
    app: {
      getStatus: vi.fn().mockResolvedValue({ ok: true, data: state.appStatus }),
      onAppearanceUpdated: vi.fn().mockReturnValue(() => {}),
      onNavigate: vi.fn().mockReturnValue(() => {})
    },
    tasks: {
      getSnapshot: vi.fn().mockResolvedValue({ ok: true, data: state.taskSnapshot }),
      getThreadMessages: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          items: [],
          oldestSequence: null,
          newestSequence: null,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }),
      getActiveTasks: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      getSchedulerStatus: vi.fn().mockResolvedValue({ ok: true, data: state.schedulerStatus }),
      getTaskDetail: vi.fn().mockResolvedValue({ ok: true, data: null }),
      listScheduledRuns: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      onUpdated: vi.fn().mockReturnValue(() => {}),
      deleteBackgroundTask: vi.fn().mockResolvedValue({ ok: true, data: { deleted: true, taskId: 'task-1' } }),
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
      getCapabilityPreview: vi.fn().mockResolvedValue({ ok: true, data: state.agentCapabilityPreview })
    },
    workspace: {
      selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: null }),
      onChanged: vi.fn().mockReturnValue(() => {})
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

export function createActiveTask(partial: {
  taskId: string;
  threadId: string;
  goal: string;
  status?: TaskStatus;
  workspacePath?: string | null;
}): ActiveTaskItem {
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
    workspacePath: partial.workspacePath === undefined ? 'F:\\Code\\Roc' : partial.workspacePath,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z'
  };
}

export function createTaskDetail(task: ActiveTaskItem): TaskDetail {
  return {
    threadId: task.threadId,
    taskId: task.taskId,
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

export function createBackgroundTaskDetail(task: ActiveTaskItem): TaskDetail {
  const detail = createTaskDetail(task);
  return {
    ...detail,
    backgroundTask: {
      id: task.taskId,
      threadId: task.threadId,
      runId: detail.lastRunId ?? 'run-created',
      goal: task.goal,
      status: backgroundTaskSchema.shape.status.parse(task.status),
      scheduled: true,
      triggerType: 'manual',
      triggerDescription: '手动触发',
      nextRunAt: task.nextRunAt,
      cronExpression: null,
      workspacePath: task.workspacePath ?? 'F:\\Code\\Roc',
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      riskLevel: task.riskLevel,
      requiresConfirmation: false,
      lastRunAt: task.lastRunAt,
      lastRunStatus: null,
      runCount: 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      enabledCapabilities: null
    }
  };
}

export function queryButton(testId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

export function setTextareaValue(testId: string, value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(textarea).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  expect(setter).not.toBeUndefined();
  setter?.call(textarea, value);
  textarea?.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
