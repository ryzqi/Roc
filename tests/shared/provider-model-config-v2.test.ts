import { describe, expect, it } from 'vitest';
import { providerConfigSchema, providerModelSchema, providersConfigSchema } from '../../src/shared/schemas/ipc-memory-settings';
import { migrateLegacyUnifiedDocument } from '../../src/main/services/config/migration';

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
});
