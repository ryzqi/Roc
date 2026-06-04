import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-memory-rebuild-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('Memory rebuild Phase 1 DDL', () => {
  it('drops all legacy memory tables on startup', () => {
    const db = services.databaseService.db;
    const dropped = [
      'memory_entries_index',
      'memory_candidates',
      'memory_conflicts',
      'memory_operations',
      'session_recall_index',
      'langgraph_store_items',
      'memory_entries_fts',
      'session_recall_fts'
    ];
    for (const table of dropped) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?")
        .get(table) as { name: string } | undefined;
      expect(row, `${table} should be dropped`).toBeUndefined();
    }
  });
});
