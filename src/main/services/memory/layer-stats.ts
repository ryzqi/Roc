import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryLayer } from '../../../shared/types';
import type { DatabaseService } from '../database-service';

export function layerStats(
  database: DatabaseService,
  layer: MemoryLayer,
  directory: string
): { entries: number; characters: number; path: string } {
  const rows = database.db
    .prepare('SELECT markdown_path FROM memory_entries_index WHERE layer = ? AND status != ?')
    .all(layer, 'archived') as Array<{ markdown_path: string }>;

  let characters = 0;
  for (const row of rows) {
    if (existsSync(row.markdown_path)) {
      characters += readFileSync(row.markdown_path, 'utf8').length;
    }
  }

  if (rows.length === 0 && existsSync(directory)) {
    if (layer === 'hot') {
      const hotPath = join(directory, 'hot_memory.md');
      characters = existsSync(hotPath) ? readFileSync(hotPath, 'utf8').length : 0;
    }
  }

  return { entries: rows.length, characters, path: directory };
}
