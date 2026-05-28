import type { DatabaseService } from '../database-service';

export function hasTable(database: DatabaseService, table: string): boolean {
  const row = database.db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}
