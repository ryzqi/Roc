import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createFixedNvidiaProviderConfig, isFixedProvider, normalizeFixedNvidiaProvider } from '../../shared/provider-defaults';
import type {
  AppSettings,
  DefaultModelState,
  McpServerConfig,
  McpServersConfig,
  PermissionsConfig,
  ProviderConfig,
  ProvidersConfig,
  RocSettingsDocument,
  SettingsSaveRequest
} from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';

const PROVIDER_CREDENTIAL_REF_PATTERN = /^secret:[A-Za-z0-9_-]+$/;

const SettingsSchema: z.ZodType<AppSettings> = z.object({
  schemaVersion: z.literal(2),
  defaultWorkspace: z.string().nullable(),
  startup: z.object({
    openAtLogin: z.boolean(),
    minimizeToTray: z.boolean()
  }),
  notifications: z.object({
    lowDistraction: z.boolean()
  }),
  globalHotkey: z.string().nullable(),
  memory: z.object({
    candidateReviewMode: z.enum(['manual', 'auto_after_approval']),
    warmRecallEnabled: z.boolean(),
    sessionRetentionDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
    crossScopeRecall: z.enum(['explicit_only', 'expanded_with_label']),
    coldAutoForgetDays: z.union([z.literal(90), z.literal(180), z.literal(365), z.null()])
  })
});

const ProviderModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsToolCalls: z.boolean()
});

const ProviderCredentialRefSchema = z
  .string()
  .nullable()
  .refine(
    (value) => value === null || PROVIDER_CREDENTIAL_REF_PATTERN.test(value),
    'Provider 凭据引用必须为 secret:<providerId> 或 null。'
  );

const ProviderOptionsSchema = z
  .object({
    temperature: z.number().finite().optional(),
    maxTokens: z.number().int().positive().optional(),
    thinking: z.boolean().optional()
  })
  .optional();

const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['openai_compatible', 'anthropic_compatible', 'nvidia', 'ollama', 'custom']),
  endpoint: z.string().min(1),
  credentialRef: ProviderCredentialRefSchema,
  enabled: z.boolean(),
  models: z.array(ProviderModelSchema),
  options: ProviderOptionsSchema
});

const ProvidersSchema: z.ZodType<ProvidersConfig> = z.object({
  schemaVersion: z.literal(1),
  defaultModelId: z.string().nullable(),
  providers: z.array(ProviderSchema)
});

const McpServerSchema: z.ZodType<McpServerConfig> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  preset: z.boolean(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  url: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1))
});

const McpServersConfigSchema: z.ZodType<McpServersConfig> = z.object({
  schemaVersion: z.literal(1),
  servers: z.array(McpServerSchema)
});

const PermissionConfirmationSchema = z.enum(['always_confirm', 'never_confirm']);

const PermissionsConfigSchema: z.ZodType<PermissionsConfig> = z.object({
  schemaVersion: z.literal(2),
  defaultConfirmations: z.object({
    workspaceOutsideWrite: PermissionConfirmationSchema,
    gitPush: PermissionConfirmationSchema,
    memoryDelete: PermissionConfirmationSchema,
    workspaceOutsideShell: PermissionConfirmationSchema
  }),
  grants: z.array(z.unknown())
});

const ShortcutsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  shortcuts: z.array(z.unknown())
});

const SettingsSaveRequestSchema: z.ZodType<SettingsSaveRequest> = z.object({
  settings: SettingsSchema,
  providers: z.array(ProviderSchema),
  defaultModelId: z.string().nullable(),
  permissions: PermissionsConfigSchema
});

const SettingsDocumentSchema: z.ZodType<RocSettingsDocument> = z.object({
  schemaVersion: z.literal(3),
  settings: SettingsSchema,
  providers: ProvidersSchema,
  mcp: McpServersConfigSchema,
  permissions: PermissionsConfigSchema,
  shortcuts: ShortcutsConfigSchema
});

export type RocSettings = AppSettings;
export type RocProviders = z.infer<typeof ProvidersSchema>;
export type RocMcpConfig = z.infer<typeof McpServersConfigSchema>;
export type RocPermissions = PermissionsConfig;

const defaultSettings: RocSettings = {
  schemaVersion: 2,
  defaultWorkspace: null,
  startup: {
    openAtLogin: false,
    minimizeToTray: true
  },
  notifications: {
    lowDistraction: true
  },
  globalHotkey: null,
  memory: {
    candidateReviewMode: 'manual',
    warmRecallEnabled: true,
    sessionRetentionDays: 90,
    crossScopeRecall: 'explicit_only',
    coldAutoForgetDays: 90
  }
};

