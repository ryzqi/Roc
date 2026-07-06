import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { configureRocDatabaseConnection, type RocLogicalDatabaseName } from './database-pragmas';

const defaultBusyTimeoutMs = 5000;
const defaultSynchronous = 'NORMAL' as const;
const pluginIdPattern = /^@roc\/plugin-[a-z0-9-]+$/u;
const pluginDatabaseNames = new Map<string, RocLogicalDatabaseName>([
  ['@roc/plugin-agent', 'agent'],
  ['@roc/plugin-memory', 'memory'],
  ['@roc/plugin-task', 'task']
]);

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
    configureRocDatabaseConnection(connection, {
      databaseName: resolvePluginDatabaseName(pluginId),
      busyTimeoutMs: defaultBusyTimeoutMs,
      synchronous: defaultSynchronous
    });
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
    configureRocDatabaseConnection(connection, {
      databaseName: 'core',
      busyTimeoutMs: defaultBusyTimeoutMs,
      synchronous: defaultSynchronous
    });
    this.connections.set(coreId, connection);
    return connection;
  }

  getDatabasePath(name: RocLogicalDatabaseName): string {
    if (name === 'core') {
      return join(this.rootDir, 'data', 'core.db');
    }
    if (name === 'agent') {
      return this.pluginDatabasePath('@roc/plugin-agent');
    }
    if (name === 'memory') {
      return this.pluginDatabasePath('@roc/plugin-memory');
    }
    if (name === 'task') {
      return this.pluginDatabasePath('@roc/plugin-task');
    }
    if (name.startsWith('plugin:')) {
      return this.pluginDatabasePath(name.slice('plugin:'.length));
    }
    throw new Error('database_name_invalid');
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
    assertPluginId(pluginId);
    return join(this.rootDir, 'data', 'plugins', `${pluginId}.db`);
  }
}

export function assertPluginId(pluginId: string): void {
  if (!pluginIdPattern.test(pluginId)) {
    throw new Error('invalid_plugin_id');
  }
}

function resolvePluginDatabaseName(pluginId: string): RocLogicalDatabaseName {
  const knownName = pluginDatabaseNames.get(pluginId);
  if (knownName !== undefined) {
    return knownName;
  }
  return `plugin:${pluginId}`;
}
