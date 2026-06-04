import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  DefaultModelState,
  PermissionsConfig,
  ProviderConfig,
  ProvidersConfig,
  RocSettingsDocument,
  SettingsSaveRequest
} from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';
import { requireText } from './validation';
import { defaultMcpConfig, defaultPermissions, defaultProviders, defaultSettings, defaultShortcuts } from './config/defaults';
import {
  isCurrentSettingsDocument,
  isLegacyUnifiedSettingsDocument,
  migrateLegacySplitConfig,
  migrateLegacyUnifiedDocument,
  normalizeCurrentSettingsDocument,
  normalizeLegacyMcpConfig
} from './config/migration';
import {
  defaultModelStateForProviders,
  deleteProviderFromConfig,
  normalizeProvidersConfig
} from './config/provider-rules';
import {
  McpServersConfigSchema,
  PermissionsConfigSchema,
  ProvidersSchema,
  SettingsDocumentSchema,
  SettingsSaveRequestSchema,
  SettingsSchema,
  ShortcutsConfigSchema,
  ProviderSchema
} from './config/schema';

export type RocSettings = typeof defaultSettings;
export type RocProviders = ProvidersConfig;
export type RocMcpConfig = typeof defaultMcpConfig;
export type RocPermissions = PermissionsConfig;
export type RocTaskSettings = RocSettings['tasks'];

const settingsDocumentCacheTtlMs = 5000;

export class ConfigService {
  private settingsDocumentCache: RocSettingsDocument | null = null;
  private settingsDocumentCacheLoadedAtMs: number | null = null;

  constructor(private readonly paths: RocPaths) {}

  initialize(): void {
    this.ensureSettingsDocument();
    this.ensureTextAtPath(join(this.paths.rtkDir, 'config.toml'), this.defaultRtkConfig());
    this.getSettingsDocument();
  }

  getSettings(): RocSettings {
    return this.getSettingsDocument().settings;
  }

  async getSettingsAsync(): Promise<RocSettings> {
    return (await this.getSettingsDocumentAsync()).settings;
  }

  getTaskSettings(): RocTaskSettings {
    return this.getSettings().tasks;
  }

  saveSettings(settings: RocSettings): void {
    const document = this.getSettingsDocument();
    this.writeSettingsDocument({
      ...document,
      settings: SettingsSchema.parse(settings)
    });
  }

  async saveSettingsAsync(settings: RocSettings): Promise<void> {
    const document = await this.getSettingsDocumentAsync();
    await this.writeSettingsDocumentAsync({
      ...document,
      settings: SettingsSchema.parse(settings)
    });
  }

  getProviders(): RocProviders {
    return normalizeProvidersConfig(this.getSettingsDocument().providers);
  }

  async getProvidersAsync(): Promise<RocProviders> {
    return normalizeProvidersConfig((await this.getSettingsDocumentAsync()).providers);
  }

  saveProviders(providers: RocProviders): void {
    const document = this.getSettingsDocument();
    const normalizedProviders = normalizeProvidersConfig(ProvidersSchema.parse(providers));
    this.writeSettingsDocument({
      ...document,
      providers: normalizedProviders
    });
  }

