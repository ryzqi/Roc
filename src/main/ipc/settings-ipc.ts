import { ipcChannels } from '../../shared/ipc';
import type {
  McpServerSnapshot,
  ProviderSecretSetRequest,
  ProviderTestRequest,
  SettingsListRemoteModelsRequest,
  SettingsSaveHookConfigRequest,
  SettingsSaveRequest,
  SettingsSetDefaultModelRequest,
  SettingsSnapshot,
  SettingsTrustHookRequest,
  SkillSnapshot
} from '../../shared/types';
import type { ConfigService } from '../services/config-service';
import { logWarn, wrapIpc } from '../services/errors';
import { listRemoteModels } from '../services/remote-model-catalog';
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
  timedHandle(ipcChannels.settingsTestProvider, (_event, request: ProviderTestRequest) =>
    wrapIpc(() => providerRuntimeService.testProvider(request))
  );
  /**
   * 「拉取这个端点上有什么模型」（P10）。
   *
   * 密钥来源二选一，都在主进程里解决，不回传：
   *  - `apiKey`：用户刚在输入框里敲进去、还没保存的一次性明文；
   *  - `providerId`：设置里已经存好的凭据（用户的常见路径：建好 provider、存好 key，
   *    然后才发现模型标识要填对）。
   * 两者都没有时也允许发请求：本机推理服务（llama.cpp / LM Studio / Ollama）不需要凭据，
   * 没有 key 就一定是错的判断会把这批用户挡在外面。
   */
  timedHandle(ipcChannels.settingsListRemoteModels, (_event, request: SettingsListRemoteModelsRequest) =>
    wrapIpc(async () => {
      const apiKey = await resolveListApiKey(secretService, request);
      return listRemoteModels({ endpoint: request.endpoint, apiKey });
    })
  );
  // 「换默认模型」 的窄通道：只写 `defaultModelId`，其余字段原样保留。
  // 复用它的是助手的输入区（不想为了一个字段重发整份设置文档），以及任何只想
  // 改默认模型而手里没有完整草稿的调用方。返回整份快照，调用方据此刷新。
  timedHandle(ipcChannels.settingsSetDefaultModel, (_event, request: SettingsSetDefaultModelRequest) =>
    wrapIpc(async () => {
      configService.setDefaultModel(request.defaultModelId);
      return buildSettingsSnapshotAsync(configService, secretService, kernelSettings, controls, hooks);
    })
  );
  timedHandle(ipcChannels.settingsSetProviderSecret, (_event, request: ProviderSecretSetRequest) =>
    wrapIpc(async () => {
      await secretService.setProviderSecret(request.providerId, request.plaintext);
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

/**
 * 「拉取模型」要用的密钥，三种情况合并成一个值（P10）。
 *
 *  - 请求里带了明文 → 用它（用户刚输入、还没保存的那一份）；
 *  - 没带，但给了 providerId → 读钥匙串；
 *  - 读不到 → 返回 null 继续发请求。
 *
 * 最后一条是有意的：`getProviderSecret` 对未保存的凭据抛
 * `provider_credential_unavailable`，对钥匙串不可用抛 `secret_storage_unavailable`。
 * 前者必须当作「这个端点大概不需要密钥」继续（本机 llama.cpp / LM Studio / Ollama
 * 是主要用例），后者也不该拦住列表请求——列表能否拿到只取决于端点，凭据缺失最多让
 * 服务端回 401，而那条错误比这里的更具体。
 */
async function resolveListApiKey(
  secretService: SecretService,
  request: SettingsListRemoteModelsRequest
): Promise<string | null> {
  if (typeof request.apiKey === 'string' && request.apiKey.length > 0) {
    return request.apiKey;
  }
  if (request.providerId === null || request.providerId === undefined) {
    return null;
  }
  try {
    const stored = await secretService.getProviderSecret(request.providerId);
    return stored.length > 0 ? stored : null;
  } catch (error) {
    logWarn('Pulling models without a stored provider credential.', {
      component: 'settings-ipc',
      metadata: {
        providerId: request.providerId,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    return null;
  }
}
