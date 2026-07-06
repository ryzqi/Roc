import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyAgentDatabaseSchema } from '../../infrastructure/database-schemas';

export function applyAgentPluginSchema(db: DatabaseConnection): void {
  applyAgentDatabaseSchema(db);
}
