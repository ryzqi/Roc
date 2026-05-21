import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
        'idx_scheduled_task_runs_task_status',
        'idx_task_events_recent_active_threads',
        'idx_task_events_thread_type_created',
        'idx_task_threads_kind_status',
        'idx_task_threads_active_updated'
      ])
    );
  });

  it('migrates task workbench schema to version 2', () => {
    const version = services.databaseService.db
      .prepare('SELECT schema_version FROM app_config_versions WHERE id = 1')
      .get() as { schema_version: number };
    const threadColumns = services.databaseService.db
      .prepare('PRAGMA table_info(task_threads)')
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const backgroundColumns = services.databaseService.db
      .prepare('PRAGMA table_info(background_tasks)')
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const scheduledRunsTable = services.databaseService.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_task_runs'")
      .get() as { name: string } | undefined;

    expect(version.schema_version).toBe(2);
    expect(threadColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'kind',
          dflt_value: "'chat'"
        })
      ])
    );
    expect(backgroundColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['cron_expression', 'last_run_at', 'last_run_status', 'run_count'])
    );
    expect(scheduledRunsTable).toEqual({ name: 'scheduled_task_runs' });
  });

  it('upgrades an existing schema v1 task database without losing task rows', () => {
    services.databaseService.close();
    const legacy = new Database(join(root, 'roc.sqlite'));
    legacy
      .prepare(
        `INSERT INTO task_threads (id, title, goal, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('thread-legacy', '旧任务', '旧任务目标', 'completed', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null);
    legacy.close();

    services.databaseService.initialize();

    const thread = services.databaseService.db
      .prepare('SELECT kind, title FROM task_threads WHERE id = ?')
      .get('thread-legacy') as { kind: string; title: string };
    const version = services.databaseService.db
      .prepare('SELECT schema_version FROM app_config_versions WHERE id = 1')
      .get() as { schema_version: number };

    expect(thread).toEqual({
      kind: 'chat',
      title: '旧任务'
    });
    expect(version.schema_version).toBe(2);
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
