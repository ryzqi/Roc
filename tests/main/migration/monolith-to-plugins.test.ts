import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateMonolithToPlugins } from '../../../src/main/infrastructure/migration/monolith-to-plugins';
import { DatabaseService } from '../../../src/main/services/database-service';
import { RocPaths } from '../../../src/main/services/paths';

let root: string;
let databaseService: DatabaseService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-monolith-migration-test-'));
  const paths = new RocPaths(root);
  paths.ensureTree();
  databaseService = new DatabaseService(paths);
  databaseService.initialize();
  seedCurrentSchema(databaseService.db);
});

afterEach(() => {
  databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('migrateMonolithToPlugins', () => {
  it('copies current Roc tables into plugin databases with FTS rebuilt and checksums recorded', () => {
    const sourceDatabasePath = join(root, 'roc.sqlite');
    const targetDir = join(root, 'custom-plugin-data-next');

    const result = migrateMonolithToPlugins({ sourceDatabasePath, targetDir });

    expect(result.targetDir).toBe(targetDir);
    expect(existsSync(result.backupPath)).toBe(true);

    const agentDb = openPluginDb(targetDir, '@roc', 'plugin-agent.db');
    const taskDb = openPluginDb(targetDir, '@roc', 'plugin-task.db');
    const memoryDb = openPluginDb(targetDir, '@roc', 'plugin-memory.db');
    const mcpDb = openPluginDb(targetDir, '@roc', 'plugin-mcp.db');
    const skillsDb = openPluginDb(targetDir, '@roc', 'plugin-skills.db');
    const diagnosticsDb = openPluginDb(targetDir, '@roc', 'plugin-diagnostics.db');
    const coreDb = new Database(join(targetDir, 'data', 'core.db'));

    try {
      expect(count(agentDb, 'task_threads')).toBe(1);
      expect(count(agentDb, 'task_runs')).toBe(1);
      expect(count(agentDb, 'task_events')).toBe(1);
      expect(count(agentDb, 'session_messages')).toBe(2);
      expect(searchSessionMessages(agentDb, 'alpha')).toEqual(['msg_visible']);
      expect(searchSessionMessages(agentDb, 'updated')).toEqual(['msg_update']);
      expect(searchSessionMessages(agentDb, 'deleted')).toEqual([]);

      expect(count(taskDb, 'background_tasks')).toBe(1);
      expect(count(taskDb, 'scheduled_task_runs')).toBe(1);
      expect(() => insertTaskPluginBackgroundTask(taskDb, root)).not.toThrow();
      expect(count(memoryDb, 'memory_flush_marks')).toBe(1);
      expect(count(mcpDb, 'mcp_servers')).toBe(1);
      expect(count(skillsDb, 'skills')).toBe(1);
      expect(count(diagnosticsDb, 'performance_samples')).toBe(1);
      expect(count(diagnosticsDb, 'diagnostic_packages')).toBe(1);
      expect(count(diagnosticsDb, 'recovery_points')).toBe(1);

      const checksum = JSON.parse(
        String(coreDb.prepare('SELECT checksum_json FROM migration_runs').pluck().get())
      ) as Record<string, Record<string, { rows: number; checksum: string }>>;
      expect(checksum['@roc/plugin-agent']?.session_messages.rows).toBe(2);
      expect(checksum['@roc/plugin-task']?.background_tasks.rows).toBe(1);
      expect(checksum['@roc/plugin-diagnostics']?.recovery_points.checksum).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      agentDb.close();
      taskDb.close();
      memoryDb.close();
      mcpDb.close();
      skillsDb.close();
      diagnosticsDb.close();
      coreDb.close();
    }
  });

  it('uses plugin-data-next beside the source by default and rejects existing targets', () => {
    const sourceDatabasePath = join(root, 'roc.sqlite');
    const defaultTargetDir = join(root, 'plugin-data-next');

    const result = migrateMonolithToPlugins({ sourceDatabasePath });

    expect(result.targetDir).toBe(defaultTargetDir);
    expect(existsSync(defaultTargetDir)).toBe(true);
    expect(() => migrateMonolithToPlugins({ sourceDatabasePath, targetDir: defaultTargetDir })).toThrow(
      /migration_target_exists/u
    );
  });
});

function seedCurrentSchema(db: Database.Database): void {
  db.prepare(
    `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('thread_1', 'chat', 'Thread 1', 'Goal 1', 'active', '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z');
  db.prepare(
    `INSERT INTO task_runs (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'run_1',
    'thread_1',
    1,
    'Run input',
    'completed',
    '2026-06-04T00:01:00.000Z',
    '2026-06-04T00:02:00.000Z',
    'model_1',
    '[]'
  );
  db.prepare(
    `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('event_1', 'thread_1', 'run_1', 'message_delta', '{"delta":"ok"}', '2026-06-04T00:01:30.000Z');
  db.prepare(
    `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('msg_visible', 'thread_1', 'assistant', 'searchable alpha message', 3, 'visible', '2026-06-04T00:03:00.000Z');
  db.prepare(
    `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('msg_update', 'thread_1', 'assistant', 'old content', 2, 'visible', '2026-06-04T00:04:00.000Z');
  db.prepare('UPDATE session_messages SET content = ? WHERE id = ?').run('updated beta message', 'msg_update');
  db.prepare(
    `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('msg_delete', 'thread_1', 'assistant', 'deleted gamma message', 2, 'visible', '2026-06-04T00:05:00.000Z');
  db.prepare('DELETE FROM session_messages WHERE id = ?').run('msg_delete');
  db.prepare(
    `INSERT INTO memory_flush_marks (thread_id, flushed_at, ratio, tokens_used)
     VALUES (?, ?, ?, ?)`
  ).run('thread_1', '2026-06-04T00:06:00.000Z', 0.75, 100);
  db.prepare(
    `INSERT INTO background_tasks
     (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, cron_expression,
      workspace_path, allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
      requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at, enabled_capabilities_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'background_1',
    'thread_1',
    'run_1',
    'Background goal',
    'active',
    1,
    'daily',
    'Every morning',
    '2026-06-05T00:00:00.000Z',
    '0 0 * * *',
    root,
    '[]',
    '[]',
    'retry',
    'silent',
    'low',
    0,
    null,
    null,
    0,
    '2026-06-04T00:07:00.000Z',
    '2026-06-04T00:07:00.000Z',
    '[]'
  );
  db.prepare(
    `INSERT INTO scheduled_task_runs
     (id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('scheduled_1', 'background_1', 'run_1', '2026-06-05T00:00:00.000Z', null, 'pending', null);
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, enabled, status, tools_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('mcp_1', 'Docs MCP', 'stdio', 1, 'ready', 3, '2026-06-04T00:08:00.000Z');
  db.prepare(
    `INSERT INTO skills (id, name, description, path, enabled, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('skill_1', 'Skill', 'Skill description', join(root, 'skills', 'skill_1'), 1, 'ready', '2026-06-04T00:09:00.000Z');
  db.prepare(
    `INSERT INTO performance_samples
     (id, sampled_at, mode, uptime_seconds, rss_mb, heap_used_mb, heap_total_mb, memory_budget_mb, exceeds_budget)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('perf_1', '2026-06-04T00:10:00.000Z', 'normal', 10, 100, 50, 80, 512, 0);
  db.prepare(
    `INSERT INTO diagnostic_packages (id, task_id, path, created_at, includes_json, redacted)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('diag_1', 'thread_1', join(root, 'diag.zip'), '2026-06-04T00:11:00.000Z', '[]', 1);
  db.prepare(
    `INSERT INTO recovery_points (id, relative_path, snapshot_path, content_sha256, source, created_at, restored)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('recovery_1', 'src/main/index.ts', join(root, 'snapshot'), 'abc123', 'task', '2026-06-04T00:12:00.000Z', 0);
}

function openPluginDb(targetDir: string, scope: string, fileName: string): Database.Database {
  return new Database(join(targetDir, 'data', 'plugins', scope, fileName));
}

function count(db: Database.Database, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
}

function searchSessionMessages(db: Database.Database, query: string): string[] {
  return db
    .prepare(
      `SELECT sm.id
       FROM session_messages_fts
       JOIN session_messages sm ON sm.rowid = session_messages_fts.rowid
       WHERE session_messages_fts MATCH ?
       ORDER BY sm.id`
    )
    .pluck()
    .all(query) as string[];
}

function insertTaskPluginBackgroundTask(db: Database.Database, workspacePath: string): void {
  db.prepare(
    `INSERT INTO background_tasks
     (id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at, cron_expression,
      workspace_path, allowed_actions_json, forbidden_actions_json, failure_policy, notification_policy, risk_level,
      requires_confirmation, last_run_at, last_run_status, run_count, created_at, updated_at, enabled_capabilities_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'background_task_plugin_insert',
    'thread_owned_elsewhere',
    'run_owned_elsewhere',
    'Task plugin insert',
    'active',
    1,
    'manual',
    'Manual trigger',
    null,
    null,
    workspacePath,
    '[]',
    '[]',
    'retry',
    'silent',
    'low',
    0,
    null,
    null,
    0,
    '2026-06-04T00:13:00.000Z',
    '2026-06-04T00:13:00.000Z',
    '[]'
  );
}
