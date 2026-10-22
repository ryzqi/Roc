import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { assertPluginId } from './database-pool';

type PluginConfigFacade = {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
};

export class ConfigStore {
  constructor(
    private readonly coreDb: DatabaseConnection,
    private readonly configDir: string
  ) {}

  migrateCurrentSettings(pluginId: string): void {
    const rawDocument = readFileSync(join(this.configDir, 'settings.json'), 'utf8');
    // A corrupt settings document must name itself: a bare SyntaxError here reads like a crash.
    let document: unknown;
    try {
      document = JSON.parse(rawDocument);
    } catch {
      throw new Error('config_document_corrupt');
    }
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
