import { describe, expect, it } from 'vitest';
import { providerConfigSchema, providerModelSchema, providersConfigSchema } from '../../src/shared/schemas/ipc-memory-settings';
import { migrateLegacyUnifiedDocument, normalizeCurrentSettingsDocument } from '../../src/main/services/config/migration';
import { defaultMcpConfig, defaultPermissions, defaultSettings, defaultShortcuts } from '../../src/main/services/config/defaults';

const model = (id: string, options?: Record<string, unknown>) => ({
  id,
  displayName: id,
  enabled: true,
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsImages: false,
  ...(options === undefined ? {} : { options })
});

describe('provider model configuration v2', () => {
  it('accepts model options and rejects provider-level model options', () => {
    expect(providerModelSchema.parse(model('a', { temperature: 0.2, contextBudgetTokens: 4096 })).options).toMatchObject({
      temperature: 0.2,
      contextBudgetTokens: 4096
    });
    expect(() => providerConfigSchema.parse({
      id: 'p',
      name: 'Provider',
      type: 'openai_compatible',
      endpoint: 'https://example.test/v1',
      credentialRef: null,
      enabled: true,
      models: [model('a')],
      options: { temperature: 0.2 }
    })).toThrow();
    expect(() => providerModelSchema.parse(model('bad-context', { contextBudgetTokens: 0 }))).toThrow();
    expect(() => providerModelSchema.parse(model('bad-top-p', { topP: 1.1 }))).toThrow();
    expect(() => providersConfigSchema.parse({
      schemaVersion: 2,
      defaultModelId: null,
      providers: [{
        id: 'duplicates',
        name: 'Duplicates',
        type: 'openai_compatible',
        endpoint: 'https://example.test/v1',
        credentialRef: null,
        enabled: true,
        models: [model('same'), model('same')]
      }]
    })).toThrow();
  });

  it('migrates legacy provider options to every model and is idempotent', () => {
    const migrated = migrateLegacyUnifiedDocument({
      schemaVersion: 3,
      settings: { schemaVersion: 2 },
      providers: {
        schemaVersion: 1,
        defaultModelId: 'p:a',
        providers: [{
          id: 'p',
          name: 'Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test/v1',
          credentialRef: null,
          enabled: true,
          models: [model('a'), model('b')],
          options: { temperature: 0.4, timeoutMs: 5000 }
        }]
      }
    });
    expect(migrated.providers.schemaVersion).toBe(2);
    const provider = migrated.providers.providers.find((item) => item.id === 'p');
    expect(provider?.options).toEqual({ timeoutMs: 5000 });
    expect(provider?.models.map((item) => item.options)).toEqual([
      { temperature: 0.4 },
      { temperature: 0.4 }
    ]);
    expect(providersConfigSchema.parse(migrated.providers)).toEqual(migrated.providers);
  });

  it('drops retired OpenAI and Anthropic model options from current documents', () => {
    const normalized = normalizeCurrentSettingsDocument({
      schemaVersion: 4,
      settings: defaultSettings,
      providers: {
        schemaVersion: 2,
        defaultModelId: 'p:a',
        providers: [{
          id: 'p',
          name: 'Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test/v1',
          credentialRef: null,
          enabled: true,
          models: [model('a', {
            temperature: 0.2,
            useResponsesApi: true,
            serviceTier: 'flex',
            verbosity: 'high',
            zdrEnabled: true,
            anthropicBetas: ['prompt-caching-2024-07-31'],
            invocationKwargs: { metadata: { user_id: 'x' } }
          })]
        }]
      },
      mcp: defaultMcpConfig,
      permissions: defaultPermissions,
      shortcuts: defaultShortcuts
    });
    const provider = normalized.providers.providers.find((item) => item.id === 'p');
    expect(provider?.models[0]?.options).toEqual({ temperature: 0.2 });
    expect(providersConfigSchema.parse(normalized.providers)).toEqual(normalized.providers);
  });
});
