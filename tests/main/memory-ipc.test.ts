import { describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../../src/shared/ipc';
import { registerMemoryIpc } from '../../src/main/ipc/memory-ipc';
import type { MemoryService } from '../../src/main/services/memory-service';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';

describe('memory IPC', () => {
  it('registers status, read, and write handlers against MemoryService', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    const service = {
      status: vi.fn(() => ({ root: 'F:\\Code\\Roc\\.roc\\memory' })),
      readFile: vi.fn(() => '# user prefers PowerShell'),
      writeFile: vi.fn(() => ({ ok: true, meta: { scope: 'global', kind: 'user' } }))
    } as unknown as MemoryService;

    registerMemoryIpc((channel, handler) => handlers.set(channel, handler), service);

    expect(Array.from(handlers.keys()).sort()).toEqual([
      ipcChannels.memoryReadFile,
      ipcChannels.memoryStatus,
      ipcChannels.memoryWriteFile
    ].sort());

    await handlers.get(ipcChannels.memoryReadFile)?.(null, { scope: 'global', kind: 'user' });
    await handlers.get(ipcChannels.memoryWriteFile)?.(null, {
      scope: 'global',
      kind: 'user',
      content: '# user prefers PowerShell'
    });

    expect(service.readFile).toHaveBeenCalledWith({ scope: 'global', kind: 'user' });
    expect(service.writeFile).toHaveBeenCalledWith({
      scope: 'global',
      kind: 'user',
      content: '# user prefers PowerShell'
    });
  });
});
