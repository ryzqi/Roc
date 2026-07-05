import { ipcChannels } from '../../shared/ipc';
import type {
  McpServerSnapshot,
  ProviderSecretSetRequest,
  SettingsSaveHookConfigRequest,
  SettingsSaveRequest,
  SettingsSnapshot,
  SettingsTrustHookRequest,
  SkillSnapshot
} from '../../shared/types';
import type { ConfigService } from '../services/config-service';
import { wrapIpc } from '../services/errors';
import type { ProviderRuntimeService } from '../services/provider-runtime-service';
import type { SecretService } from '../services/secret-service';
import type { TimedHandle } from './ipc-common';
import type { AppWindowControls } from './register-ipc';

export type KernelSettingsBridge = {
  listMcpServers(): Promise<McpServerSnapshot[]>;
  listSkills(): Promise<SkillSnapshot[]>;
  syncSettingsSnapshot(request: SettingsSaveRequest): Promise<void> | void;
};

export type HookSettingsBridge = {
  hookConfigService: {
    loadConfigSnapshot(): Promise<SettingsSnapshot['hooks']>;
    saveConfig(config: SettingsSaveHookConfigRequest['config']): Promise<SettingsSnapshot['hooks']>;
  };
  hookTrustService: {
    trust(request: SettingsTrustHookRequest): Promise<void>;
  };
};

export function registerSettingsIpc(
  timedHandle: TimedHandle,
  configService: ConfigService,
  secretService: SecretService,
  providerRuntimeService: ProviderRuntimeService,
  kernelSettings: KernelSettingsBridge,
  controls: Pick<AppWindowControls, 'getHostIntegrationStatus' | 'syncHostSettings'>,
  hooks?: HookSettingsBridge
): void {
  timedHandle(ipcChannels.settingsGet, () =>
    wrapIpc(() => buildSettingsSnapshotAsync(configService, secretService, kernelSettings, controls, hooks))
  );
  timedHandle(ipcChannels.settingsSave, (_event, settings: SettingsSaveRequest) =>
    wrapIpc(async () => {
      const savedSettings = await configService.saveSettingsSnapshotAsync(settings);
      await kernelSettings.syncSettingsSnapshot(savedSettings);
      controls.syncHostSettings(savedSettings.settings);
      return await buildSettingsSnapshotAsync(configService, secretService, kernelSettings, controls, hooks);
    })
  );
  timedHandle(ipcChannels.settingsTestProvider, (_event, id: string) =>
    wrapIpc(() => providerRuntimeService.testProvider(id))
  );
  timedHandle(ipcChannels.settingsSetProviderSecret, (_event, request: ProviderSecretSetRequest) =>
    wrapIpc(() => {
      secretService.setProviderSecret(request.providerId, request.plaintext);
      return { providerId: request.providerId, stored: true as const };
    })
  );
  timedHandle(ipcChannels.settingsClearProviderSecret, (_event, providerId: string) =>
    wrapIpc(async () => {
      secretService.clearProviderSecret(providerId);
      const provider = (await configService.getProvidersAsync()).providers.find((entry) => entry.id === providerId);
      if (provider?.type === 'llama_cpp' && provider.credentialRef !== null) {
        await configService.upsertProviderAsync({
          ...provider,
          credentialRef: null
        });
      }
      return { providerId, stored: false as const };
    })
  );
  timedHandle(ipcChannels.settingsHooksGet, () =>
    wrapIpc(async () => {
      if (hooks === undefined) {
        throw new Error('hook_settings_unavailable');
      }
      return await hooks.hookConfigService.loadConfigSnapshot();
    })
  );
  timedHandle(ipcChannels.settingsHooksSave, (_event, request: SettingsSaveHookConfigRequest) =>
    wrapIpc(async () => {
      if (hooks === undefined) {
        throw new Error('hook_settings_unavailable');
      }
      return await hooks.hookConfigService.saveConfig(request.config);
    })
  );
  timedHandle(ipcChannels.settingsHooksTrust, (_event, request: SettingsTrustHookRequest) =>
    wrapIpc(async () => {
      if (hooks === undefined) {
        throw new Error('hook_settings_unavailable');
      }
      await hooks.hookTrustService.trust(request);
      return await hooks.hookConfigService.loadConfigSnapshot();
    })
  );
}

async function buildSettingsSnapshotAsync(
  configService: ConfigService,
  secretService: SecretService,
  kernelSettings: Pick<KernelSettingsBridge, 'listMcpServers' | 'listSkills'>,
  controls: Pick<AppWindowControls, 'getHostIntegrationStatus'>,
  hooks?: HookSettingsBridge
): Promise<SettingsSnapshot> {
  const providersConfig = await configService.getProvidersAsync();
  const providerSecretStatus = secretService.listSecretStatuses(providersConfig.providers.map((provider) => provider.id));
  const [mcpServers, skills] = await Promise.all([
    kernelSettings.listMcpServers(),
    kernelSettings.listSkills()
  ]);
  return {
    settings: await configService.getSettingsAsync(),
    providers: providersConfig.providers,
    defaultModelId: providersConfig.defaultModelId,
    providerSecretStatus,
    permissions: await configService.getPermissionsAsync(),
    mcpServers,
    skills,
    hooks: hooks === undefined ? unavailableHookConfigSnapshot() : await hooks.hookConfigService.loadConfigSnapshot(),
    hostIntegration: controls.getHostIntegrationStatus()
  };
}

function unavailableHookConfigSnapshot(): SettingsSnapshot['hooks'] {
  return {
    configPath: '',
    exists: false,
    config: {
      schemaVersion: 1,
      hooks: {}
    },
    handlers: [],
    validationErrors: ['hook_settings_unavailable']
  };
}