const defaultProviders: RocProviders = {
  schemaVersion: 1,
  defaultModelId: null,
  providers: [createFixedNvidiaProviderConfig()]
};

const defaultMcpConfig: RocMcpConfig = {
  schemaVersion: 1,
  servers: []
};

const defaultPermissions: PermissionsConfig = {
  schemaVersion: 2,
  defaultConfirmations: {
    workspaceOutsideWrite: 'always_confirm',
    gitPush: 'always_confirm',
    memoryDelete: 'always_confirm',
    workspaceOutsideShell: 'always_confirm'
  },
  grants: []
};

const defaultShortcuts = {
  schemaVersion: 1 as const,
  shortcuts: []
};

export class ConfigService {
  constructor(private readonly paths: RocPaths) {}

  initialize(): void {
    this.ensureSettingsDocument();
    this.ensureTextAtPath(join(this.paths.rtkDir, 'config.toml'), this.defaultRtkConfig());
    this.getSettingsDocument();
  }

  getSettings(): RocSettings {
    return this.getSettingsDocument().settings;
  }

  saveSettings(settings: RocSettings): void {
    const document = this.getSettingsDocument();
    this.writeSettingsDocument({
      ...document,
      settings: SettingsSchema.parse(settings)
    });
  }

  getProviders(): RocProviders {
    return this.normalizeProvidersConfig(this.getSettingsDocument().providers);
  }

  saveProviders(providers: RocProviders): void {
    const document = this.getSettingsDocument();
    const normalizedProviders = this.normalizeProvidersConfig(ProvidersSchema.parse(providers));
    this.writeSettingsDocument({
      ...document,
      providers: normalizedProviders
    });
  }

  getMcpConfig(): RocMcpConfig {
    return this.getSettingsDocument().mcp;
  }

  saveMcpConfig(config: RocMcpConfig): void {
    const document = this.getSettingsDocument();
    this.writeSettingsDocument({
      ...document,
      mcp: McpServersConfigSchema.parse(config)
    });
  }

  getPermissions(): RocPermissions {
    return this.getSettingsDocument().permissions;
  }

  savePermissions(permissions: RocPermissions): void {
    const document = this.getSettingsDocument();
    this.writeSettingsDocument({
      ...document,
      permissions: PermissionsConfigSchema.parse(permissions)
    });
  }

  saveSettingsSnapshot(request: SettingsSaveRequest): SettingsSaveRequest {
    const parsed = SettingsSaveRequestSchema.parse(request);
    const normalizedProviders = this.normalizeProvidersConfig({
      schemaVersion: 1,
      defaultModelId: parsed.defaultModelId,
      providers: parsed.providers
    });
    const document = this.getSettingsDocument();
    this.writeSettingsDocument({
      ...document,
      settings: parsed.settings,
      providers: normalizedProviders,
      permissions: parsed.permissions
    });
    return {
      settings: parsed.settings,
      providers: normalizedProviders.providers,
      defaultModelId: normalizedProviders.defaultModelId,
      permissions: parsed.permissions
    };
  }

  upsertProvider(provider: ProviderConfig): ProviderConfig {
    const parsedProvider = ProviderSchema.parse(provider);
    const config = this.getProviders();
    const existingIndex = config.providers.findIndex((item) => item.id === parsedProvider.id);
    const nextProviders =
      existingIndex === -1
        ? [...config.providers, parsedProvider]
        : config.providers.map((item) => (item.id === parsedProvider.id ? parsedProvider : item));
    this.saveProviders({
      schemaVersion: 1,
      defaultModelId: config.defaultModelId,
      providers: nextProviders
    });
    return parsedProvider;
  }

  deleteProvider(providerId: string): void {
    const id = this.requireText(providerId, 'provider_id_empty', 'Provider ID 不能为空。', '请选择要删除的 provider。');
    const config = this.getProviders();
    const provider = config.providers.find((item) => item.id === id);
    if (provider === undefined) {
      throw new RocDomainError({
        code: 'provider_not_found',
        message: `找不到 Provider ${id}。`,
        category: 'not_found',
        retryable: false,
        userAction: '请刷新设置页后重试。'
      });
    }
    if (isFixedProvider(id)) {
      this.saveProviders({
        schemaVersion: 1,
        defaultModelId:
          config.defaultModelId !== null && provider.models.some((model) => model.id === config.defaultModelId)
            ? null
            : config.defaultModelId,
        providers: config.providers.map((item) => (item.id === id ? createFixedNvidiaProviderConfig() : item))
      });
      return;
    }
    const deletedModelIds = new Set(provider.models.map((model) => model.id));
    const nextDefaultModelId =
      config.defaultModelId !== null && deletedModelIds.has(config.defaultModelId) ? null : config.defaultModelId;
    this.saveProviders({
      schemaVersion: 1,
      defaultModelId: nextDefaultModelId,
      providers: config.providers.filter((item) => item.id !== id)
    });
  }

