import { existsSync, readFileSync } from 'node:fs';

const domainFiles = [
  'app-ipc.ts',
  'window-ipc.ts',
  'tasks-ipc.ts',
  'lifecycle-ipc.ts',
  'diagnostics-ipc.ts',
  'memory-ipc.ts',
  'settings-ipc.ts',
  'mcp-ipc.ts',
  'skills-ipc.ts',
  'agent-ipc.ts',
  'chat-ipc.ts',
  'workspace-ipc.ts',
  'files-ipc.ts',
  'git-ipc.ts',
  'terminal-ipc.ts',
  'shell-ipc.ts'
];

describe('IPC domain registration structure', () => {
  it('keeps register-ipc as an orchestrator over domain-specific registrars', () => {
    const root = new URL('../../src/main/ipc/', import.meta.url);
    const registerIpcSource = readFileSync(new URL('register-ipc.ts', root), 'utf8');

    for (const fileName of domainFiles) {
      expect(existsSync(new URL(fileName, root))).toBe(true);
    }
    expect(registerIpcSource).toContain('registerAppIpc');
    expect(registerIpcSource).toContain('registerShellIpc');
    expect(registerIpcSource).not.toContain('ipcChannels.gitStatus');
    expect(registerIpcSource).not.toContain('dialog.showOpenDialog');
  });
});
