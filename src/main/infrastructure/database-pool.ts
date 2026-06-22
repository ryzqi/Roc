import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

const pluginIdPattern = /^@roc\/plugin-[a-z0-9-]+$/u;

export class DatabasePool {
  private readonly connections = new Map<string, DatabaseConnection>();

  constructor(private readonly rootDir: string) {}

  getConnection(pluginId: string): DatabaseConnection {
    assertPluginId(pluginId);
    const existing = this.connections.get(pluginId);
    if (existing !== undefined) {
      return existing;
    }

    const databasePath = this.pluginDatabasePath(pluginId);
    mkdirSync(dirname(databasePath), { recursive: true });
    const connection = new Database(databasePath);
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    this.connections.set(pluginId, connection);
    return connection;
  }

  getCoreConnection(): DatabaseConnection {
    const coreId = '@roc/core';
    const existing = this.connections.get(coreId);
    if (existing !== undefined) {
      return existing;
    }
    const databasePath = join(this.rootDir, 'data', 'core.db');
    mkdirSync(dirname(databasePath), { recursive: true });
    const connection = new Database(databasePath);
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    this.connections.set(coreId, connection);
    return connection;
  }

  createPluginDatabaseFacade(pluginId: string): {
    getConnection(): DatabaseConnection;
    getCoreConnection(): DatabaseConnection;
  } {
    assertPluginId(pluginId);
    return {
      getConnection: () => this.getConnection(pluginId),
      getCoreConnection: () => this.getCoreConnection()
    };
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.close();
    }
    this.connections.clear();
  }

  private pluginDatabasePath(pluginId: string): string {
    return join(this.rootDir, 'data', 'plugins', `${pluginId}.db`);
  }
}

export function assertPluginId(pluginId: string): void {
  if (!pluginIdPattern.test(pluginId)) {
    throw new Error('invalid_plugin_id');
  }
}
