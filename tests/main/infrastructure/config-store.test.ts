import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore } from '../../../src/main/infrastructure/config-store';
import { DatabasePool } from '../../../src/main/infrastructure/database-pool';

let root: string;
let pool: DatabasePool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-config-store-test-'));
  pool = new DatabasePool(root);
  mkdirSync(join(root, 'config'), { recursive: true });
});

afterEach(() => {
  pool.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('migrates the current settings JSON document into plugin-scoped core.db records', () => {
    const document = {
      schemaVersion: 4,
      settings: {
        schemaVersion: 2,
        startup: { openAtLogin: true }
      },
      providers: {
        schemaVersion: 1,
        defaultModelId: 'provider:provider-model',
        providers: []
      },
      mcp: {
        schemaVersion: 1,
        servers: []
      },
      permissions: {
        schemaVersion: 3,
        mode: 'fully_automatic',
        grants: []
      }
    };
    writeFileSync(join(root, 'config', 'settings.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const store = new ConfigStore(pool, join(root, 'config'));

    store.migrateCurrentSettings('@roc/plugin-agent');
    const agentConfig = store.createPluginConfigFacade('@roc/plugin-agent');
    const taskConfig = store.createPluginConfigFacade('@roc/plugin-task');
    agentConfig.set('runtime', { enabled: true });

    expect(agentConfig.get('settingsDocument')).toEqual(document);
    expect(agentConfig.get('runtime')).toEqual({ enabled: true });
    expect(taskConfig.get('runtime')).toBeNull();
    expect(agentConfig.get.length).toBe(1);
    expect(agentConfig.set.length).toBe(2);
    expect(
      pool
        .getCoreConnection()
        .prepare('SELECT value_json FROM plugin_config WHERE plugin_id = ? AND key = ?')
        .pluck()
        .get('@roc/plugin-agent', 'settingsDocument')
    ).toBe(JSON.stringify(document));
  });

  it('rejects invalid plugin ids instead of writing unscoped config', () => {
    const store = new ConfigStore(pool, join(root, 'config'));

    expect(() => store.createPluginConfigFacade('plugin-agent')).toThrow(/invalid_plugin_id/u);
  });
});
