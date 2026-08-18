import { describe, expect, it, vi } from 'vitest';

import { ipcChannels, type RocPreloadApi } from '../../src/shared/ipc';
import { ipcRegistry } from '../../src/shared/ipc-registry';

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
    const registryEntries = [...ipcRegistry.requests, ...ipcRegistry.events];
    const expectedMethodsByDomain = Object.fromEntries(
      [...new Set(registryEntries.map((entry) => entry.domain))].map((domain) => [
        domain,
        registryEntries
          .filter((entry) => entry.domain === domain)
          .map((entry) => entry.method)
          .sort()
      ])
    );
    const actualMethodsByDomain = Object.fromEntries(
      Object.entries(api).map(([domain, methods]) => [domain, Object.keys(methods).sort()])
    );

    expect(actualMethodsByDomain).toEqual(expectedMethodsByDomain);

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
