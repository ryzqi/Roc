import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertPluginId, type DatabasePool } from './database-pool';

type PluginConfigFacade = {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
};

export class ConfigStore {
  constructor(
    private readonly databasePool: DatabasePool,
    private readonly configDir: string
  ) {}

  migrateCurrentSettings(pluginId: string): void {
    const rawDocument = readFileSync(join(this.configDir, 'settings.json'), 'utf8');
    const document = JSON.parse(rawDocument) as unknown;
    this.set(pluginId, 'settingsDocument', document);
  }

  createPluginConfigFacade(pluginId: string): PluginConfigFacade {
    assertPluginId(pluginId);
    return {
      get: <T>(key: string): T | null => this.get<T>(pluginId, key),
      set: <T>(key: string, value: T): void => {
        this.set(pluginId, key, value);
      }
    };
  }

  private get<T>(pluginId: string, key: string): T | null {
    assertPluginId(pluginId);
    this.ensureTable();
    const value = this.databasePool
      .getCoreConnection()
      .prepare('SELECT value_json FROM plugin_config WHERE plugin_id = ? AND key = ?')
      .pluck()
      .get(pluginId, key);
    if (typeof value !== 'string') {
      return null;
    }
    return JSON.parse(value) as T;
  }

  private set<T>(pluginId: string, key: string, value: T): void {
    assertPluginId(pluginId);
    this.ensureTable();
    this.databasePool
      .getCoreConnection()
      .prepare(
        `INSERT OR REPLACE INTO plugin_config (plugin_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(pluginId, key, JSON.stringify(value), new Date().toISOString());
  }

  private ensureTable(): void {
    this.databasePool.getCoreConnection().exec(`
      CREATE TABLE IF NOT EXISTS plugin_config (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );
    `);
  }
}
