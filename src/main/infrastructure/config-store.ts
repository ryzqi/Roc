import type { Database as DatabaseConnection } from 'better-sqlite3';

import { assertPluginId } from './database-pool';

type PluginConfigFacade = {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
};

export class ConfigStore {
  constructor(private readonly coreDb: DatabaseConnection) {}

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
    const value = this.coreDb
      .prepare('SELECT value_json FROM plugin_config WHERE plugin_id = ? AND key = ?')
      .pluck()
      .get(pluginId, key);
    if (typeof value !== 'string') {
      return null;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error('config_value_corrupt');
    }
  }

  private set<T>(pluginId: string, key: string, value: T): void {
    assertPluginId(pluginId);
    this.coreDb
      .prepare(
        `INSERT OR REPLACE INTO plugin_config (plugin_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(pluginId, key, JSON.stringify(value), new Date().toISOString());
  }
}
