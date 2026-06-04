import { createHash } from 'node:crypto';

import type { DatabasePool } from './database-pool';

export class SchemaRegistry {
  constructor(private readonly databasePool: DatabasePool) {}

  apply(pluginId: string, sql: string): void {
    const pluginDb = this.databasePool.getConnection(pluginId);
    const coreDb = this.databasePool.getCoreConnection();
    const version = createSchemaVersion(sql);
    const appliedAt = new Date().toISOString();

    pluginDb.exec(sql);
    coreDb.exec(`
      CREATE TABLE IF NOT EXISTS plugin_schema_versions (
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, version)
      );
    `);
    coreDb
      .prepare(
        `INSERT OR REPLACE INTO plugin_schema_versions (plugin_id, version, applied_at)
         VALUES (?, ?, ?)`
      )
      .run(pluginId, version, appliedAt);
  }
}

function createSchemaVersion(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}
