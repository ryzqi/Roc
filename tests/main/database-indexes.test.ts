import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-db-indexes-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('database indexes', () => {
  it('creates indexes for startup snapshots, task history, memory lookup, and store namespaces', () => {
    const indexes = services.databaseService.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_background_tasks_updated',
        'idx_langgraph_store_namespace',
        'idx_memory_entries_scope_status_updated',
        'idx_memory_entries_status_layer_updated',
        'idx_session_recall_scope_created',
        'idx_task_events_recent_active_threads',
        'idx_task_events_thread_type_created',
        'idx_task_threads_active_updated'
      ])
    );
  });

  it('uses an index for task snapshot thread lookup', () => {
    const plan = services.databaseService.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, title, goal, status, created_at, updated_at
         FROM task_threads
         WHERE archived_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 50`
      )
      .all() as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join('\n')).toContain('idx_task_threads_active_updated');
  });
});
