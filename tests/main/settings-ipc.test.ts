import { describe, expect, it, vi } from 'vitest';
import { registerSettingsIpc } from '../../src/main/ipc/settings-ipc';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';
import { defaultPermissions, defaultProviders, defaultSettings } from '../../src/main/services/config/defaults';
import type { ConfigService } from '../../src/main/services/config-service';
import type { McpService } from '../../src/main/services/mcp-service';
import type { ProviderRuntimeService } from '../../src/main/services/provider-runtime-service';
import type { SecretService } from '../../src/main/services/secret-service';
import type { SkillService } from '../../src/main/services/skill-service';
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
    const mcpService = {
      listServers: vi.fn(() => [])
    } as unknown as McpService;
    const skillService = {
      list: vi.fn(() => [])
    } as unknown as SkillService;
    const providerRuntimeService = {
      testProvider: vi.fn()
    } as unknown as ProviderRuntimeService;
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
      mcpService,
      skillService,
      providerRuntimeService,
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
    expect(controls.syncHostSettings).toHaveBeenCalledWith(saveRequest.settings);
  });
});
