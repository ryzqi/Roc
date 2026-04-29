import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DefaultModelState, ProviderConfig, ProviderTestResult, ProvidersConfig } from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';

const SettingsSchema = z.object({
  schemaVersion: z.literal(1),
  defaultWorkspace: z.string().nullable(),
  startup: z.object({
    openAtLogin: z.boolean(),
    minimizeToTray: z.boolean()
  }),
  notifications: z.object({
    lowDistraction: z.boolean()
  }),
  appearance: z.object({
    theme: z.literal('light')
  }),
  memory: z.object({
    candidateReviewMode: z.literal('manual'),
    warmRecallEnabled: z.boolean()
  })
});

const ProviderModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsToolCalls: z.boolean()
});

const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['openai_compatible', 'anthropic_compatible', 'ollama', 'custom']),
  endpoint: z.string().min(1),
  credentialRef: z.string().nullable(),
  enabled: z.boolean(),
  models: z.array(ProviderModelSchema)
});

const ProvidersSchema: z.ZodType<ProvidersConfig> = z.object({
  schemaVersion: z.literal(1),
  defaultModelId: z.string().nullable(),
  providers: z.array(ProviderSchema)
});

export type RocSettings = z.infer<typeof SettingsSchema>;
export type RocProviders = z.infer<typeof ProvidersSchema>;

const defaultSettings: RocSettings = {
  schemaVersion: 1,
  defaultWorkspace: null,
  startup: {
    openAtLogin: false,
    minimizeToTray: true
  },
  notifications: {
    lowDistraction: true
  },
  appearance: {
    theme: 'light'
  },
  memory: {
    candidateReviewMode: 'manual',
    warmRecallEnabled: true
  }
};

const defaultProviders: RocProviders = {
  schemaVersion: 1,
  defaultModelId: null,
  providers: []
};

export class ConfigService {
  constructor(private readonly paths: RocPaths) {}

  initialize(): void {
    this.ensureJson('settings.json', defaultSettings);
    this.ensureJson('providers.json', defaultProviders);
    this.ensureJson('mcp.servers.json', { schemaVersion: 1, servers: [] });
    this.ensureJson('permissions.json', { schemaVersion: 1, grants: [] });
    this.ensureJson('shortcuts.json', { schemaVersion: 1, shortcuts: [] });
    this.ensureText('rtk.toml', "root = \"%USERPROFILE%\\\\.roc\\\\rtk\"\n");
    this.getSettings();
    this.getProviders();
  }

  getSettings(): RocSettings {
    const parsed = JSON.parse(readFileSync(this.filePath('settings.json'), 'utf8')) as unknown;
    return SettingsSchema.parse(parsed);
  }

  saveSettings(settings: RocSettings): void {
    const parsed = SettingsSchema.parse(settings);
    writeFileSync(this.filePath('settings.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }

  getProviders(): RocProviders {
    const parsed = JSON.parse(readFileSync(this.filePath('providers.json'), 'utf8')) as unknown;
    return ProvidersSchema.parse(parsed);
  }

  saveProviders(providers: RocProviders): void {
    const parsed = ProvidersSchema.parse(providers);
    writeFileSync(this.filePath('providers.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
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

  testProvider(providerId: string): ProviderTestResult {
    const id = this.requireText(providerId, 'provider_id_empty', 'Provider ID 不能为空。', '请选择要测试的 provider。');
    const provider = this.getProviders().providers.find((item) => item.id === id);
    if (provider === undefined) {
      throw new RocDomainError({
        code: 'provider_not_found',
        message: `找不到 Provider ${id}。`,
        category: 'not_found',
        retryable: false,
        userAction: '请刷新设置页后重试。'
      });
    }

    const checked = ['id', 'name', 'type', 'endpoint', 'models'];
    const enabledModels = provider.models.filter((model) => model.enabled);
    if (!provider.enabled) {
      return {
        providerId: id,
        status: 'invalid',
        defaultModelReady: false,
        checked,
        error: 'Provider 未启用。'
      };
    }
    if (enabledModels.length === 0) {
      return {
        providerId: id,
        status: 'invalid',
        defaultModelReady: false,
        checked,
        error: 'Provider 没有已启用模型。'
      };
    }

    const defaultModelState = this.getDefaultModelState();
    return {
      providerId: id,
      status: 'ready',
      defaultModelReady: defaultModelState.status === 'ready' && defaultModelState.providerId === id,
      checked,
      error: null
    };
  }

  getDefaultModelState(): DefaultModelState {
    const providersConfig = this.getProviders();
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

  private ensureJson(name: string, value: unknown): void {
    const target = this.filePath(name);
    if (!existsSync(target)) {
      writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }
  }

  private ensureText(name: string, value: string): void {
    const target = this.filePath(name);
    if (!existsSync(target)) {
      writeFileSync(target, value, 'utf8');
    }
  }

  private filePath(name: string): string {
    return join(this.paths.configDir, name);
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
