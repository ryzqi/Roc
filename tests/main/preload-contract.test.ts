import { describe, expect, it, vi } from 'vitest';

import { ipcChannels, type RocPreloadApi } from '../../src/shared/ipc';

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

    const api = electronMock.exposed.get('roc') as RocPreloadApi;
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
    expect(Object.keys(api.settings).sort()).toEqual([
      'clearProviderSecret',
      'get',
      'getHooks',
      'save',
      'saveHooks',
      'setProviderSecret',
      'testProvider',
      'trustHook'
    ]);
    expect(Object.keys(api.agent).sort()).toEqual([
      'clearLangSmithApiKey',
      'getCapabilityPreview',
      'getConfigPreview',
      'getLangSmithSettings',
      'getStatus',
      'saveLangSmithSettings',
      'setLangSmithApiKey'
    ]);

    electronMock.ipcRenderer.invoke.mockClear();
    const config = { schemaVersion: 1 as const, enabled: false, projectName: 'roc' };
    await api.agent.getLangSmithSettings();
    await api.agent.saveLangSmithSettings(config);
    await api.agent.setLangSmithApiKey({ apiKey: 'lsv2-test' });
    await api.agent.clearLangSmithApiKey();

    expect(electronMock.ipcRenderer.invoke.mock.calls).toEqual([
      [ipcChannels.agentLangSmithSettingsGet],
      [ipcChannels.agentLangSmithSettingsSave, config],
      [ipcChannels.agentLangSmithSecretSet, { apiKey: 'lsv2-test' }],
      [ipcChannels.agentLangSmithSecretClear]
    ]);
    expect(JSON.stringify(api)).not.toContain('invokeCapability');
    expect(JSON.stringify(api)).not.toContain('*');
  });
});