  async saveProvidersAsync(providers: RocProviders): Promise<void> {
    const document = await this.getSettingsDocumentAsync();
    const normalizedProviders = normalizeProvidersConfig(ProvidersSchema.parse(providers));
    await this.writeSettingsDocumentAsync({
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

  async getPermissionsAsync(): Promise<RocPermissions> {
    return (await this.getSettingsDocumentAsync()).permissions;
  }

  savePermissions(permissions: RocPermissions): void {
    const document = this.getSettingsDocument();
    this.writeSettingsDocument({
      ...document,
      permissions: PermissionsConfigSchema.parse(permissions)
    });
  }

  async savePermissionsAsync(permissions: RocPermissions): Promise<void> {
    const document = await this.getSettingsDocumentAsync();
    await this.writeSettingsDocumentAsync({
      ...document,
      permissions: PermissionsConfigSchema.parse(permissions)
    });
  }

  saveSettingsSnapshot(request: SettingsSaveRequest): SettingsSaveRequest {
    const parsed = SettingsSaveRequestSchema.parse(request);
    const normalizedProviders = normalizeProvidersConfig({
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

  async saveSettingsSnapshotAsync(request: SettingsSaveRequest): Promise<SettingsSaveRequest> {
    const parsed = SettingsSaveRequestSchema.parse(request);
    const normalizedProviders = normalizeProvidersConfig({
      schemaVersion: 1,
      defaultModelId: parsed.defaultModelId,
      providers: parsed.providers
    });
    const document = await this.getSettingsDocumentAsync();
    await this.writeSettingsDocumentAsync({
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

  async upsertProviderAsync(provider: ProviderConfig): Promise<ProviderConfig> {
    const parsedProvider = ProviderSchema.parse(provider);
    const config = await this.getProvidersAsync();
    const existingIndex = config.providers.findIndex((item) => item.id === parsedProvider.id);
    const nextProviders =
      existingIndex === -1
        ? [...config.providers, parsedProvider]
        : config.providers.map((item) => (item.id === parsedProvider.id ? parsedProvider : item));
    await this.saveProvidersAsync({
      schemaVersion: 1,
      defaultModelId: config.defaultModelId,
      providers: nextProviders
    });
    return parsedProvider;
  }

  deleteProvider(providerId: string): void {
    const id = requireText(providerId, 'provider_id_empty', 'Provider ID 不能为空。', '请选择要删除的 provider。');
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
    this.saveProviders(deleteProviderFromConfig(config, id));
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

    const id = requireText(modelId, 'default_model_id_empty', '默认模型 ID 不能为空。', '请选择一个默认模型。');
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
    return defaultModelStateForProviders(this.getProviders());
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
    if (rawSettings !== undefined && isCurrentSettingsDocument(rawSettings)) {
      this.writeSettingsDocument(normalizeCurrentSettingsDocument(rawSettings as Record<string, unknown>));
      return;
    }
    if (rawSettings !== undefined && isLegacyUnifiedSettingsDocument(rawSettings)) {
      this.writeSettingsDocument(migrateLegacyUnifiedDocument(rawSettings as Record<string, unknown>));
      return;
    }
    this.writeSettingsDocument(
      migrateLegacySplitConfig({
        rawSettings,
        legacyProviders: this.readLegacyConfig('providers.json', defaultProviders),
        legacyMcp: this.readJsonIfExists('mcp.servers.json'),
        legacyPermissions: this.readJsonIfExists('permissions.json'),
        legacyShortcuts: this.readLegacyConfigStrict('shortcuts.json', ShortcutsConfigSchema, defaultShortcuts)
      })
    );
  }

  private getSettingsDocument(): RocSettingsDocument {
    const cached = this.getFreshSettingsDocumentCache();
    if (cached !== null) {
      return cached;
    }

    const parsed = JSON.parse(readFileSync(this.filePath('settings.json'), 'utf8')) as unknown;
    const document = SettingsDocumentSchema.parse(parsed);
    const normalizedMcp = normalizeLegacyMcpConfig(document.mcp);
    if (JSON.stringify(normalizedMcp) !== JSON.stringify(document.mcp)) {
      const normalizedDocument: RocSettingsDocument = {
        ...document,
        mcp: normalizedMcp
      };
      this.writeSettingsDocument(normalizedDocument);
      return this.cloneSettingsDocument(normalizedDocument);
    }
    return this.setSettingsDocumentCache(document);
  }

  private async getSettingsDocumentAsync(): Promise<RocSettingsDocument> {
    const cached = this.getFreshSettingsDocumentCache();
    if (cached !== null) {
      return cached;
    }

    const parsed = JSON.parse(await readFile(this.filePath('settings.json'), 'utf8')) as unknown;
    const document = SettingsDocumentSchema.parse(parsed);
    const normalizedMcp = normalizeLegacyMcpConfig(document.mcp);
    if (JSON.stringify(normalizedMcp) !== JSON.stringify(document.mcp)) {
      const normalizedDocument: RocSettingsDocument = {
        ...document,
        mcp: normalizedMcp
      };
      await this.writeSettingsDocumentAsync(normalizedDocument);
      return this.cloneSettingsDocument(normalizedDocument);
    }
    return this.setSettingsDocumentCache(document);
  }

  private writeSettingsDocument(document: RocSettingsDocument): void {
    const parsed = SettingsDocumentSchema.parse(document);
    writeFileSync(this.filePath('settings.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    this.setSettingsDocumentCache(parsed);
  }

  private async writeSettingsDocumentAsync(document: RocSettingsDocument): Promise<void> {
    const parsed = SettingsDocumentSchema.parse(document);
    await writeFile(this.filePath('settings.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    this.setSettingsDocumentCache(parsed);
  }

  private getFreshSettingsDocumentCache(): RocSettingsDocument | null {
    if (this.settingsDocumentCache === null || this.settingsDocumentCacheLoadedAtMs === null) {
      return null;
    }
    if (Date.now() - this.settingsDocumentCacheLoadedAtMs >= settingsDocumentCacheTtlMs) {
      this.settingsDocumentCache = null;
      this.settingsDocumentCacheLoadedAtMs = null;
      return null;
    }
    return this.cloneSettingsDocument(this.settingsDocumentCache);
  }

  private setSettingsDocumentCache(document: RocSettingsDocument): RocSettingsDocument {
    const cached = this.cloneSettingsDocument(document);
    this.settingsDocumentCache = cached;
    this.settingsDocumentCacheLoadedAtMs = Date.now();
    return this.cloneSettingsDocument(cached);
  }

  private cloneSettingsDocument(document: RocSettingsDocument): RocSettingsDocument {
    return SettingsDocumentSchema.parse(JSON.parse(JSON.stringify(document)) as unknown);
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

  private filePath(name: string): string {
    return join(this.paths.configDir, name);
  }
}
