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
    rmSync(join(root, 'roc.sqlite'), { force: true });
    rmSync(join(root, 'roc.sqlite-shm'), { force: true });
    rmSync(join(root, 'roc.sqlite-wal'), { force: true });

    const legacy = new Database(join(root, 'roc.sqlite'));
    legacy.exec(`
      CREATE TABLE task_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE app_config_versions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO task_threads (id, title, goal, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('thread-legacy', '旧任务', '旧任务目标', 'completed', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', null);
    legacy
      .prepare(
        `INSERT INTO app_config_versions (id, schema_version, updated_at)
         VALUES (1, 1, ?)`
      )
      .run('2026-05-01T00:00:00.000Z');
    legacy.close();

    expect(() => services.databaseService.initialize()).not.toThrow();

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

  it('migrates historical long_running threads to chat and preserves legacy background task rows', () => {
    services.databaseService.close();
    rmSync(join(root, 'roc.sqlite'), { force: true });
    rmSync(join(root, 'roc.sqlite-shm'), { force: true });
    rmSync(join(root, 'roc.sqlite-wal'), { force: true });

    const legacy = new Database(join(root, 'roc.sqlite'));
    legacy.exec(`
      CREATE TABLE task_threads (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'chat',
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE background_tasks (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled INTEGER NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_description TEXT NOT NULL,
        next_run_at TEXT,
        cron_expression TEXT,
        workspace_path TEXT NOT NULL,
        allowed_actions_json TEXT NOT NULL,
        forbidden_actions_json TEXT NOT NULL,
        failure_policy TEXT NOT NULL,
        notification_policy TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        requires_confirmation INTEGER NOT NULL,
        last_run_at TEXT,
        last_run_status TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE app_config_versions (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'thread-long-running',
        'long_running',
        '历史长跑对话',
        '历史长跑目标',
        'running',
        '2026-05-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z',
        null
      );
    legacy
      .prepare(
        `INSERT INTO background_tasks
         (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, cron_expression, workspace_path,
          allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
          requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'background-legacy',
        'thread-long-running',
        'run-legacy',
        '历史后台任务',
        'running',
        1,
        'cron',
        '每天 09:00',
        '2026-05-21T01:00:00.000Z',
        '0 9 * * *',
        root,
        '[]',
        '[]',
        'pause_and_report',
        'failures_and_confirmations',
        'low',
        0,
        null,
        null,
        0,
        '2026-05-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z'
      );
    legacy
      .prepare(
        `INSERT INTO app_config_versions (id, schema_version, updated_at)
         VALUES (1, 2, ?)`
      )
      .run('2026-05-01T00:00:00.000Z');
    legacy.close();

    expect(() => services.databaseService.initialize()).not.toThrow();

    const thread = services.databaseService.db
      .prepare('SELECT kind FROM task_threads WHERE id = ?')
      .get('thread-long-running') as { kind: string };
    const backgroundTask = services.databaseService.db
      .prepare('SELECT enabled_capabilities_json FROM background_tasks WHERE id = ?')
      .get('background-legacy') as { enabled_capabilities_json: string | null };
    const backgroundColumns = services.databaseService.db
      .prepare('PRAGMA table_info(background_tasks)')
      .all() as Array<{ name: string }>;

    expect(thread.kind).toBe('chat');
    expect(backgroundTask.enabled_capabilities_json).toBeNull();
    expect(backgroundColumns.map((column) => column.name)).toContain('enabled_capabilities_json');
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
