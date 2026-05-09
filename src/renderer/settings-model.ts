import type {
  AppSettings,
  McpServerSnapshot,
  PermissionConfirmationPolicy,
  PermissionsConfig,
  ProviderConfig,
  ProviderModel,
  ProviderSecretStatus,
  ProviderTestResult,
  ProviderType,
  SettingsSaveRequest,
  SettingsSnapshot,
  SkillSnapshot
} from '../shared/types';
import {
  fixedNvidiaBaseUrl,
  fixedNvidiaProviderId,
  fixedNvidiaProviderName,
  normalizeFixedNvidiaProvider
} from '../shared/provider-defaults';

export type SettingsSectionId =
  | 'providers'
  | 'default-model'
  | 'app-basics'
  | 'auth-security'
  | 'memory'
  | 'browser'
  | 'capabilities';

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
};

export type EditableProviderType = Extract<ProviderType, 'openai_compatible' | 'anthropic_compatible' | 'nvidia'>;
export type CreatableProviderType = Extract<EditableProviderType, 'openai_compatible' | 'anthropic_compatible'>;

export type ProviderDraft = {
  mode: 'create' | 'edit';
  id: string;
  name: string;
  type: EditableProviderType;
  endpoint: string;
  apiKey: string;
  enabled: boolean;
  modelsText: string;
  temperature: string;
  maxTokens: string;
  thinking: boolean;
};

export type EnabledModelOption = {
  modelId: string;
  providerId: string;
  label: string;
};

export type ImpactSeverity = 'info' | 'high';

export type ImpactRow = {
  sectionId: SettingsSectionId;
  field: string;
  before: string;
  after: string;
  impact: string;
  severity: ImpactSeverity;
};

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'providers', label: '模型提供商' },
  { id: 'default-model', label: '默认模型' },
  { id: 'app-basics', label: '应用基础' },
  { id: 'auth-security', label: '授权与安全' },
  { id: 'memory', label: '记忆策略' },
  { id: 'browser', label: '网页与浏览器' },
  { id: 'capabilities', label: '能力入口' }
];

const editableProviderTypes: readonly EditableProviderType[] = ['openai_compatible', 'anthropic_compatible', 'nvidia'];
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function selectSettingsSection(current: SettingsSectionId, requested: string): SettingsSectionId {
  if (SETTINGS_SECTIONS.some((section) => section.id === requested)) {
    return requested as SettingsSectionId;
  }
  return current;
}

