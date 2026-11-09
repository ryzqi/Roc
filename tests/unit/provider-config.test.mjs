import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { ConfigService } = await importTypeScriptModule('src/main/services/config-service.ts', { platform: 'node' });
const { normalizeProvidersConfig } = await importTypeScriptModule('src/main/services/config/provider-rules.ts');

function withConfig(run) {
  const root = mkdtempSync(join(tmpdir(), 'roc-provider-config-'));
  const paths = { configDir: join(root, 'config'), rtkDir: join(root, 'rtk') };
  mkdirSync(paths.configDir);
  mkdirSync(paths.rtkDir);
  const config = new ConfigService(paths);
  config.initialize();
  return Promise.resolve().then(() => run(config, paths)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function provider(type, id = type) {
  return {
    id, type, name: `User ${id}`, endpoint: `https://${id}.example/v1`,
    credentialRef: `secret:${id}`, enabled: true,
    models: [{ id: 'model', displayName: 'User model', enabled: true,
      supportsStreaming: true, supportsToolCalls: true, supportsImages: false }]
  };
}

test('fresh settings and sync/async saves remain empty after restart', async () => {
  await withConfig(async (config, paths) => {
    const empty = { schemaVersion: 2, defaultModelId: null, providers: [] };
    assert.deepEqual(config.getProviders(), empty);
    assert.equal(config.getDefaultModelState().status, 'missing');
    config.saveProviders(empty);
    await config.saveProvidersAsync(empty);
    const restarted = new ConfigService(paths);
    restarted.initialize();
    assert.deepEqual(await restarted.getProvidersAsync(), empty);
    assert.deepEqual(JSON.parse(readFileSync(join(paths.configDir, 'settings.json'), 'utf8')).providers, empty);
  });
});

test('provider normalization preserves user fields, order and multiple instances of a protocol', () => {
  const providers = [provider('openrouter'), provider('nvidia', 'private-nvidia'), provider('nvidia'),
    provider('llama_cpp'), provider('openai_compatible', 'custom')];
  providers[0].models = [];
  const config = { schemaVersion: 2, defaultModelId: 'nvidia:model', providers };
  assert.deepEqual(normalizeProvidersConfig(config), config);
});

test('former built-ins are editable and removable without returning after restart', async () => {
  await withConfig(async (config, paths) => {
    const providers = ['nvidia', 'openrouter', 'llama_cpp'].map(type => provider(type));
    config.saveProviders({ schemaVersion: 2, defaultModelId: 'nvidia:model', providers });
    assert.deepEqual(config.getProviders().providers, providers);
    for (const entry of providers) {
      config.deleteProvider(entry.id);
      assert.equal(config.getProviders().providers.some(candidate => candidate.id === entry.id), false);
    }
    const restarted = new ConfigService(paths);
    restarted.initialize();
    assert.deepEqual(await restarted.getProvidersAsync(), { schemaVersion: 2, defaultModelId: null, providers: [] });
  });
});

test('removing one provider keeps a same-named model owned by another provider as default', async () => {
  await withConfig(async config => {
    const providers = [provider('nvidia'), provider('openrouter')];
    config.saveProviders({ schemaVersion: 2, defaultModelId: 'openrouter:model', providers });
    config.deleteProvider('nvidia');
    assert.equal(config.getProviders().defaultModelId, 'openrouter:model');
    assert.deepEqual(config.getProviders().providers, [providers[1]]);
  });
});
