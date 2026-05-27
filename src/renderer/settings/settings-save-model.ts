import type {
  AppSettings,
  HostIntegrationStatus,
  McpServerSnapshot,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult,
  SettingsSaveRequest,
  SettingsSnapshot,
  SkillSnapshot
} from '../../shared/types';

export type LoadedSettingsState = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
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
    hostIntegration: snapshot.hostIntegration,
    providerTestStatus: null,
    mcpTestStatus: null
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
  const clearsDefaultModel =
    !provider.enabled &&
    request.defaultModelId !== null &&
    provider.models.some((model) => model.id === request.defaultModelId);
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
  const deletedModelIds = new Set(deletedProvider.models.map((model) => model.id));
  return {
    ...request,
    providers: request.providers.filter((provider) => provider.id !== providerId),
    defaultModelId:
      request.defaultModelId !== null && deletedModelIds.has(request.defaultModelId)
        ? null
        : request.defaultModelId
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