export function createProviderDraft(type: EditableProviderType, provider?: ProviderConfig): ProviderDraft {
  if (!editableProviderTypes.includes(type)) {
    throw new Error(`Unsupported provider draft type: ${type}`);
  }
  if (type === 'nvidia') {
    const normalized = normalizeFixedNvidiaProvider(provider);
    return {
      mode: 'edit',
      id: fixedNvidiaProviderId,
      name: fixedNvidiaProviderName,
      type: 'nvidia',
      endpoint: fixedNvidiaBaseUrl,
      apiKey: '',
      enabled: normalized.enabled,
      modelsText: normalized.models.map((model) => `${model.id} | ${model.displayName}`).join('\n'),
      temperature:
        typeof normalized.options?.temperature === 'number' ? String(normalized.options.temperature) : '',
      maxTokens:
        typeof normalized.options?.maxTokens === 'number' ? String(normalized.options.maxTokens) : '',
      thinking: normalized.options?.thinking === true
    };
  }
  if (provider === undefined) {
    return {
      mode: 'create',
      id: '',
      name: '',
      type,
      endpoint: '',
      apiKey: '',
      enabled: true,
      modelsText: '',
      temperature: '',
      maxTokens: '',
      thinking: false
    };
  }
  if (!editableProviderTypes.includes(provider.type as EditableProviderType)) {
    throw new Error(`Unsupported provider edit type: ${provider.type}`);
  }
  return {
    mode: 'edit',
    id: provider.id,
    name: provider.name,
    type: provider.type as EditableProviderType,
    endpoint: provider.endpoint,
    apiKey: '',
    enabled: provider.enabled,
    modelsText: provider.models.map((model) => `${model.id} | ${model.displayName}`).join('\n'),
    temperature: typeof provider.options?.temperature === 'number' ? String(provider.options.temperature) : '',
    maxTokens: typeof provider.options?.maxTokens === 'number' ? String(provider.options.maxTokens) : '',
    thinking: provider.options?.thinking === true
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

export function buildProviderIdFromName(name: string): string {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new Error('Provider 名称不能为空。');
  }
  const id = normalizedName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (id.length === 0 || !PROVIDER_ID_PATTERN.test(id)) {
    throw new Error('Provider 名称无法生成合法 ID，请使用字母或数字。');
  }
  return id;
}

function resolveProviderDraftId(draft: ProviderDraft): string {
  if (draft.mode === 'create') {
    return buildProviderIdFromName(draft.name);
  }
  const id = draft.id.trim();
  if (id.length === 0) {
    throw new Error('Provider ID 不能为空。');
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error('Provider ID 只允许字母、数字、下划线和短横线。');
  }
  return id;
}

export function assertProviderCreateIdAvailable(
  providers: readonly ProviderConfig[],
  providerId: string
): void {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (providers.some((provider) => provider.id.trim().toLowerCase() === normalizedProviderId)) {
    throw new Error('Provider 名称生成的 ID 已存在，请调整名称后重试。');
  }
}

export function buildProviderConfigFromDraft(draft: ProviderDraft): ProviderConfig {
  const options = buildProviderOptionsFromDraft(draft);
  if (draft.type === 'nvidia') {
    const models = parseProviderModelDraft(draft.modelsText);
    if (models.length === 0) {
      throw new Error('NVIDIA 至少需要一个模型。');
    }
    const provider = normalizeFixedNvidiaProvider({
      id: fixedNvidiaProviderId,
      name: fixedNvidiaProviderName,
      type: 'nvidia',
      endpoint: fixedNvidiaBaseUrl,
      credentialRef: `secret:${fixedNvidiaProviderId}`,
      enabled: draft.enabled,
      models,
      options
    });
    return options === undefined
      ? { ...provider, options: undefined }
      : provider;
  }

  const id = resolveProviderDraftId(draft);
  const name = draft.name.trim();
  const endpoint = draft.endpoint.trim();
  if (name.length === 0) {
    throw new Error('Provider 名称不能为空。');
  }
  if (endpoint.length === 0) {
    throw new Error('Provider endpoint 不能为空。');
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
    credentialRef: `secret:${id}`,
    enabled: draft.enabled,
    models,
    options
  };
}

function parseOptionalNumber(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} 必须是数字。`);
  }
  return parsed;
}

function buildProviderOptionsFromDraft(draft: ProviderDraft): ProviderConfig['options'] {
  const temperature = parseOptionalNumber(draft.temperature, 'Temperature');
  const maxTokens = parseOptionalNumber(draft.maxTokens, 'Max tokens');
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new Error('Max tokens 必须是正整数。');
  }
  if (temperature === undefined && maxTokens === undefined && draft.thinking === false) {
    return undefined;
  }
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(draft.thinking ? { thinking: true } : {})
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

export type ProviderTypeMeta = {
  defaultBaseUrl: string;
};

export function providerTypeMeta(type: EditableProviderType): ProviderTypeMeta {
  if (type === 'nvidia') {
    return {
      defaultBaseUrl: fixedNvidiaBaseUrl
    };
  }
  if (type === 'anthropic_compatible') {
    return {
      defaultBaseUrl: 'https://api.anthropic.com'
    };
  }
  return {
    defaultBaseUrl: 'https://api.openai.com/v1'
  };
}

export type LoadedSettingsState = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
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

const memoryFieldImpactCopy: Record<keyof AppSettings['memory'], string> = {
  candidateReviewMode: '会影响候选记忆是否需要人工确认才能进入有效记忆。',
  warmRecallEnabled: '会影响暖记忆是否在任务中按需召回。',
  sessionRetentionDays: '会影响会话回忆的保留期，过期后会被自动清理。',
  crossScopeRecall: '会影响跨项目、跨任务的记忆召回是否需要显式扩大范围。',
  coldAutoForgetDays: '会影响冷记忆的自动遗忘策略。'
};

const permissionConfirmationCopy: Record<keyof PermissionsConfig['defaultConfirmations'], string> = {
  workspaceOutsideWrite: '会影响 agent 写入工作区外文件时是否始终要求确认。',
  gitPush: '会影响 git push 是否始终要求确认。',
  memoryDelete: '会影响删除记忆条目是否始终要求确认。',
  workspaceOutsideShell: '会影响在工作区外执行命令时是否始终要求确认。'
};

const confirmationCopy: Record<PermissionConfirmationPolicy, string> = {
  always_confirm: '始终确认',
  never_confirm: '不确认'
};

const candidateModeCopy: Record<AppSettings['memory']['candidateReviewMode'], string> = {
  manual: '人工审阅',
  auto_after_approval: '已确认后自动准入'
};

const crossScopeCopy: Record<AppSettings['memory']['crossScopeRecall'], string> = {
  explicit_only: '仅显式扩大范围',
  expanded_with_label: '默认扩大并标注来源'
};

function describeMemoryValue<K extends keyof AppSettings['memory']>(
  field: K,
  value: AppSettings['memory'][K]
): string {
  if (field === 'candidateReviewMode') {
    return candidateModeCopy[value as AppSettings['memory']['candidateReviewMode']];
  }
  if (field === 'crossScopeRecall') {
    return crossScopeCopy[value as AppSettings['memory']['crossScopeRecall']];
  }
  if (field === 'coldAutoForgetDays') {
    const days = value as AppSettings['memory']['coldAutoForgetDays'];
    return days === null ? '不自动遗忘' : `${days} 天`;
  }
  if (field === 'sessionRetentionDays') {
    return `${value as number} 天`;
  }
  if (field === 'warmRecallEnabled') {
    return value === true ? '已启用' : '已关闭';
  }
  return String(value);
}

function pushIfChanged<T>(
  rows: ImpactRow[],
  sectionId: SettingsSectionId,
  field: string,
  before: T,
  after: T,
  impact: string,
  severity: ImpactSeverity,
  format: (value: T) => string = (value) => String(value)
): void {
  if (before === after) {
    return;
  }
  rows.push({
    sectionId,
    field,
    before: format(before),
    after: format(after),
    impact,
    severity
  });
}

export type ImpactSourceState = {
  settings: AppSettings;
  permissions: PermissionsConfig;
  defaultModelId: string | null;
};

export function buildImpactRows(base: ImpactSourceState, draft: ImpactSourceState): ImpactRow[] {
  const rows: ImpactRow[] = [];

  pushIfChanged(
    rows,
    'default-model',
    'defaultModelId',
    base.defaultModelId,
    draft.defaultModelId,
    '会影响新任务和后台任务的模型选择，未配置时聊天和任务入口会进入阻断状态。',
    'high',
    (value) => (value === null ? '未配置' : value)
  );

  pushIfChanged(
    rows,
    'app-basics',
    'defaultWorkspace',
    base.settings.defaultWorkspace,
    draft.settings.defaultWorkspace,
    '会影响新任务的默认执行边界，工作区外动作仍需显式确认。',
    'info',
    (value) => (value === null ? '未选择' : value)
  );

  pushIfChanged(
    rows,
    'app-basics',
    'startup.openAtLogin',
    base.settings.startup.openAtLogin,
    draft.settings.startup.openAtLogin,
    '会影响 Roc 是否随系统登录启动。',
    'info',
    (value) => (value ? '开机启动' : '不开机启动')
  );

  pushIfChanged(
    rows,
    'app-basics',
    'startup.minimizeToTray',
    base.settings.startup.minimizeToTray,
    draft.settings.startup.minimizeToTray,
    '会影响关闭主窗口后是否驻留托盘。',
    'info',
    (value) => (value ? '最小化到托盘' : '直接退出')
  );

  pushIfChanged(
    rows,
    'app-basics',
    'notifications.lowDistraction',
    base.settings.notifications.lowDistraction,
    draft.settings.notifications.lowDistraction,
    '会影响 Roc 主动通知的频率与范围。',
    'info',
    (value) => (value ? '低打扰' : '常规')
  );

  pushIfChanged(
    rows,
    'app-basics',
    'globalHotkey',
    base.settings.globalHotkey,
    draft.settings.globalHotkey,
    '会影响全局快捷入口；本版本仅保存键位字符串，未注册系统级快捷键。',
    'info',
    (value) => (value === null || value.length === 0 ? '未设置' : value)
  );

  for (const field of Object.keys(base.settings.memory) as Array<keyof AppSettings['memory']>) {
    const before = base.settings.memory[field];
    const after = draft.settings.memory[field];
    if (before === after) {
      continue;
    }
    rows.push({
      sectionId: 'memory',
      field: `memory.${field}`,
      before: describeMemoryValue(field, before),
      after: describeMemoryValue(field, after),
      impact: memoryFieldImpactCopy[field],
      severity: 'high'
    });
  }

  for (const field of Object.keys(base.permissions.defaultConfirmations) as Array<
    keyof PermissionsConfig['defaultConfirmations']
  >) {
    const before = base.permissions.defaultConfirmations[field];
    const after = draft.permissions.defaultConfirmations[field];
    if (before === after) {
      continue;
    }
    rows.push({
      sectionId: 'auth-security',
      field: `defaultConfirmations.${field}`,
      before: confirmationCopy[before],
      after: confirmationCopy[after],
      impact: permissionConfirmationCopy[field],
      severity: 'high'
    });
  }

  return rows;
}

export function dirtySectionIds(rows: readonly ImpactRow[]): SettingsSectionId[] {
  const result = new Set<SettingsSectionId>();
  for (const row of rows) {
    result.add(row.sectionId);
  }
  return Array.from(result);
}

export function findSecretStatus(
  statuses: readonly ProviderSecretStatus[],
  providerId: string
): ProviderSecretStatus | null {
  return statuses.find((entry) => entry.providerId === providerId) ?? null;
}
