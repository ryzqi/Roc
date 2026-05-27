import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { ipcChannels } from '../../src/shared/ipc';
import type { Workspace } from '../../src/shared/types';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      })
    },
    showOpenDialog: vi.fn()
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {
    showOpenDialog: electronMock.showOpenDialog
  },
  ipcMain: electronMock.ipcMain
}));

let root: string;
let workspaceRoot: string;
let services: AppServices;

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.ipcMain.handle.mockClear();
  electronMock.showOpenDialog.mockReset();
  root = mkdtempSync(join(tmpdir(), 'roc-ipc-test-'));
  workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  writeFileSync(join(workspaceRoot, 'real-file.txt'), 'workspace dialog ipc\n', 'utf8');
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

function registerWorkspaceHandlers(): void {
  registerIpc(services, {} as BrowserWindow, {
    openMainPage: () => undefined,
    openQuickEntry: async () => undefined,
    openTrayEntry: async () => undefined,
    broadcastTaskUpdated: () => undefined
  });
}

async function invokeWorkspaceDialogHandler(): Promise<unknown> {
  const handler = electronMock.handlers.get(ipcChannels.workspaceSelectFromDialog);
  if (handler === undefined) {
    throw new Error('workspaceSelectFromDialog handler was not registered.');
  }
  return handler();
}

