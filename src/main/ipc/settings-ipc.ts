import { ipcChannels } from '../../shared/ipc';
import type { ProviderSecretSetRequest, SettingsSnapshot } from '../../shared/types';
import type { ConfigService } from '../services/config-service';
import { wrapIpc } from '../services/errors';
import type { McpService } from '../services/mcp-service';
import type { ProviderRuntimeService } from '../services/provider-runtime-service';
import type { SecretService } from '../services/secret-service';
import type { SkillService } from '../services/skill-service';
import type { TimedHandle } from './ipc-common';
import type { AppWindowControls } from './register-ipc';

export function registerSettingsIpc(
  timedHandle: TimedHandle,
  configService: ConfigService,
  secretService: SecretService,
  mcpService: McpService,
  skillService: SkillService,
  providerRuntimeService: ProviderRuntimeService,
  controls: Pick<AppWindowControls, 'getHostIntegrationStatus' | 'syncHostSettings'>
): void {
  timedHandle(ipcChannels.settingsGet, () =>
    wrapIpc(() => buildSettingsSnapshot(configService, secretService, mcpService, skillService, controls))
  );
  timedHandle(ipcChannels.settingsSave, (_event, settings) =>
    wrapIpc(() => {
      configService.saveSettingsSnapshot(settings);
      controls.syncHostSettings(settings.settings);
      return buildSettingsSnapshot(configService, secretService, mcpService, skillService, controls);
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
    wrapIpc(() => {
      secretService.clearProviderSecret(providerId);
      const provider = configService.getProviders().providers.find((entry) => entry.id === providerId);
      if (provider?.type === 'llama_cpp' && provider.credentialRef !== null) {
        configService.upsertProvider({
          ...provider,
          credentialRef: null
        });
      }
      return { providerId, stored: false as const };
    })
  );
}

function buildSettingsSnapshot(
  configService: ConfigService,
  secretService: SecretService,
  mcpService: McpService,
  skillService: SkillService,
  controls: Pick<AppWindowControls, 'getHostIntegrationStatus'>
): SettingsSnapshot {
  const providersConfig = configService.getProviders();
  const providerSecretStatus = secretService.listSecretStatuses(providersConfig.providers.map((provider) => provider.id));
  return {
    settings: configService.getSettings(),
    providers: providersConfig.providers,
    defaultModelId: providersConfig.defaultModelId,
    providerSecretStatus,
    permissions: configService.getPermissions(),
    mcpServers: mcpService.listServers(),
    skills: skillService.list(),
    hostIntegration: controls.getHostIntegrationStatus()
  };
}
