import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyTaskDatabaseSchema } from '../../infrastructure/database-schemas';

export function applyTaskPluginSchema(db: DatabaseConnection): void {
  applyTaskDatabaseSchema(db);
}