describe('workspace dialog IPC', () => {
  it('registers terminal session IPC handlers', () => {
    registerWorkspaceHandlers();

    expect(electronMock.handlers.has(ipcChannels.terminalCreateSession)).toBe(true);
    expect(electronMock.handlers.has(ipcChannels.terminalWriteInput)).toBe(true);
    expect(electronMock.handlers.has(ipcChannels.terminalResize)).toBe(true);
    expect(electronMock.handlers.has(ipcChannels.terminalCloseSession)).toBe(true);
  });

  it('registers chat run IPC handlers and delegates to the Deep Agents runtime', async () => {
    registerWorkspaceHandlers();
    const startRunSpy = vi.spyOn(services.deepAgentRuntimeService, 'startRun').mockResolvedValue({
      runId: 'chat_123',
      mode: 'chat',
      threadId: 'thread_123',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6',
      createdAt: '2026-05-09T00:00:00.000Z'
    });
    const cancelRunSpy = vi.spyOn(services.deepAgentRuntimeService, 'cancelRun').mockReturnValue({
      runId: 'chat_123',
      cancelled: true
    });

    const startHandler = electronMock.handlers.get(ipcChannels.chatStartRun);
    const cancelHandler = electronMock.handlers.get(ipcChannels.chatCancelRun);
    if (startHandler === undefined || cancelHandler === undefined) {
      throw new Error('chat run handlers were not registered.');
    }

    const startResult = await startHandler({}, {
      input: 'hello',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const cancelResult = await cancelHandler({}, 'chat_123');

    expect(startRunSpy).toHaveBeenCalledWith({
      input: 'hello',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    expect(cancelRunSpy).toHaveBeenCalledWith('chat_123');
    expect(startResult).toEqual({
      ok: true,
      data: {
        runId: 'chat_123',
        mode: 'chat',
        threadId: 'thread_123',
        providerId: 'nvidia',
        modelId: 'moonshotai/kimi-k2.6',
        createdAt: '2026-05-09T00:00:00.000Z'
      }
    });
    expect(cancelResult).toEqual({
      ok: true,
      data: {
        runId: 'chat_123',
        cancelled: true
      }
    });
  });

  it('registers delete thread IPC and delegates to TaskService', async () => {
    registerWorkspaceHandlers();
    const archiveThreadSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & {
          archiveThread: (threadId: string) => { deleted: true; threadId: string };
        },
        'archiveThread'
      )
      .mockReturnValue({
        deleted: true,
        threadId: 'thread_123'
      });

    const deleteHandler = electronMock.handlers.get(ipcChannels.tasksDeleteThread);
    if (deleteHandler === undefined) {
      throw new Error('tasksDeleteThread handler was not registered.');
    }

    const result = await deleteHandler({}, { threadId: 'thread_123' });

    expect(archiveThreadSpy).toHaveBeenCalledWith('thread_123');
    expect(result).toEqual({
      ok: true,
      data: {
        deleted: true,
        threadId: 'thread_123'
      }
    });
  });

  it('registers task workbench IPC handlers and delegates to task services', async () => {
    registerWorkspaceHandlers();
    const getActiveTasksSpy = vi
      .spyOn(services.taskService as AppServices['taskService'] & { getActiveTasks: () => unknown[] }, 'getActiveTasks')
      .mockReturnValue([]);
    const getTaskDetailSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & { getTaskDetail: (request: unknown) => unknown },
        'getTaskDetail'
      )
      .mockReturnValue({ taskId: 'task_1', schedulerRegistered: true });
    const listScheduledRunsSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & {
          listScheduledRuns: (request: unknown) => unknown[];
        },
        'listScheduledRuns'
      )
      .mockReturnValue([]);
    const updateBackgroundTaskSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & { updateBackgroundTask: (request: unknown) => unknown },
        'updateBackgroundTask'
      )
      .mockReturnValue({ id: 'task_1' });
    const deleteBackgroundTaskSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & {
          deleteBackgroundTask: (taskId: string) => { deleted: true };
        },
        'deleteBackgroundTask'
      )
      .mockReturnValue({ deleted: true });
    const openInChatSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & {
          openBackgroundTaskInChat: (taskId: string) => { threadId: string };
        },
        'openBackgroundTaskInChat'
      )
      .mockReturnValue({
        threadId: 'thread_1'
      });
    const schedulerStatusSpy = vi.spyOn(services.taskSchedulerService, 'getStatus').mockReturnValue({
      running: true,
      registeredTaskCount: 1,
      nextFireAt: '2026-05-22T01:00:00.000Z',
      recentSkippedCount: 0,
      lastError: null
    });
    const runNowSpy = vi.spyOn(services.taskSchedulerService, 'fire').mockResolvedValue('run_1');
    const registerTaskSpy = vi.spyOn(services.taskSchedulerService, 'registerTask').mockImplementation(() => {});
    const unregisterTaskSpy = vi.spyOn(services.taskSchedulerService, 'unregisterTask').mockImplementation(() => {});
    const createdTask = {
      id: 'task_created',
      threadId: 'thread_created',
      runId: 'run_created',
      goal: '新建后台任务',
      status: 'running',
      scheduled: true,
      triggerType: 'once',
      triggerDescription: '一次',
      nextRunAt: '2026-05-22T01:00:00.000Z',
      cronExpression: null,
      workspacePath: workspaceRoot,
      allowedActions: ['pnpm test'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations',
      riskLevel: 'medium',
      requiresConfirmation: false,
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0,
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z'
    };
    const pausedTask = {
      ...createdTask,
      id: 'task_paused',
      status: 'paused'
    };
    const resumedTask = {
      ...createdTask,
      id: 'task_resumed',
      status: 'running'
    };
    const createBackgroundTaskSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & { createBackgroundTask: (preview: unknown) => unknown },
        'createBackgroundTask'
      )
      .mockReturnValue(createdTask);
    const pauseBackgroundTaskSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & { pauseBackgroundTask: (taskId: string) => unknown },
        'pauseBackgroundTask'
      )
      .mockReturnValue(pausedTask);
    const resumeBackgroundTaskSpy = vi
      .spyOn(
        services.taskService as AppServices['taskService'] & { resumeBackgroundTask: (taskId: string) => unknown },
        'resumeBackgroundTask'
      )
      .mockReturnValue(resumedTask);

    const handlers = [
      ipcChannels.tasksCreateBackgroundTask,
      ipcChannels.tasksPauseBackgroundTask,
      ipcChannels.tasksResumeBackgroundTask,
      ipcChannels.tasksGetActiveTasks,
      ipcChannels.tasksGetTaskDetail,
      ipcChannels.tasksListScheduledRuns,
      ipcChannels.tasksRunBackgroundNow,
      ipcChannels.tasksDeleteBackgroundTask,
      ipcChannels.tasksUpdateBackgroundTask,
      ipcChannels.tasksOpenInChat,
      ipcChannels.tasksGetSchedulerStatus
    ];
    for (const channel of handlers) {
      expect(electronMock.handlers.has(channel)).toBe(true);
    }

    await electronMock.handlers.get(ipcChannels.tasksCreateBackgroundTask)?.({}, {
      goal: '新建后台任务'
    });
    await electronMock.handlers.get(ipcChannels.tasksPauseBackgroundTask)?.({}, 'task_paused');
    await electronMock.handlers.get(ipcChannels.tasksResumeBackgroundTask)?.({}, 'task_resumed');
    await electronMock.handlers.get(ipcChannels.tasksGetActiveTasks)?.({});
    await electronMock.handlers.get(ipcChannels.tasksGetTaskDetail)?.({}, { taskId: 'task_1' });
    await electronMock.handlers.get(ipcChannels.tasksListScheduledRuns)?.({}, { taskId: 'task_1', limit: 5 });
    await electronMock.handlers.get(ipcChannels.tasksRunBackgroundNow)?.({}, 'task_1');
    await electronMock.handlers.get(ipcChannels.tasksDeleteBackgroundTask)?.({}, 'task_1');
    await electronMock.handlers.get(ipcChannels.tasksUpdateBackgroundTask)?.({}, {
      taskId: 'task_1',
      patch: {},
      reason: 'test'
    });
    await electronMock.handlers.get(ipcChannels.tasksOpenInChat)?.({}, { taskId: 'task_1' });
    await electronMock.handlers.get(ipcChannels.tasksGetSchedulerStatus)?.({});

    expect(createBackgroundTaskSpy).toHaveBeenCalledWith({
      goal: '新建后台任务'
    });
    expect(registerTaskSpy).toHaveBeenCalledWith(createdTask);
    expect(pauseBackgroundTaskSpy).toHaveBeenCalledWith('task_paused');
    expect(unregisterTaskSpy).toHaveBeenCalledWith('task_paused');
    expect(resumeBackgroundTaskSpy).toHaveBeenCalledWith('task_resumed');
    expect(registerTaskSpy).toHaveBeenCalledWith(resumedTask);
    expect(getActiveTasksSpy).toHaveBeenCalled();
    expect(getTaskDetailSpy).toHaveBeenCalledWith({
      taskId: 'task_1',
      schedulerRegistered: true
    });
    expect(listScheduledRunsSpy).toHaveBeenCalledWith({ taskId: 'task_1', limit: 5 });
    expect(runNowSpy).toHaveBeenCalledWith('task_1');
    expect(deleteBackgroundTaskSpy).toHaveBeenCalledWith('task_1');
    expect(unregisterTaskSpy).toHaveBeenCalledWith('task_1');
    expect(updateBackgroundTaskSpy).toHaveBeenCalledWith({
      taskId: 'task_1',
      patch: {},
      reason: 'test'
    });
    expect(openInChatSpy).toHaveBeenCalledWith('task_1');
    expect(schedulerStatusSpy).toHaveBeenCalled();
  });

  it('does not return fake run-now success when the scheduler starts no run', async () => {
    const broadcastTaskUpdated = vi.fn();
    registerIpc(services, {} as BrowserWindow, {
      openMainPage: () => undefined,
      openQuickEntry: async () => undefined,
      openTrayEntry: async () => undefined,
      broadcastTaskUpdated
    });
    const runNowSpy = vi.spyOn(services.taskSchedulerService, 'fire').mockResolvedValue(null);

    const result = await electronMock.handlers.get(ipcChannels.tasksRunBackgroundNow)?.({}, 'task_1');

    expect(runNowSpy).toHaveBeenCalledWith('task_1');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'background_task_run_not_started',
        message: '后台任务没有启动新的运行。',
        category: 'conflict',
        retryable: true,
        userAction: '请刷新任务工作台，确认任务仍处于可运行状态后重试。'
      }
    });
    expect(broadcastTaskUpdated).not.toHaveBeenCalled();
  });

  it('records timing metadata for registered IPC handlers', async () => {
    registerWorkspaceHandlers();
    vi.spyOn(
      services.taskService as AppServices['taskService'] & {
        archiveThread: (threadId: string) => { deleted: true; threadId: string };
      },
      'archiveThread'
    ).mockReturnValue({
      deleted: true,
      threadId: 'thread_123'
    });

    const deleteHandler = electronMock.handlers.get(ipcChannels.tasksDeleteThread);
    if (deleteHandler === undefined) {
      throw new Error('tasksDeleteThread handler was not registered.');
    }

    await deleteHandler({}, { threadId: 'thread_123' });

    const ipcSamples = services.performanceObserverService
      .getSnapshot()
      .samples.filter((sample) => sample.phase === 'ipc_call');
    expect(ipcSamples).toEqual([
      expect.objectContaining({
        label: ipcChannels.tasksDeleteThread,
        metadata: {
          channel: ipcChannels.tasksDeleteThread,
          ok: true
        }
      })
    ]);
  });

  it('returns null when directory selection is cancelled', async () => {
    registerWorkspaceHandlers();
    electronMock.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: []
    });

    const result = await invokeWorkspaceDialogHandler();

    expect(result).toEqual({ ok: true, data: null });
    expect(services.workspaceService.getCurrentWorkspace()).toBeNull();
  });

  it('selects a real directory from the system dialog result', async () => {
    registerWorkspaceHandlers();
    electronMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [workspaceRoot]
    });

    const result = await invokeWorkspaceDialogHandler();

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: workspaceRoot,
        displayName: 'workspace',
        trustState: 'trusted'
      } satisfies Partial<Workspace>
    });
    expect(services.workspaceService.getCurrentWorkspace()?.path).toBe(workspaceRoot);
  });
});
