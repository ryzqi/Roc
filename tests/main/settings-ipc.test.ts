import { describe, expect, it, vi } from 'vitest';
import { registerSettingsIpc } from '../../src/main/ipc/settings-ipc';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';
import { defaultPermissions, defaultProviders, defaultSettings } from '../../src/main/services/config/defaults';
import type { ConfigService } from '../../src/main/services/config-service';
import type { ProviderRuntimeService } from '../../src/main/services/provider-runtime-service';
import type { SecretService } from '../../src/main/services/secret-service';
import { ipcChannels } from '../../src/shared/ipc';

describe('settings IPC', () => {
  it('uses asynchronous config reads and writes for settings get and save', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    const configService = {
      getProviders: vi.fn(() => {
        throw new Error('settings IPC must use getProvidersAsync.');
      }),
      getProvidersAsync: vi.fn(async () => defaultProviders),
      getSettings: vi.fn(() => {
        throw new Error('settings IPC must use getSettingsAsync.');
      }),
      getSettingsAsync: vi.fn(async () => defaultSettings),
      getPermissions: vi.fn(() => {
        throw new Error('settings IPC must use getPermissionsAsync.');
      }),
      getPermissionsAsync: vi.fn(async () => defaultPermissions),
      saveSettingsSnapshot: vi.fn(() => {
        throw new Error('settings IPC must use saveSettingsSnapshotAsync.');
      }),
      saveSettingsSnapshotAsync: vi.fn(async (request) => request)
    } as unknown as ConfigService;
    const secretService = {
      listSecretStatuses: vi.fn(() => [])
    } as unknown as SecretService;
    const providerRuntimeService = {
      testProvider: vi.fn()
    } as unknown as ProviderRuntimeService;
    const kernelSettings = {
      listMcpServers: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      syncSettingsSnapshot: vi.fn(async () => undefined)
    };
    const controls = {
      getHostIntegrationStatus: vi.fn(() => ({
        startup: {
          configuredOpenAtLogin: false,
          effectiveOpenAtLogin: false,
          syncError: null
        },
        globalHotkey: {
          accelerator: null,
          registered: false,
          registrationError: null
        }
      })),
      syncHostSettings: vi.fn()
    };

    registerSettingsIpc(
      (channel, handler) => handlers.set(channel, handler),
      configService,
      secretService,
      providerRuntimeService,
      kernelSettings,
      controls
    );

    const getResult = await handlers.get(ipcChannels.settingsGet)?.(null);
    const saveRequest = {
      settings: {
        ...defaultSettings,
        globalHotkey: 'Ctrl+Alt+R'
      },
      providers: defaultProviders.providers,
      defaultModelId: defaultProviders.defaultModelId,
      permissions: defaultPermissions
    };
    const saveResult = await handlers.get(ipcChannels.settingsSave)?.(null, saveRequest);

    expect(getResult).toMatchObject({
      ok: true,
      data: {
        settings: defaultSettings,
        providers: defaultProviders.providers
      }
    });
    expect(saveResult).toMatchObject({
      ok: true,
      data: {
        settings: defaultSettings,
        providers: defaultProviders.providers
      }
    });
    expect(configService.getSettings).not.toHaveBeenCalled();
    expect(configService.getProviders).not.toHaveBeenCalled();
    expect(configService.getPermissions).not.toHaveBeenCalled();
    expect(configService.saveSettingsSnapshot).not.toHaveBeenCalled();
    expect(configService.getSettingsAsync).toHaveBeenCalledTimes(2);
    expect(configService.getProvidersAsync).toHaveBeenCalledTimes(2);
    expect(configService.getPermissionsAsync).toHaveBeenCalledTimes(2);
    expect(configService.saveSettingsSnapshotAsync).toHaveBeenCalledWith(saveRequest);
    expect(kernelSettings.listMcpServers).toHaveBeenCalledTimes(2);
    expect(kernelSettings.listSkills).toHaveBeenCalledTimes(2);
    expect(kernelSettings.syncSettingsSnapshot).toHaveBeenCalledWith(saveRequest);
    expect(controls.syncHostSettings).toHaveBeenCalledWith(saveRequest.settings);
  });
});
