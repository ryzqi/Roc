import { existsSync, readFileSync } from 'node:fs';

const boundaryFiles = [
  'files-ipc.ts',
  'ipc-common.ts',
  'plugin-capability-adapter.ts',
  'register-ipc.ts',
  'settings-ipc.ts',
  'shell-ipc.ts',
  'window-ipc.ts',
  'workspace-ipc.ts'
] as const;

const removedServiceSpecificFiles = [
  'app-ipc.ts',
  'tasks-ipc.ts',
  'lifecycle-ipc.ts',
  'diagnostics-ipc.ts',
  'memory-ipc.ts',
  'mcp-ipc.ts',
  'skills-ipc.ts',
  'agent-ipc.ts',
  'chat-ipc.ts',
  'git-ipc.ts',
  'terminal-ipc.ts',
  'rtk-ipc.ts'
] as const;

describe('IPC domain registration structure', () => {
  it('keeps register-ipc as an orchestrator over capability adapters and boundary supplements', () => {
    const root = new URL('../../src/main/ipc/', import.meta.url);
    const registerIpcSource = readFileSync(new URL('register-ipc.ts', root), 'utf8');

    for (const fileName of boundaryFiles) {
      expect(existsSync(new URL(fileName, root))).toBe(true);
    }
    for (const fileName of removedServiceSpecificFiles) {
      expect(existsSync(new URL(fileName, root))).toBe(false);
    }
    expect(registerIpcSource).toContain('registerPluginCapabilityIpc');
    expect(registerIpcSource).toContain('registerSettingsIpc');
    expect(registerIpcSource).toContain('registerShellConfirmIpc');
    expect(registerIpcSource).toContain('registerWorkspaceDialogIpc');
    expect(registerIpcSource).not.toContain('registerAppIpc');
    expect(registerIpcSource).not.toContain('registerShellIpc');
    expect(registerIpcSource).not.toContain('ipcChannels.gitStatus');
    expect(registerIpcSource).not.toContain('dialog.showOpenDialog');
  });

  it('keeps boundary IPC files free of service-specific capability registration exports', () => {
    const root = new URL('../../src/main/ipc/', import.meta.url);
    const shellSource = readFileSync(new URL('shell-ipc.ts', root), 'utf8');
    const workspaceSource = readFileSync(new URL('workspace-ipc.ts', root), 'utf8');
    const filesSource = readFileSync(new URL('files-ipc.ts', root), 'utf8');

    expect(shellSource).not.toContain('registerShellIpc');
    expect(workspaceSource).not.toContain('registerWorkspaceIpc');
    expect(filesSource).not.toContain('registerFilesIpc');
  });
});
