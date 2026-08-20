import type {
  AgentRuntimeStatus,
  AppSettings,
  HostIntegrationStatus,
  McpServerSnapshot,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult,
  RocHookConfigSnapshot,
  SettingsSaveRequest,
  SettingsSnapshot,
  SkillSnapshot
} from '../../shared/types';
import { buildProviderModelKey, parseProviderModelKey } from '../../shared/provider-model-key';
import type { LoadedState } from '../loaded-state';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';

export type LoadedSettingsState = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  hookSettings: RocHookConfigSnapshot;
  hostIntegration: HostIntegrationStatus;
  providerTestStatus: ProviderTestResult | null;
  mcpTestStatus: null;
};

export function applySettingsSnapshot(snapshot: SettingsSnapshot): LoadedSettingsState {
  return {
    settings: snapshot.settings,
    providers: snapshot.providers,
    defaultModelId: snapshot.defaultModelId,
    providerSecretStatus: snapshot.providerSecretStatus,
    permissions: snapshot.permissions,
    mcpServers: snapshot.mcpServers,
    skills: snapshot.skills,
    hookSettings: snapshot.hooks,
    hostIntegration: snapshot.hostIntegration,
    providerTestStatus: null,
    mcpTestStatus: null
  };
}

export async function buildSettingsStateUpdate(client: RocClient, snapshot: SettingsSnapshot): Promise<Partial<LoadedState>> {
  return {
    ...applySettingsSnapshot(snapshot),
    agent: unwrap<AgentRuntimeStatus>('agent status', await client.api.agent.getStatus()),
    agentCapabilityPreview: null
  };
}

export function buildSettingsSaveRequest(data: {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  permissions: PermissionsConfig;
}): SettingsSaveRequest {
  return {
    settings: data.settings,
    providers: data.providers,
    defaultModelId: data.defaultModelId,
    permissions: data.permissions
  };
}

export function upsertProviderInSettingsSaveRequest(
  request: SettingsSaveRequest,
  provider: ProviderConfig
): SettingsSaveRequest {
  const existingIndex = request.providers.findIndex((item) => item.id === provider.id);
  const defaultModelKey = request.defaultModelId === null ? null : parseProviderModelKey(request.defaultModelId);
  const clearsDefaultModel =
    defaultModelKey !== null &&
    defaultModelKey.providerId === provider.id &&
    (!provider.enabled ||
      !provider.models.some((model) => model.id === defaultModelKey.modelId && model.enabled));
  return {
    ...request,
    defaultModelId: clearsDefaultModel ? null : request.defaultModelId,
    providers:
      existingIndex === -1
        ? [...request.providers, provider]
        : request.providers.map((item) => (item.id === provider.id ? provider : item))
  };
}

export function deleteProviderFromSettingsSaveRequest(
  request: SettingsSaveRequest,
  providerId: string
): SettingsSaveRequest {
  const deletedProvider = request.providers.find((provider) => provider.id === providerId);
  if (deletedProvider === undefined) {
    return request;
  }
  const defaultModelKey = request.defaultModelId === null ? null : parseProviderModelKey(request.defaultModelId);
  const clearsDefaultModel =
    defaultModelKey !== null &&
    defaultModelKey.providerId === deletedProvider.id &&
    deletedProvider.models.some((model) => buildProviderModelKey(deletedProvider.id, model.id) === request.defaultModelId);
  return {
    ...request,
    providers: request.providers.filter((provider) => provider.id !== providerId),
    defaultModelId: clearsDefaultModel ? null : request.defaultModelId
  };
}

export function setDefaultModelInSettingsSaveRequest(
  request: SettingsSaveRequest,
  modelId: string | null
): SettingsSaveRequest {
  return {
    ...request,
    defaultModelId: modelId
  };
}
