import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabasePool } from '../../../src/main/infrastructure/database-pool';
import { rebuildRocDatabases } from '../../../src/main/infrastructure/database-rebuild';

let root: string;
let pool: DatabasePool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-database-rebuild-test-'));
  pool = new DatabasePool(root);
});

afterEach(() => {
  pool.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe('rebuildRocDatabases', () => {
  it('rebuilds target databases, imports allowed rows, deletes old work databases, and keeps one backup', () => {
    writeOldAgentDatabase(pool.getDatabasePath('agent'));
    writeOldMemoryDatabase(pool.getDatabasePath('memory'));
    writeOldTaskDatabase(pool.getDatabasePath('task'));
    writeOldWorkspaceDatabase(pool.getDatabasePath('plugin:@roc/plugin-workspace'));
    writeOldDiagnosticsDatabase(pool.getDatabasePath('plugin:@roc/plugin-diagnostics'));

    const result = rebuildRocDatabases({
      rootDir: root,
      now: () => '2026-07-06T00:00:00.000Z',
      backupId: 'migration-pre-20260706'
    });

    expect(result).toEqual({
      backupDir: join(root, 'backups', 'migration-pre-20260706'),
      rebuilt: true
    });

    const agentDb = new Database(pool.getDatabasePath('agent'), { readonly: true });
    const memoryDb = new Database(pool.getDatabasePath('memory'), { readonly: true });
    const taskDb = new Database(pool.getDatabasePath('task'), { readonly: true });
    const workspaceDb = new Database(pool.getDatabasePath('plugin:@roc/plugin-workspace'), { readonly: true });
    const diagnosticsDb = new Database(pool.getDatabasePath('plugin:@roc/plugin-diagnostics'), { readonly: true });
    try {
      expect(agentDb.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_threads'").pluck().get()).toBe(
        'agent_threads'
      );
      expect(agentDb.prepare('SELECT COUNT(*) FROM agent_threads').pluck().get()).toBe(1);
      expect(agentDb.prepare('SELECT COUNT(*) FROM agent_runs').pluck().get()).toBe(1);
      expect(agentDb.prepare('SELECT COUNT(*) FROM agent_run_telemetry').pluck().get()).toBe(0);
      expect(agentDb.prepare('SELECT COUNT(*) FROM agent_langsmith_trace_sessions').pluck().get()).toBe(0);
      expect(agentDb.prepare('SELECT status, snapshot_error_code FROM agent_runs WHERE id = ?').get('run-1')).toEqual({
        status: 'interrupted',
        snapshot_error_code: 'legacy_snapshot_missing'
      });
      expect(agentDb.prepare('SELECT status FROM agent_threads WHERE id = ?').pluck().get('thread-1')).toBe('interrupted');
      expect(agentDb.prepare('SELECT COUNT(*) FROM agent_events').pluck().get()).toBe(1);
      expect(agentDb.prepare('SELECT COUNT(*) FROM session_messages').pluck().get()).toBe(1);
      expect(
        agentDb
          .prepare('SELECT interrupt_id, position FROM agent_pending_interrupts ORDER BY position ASC')
          .all()
      ).toEqual([
        { interrupt_id: 'interrupt-primary', position: 0 },
        { interrupt_id: 'interrupt-secondary', position: 1 }
      ]);
      expect(agentDb.prepare('SELECT execution_path, checkpoint_id, status FROM agent_tool_effects').get()).toEqual({
        execution_path: 'main',
        checkpoint_id: 'checkpoint-1',
        status: 'succeeded'
      });
      expect(taskDb.prepare("SELECT name FROM sqlite_master WHERE name = 'task_events'").pluck().get()).toBeUndefined();
      expect(taskDb.prepare('SELECT COUNT(*) FROM background_tasks').pluck().get()).toBe(1);
      expect(memoryDb.prepare('SELECT COUNT(*) FROM langgraph_store_items').pluck().get()).toBe(1);
      expect(workspaceDb.prepare('SELECT COUNT(*) FROM recovery_points').pluck().get()).toBe(1);
      expect(diagnosticsDb.prepare('SELECT COUNT(*) FROM performance_samples').pluck().get()).toBe(1);
      expect(diagnosticsDb.prepare('SELECT COUNT(*) FROM diagnostic_packages').pluck().get()).toBe(1);
      expect(existsSync(join(root, 'backups', 'migration-pre-20260706'))).toBe(true);
      expect(existsSync(join(root, 'backups', 'migration-pre-20260706', 'data', 'plugins', '@roc', 'plugin-task.db'))).toBe(
        true
      );
    } finally {
      agentDb.close();
      memoryDb.close();
      taskDb.close();
      workspaceDb.close();
      diagnosticsDb.close();
    }
  });

  it('imports v8 agent tool effects as unknown legacy executions', () => {
    writeOldAgentDatabase(pool.getDatabasePath('agent'), 'v8');

    rebuildRocDatabases({
      rootDir: root,
      now: () => '2026-07-06T00:00:00.000Z',
      backupId: 'migration-v8-effects'
    });

    const agentDb = new Database(pool.getDatabasePath('agent'), { readonly: true });
    try {
      expect(
        agentDb.prepare(
          `SELECT execution_path, checkpoint_id, effect_class, reconcile_strategy, status
           FROM agent_tool_effects`
        ).get()
      ).toEqual({
        execution_path: 'legacy-main',
        checkpoint_id: 'legacy-checkpoint',
        effect_class: 'external_call',
        reconcile_strategy: 'manual_confirmation',
        status: 'unknown'
      });
      expect(
        agentDb.prepare('SELECT run_id, thread_id, interrupt_id, position, payload_json FROM agent_pending_interrupts').all()
      ).toEqual([
        {
          run_id: 'run-1',
          thread_id: 'thread-1',
          interrupt_id: 'interrupt-primary',
          position: 0,
          payload_json: '{"kind":"question","question":"Primary?"}'
        }
      ]);
      expect(
        (agentDb.prepare('PRAGMA table_info(agent_pending_interrupts)').all() as Array<{ name: string }>).map(
          (column) => column.name
        )
      ).toEqual(['run_id', 'thread_id', 'interrupt_id', 'position', 'payload_json', 'created_at', 'updated_at']);
    } finally {
      agentDb.close();
    }
  });
});

function writeOldAgentDatabase(path: string, effectSchema: 'v8' | 'v9' = 'v9'): void {
  withDatabase(path, (db) => {
    db.exec(`
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
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_number INTEGER NOT NULL,
        user_input TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        model_id TEXT,
        enabled_capabilities_json TEXT NOT NULL
      );
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER,
        phase TEXT NOT NULL DEFAULT 'visible',
        workspace_hash TEXT,
        created_at TEXT NOT NULL
      );
      `);
    if (effectSchema === 'v8') {
      db.exec(`
        CREATE TABLE agent_tool_effects (
          run_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, tool_call_id)
        );

        CREATE TABLE agent_pending_interrupts (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          interrupt_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          mode TEXT NOT NULL,
          task_source TEXT,
          workflow_hint TEXT,
          workspace_path_state TEXT NOT NULL,
          workspace_path TEXT,
          explicit_skill_ids_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } else {
      db.exec(`
        CREATE TABLE agent_tool_effects (
          run_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          execution_path TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          effect_class TEXT NOT NULL,
          reconcile_strategy TEXT NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, execution_path, checkpoint_id, tool_call_id)
        );

        CREATE TABLE agent_pending_interrupts (
          run_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          interrupt_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          mode TEXT NOT NULL,
          task_source TEXT,
          workflow_hint TEXT,
          workspace_path_state TEXT NOT NULL,
          workspace_path TEXT,
          explicit_skill_ids_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, interrupt_id)
        );
      `);
    }
    db.prepare(
      `INSERT INTO task_threads (id, kind, title, goal, status, created_at, updated_at)
       VALUES ('thread-1', 'chat', 'Thread', 'Goal', 'running', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO task_runs (id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json)
       VALUES ('run-1', 'thread-1', 1, 'hello', 'running', '2026-07-06T00:00:00.000Z', NULL, 'model-a', '{}')`
    ).run();
    db.prepare(
      `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
       VALUES ('event-1', 'thread-1', 'run-1', 'message', '{"text":"ok"}', '2026-07-06T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
       VALUES ('event-orphan', 'thread-1', 'missing-run', 'message', '{"text":"discard"}', '2026-07-06T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
       VALUES ('message-1', 'thread-1', 'user', 'hello', 1, 'visible', 'workspace-a', '2026-07-06T00:00:00.000Z')`
    ).run();
    if (effectSchema === 'v8') {
      db.prepare(
        `INSERT INTO agent_pending_interrupts
         (run_id, thread_id, interrupt_id, payload_json, mode, task_source, workflow_hint,
          workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at)
         VALUES ('run-1', 'thread-1', 'interrupt-primary', '{"kind":"question","question":"Primary?"}',
          'snapshot', NULL, NULL, 'null', NULL, NULL, '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
      ).run();
      db.prepare(
        `INSERT INTO agent_tool_effects
         (run_id, thread_id, tool_call_id, tool_name, input_hash, status, result_json, error_json, created_at, updated_at)
         VALUES ('run-1', 'thread-1', 'call-1', 'run_shell_command', 'hash-1', 'in_progress', NULL, NULL,
          '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
      ).run();
    } else {
      const insertInterrupt = db.prepare(
        `INSERT INTO agent_pending_interrupts
         (run_id, thread_id, interrupt_id, position, payload_json, mode, task_source, workflow_hint,
          workspace_path_state, workspace_path, explicit_skill_ids_json, created_at, updated_at)
         VALUES ('run-1', 'thread-1', ?, ?, ?, 'snapshot', NULL, NULL, 'null', NULL, NULL,
          '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
      );
      insertInterrupt.run('interrupt-primary', 0, '{"kind":"question","question":"Primary?"}');
      insertInterrupt.run('interrupt-secondary', 1, '{"kind":"question","question":"Secondary?"}');
      db.prepare(
        `INSERT INTO agent_tool_effects
         (run_id, thread_id, execution_path, checkpoint_id, tool_call_id, tool_name, input_hash,
          effect_class, reconcile_strategy, status, result_json, error_json, created_at, updated_at)
         VALUES ('run-1', 'thread-1', 'main', 'checkpoint-1', 'call-1', 'run_shell_command', 'hash-1',
          'host_execution', 'manual_confirmation', 'succeeded', '{"exitCode":0}', NULL,
          '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
      ).run();
    }
  });
}

function writeOldMemoryDatabase(path: string): void {
  withDatabase(path, (db) => {
    db.exec(`
      CREATE TABLE langgraph_store_items (
        namespace_key TEXT NOT NULL,
        namespace_json TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace_key, key)
      );
    `);
    db.prepare(
      `INSERT INTO langgraph_store_items (namespace_key, namespace_json, key, value_json, created_at, updated_at)
       VALUES ('roc/memory/global', '["roc","memory","global"]', '/MEMORY.md', '{"content":"memory"}', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
    ).run();
  });
}

function writeOldTaskDatabase(path: string): void {
  withDatabase(path, (db) => {
    db.exec(`
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        updated_at TEXT NOT NULL,
        enabled_capabilities_json TEXT
      );
      CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY,
        background_task_id TEXT NOT NULL,
        task_run_id TEXT,
        scheduled_at TEXT NOT NULL,
        triggered_at TEXT,
        status TEXT NOT NULL,
        skip_reason TEXT
      );
    `);
    db.prepare(
      `INSERT INTO task_events (id, thread_id, run_id, type, payload_json, created_at)
       VALUES ('task-event-1', 'old-thread', 'old-run', 'message', '{}', '2026-07-06T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO background_tasks (
        id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description, next_run_at,
        cron_expression, workspace_path, allowed_actions_json, forbidden_actions_json, failure_policy,
        notification_policy, risk_level, requires_confirmation, last_run_at, last_run_status, run_count,
        created_at, updated_at, enabled_capabilities_json
      )
      VALUES (
        'background-1', 'thread-1', 'run-1', 'Goal', 'running', 1, 'manual', 'Manual', NULL,
        NULL, 'F:\\Code\\Roc', '[]', '[]', 'pause_and_report',
        'failures_and_confirmations', 'low', 0, NULL, NULL, 0,
        '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z', '{}'
      )`
    ).run();
    db.prepare(
      `INSERT INTO scheduled_task_runs (id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason)
       VALUES ('scheduled-1', 'background-1', NULL, '2026-07-06T00:00:00.000Z', NULL, 'pending', NULL)`
    ).run();
  });
}

function writeOldWorkspaceDatabase(path: string): void {
  withDatabase(path, (db) => {
    db.exec(`
      CREATE TABLE recovery_points (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO recovery_points (id, relative_path, snapshot_path, content_sha256, source, created_at, restored)
       VALUES ('recovery-1', 'src/index.ts', 'snapshots/recovery-1', 'hash', 'manual', '2026-07-06T00:00:00.000Z', 0)`
    ).run();
  });
}

function writeOldDiagnosticsDatabase(path: string): void {
  withDatabase(path, (db) => {
    db.exec(`
      CREATE TABLE performance_samples (
        id TEXT PRIMARY KEY,
        sampled_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        uptime_seconds REAL NOT NULL,
        rss_mb REAL NOT NULL,
        heap_used_mb REAL NOT NULL,
        heap_total_mb REAL NOT NULL,
        memory_budget_mb REAL NOT NULL,
        exceeds_budget INTEGER NOT NULL
      );
      CREATE TABLE diagnostic_packages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        includes_json TEXT NOT NULL,
        redacted INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO performance_samples (
        id, sampled_at, mode, uptime_seconds, rss_mb, heap_used_mb, heap_total_mb, memory_budget_mb, exceeds_budget
      )
      VALUES ('sample-1', '2026-07-06T00:00:00.000Z', 'runtime', 1, 2, 3, 4, 5, 0)`
    ).run();
    db.prepare(
      `INSERT INTO diagnostic_packages (id, task_id, path, created_at, includes_json, redacted)
       VALUES ('package-1', 'task-1', 'diagnostics/package-1.zip', '2026-07-06T00:00:00.000Z', '[]', 1)`
    ).run();
  });
}

function withDatabase(path: string, write: (db: Database.Database) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    write(db);
  } finally {
    db.close();
  }
}
