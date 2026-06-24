import { describe, expect, it, vi } from 'vitest';
import type { IpcMainHandler } from '../../src/main/ipc/ipc-common';
import { registerSettingsIpc } from '../../src/main/ipc/settings-ipc';
import { defaultPermissions, defaultProviders, defaultSettings } from '../../src/main/services/config/defaults';
import type { ConfigService } from '../../src/main/services/config-service';
import type { ProviderRuntimeService } from '../../src/main/services/provider-runtime-service';
import type { SecretService } from '../../src/main/services/secret-service';
import { ipcChannels } from '../../src/shared/ipc';
import type { SettingsSnapshot } from '../../src/shared/types';

function createHookSnapshot(input: { exists: boolean }): SettingsSnapshot['hooks'] {
  return {
    configPath: 'C:\\Users\\me\\.roc\\hooks.json',
    exists: input.exists,
    config: { schemaVersion: 1, hooks: {} },
    handlers: [],
    validationErrors: []
  };
}

function requireHandler(handlers: Map<string, IpcMainHandler>, channel: string): IpcMainHandler {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`missing_handler:${channel}`);
  }
  return handler;
}

describe('settings hook IPC', () => {
  it('registers hook config and trust handlers', async () => {
    const handlers = new Map<string, IpcMainHandler>();
    const configService = {
      getProvidersAsync: vi.fn(async () => defaultProviders),
      getSettingsAsync: vi.fn(async () => defaultSettings),
      getPermissionsAsync: vi.fn(async () => defaultPermissions),
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
    const hookConfigService = {
      loadConfigSnapshot: vi.fn(async () => createHookSnapshot({ exists: false })),
      saveConfig: vi.fn(async () => createHookSnapshot({ exists: true }))
    };
    const hookTrustService = {
      trust: vi.fn(async () => undefined)
    };

    registerSettingsIpc(
      (channel, handler) => handlers.set(channel, handler),
      configService,
      secretService,
      providerRuntimeService,
      kernelSettings,
      controls,
      { hookConfigService, hookTrustService }
    );

    expect(handlers.has(ipcChannels.settingsHooksGet)).toBe(true);
    expect(handlers.has(ipcChannels.settingsHooksSave)).toBe(true);
    expect(handlers.has(ipcChannels.settingsHooksTrust)).toBe(true);

    await expect(requireHandler(handlers, ipcChannels.settingsHooksGet)()).resolves.toMatchObject({
      ok: true,
      data: {
        exists: false
      }
    });
    await expect(
      requireHandler(handlers, ipcChannels.settingsHooksSave)(null, {
        config: { schemaVersion: 1, hooks: {} }
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        exists: true
      }
    });
    await expect(
      requireHandler(handlers, ipcChannels.settingsHooksTrust)(null, {
        handlerId: 'PreToolUse:0:0',
        hash: 'hash_1'
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        exists: false
      }
    });
    expect(hookTrustService.trust).toHaveBeenCalledWith({
      handlerId: 'PreToolUse:0:0',
      hash: 'hash_1'
    });
    expect(hookConfigService.saveConfig).toHaveBeenCalledWith({ schemaVersion: 1, hooks: {} });
  });
});
