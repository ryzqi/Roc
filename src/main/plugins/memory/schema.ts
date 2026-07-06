import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyMemoryDatabaseSchema } from '../../infrastructure/database-schemas';

export function applyMemoryPluginSchema(db: DatabaseConnection): void {
  applyMemoryDatabaseSchema(db);
}
