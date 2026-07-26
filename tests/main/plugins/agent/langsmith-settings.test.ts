import { describe, expect, it, vi } from 'vitest';

import {
  AgentLangSmithSettingsStore,
  defaultAgentLangSmithConfig
} from '../../../../src/main/plugins/agent/langsmith-settings';

describe('AgentLangSmithSettingsStore', () => {
  it('initializes a missing config as explicitly disabled without reading secret storage', () => {
    const fixture = createStoreFixture();

    expect(fixture.store.initialize()).toEqual(defaultAgentLangSmithConfig);
    expect(fixture.readConfig()).toEqual(defaultAgentLangSmithConfig);
    expect(fixture.secrets.get).not.toHaveBeenCalled();
  });

  it.each([
    { schemaVersion: 2, enabled: false, projectName: 'roc' },
    { schemaVersion: 1, enabled: false, projectName: 'roc', unknown: true },
    { schemaVersion: 1, enabled: false, projectName: '' }
  ])('rejects corrupt or unknown persisted config %#', (persisted) => {
    const fixture = createStoreFixture(persisted);

    expect(() => fixture.store.initialize()).toThrow('agent_langsmith_config_invalid');
  });

  it('stores an API key separately and never returns its plaintext in the public snapshot', () => {
    const fixture = createStoreFixture();
    fixture.store.initialize();

    const afterSecret = fixture.store.setApiKey('  lsv2_secret  ');
    const afterEnable = fixture.store.saveConfig({
      schemaVersion: 1,
      enabled: true,
      projectName: 'roc-production'
    });

    expect(fixture.readSecret()).toBe('lsv2_secret');
    expect(afterSecret).toEqual({
      config: defaultAgentLangSmithConfig,
      apiKeyStored: true
    });
    expect(afterEnable).toEqual({
      config: {
        schemaVersion: 1,
        enabled: true,
        projectName: 'roc-production'
      },
      apiKeyStored: true
    });
    expect(JSON.stringify(afterEnable)).not.toContain('lsv2_secret');
  });

  it('rejects enabling tracing while the API key is missing', () => {
    const fixture = createStoreFixture();
    fixture.store.initialize();

    expect(() =>
      fixture.store.saveConfig({
        schemaVersion: 1,
        enabled: true,
        projectName: 'roc'
      })
    ).toThrow('agent_langsmith_api_key_missing');
    expect(fixture.readConfig()).toEqual(defaultAgentLangSmithConfig);
  });

  it('requires tracing to be disabled before clearing the API key', () => {
    const fixture = createStoreFixture();
    fixture.store.initialize();
    fixture.store.setApiKey('lsv2_secret');
    fixture.store.saveConfig({ schemaVersion: 1, enabled: true, projectName: 'roc' });

    expect(() => fixture.store.clearApiKey()).toThrow('agent_langsmith_disable_before_secret_clear');
    expect(fixture.readSecret()).toBe('lsv2_secret');

    fixture.store.saveConfig({ schemaVersion: 1, enabled: false, projectName: 'roc' });
    expect(fixture.store.clearApiKey()).toEqual({
      config: defaultAgentLangSmithConfig,
      apiKeyStored: false
    });
    expect(fixture.readSecret()).toBeNull();
  });

  it('returns no runtime settings and does not touch secret storage while disabled', () => {
    const fixture = createStoreFixture(defaultAgentLangSmithConfig, 'ambient-secret');

    expect(fixture.store.getRuntimeSettings()).toBeNull();
    expect(fixture.secrets.get).not.toHaveBeenCalled();
  });

  it('returns enabled runtime settings only with a stored API key', () => {
    const config = { schemaVersion: 1 as const, enabled: true, projectName: 'roc-traces' };
    const fixture = createStoreFixture(config, 'lsv2_secret');

    expect(fixture.store.getRuntimeSettings()).toEqual({
      config,
      apiKey: 'lsv2_secret'
    });
  });
});

function createStoreFixture(initialConfig: unknown = null, initialSecret: string | null = null) {
  let configValue = initialConfig;
  let secretValue = initialSecret;
  const config = {
    get: <T>(): T | null => configValue as T | null,
    set: <T>(_key: string, value: T): void => {
      configValue = value;
    }
  };
  const secrets = {
    get: vi.fn((): string | null => secretValue),
    set: vi.fn((_key: string, plaintext: string): void => {
      secretValue = plaintext;
    }),
    clear: vi.fn((): void => {
      secretValue = null;
    })
  };

  return {
    store: new AgentLangSmithSettingsStore(config, secrets),
    secrets,
    readConfig: () => configValue,
    readSecret: () => secretValue
  };
}
