import { describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../../src/shared/ipc';
import { registerMemoryIpc } from '../../src/main/ipc/memory-ipc';
import type { SessionArchiveService } from '../../src/main/services/memory/session-archive';
import type { MemoryService } from '../../src/main/services/memory-service';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';

describe('memory IPC', () => {
  it('registers status, read, and write handlers against MemoryService', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    const service = {
      status: vi.fn(() => ({ root: 'F:\\Code\\Roc\\.roc\\memory' })),
      readFile: vi.fn(() => {
        throw new Error('memoryReadFile IPC must use readFileAsync.');
      }),
      readFileAsync: vi.fn(async () => '# user prefers PowerShell'),
      writeFile: vi.fn(() => {
        throw new Error('memoryWriteFile IPC must use writeFileAsync.');
      }),
      writeFileAsync: vi.fn(async () => ({ ok: true, meta: { scope: 'global', kind: 'user' } })),
      buildSnapshotForCurrentWorkspace: vi.fn(() => ({
        user: {
          kind: 'user',
          filename: 'USER.md',
          content: '# user prefers PowerShell',
          charCount: 25,
          charLimit: 1375,
          source: 'global',
          enabled: true
        },
        agents: {
          kind: 'agents',
          filename: 'AGENTS.md',
          content: '',
          charCount: 0,
          charLimit: 800,
          source: 'global',
          enabled: true
        },
        memory: {
          kind: 'memory',
          filename: 'MEMORY.md',
          content: '',
          charCount: 0,
          charLimit: 2200,
          source: 'global',
          enabled: true
        },
        totalChars: 25,
        totalLimit: 4375,
        globallyEnabled: true
      }))
    } as unknown as MemoryService;
    const archive = {
      list: vi.fn(() => []),
      search: vi.fn(() => ({ query: 'electron', total: 0, items: [] }))
    } as unknown as SessionArchiveService;

    registerMemoryIpc((channel, handler) => handlers.set(channel, handler), service, archive);

    expect(Array.from(handlers.keys()).sort()).toEqual([
      ipcChannels.memoryReadFile,
      ipcChannels.memorySnapshotPreview,
      ipcChannels.memoryStatus,
      ipcChannels.memoryWriteFile,
      ipcChannels.sessionMessagesList,
      ipcChannels.sessionMessagesSearch
    ].sort());

    const snapshot = await handlers.get(ipcChannels.memorySnapshotPreview)?.(null);
    await handlers.get(ipcChannels.memoryReadFile)?.(null, { scope: 'global', kind: 'user' });
    await handlers.get(ipcChannels.memoryWriteFile)?.(null, {
      scope: 'global',
      kind: 'user',
      content: '# user prefers PowerShell'
    });
    await handlers.get(ipcChannels.sessionMessagesList)?.(null, { threadId: 't1', limit: 20 });
    await handlers.get(ipcChannels.sessionMessagesSearch)?.(null, {
      query: 'electron',
      workspaceScope: 'all',
      limit: 10
    });

    expect(snapshot).toMatchObject({
      ok: true,
      data: { text: expect.stringContaining('<FROZEN_SNAPSHOT>') }
    });
    expect(service.buildSnapshotForCurrentWorkspace).toHaveBeenCalled();
    expect(service.readFile).not.toHaveBeenCalled();
    expect(service.writeFile).not.toHaveBeenCalled();
    expect(service.readFileAsync).toHaveBeenCalledWith({ scope: 'global', kind: 'user' });
    expect(service.writeFileAsync).toHaveBeenCalledWith({
      scope: 'global',
      kind: 'user',
      content: '# user prefers PowerShell'
    });
    expect(archive.list).toHaveBeenCalledWith('t1', 20);
    expect(archive.search).toHaveBeenCalledWith({
      query: 'electron',
      workspaceScope: 'all',
      limit: 10
    });
  });
});
