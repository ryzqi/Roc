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
    wrapIpc(() => buildSettingsSnapshotAsync(configService, secretService, mcpService, skillService, controls))
  );
  timedHandle(ipcChannels.settingsSave, (_event, settings) =>
    wrapIpc(async () => {
      await configService.saveSettingsSnapshotAsync(settings);
      controls.syncHostSettings(settings.settings);
      return await buildSettingsSnapshotAsync(configService, secretService, mcpService, skillService, controls);
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
}

async function buildSettingsSnapshotAsync(
  configService: ConfigService,
  secretService: SecretService,
  mcpService: McpService,
  skillService: SkillService,
  controls: Pick<AppWindowControls, 'getHostIntegrationStatus'>
): Promise<SettingsSnapshot> {
  const providersConfig = await configService.getProvidersAsync();
  const providerSecretStatus = secretService.listSecretStatuses(providersConfig.providers.map((provider) => provider.id));
  return {
    settings: await configService.getSettingsAsync(),
    providers: providersConfig.providers,
    defaultModelId: providersConfig.defaultModelId,
    providerSecretStatus,
    permissions: await configService.getPermissionsAsync(),
    mcpServers: mcpService.listServers(),
    skills: skillService.list(),
    hostIntegration: controls.getHostIntegrationStatus()
  };
}
