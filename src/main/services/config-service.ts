import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DefaultModelState,
  PermissionsConfig,
  ProviderConfig,
  ProvidersConfig,
  RocSettingsDocument,
  SettingsSaveRequest
} from '../../shared/types';
import { parseProviderModelKey } from '../../shared/provider-model-key';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';
import { requireText } from './validation';
import { defaultMcpConfig, defaultPermissions, defaultProviders, defaultSettings, defaultShortcuts } from './config/defaults';
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
  ProviderSchema
} from './config/schema';

export type RocSettings = typeof defaultSettings;
export type RocProviders = ProvidersConfig;
export type RocMcpConfig = typeof defaultMcpConfig;
export type RocPermissions = PermissionsConfig;
export type RocTaskSettings = RocSettings['tasks'];

const settingsDocumentCacheTtlMs = 5000;

function fileVersion(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

export class ConfigService {
  private settingsDocumentCache: RocSettingsDocument | null = null;
  private settingsDocumentCacheLoadedAtMs: number | null = null;
  private settingsDocumentFileVersion: string | null = null;
  private settingsDocumentRevision = 0;
  private settingsReadGeneration = 0;
  private settingsReadPromise: Promise<RocSettingsDocument> | null = null;
  private settingsWriteQueue: Promise<void> = Promise.resolve();
  private pendingSettingsWrites = 0;

  constructor(private readonly paths: RocPaths) {}

  initialize(): void {
    this.ensureSettingsDocument();
    this.ensureTextAtPath(join(this.paths.rtkDir, 'config.toml'), this.defaultRtkConfig());
    this.getSettingsDocument();
  }

  getSettings(): RocSettings {
    return structuredClone(this.getSettingsDocument().settings);
  }

  reloadSettingsDocument(): RocSettingsDocument {
    return structuredClone(this.getSettingsDocument(true));
  }

  async getSettingsAsync(): Promise<RocSettings> {
    return structuredClone((await this.getSettingsDocumentAsync()).settings);
  }

  getTaskSettings(): RocTaskSettings {
    return this.getSettings().tasks;
  }

  saveSettings(settings: RocSettings): void {
    const parsed = SettingsSchema.parse(settings);
    this.updateSettingsDocument(document => ({ ...document, settings: parsed }));
  }

  async saveSettingsAsync(settings: RocSettings): Promise<void> {
    const parsed = SettingsSchema.parse(settings);
    await this.updateSettingsDocumentAsync(document => ({ ...document, settings: parsed }));
  }

  getProviders(): RocProviders {
    return normalizeProvidersConfig(structuredClone(this.getSettingsDocument().providers));
  }

  async getProvidersAsync(): Promise<RocProviders> {
    return normalizeProvidersConfig(structuredClone((await this.getSettingsDocumentAsync()).providers));
  }

  saveProviders(providers: RocProviders): void {
    const normalizedProviders = normalizeProvidersConfig(ProvidersSchema.parse(providers));
    this.updateSettingsDocument(document => ({ ...document, providers: normalizedProviders }));
  }

  async saveProvidersAsync(providers: RocProviders): Promise<void> {
    const normalizedProviders = normalizeProvidersConfig(ProvidersSchema.parse(providers));
    await this.updateSettingsDocumentAsync(document => ({ ...document, providers: normalizedProviders }));
  }

  getMcpConfig(): RocMcpConfig {
    return structuredClone(this.getSettingsDocument().mcp);
  }

  saveMcpConfig(config: RocMcpConfig): void {
    const parsed = McpServersConfigSchema.parse(config);
    this.updateSettingsDocument(document => ({ ...document, mcp: parsed }));
  }

  getPermissions(): RocPermissions {
    return structuredClone(this.getSettingsDocument().permissions);
  }

  async getPermissionsAsync(): Promise<RocPermissions> {
    return structuredClone((await this.getSettingsDocumentAsync()).permissions);
  }

  savePermissions(permissions: RocPermissions): void {
    const parsed = PermissionsConfigSchema.parse(permissions);
    this.updateSettingsDocument(document => ({ ...document, permissions: parsed }));
  }

  async savePermissionsAsync(permissions: RocPermissions): Promise<void> {
    const parsed = PermissionsConfigSchema.parse(permissions);
    await this.updateSettingsDocumentAsync(document => ({ ...document, permissions: parsed }));
  }

  saveSettingsSnapshot(request: SettingsSaveRequest): SettingsSaveRequest {
    const parsed = SettingsSaveRequestSchema.parse(request);
    const normalizedProviders = normalizeProvidersConfig({
      schemaVersion: 2,
      defaultModelId: parsed.defaultModelId,
      providers: parsed.providers
    });
    this.updateSettingsDocument(document => ({
      ...document,
      settings: parsed.settings,
      providers: normalizedProviders,
      permissions: parsed.permissions
    }));
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
      schemaVersion: 2,
      defaultModelId: parsed.defaultModelId,
      providers: parsed.providers
    });
    await this.updateSettingsDocumentAsync(document => ({
      ...document,
      settings: parsed.settings,
      providers: normalizedProviders,
      permissions: parsed.permissions
    }));
    return {
      settings: parsed.settings,
      providers: normalizedProviders.providers,
      defaultModelId: normalizedProviders.defaultModelId,
      permissions: parsed.permissions
    };
  }

  upsertProvider(provider: ProviderConfig): ProviderConfig {
    const parsedProvider = ProviderSchema.parse(provider);
    this.updateSettingsDocument(document => this.withProvider(document, parsedProvider));
    return parsedProvider;
  }

  async upsertProviderAsync(provider: ProviderConfig): Promise<ProviderConfig> {
    const parsedProvider = ProviderSchema.parse(provider);
    await this.updateSettingsDocumentAsync(document => this.withProvider(document, parsedProvider));
    return parsedProvider;
  }

  deleteProvider(providerId: string): void {
    const id = requireText(providerId, 'provider_id_empty', 'Provider ID 不能为空。', '请选择要删除的 provider。');
    this.updateSettingsDocument(document => {
      const config = normalizeProvidersConfig(document.providers);
      if (!config.providers.some(item => item.id === id)) {
        throw new RocDomainError({
          code: 'provider_not_found',
          message: `找不到 Provider ${id}。`,
          category: 'not_found',
          retryable: false,
          userAction: '请刷新设置页后重试。'
        });
      }
      return { ...document, providers: deleteProviderFromConfig(config, id) };
    });
  }

  setDefaultModel(modelId: string | null): DefaultModelState {
    if (modelId === null) {
      this.updateSettingsDocument(document => ({
        ...document,
        providers: { ...document.providers, defaultModelId: null }
      }));
      return this.getDefaultModelState();
    }

    const id = requireText(modelId, 'default_model_id_empty', '默认模型 ID 不能为空。', '请选择一个默认模型。');
    const modelKey = parseProviderModelKey(id);
    if (modelKey === null) {
      throw new RocDomainError({
        code: 'default_model_not_found',
        message: '默认模型不存在。',
        category: 'validation',
        retryable: false,
        userAction: '请从已配置 provider 的模型列表中选择默认模型。'
      });
    }
    this.updateSettingsDocument(document => {
      const config = normalizeProvidersConfig(document.providers);
      const targetProvider = config.providers.find(provider => provider.id === modelKey.providerId);
      const targetModel = targetProvider?.models.find(model => model.id === modelKey.modelId);
      if (targetProvider === undefined || targetModel === undefined) {
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
      return { ...document, providers: { ...config, defaultModelId: id } };
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
    const target = this.filePath('settings.json');
    const version = existsSync(target) ? fileVersion(statSync(target, { bigint: true })) : null;
    const rawSettings = this.readJsonIfExists('settings.json');
    if (rawSettings === undefined) {
      this.writeSettingsDocument({
        schemaVersion: 4,
        settings: defaultSettings,
        providers: defaultProviders,
        mcp: defaultMcpConfig,
        permissions: defaultPermissions,
        shortcuts: defaultShortcuts
      });
      return;
    }
    if (rawSettings === null || typeof rawSettings !== 'object' || !('schemaVersion' in rawSettings) || rawSettings.schemaVersion !== 4) {
      throw new RocDomainError({
        code: 'settings_schema_current_required',
        message: '设置文件不是当前 schema。',
        category: 'validation',
        retryable: false,
        userAction: '请使用当前版本的设置文件，或删除设置文件后重新启动。'
      });
    }
    if (version !== fileVersion(statSync(target, { bigint: true }))) throw this.settingsFileChangedError();
    this.setSettingsDocumentCache(SettingsDocumentSchema.parse(rawSettings), version!);
  }

  private getSettingsDocument(checkFile = false): RocSettingsDocument {
    if (!checkFile && this.isSettingsDocumentCacheFresh()) return this.settingsDocumentCache!;
    try {
      const target = this.filePath('settings.json');
      const version = fileVersion(statSync(target, { bigint: true }));
      if (this.settingsDocumentCache !== null && version === this.settingsDocumentFileVersion) {
        this.settingsDocumentCacheLoadedAtMs = Date.now();
        this.settingsReadGeneration++;
        return this.settingsDocumentCache;
      }
      const raw = JSON.parse(readFileSync(target, 'utf8')) as unknown;
      if (version !== fileVersion(statSync(target, { bigint: true }))) throw this.settingsFileChangedError();
      return this.setSettingsDocumentCache(SettingsDocumentSchema.parse(raw), version);
    } catch (error) {
      this.invalidateSettingsDocumentCache();
      throw error;
    }
  }

  private async getSettingsDocumentAsync(): Promise<RocSettingsDocument> {
    if (this.isSettingsDocumentCacheFresh()) return this.settingsDocumentCache!;
    if (this.settingsReadPromise !== null) return await this.settingsReadPromise;
    const pending = this.readSettingsDocumentAsync();
    this.settingsReadPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.settingsReadPromise === pending) this.settingsReadPromise = null;
    }
  }

  private async readSettingsDocumentAsync(): Promise<RocSettingsDocument> {
    const target = this.filePath('settings.json');
    for (;;) {
      const generation = this.settingsReadGeneration;
      try {
        const version = fileVersion(await stat(target, { bigint: true }));
        if (generation !== this.settingsReadGeneration) continue;
        if (this.settingsDocumentCache !== null && version === this.settingsDocumentFileVersion) {
          this.settingsDocumentCacheLoadedAtMs = Date.now();
          return this.settingsDocumentCache;
        }
        const raw = JSON.parse(await readFile(target, 'utf8')) as unknown;
        const currentVersion = fileVersion(await stat(target, { bigint: true }));
        if (generation !== this.settingsReadGeneration) continue;
        if (version !== currentVersion) throw this.settingsFileChangedError();
        return this.setSettingsDocumentCache(SettingsDocumentSchema.parse(raw), version);
      } catch (error) {
        if (generation !== this.settingsReadGeneration) continue;
        this.invalidateSettingsDocumentCache();
        throw error;
      }
    }
  }

  private withProvider(document: RocSettingsDocument, provider: ProviderConfig): RocSettingsDocument {
    const config = normalizeProvidersConfig(document.providers);
    const exists = config.providers.some(item => item.id === provider.id);
    return {
      ...document,
      providers: normalizeProvidersConfig({
        ...config,
        providers: exists
          ? config.providers.map(item => item.id === provider.id ? provider : item)
          : [...config.providers, provider]
      })
    };
  }

  private updateSettingsDocument(update: (document: RocSettingsDocument) => RocSettingsDocument): void {
    if (this.pendingSettingsWrites !== 0) {
      throw new RocDomainError({
        code: 'settings_write_in_progress',
        message: '设置正在保存。',
        category: 'conflict',
        retryable: true,
        userAction: '请等待当前保存完成后重试。'
      });
    }
    const document = this.getSettingsDocument(true);
    this.writeSettingsDocument(update(document), this.settingsDocumentFileVersion);
  }

  private async updateSettingsDocumentAsync(update: (document: RocSettingsDocument) => RocSettingsDocument): Promise<void> {
    this.pendingSettingsWrites++;
    const pending = this.settingsWriteQueue.then(async () => {
      // Read and merge inside the queue, including provider upserts.
      const document = this.getSettingsDocument(true);
      await this.writeSettingsDocumentAsync(update(document), this.settingsDocumentFileVersion);
    });
    this.settingsWriteQueue = pending.then(() => undefined, () => undefined);
    try {
      await pending;
    } finally {
      this.pendingSettingsWrites--;
    }
  }

  private writeSettingsDocument(document: RocSettingsDocument, expectedVersion: string | null = null): void {
    const parsed = SettingsDocumentSchema.parse(document);
    const target = this.filePath('settings.json'), temporary = `${target}.${randomUUID()}.tmp`;
    let created = false;
    try {
      writeFileSync(temporary, '', { encoding: 'utf8', flag: 'wx' });
      created = true;
      writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flush: true });
      this.publishSettingsDocument(temporary, parsed, expectedVersion);
      created = false;
    } finally {
      if (created) unlinkSync(temporary);
    }
  }

  private async writeSettingsDocumentAsync(document: RocSettingsDocument, expectedVersion: string | null): Promise<void> {
    const parsed = SettingsDocumentSchema.parse(document);
    const target = this.filePath('settings.json'), temporary = `${target}.${randomUUID()}.tmp`;
    let created = false;
    try {
      // Reserve only our own temporary path before the asynchronous write.
      writeFileSync(temporary, '', { encoding: 'utf8', flag: 'wx' });
      created = true;
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flush: true });
      this.publishSettingsDocument(temporary, parsed, expectedVersion);
      created = false;
    } finally {
      if (created) await unlink(temporary);
    }
  }

  private publishSettingsDocument(temporary: string, document: RocSettingsDocument, expectedVersion: string | null): void {
    const target = this.filePath('settings.json');
    const currentVersion = existsSync(target) ? fileVersion(statSync(target, { bigint: true })) : null;
    if (currentVersion !== expectedVersion) {
      this.invalidateSettingsDocumentCache();
      throw this.settingsFileChangedError();
    }
    // No await between the conflict check and rename: local mutations cannot interleave.
    renameSync(temporary, target);
    this.setSettingsDocumentCache(document, fileVersion(statSync(target, { bigint: true })));
  }

  private settingsFileChangedError(): RocDomainError {
    return new RocDomainError({
      code: 'settings_file_changed',
      message: '设置文件在读取或保存期间发生了变化。',
      category: 'conflict',
      retryable: true,
      userAction: '请刷新设置后重试。'
    });
  }

  private isSettingsDocumentCacheFresh(): boolean {
    return this.settingsDocumentCache !== null && this.settingsDocumentCacheLoadedAtMs !== null &&
      Date.now() - this.settingsDocumentCacheLoadedAtMs < settingsDocumentCacheTtlMs;
  }

  private invalidateSettingsDocumentCache(): void {
    this.settingsDocumentCache = null;
    this.settingsDocumentCacheLoadedAtMs = null;
    this.settingsDocumentFileVersion = null;
    this.settingsReadGeneration++;
  }

  private setSettingsDocumentCache(document: RocSettingsDocument, version: string): RocSettingsDocument {
    // Canonicalize once on change; optional undefined properties never leak to callers.
    const cached = JSON.parse(JSON.stringify(document)) as RocSettingsDocument;
    this.settingsDocumentCache = freezeSnapshot(cached);
    this.settingsDocumentFileVersion = version;
    this.settingsDocumentCacheLoadedAtMs = Date.now();
    this.settingsDocumentRevision++;
    this.settingsReadGeneration++;
    return cached;
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
