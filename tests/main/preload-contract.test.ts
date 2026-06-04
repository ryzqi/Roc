import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      electronMock.exposed.set(key, value);
    })
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  }
}));

vi.mock('electron', () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer
}));

describe('preload contract', () => {
  it('exposes the Roc API key tree expected by renderer and smoke contracts', async () => {
    electronMock.exposed.clear();
    await import('../../src/preload/index');

    const api = electronMock.exposed.get('roc') as Record<string, Record<string, unknown>>;
    expect(Object.keys(api).sort()).toEqual([
      'agent',
      'app',
      'chat',
      'diagnostics',
      'files',
      'git',
      'lifecycle',
      'mcp',
      'memory',
      'rtk',
      'sessions',
      'settings',
      'shell',
      'skills',
      'tasks',
      'terminal',
      'window',
      'workspace'
    ]);
    expect(Object.keys(api.window).sort()).toEqual(['close', 'getBounds', 'getState', 'minimize', 'toggleMaximize']);
    expect(Object.keys(api.shell).sort()).toEqual(['confirm', 'execute']);
    expect(Object.keys(api.diagnostics).sort()).toEqual([
      'createDiagnosticPackage',
      'getMetricsSnapshot',
      'runChecks',
      'runHealthCheck',
      'samplePerformance'
    ]);
    expect(Object.keys(api.memory).sort()).toEqual(['readFile', 'snapshotPreview', 'status', 'writeFile']);
    expect(Object.keys(api.sessions).sort()).toEqual(['list', 'search']);
    expect(JSON.stringify(api)).not.toContain('invokeCapability');
    expect(JSON.stringify(api)).not.toContain('*');
  });
});
