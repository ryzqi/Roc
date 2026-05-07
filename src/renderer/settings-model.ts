import type {
  AppSettings,
  McpServerSnapshot,
  ProviderConfig,
  ProviderModel,
  ProviderType,
  SettingsSaveRequest,
  SettingsSnapshot,
  SkillSnapshot
} from '../shared/types';

export type SettingsSectionId =
  | 'providers'
  | 'default-model'
  | 'app-basics'
  | 'auth-security'
  | 'memory'
  | 'browser'
  | 'capabilities'
  | 'appearance';

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
};

export type ProviderDraft = {
  mode: 'create' | 'edit';
  id: string;
  name: string;
  type: Extract<ProviderType, 'openai_compatible' | 'anthropic_compatible'>;
  endpoint: string;
  credentialRef: string;
  enabled: boolean;
  modelsText: string;
};

export type EnabledModelOption = {
  modelId: string;
  providerId: string;
  label: string;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'providers', label: '模型提供商' },
  { id: 'default-model', label: '默认模型' },
  { id: 'app-basics', label: '应用基础' },
  { id: 'auth-security', label: '授权与安全' },
  { id: 'memory', label: '记忆策略' },
  { id: 'browser', label: '网页与浏览器' },
  { id: 'capabilities', label: '能力入口' },
  { id: 'appearance', label: '外观与语言' }
];

const providerTypes = ['openai_compatible', 'anthropic_compatible'] as const;

export function selectSettingsSection(current: SettingsSectionId, requested: string): SettingsSectionId {
  if (SETTINGS_SECTIONS.some((section) => section.id === requested)) {
    return requested as SettingsSectionId;
  }
  return current;
}

export function createProviderDraft(
  type: Extract<ProviderType, 'openai_compatible' | 'anthropic_compatible'>,
  provider?: ProviderConfig
): ProviderDraft {
  if (!providerTypes.includes(type)) {
    throw new Error(`Unsupported provider draft type: ${type}`);
  }
  if (provider === undefined) {
    return {
      mode: 'create',
      id: '',
      name: '',
      type,
      endpoint: '',
      credentialRef: 'env:',
      enabled: true,
      modelsText: ''
    };
  }
  if (provider.type !== 'openai_compatible' && provider.type !== 'anthropic_compatible') {
    throw new Error(`Unsupported provider edit type: ${provider.type}`);
  }
  return {
    mode: 'edit',
    id: provider.id,
    name: provider.name,
    type: provider.type,
    endpoint: provider.endpoint,
    credentialRef: provider.credentialRef === null ? 'env:' : provider.credentialRef,
    enabled: provider.enabled,
    modelsText: provider.models.map((model) => `${model.id} | ${model.displayName}`).join('\n')
  };
}

export function parseProviderModelDraft(modelsText: string): ProviderModel[] {
  return modelsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separatorIndex = line.indexOf('|');
      const id = separatorIndex === -1 ? line.trim() : line.slice(0, separatorIndex).trim();
      const displayName = separatorIndex === -1 ? id : line.slice(separatorIndex + 1).trim();
      if (id.length === 0) {
        throw new Error('Provider model ID 不能为空。');
      }
      if (displayName.length === 0) {
        throw new Error('Provider model displayName 不能为空。');
      }
      return {
        id,
        displayName,
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      };
    });
}

export function buildProviderConfigFromDraft(draft: ProviderDraft): ProviderConfig {
  const id = draft.id.trim();
  const name = draft.name.trim();
  const endpoint = draft.endpoint.trim();
  const credentialRef = draft.credentialRef.trim();
  if (id.length === 0) {
    throw new Error('Provider ID 不能为空。');
  }
  if (name.length === 0) {
    throw new Error('Provider 名称不能为空。');
  }
  if (endpoint.length === 0) {
    throw new Error('Provider endpoint 不能为空。');
  }
  if (credentialRef.length === 0 || credentialRef === 'env:') {
    throw new Error('Provider 凭据引用必须使用 env:VAR_NAME。');
  }
  const models = parseProviderModelDraft(draft.modelsText);
  if (models.length === 0) {
    throw new Error('Provider 至少需要一个模型。');
  }
  return {
    id,
    name,
    type: draft.type,
    endpoint,
    credentialRef,
    enabled: draft.enabled,
    models
  };
}

export function buildEnabledModelOptions(providers: ProviderConfig[]): EnabledModelOption[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .map((model) => ({
          modelId: model.id,
          providerId: provider.id,
          label: `${provider.name} / ${model.displayName}`
        }))
    );
}

export function applySettingsSnapshot(snapshot: SettingsSnapshot): {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  providerTestStatus: null;
  mcpTestStatus: null;
} {
  return {
    settings: snapshot.settings,
    providers: snapshot.providers,
    defaultModelId: snapshot.defaultModelId,
    mcpServers: snapshot.mcpServers,
    skills: snapshot.skills,
    providerTestStatus: null,
    mcpTestStatus: null
  };
}

export function buildSettingsSaveRequest(data: {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
}): SettingsSaveRequest {
  return {
    settings: data.settings,
    providers: data.providers,
    defaultModelId: data.defaultModelId
  };
}

export function upsertProviderInSettingsSaveRequest(request: SettingsSaveRequest, provider: ProviderConfig): SettingsSaveRequest {
  const existingIndex = request.providers.findIndex((item) => item.id === provider.id);
  return {
    ...request,
    providers:
      existingIndex === -1
        ? [...request.providers, provider]
        : request.providers.map((item) => (item.id === provider.id ? provider : item))
  };
}

export function deleteProviderFromSettingsSaveRequest(request: SettingsSaveRequest, providerId: string): SettingsSaveRequest {
  const deletedProvider = request.providers.find((provider) => provider.id === providerId);
  if (deletedProvider === undefined) {
    return request;
  }
  const deletedModelIds = new Set(deletedProvider.models.map((model) => model.id));
  return {
    ...request,
    providers: request.providers.filter((provider) => provider.id !== providerId),
    defaultModelId: request.defaultModelId !== null && deletedModelIds.has(request.defaultModelId) ? null : request.defaultModelId
  };
}

export function setDefaultModelInSettingsSaveRequest(request: SettingsSaveRequest, modelId: string | null): SettingsSaveRequest {
  return {
    ...request,
    defaultModelId: modelId
  };
}