  setDefaultModel(modelId: string | null): DefaultModelState {
    if (modelId === null) {
      const config = this.getProviders();
      this.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: config.providers
      });
      return this.getDefaultModelState();
    }

    const id = this.requireText(modelId, 'default_model_id_empty', '默认模型 ID 不能为空。', '请选择一个默认模型。');
    const config = this.getProviders();
    const targetProvider = config.providers.find((provider) => provider.models.some((model) => model.id === id));
    if (targetProvider === undefined) {
      throw new RocDomainError({
        code: 'default_model_not_found',
        message: '默认模型不存在。',
        category: 'validation',
        retryable: false,
        userAction: '请从已配置 provider 的模型列表中选择默认模型。'
      });
    }
    const targetModel = targetProvider.models.find((model) => model.id === id);
    if (targetModel === undefined) {
      throw new RocDomainError({
        code: 'default_model_not_found',
        message: '默认模型不存在。',
        category: 'validation',
        retryable: false,
        userAction: '请从已配置 provider 的模型列表中选择默认模型。'
      });
    }
    if (!targetProvider.enabled || !targetModel.enabled) {
      throw new RocDomainError({
        code: 'default_model_unavailable',
        message: '默认模型必须来自已启用 provider 下的已启用模型。',
        category: 'validation',
        retryable: false,
        userAction: '请启用 provider 和模型后再设为默认。'
      });
    }
    this.saveProviders({
      schemaVersion: 1,
      defaultModelId: id,
      providers: config.providers
    });
    return this.getDefaultModelState();
  }

  getDefaultModelState(): DefaultModelState {
    return this.defaultModelStateFor(this.getProviders());
  }

  hasDefaultModel(): boolean {
    return this.getDefaultModelState().status === 'ready';
  }

  createDefaultModelError(state = this.getDefaultModelState()): RocDomainError {
    return new RocDomainError({
      code: state.status === 'missing' ? 'default_model_missing' : 'default_model_invalid',
      message: state.reason,
      category: 'validation',
      retryable: false,
      userAction: '请在设置页选择一个已启用 provider 下的已启用模型。'
    });
  }

  private ensureSettingsDocument(): void {
    const rawSettings = this.readJsonIfExists('settings.json');
    if (rawSettings !== undefined && this.looksLikeCurrentDocument(rawSettings)) {
      this.writeSettingsDocument(SettingsDocumentSchema.parse(rawSettings));
      return;
    }
    if (rawSettings !== undefined && this.looksLikeLegacyDocumentV2(rawSettings)) {
      this.writeSettingsDocument(this.migrateLegacyV2Document(rawSettings as Record<string, unknown>));
      return;
    }
    this.writeSettingsDocument(this.migrateLegacySplitFiles(rawSettings));
  }

  private migrateLegacySplitFiles(rawSettings: unknown | undefined): RocSettingsDocument {
    return {
      schemaVersion: 3,
      settings: rawSettings === undefined ? defaultSettings : this.upgradeLegacySettings(rawSettings),
      providers: this.upgradeLegacyProviders(this.readLegacyConfig('providers.json', defaultProviders)),
      mcp: this.readLegacyConfigStrict('mcp.servers.json', McpServersConfigSchema, defaultMcpConfig),
      permissions: this.upgradeLegacyPermissions(this.readJsonIfExists('permissions.json')),
      shortcuts: this.readLegacyConfigStrict('shortcuts.json', ShortcutsConfigSchema, defaultShortcuts)
    };
  }

  private migrateLegacyV2Document(raw: Record<string, unknown>): RocSettingsDocument {
    return {
      schemaVersion: 3,
      settings: this.upgradeLegacySettings(raw.settings),
      providers: this.upgradeLegacyProviders(raw.providers ?? defaultProviders),
      mcp: McpServersConfigSchema.parse(raw.mcp ?? defaultMcpConfig),
      permissions: this.upgradeLegacyPermissions(raw.permissions),
      shortcuts: ShortcutsConfigSchema.parse(raw.shortcuts ?? defaultShortcuts)
    };
  }

  private getSettingsDocument(): RocSettingsDocument {
    const parsed = JSON.parse(readFileSync(this.filePath('settings.json'), 'utf8')) as unknown;
    return SettingsDocumentSchema.parse(parsed);
  }

  private writeSettingsDocument(document: RocSettingsDocument): void {
    const parsed = SettingsDocumentSchema.parse(document);
    writeFileSync(this.filePath('settings.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }

  private defaultModelStateFor(providersConfig: RocProviders): DefaultModelState {
    if (providersConfig.defaultModelId === null) {
      return {
        status: 'missing',
        modelId: null,
        providerId: null,
        reason: '未配置默认模型。'
      };
    }

    for (const provider of providersConfig.providers) {
      const model = provider.models.find((candidate) => candidate.id === providersConfig.defaultModelId);
      if (model === undefined) {
        continue;
      }
      if (!provider.enabled) {
        return {
          status: 'invalid',
          modelId: model.id,
          providerId: provider.id,
          reason: '默认模型所属 provider 未启用。'
        };
      }
      if (!model.enabled) {
        return {
          status: 'invalid',
          modelId: model.id,
          providerId: provider.id,
          reason: '默认模型未启用。'
        };
      }
      return {
        status: 'ready',
        modelId: model.id,
        providerId: provider.id,
        reason: '默认模型可用。'
      };
    }

    return {
      status: 'invalid',
      modelId: providersConfig.defaultModelId,
      providerId: null,
      reason: '默认模型不存在。'
    };
  }

  private sanitizeDefaultModelIdForDisabledProviders(
    providers: readonly ProviderConfig[],
    defaultModelId: string | null
  ): string | null {
    if (defaultModelId === null) {
      return null;
    }
    if (
      providers.some(
        (provider) => !provider.enabled && provider.models.some((model) => model.id === defaultModelId)
      )
    ) {
      return null;
    }
    return defaultModelId;
  }

  private upgradeLegacySettings(raw: unknown): RocSettings {
    if (raw === null || typeof raw !== 'object') {
      return defaultSettings;
    }
    const value = raw as Record<string, unknown>;
    const startup = (value.startup ?? {}) as Record<string, unknown>;
    const notifications = (value.notifications ?? {}) as Record<string, unknown>;
    const memory = (value.memory ?? {}) as Record<string, unknown>;

    const upgraded: RocSettings = {
      schemaVersion: 2,
      defaultWorkspace: typeof value.defaultWorkspace === 'string' ? value.defaultWorkspace : null,
      startup: {
        openAtLogin: typeof startup.openAtLogin === 'boolean' ? startup.openAtLogin : false,
        minimizeToTray: typeof startup.minimizeToTray === 'boolean' ? startup.minimizeToTray : true
      },
      notifications: {
        lowDistraction: typeof notifications.lowDistraction === 'boolean' ? notifications.lowDistraction : true
      },
      globalHotkey: typeof value.globalHotkey === 'string' && value.globalHotkey.length > 0 ? value.globalHotkey : null,
      memory: {
        candidateReviewMode: memory.candidateReviewMode === 'auto_after_approval' ? 'auto_after_approval' : 'manual',
        warmRecallEnabled: typeof memory.warmRecallEnabled === 'boolean' ? memory.warmRecallEnabled : true,
        sessionRetentionDays:
          memory.sessionRetentionDays === 30 || memory.sessionRetentionDays === 180
            ? (memory.sessionRetentionDays as 30 | 180)
            : 90,
        crossScopeRecall:
          memory.crossScopeRecall === 'expanded_with_label' ? 'expanded_with_label' : 'explicit_only',
        coldAutoForgetDays: this.upgradeColdAutoForget(memory.coldAutoForgetDays)
      }
    };

    return SettingsSchema.parse(upgraded);
  }

  private upgradeColdAutoForget(value: unknown): RocSettings['memory']['coldAutoForgetDays'] {
    if (value === null) {
      return null;
    }
    if (value === 90 || value === 180 || value === 365) {
      return value;
    }
    return 90;
  }

  private upgradeLegacyProviders(raw: unknown): RocProviders {
    if (raw === null || typeof raw !== 'object') {
      return defaultProviders;
    }
    const value = raw as Record<string, unknown>;
    const providersList = Array.isArray(value.providers) ? value.providers : [];
    const upgradedProviders: ProviderConfig[] = providersList.map((entry) => {
      const provider = entry as ProviderConfig;
      const credentialRef = provider.credentialRef;
      const upgradedRef =
        typeof credentialRef === 'string' && PROVIDER_CREDENTIAL_REF_PATTERN.test(credentialRef)
          ? credentialRef
          : null;
      return {
        ...provider,
        credentialRef: upgradedRef
      };
    });

    return this.normalizeProvidersConfig(ProvidersSchema.parse({
      schemaVersion: 1,
      defaultModelId: typeof value.defaultModelId === 'string' ? value.defaultModelId : null,
      providers: upgradedProviders
    }));
  }

  private upgradeLegacyPermissions(raw: unknown): RocPermissions {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      return defaultPermissions;
    }
    const value = raw as Record<string, unknown>;
    const incoming = (value.defaultConfirmations ?? {}) as Record<string, unknown>;
    return PermissionsConfigSchema.parse({
      schemaVersion: 2,
      defaultConfirmations: {
        workspaceOutsideWrite:
          incoming.workspaceOutsideWrite === 'never_confirm' ? 'never_confirm' : 'always_confirm',
        gitPush: incoming.gitPush === 'never_confirm' ? 'never_confirm' : 'always_confirm',
        memoryDelete: incoming.memoryDelete === 'never_confirm' ? 'never_confirm' : 'always_confirm',
        workspaceOutsideShell:
          incoming.workspaceOutsideShell === 'never_confirm' ? 'never_confirm' : 'always_confirm'
      },
      grants: Array.isArray(value.grants) ? value.grants : []
    });
  }

  private readLegacyConfig(name: string, fallback: RocProviders): unknown {
    const parsed = this.readJsonIfExists(name);
    if (parsed === undefined) {
      return fallback;
    }
    return parsed;
  }

  private readLegacyConfigStrict<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
    const parsed = this.readJsonIfExists(name);
    if (parsed === undefined) {
      return fallback;
    }
    return schema.parse(parsed);
  }

  private readJsonIfExists(name: string): unknown | undefined {
    const target = this.filePath(name);
    if (!existsSync(target)) {
      return undefined;
    }
    return JSON.parse(readFileSync(target, 'utf8')) as unknown;
  }

  private ensureText(name: string, value: string): void {
    const target = this.filePath(name);
    if (!existsSync(target)) {
      writeFileSync(target, value, 'utf8');
    }
  }

  private ensureTextAtPath(target: string, value: string): void {
    if (!existsSync(target)) {
      writeFileSync(target, value, 'utf8');
    }
  }

  private defaultRtkConfig(): string {
    return [
      '[tracking]',
      `database_path = "${join(this.paths.rtkDir, 'history.db').replaceAll('\\', '\\\\')}"`,
      '',
      '[tee]',
      'enabled = true',
      'mode = "always"',
      `directory = "${join(this.paths.rtkDir, 'tee').replaceAll('\\', '\\\\')}"`,
      ''
    ].join('\n');
  }

  private looksLikeCurrentDocument(value: unknown): value is RocSettingsDocument {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value as { schemaVersion?: unknown };
    return record.schemaVersion === 3;
  }

  private looksLikeLegacyDocumentV2(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value as { schemaVersion?: unknown; settings?: unknown; providers?: unknown };
    return record.schemaVersion === 2 && 'settings' in record && 'providers' in record;
  }

  private filePath(name: string): string {
    return join(this.paths.configDir, name);
  }

  private normalizeProvidersConfig(config: RocProviders): RocProviders {
    const normalizedProviders: ProviderConfig[] = [];
    let nvidiaFound = false;

    for (const provider of config.providers) {
      if (provider.type === 'nvidia' || isFixedProvider(provider.id)) {
        if (!nvidiaFound) {
          normalizedProviders.push(normalizeFixedNvidiaProvider(provider));
          nvidiaFound = true;
        }
        continue;
      }
      normalizedProviders.push(provider);
    }

    if (!nvidiaFound) {
      normalizedProviders.unshift(createFixedNvidiaProviderConfig());
    }

    const orderedProviders = [
      ...normalizedProviders.filter((provider) => isFixedProvider(provider.id)),
      ...normalizedProviders.filter((provider) => !isFixedProvider(provider.id))
    ];
    const nextDefaultModelId = this.sanitizeDefaultModelIdForDisabledProviders(
      orderedProviders,
      config.defaultModelId
    );

    return {
      schemaVersion: 1,
      defaultModelId: nextDefaultModelId,
      providers: orderedProviders
    };
  }

  private requireText(value: string, code: string, message: string, userAction: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code,
        message,
        category: 'validation',
        retryable: false,
        userAction
      });
    }
    return trimmed;
  }
}
