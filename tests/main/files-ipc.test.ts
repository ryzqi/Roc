import { describe, expect, it, vi } from 'vitest';

import { registerFilesDialogIpc } from '../../src/main/ipc/files-ipc';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';
import { ipcChannels } from '../../src/shared/ipc';

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn()
  }
}));

describe('files IPC', () => {
  it('selects the smoke image fixture for chat image attachment coverage', async () => {
    vi.stubEnv('ROC_SMOKE', '1');
    const handlers = new Map<string, IpcMainHandler>();

    registerFilesDialogIpc(
      (channel, handler) => handlers.set(channel, handler),
      {} as never,
      {
        getCurrentWorkspace: () => ({
          id: 'workspace_1',
          path: 'C:\\roc-smoke-workspace',
          displayName: 'roc-smoke-workspace',
          lastOpenedAt: '2026-07-03T00:00:00.000Z',
          trustState: 'trusted'
        })
      }
    );

    const result = await handlers.get(ipcChannels.filesSelectFromDialog)?.();

    expect(result).toEqual({
      ok: true,
      data: {
        filePaths: ['C:\\roc-smoke-workspace\\assets\\smoke-image.png']
      }
    });
  });
});
