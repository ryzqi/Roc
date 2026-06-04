import type { Database as DatabaseConnection } from 'better-sqlite3';

export function applyTaskPluginSchema(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_threads (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'chat',
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      user_input TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      model_id TEXT,
      enabled_capabilities_json TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES task_threads(id)
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES task_threads(id)
    );

    CREATE TABLE IF NOT EXISTS background_tasks (
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
      enabled_capabilities_json TEXT,
      FOREIGN KEY(thread_id) REFERENCES task_threads(id)
    );

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      background_task_id TEXT NOT NULL,
      task_run_id TEXT,
      scheduled_at TEXT NOT NULL,
      triggered_at TEXT,
      status TEXT NOT NULL,
      skip_reason TEXT,
      FOREIGN KEY(background_task_id) REFERENCES background_tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_plugin_background_tasks_updated
    ON background_tasks(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_task_plugin_scheduled_task_runs_task_status
    ON scheduled_task_runs(background_task_id, status, scheduled_at DESC);
  `);
}
