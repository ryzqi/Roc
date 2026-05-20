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
