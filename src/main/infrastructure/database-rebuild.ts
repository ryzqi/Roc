import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { AgentRunEventLog } from '../plugins/agent/run-event-log';
import { RocSqliteCheckpointer } from '../services/deep-agent/sqlite-checkpointer';
import { AgentToolEffectStore } from '../services/deep-agent/tool-effect-store';
import { DatabasePool } from './database-pool';
import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyTaskDatabaseSchema,
  applyWorkspaceDatabaseSchema
} from './database-schemas';
import type { RocLogicalDatabaseName } from './database-pragmas';

export type RocDatabaseRebuildInput = {
  rootDir: string;
  now: () => string;
  backupId: string;
};

export type RocDatabaseRebuildResult = {
  backupDir: string;
  rebuilt: true;
};

export type RocMigrationBackupInput = {
  rootDir: string;
  now: () => string;
  backupId: string;
};

export type RocMigrationBackupManifest = {
  backupDir: string;
  createdAt: string;
  files: string[];
};

type ManagedDatabasePath = {
  name: RocLogicalDatabaseName;
  path: string;
};

type OpenedSourceDatabases = {
  core: DatabaseConnection | null;
  agent: DatabaseConnection | null;
  memory: DatabaseConnection | null;
  task: DatabaseConnection | null;
  workspace: DatabaseConnection | null;
  diagnostics: DatabaseConnection | null;
};

type OpenedTargetDatabases = {
  pool: DatabasePool;
  core: DatabaseConnection;
  agent: DatabaseConnection;
  memory: DatabaseConnection;
  task: DatabaseConnection;
  workspace: DatabaseConnection;
  diagnostics: DatabaseConnection;
};

type ImportInput = {
  sources: OpenedSourceDatabases;
  targets: OpenedTargetDatabases;
};

type RunnableStatement = {
  run(...params: unknown[]): unknown;
};

const backupIdPattern = /^[A-Za-z0-9._-]+$/u;
const managedDatabaseNames: RocLogicalDatabaseName[] = [
  'core',
  'agent',
  'memory',
  'task',
  'plugin:@roc/plugin-workspace',
  'plugin:@roc/plugin-diagnostics'
];

export function rebuildRocDatabases(input: RocDatabaseRebuildInput): RocDatabaseRebuildResult {
  const backup = createMigrationBackup(input);
  let sources: OpenedSourceDatabases | null = null;
  let targets: OpenedTargetDatabases | null = null;

  try {
    sources = openBackupSources(input.rootDir, backup.backupDir);
    removeWorkDatabaseFiles(input.rootDir);
    targets = createFreshTargetDatabases(input.rootDir, input.now);
    importAgentRows({ sources, targets }, input.now);
    importMemoryRows({ sources, targets });
    importTaskRows({ sources, targets });
    importWorkspaceRows({ sources, targets });
    importDiagnosticsRows({ sources, targets });
    return {
      backupDir: backup.backupDir,
      rebuilt: true
    };
  } catch (error) {
    closeSources(sources);
    sources = null;
    closeTargets(targets);
    targets = null;
    removeWorkDatabaseFiles(input.rootDir);
    const freshTargets = createFreshTargetDatabases(input.rootDir, input.now);
    closeTargets(freshTargets);
    throw error;
  } finally {
    closeSources(sources);
    closeTargets(targets);
  }
}

export function createMigrationBackup(input: RocMigrationBackupInput): RocMigrationBackupManifest {
  if (!backupIdPattern.test(input.backupId)) {
    throw new Error('database_rebuild_backup_id_invalid');
  }

  const backupDir = join(input.rootDir, 'backups', input.backupId);
  if (existsSync(backupDir)) {
    throw new Error('database_rebuild_backup_exists');
  }

  mkdirSync(backupDir, { recursive: true });
  const files = copyExistingDatabaseFiles({ rootDir: input.rootDir, backupDir });
  return {
    backupDir,
    createdAt: input.now(),
    files
  };
}

function copyExistingDatabaseFiles(input: { rootDir: string; backupDir: string }): string[] {
  const copied: string[] = [];
  for (const databasePath of resolveManagedDatabasePaths(input.rootDir)) {
    for (const filePath of databaseFileVariants(databasePath.path)) {
      if (!existsSync(filePath)) {
        continue;
      }
      const targetPath = resolveBackupPath(input.rootDir, input.backupDir, filePath);
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(filePath, targetPath);
      copied.push(relative(input.backupDir, targetPath));
    }
  }
  return copied;
}

function removeWorkDatabaseFiles(rootDir: string): void {
  for (const databasePath of resolveManagedDatabasePaths(rootDir)) {
    for (const filePath of databaseFileVariants(databasePath.path)) {
      assertInsideRoot(rootDir, filePath);
      rmSync(filePath, { force: true });
    }
  }
}

function createFreshTargetDatabases(rootDir: string, now: () => string): OpenedTargetDatabases {
  const pool = new DatabasePool(rootDir);
  const core = pool.getCoreConnection();
  const agent = pool.getConnection('@roc/plugin-agent');
  const memory = pool.getConnection('@roc/plugin-memory');
  const task = pool.getConnection('@roc/plugin-task');
  const workspace = pool.getConnection('@roc/plugin-workspace');
  const diagnostics = pool.getConnection('@roc/plugin-diagnostics');

  applyCoreDatabaseSchema(core, now);
  applyAgentDatabaseSchema(agent, now);
  applyMemoryDatabaseSchema(memory, now);
  applyTaskDatabaseSchema(task, now);
  applyWorkspaceDatabaseSchema(workspace, now);
  applyDiagnosticsDatabaseSchema(diagnostics, now);

  return {
    pool,
    core,
    agent,
    memory,
    task,
    workspace,
    diagnostics
  };
}

function importAgentRows(input: ImportInput, now: () => string): void {
  importAgentThreads(input.sources.agent, input.targets.agent);
  importAgentRuns(input.sources.agent, input.targets.agent, now);
  importAgentEvents(input.sources.agent, input.targets.agent);
  importSessionMessages(input.sources.agent, input.targets.agent);
  importPendingInterrupts(input.sources.agent, input.targets.agent);
  const runEventLog = new AgentRunEventLog(input.targets.agent);
  runEventLog.restoreFrom(input.sources.core);
  runEventLog.restoreFrom(input.sources.agent);
  const checkpointer = new RocSqliteCheckpointer(input.targets.agent);
  checkpointer.restoreFrom(input.sources.core);
  checkpointer.restoreFrom(input.sources.agent);
  const toolEffectStore = new AgentToolEffectStore(input.targets.agent);
  toolEffectStore.restoreFrom(input.sources.agent);
  toolEffectStore.restoreFrom(input.sources.core);
  importContextArtifacts(input.sources.agent, input.targets.agent);
}

function importMemoryRows(input: ImportInput): void {
  importLangGraphStoreItems(input.sources.core, input.targets.memory);
  importLangGraphStoreItems(input.sources.memory, input.targets.memory);
  importMemoryEvents(input.sources.memory, input.targets.memory);
  importMemoryAutoAudit(input.sources.memory, input.targets.memory);
}

function importTaskRows(input: ImportInput): void {
  importBackgroundTasks(input.sources.task, input.targets.task);
  importScheduledTaskRuns(input.sources.task, input.targets.task);
}

function importWorkspaceRows(input: ImportInput): void {
  importRecoveryPoints(input.sources.workspace, input.targets.workspace);
}

function importDiagnosticsRows(input: ImportInput): void {
  importPerformanceSamples(input.sources.diagnostics, input.targets.diagnostics);
  importDiagnosticPackages(input.sources.diagnostics, input.targets.diagnostics);
}

function closeTargets(targets: OpenedTargetDatabases | null): void {
  if (targets === null) {
    return;
  }
  targets.pool.closeAll();
}

function openBackupSources(rootDir: string, backupDir: string): OpenedSourceDatabases {
  const paths = resolveManagedDatabasePaths(rootDir);
  return {
    core: openReadonlyDatabase(resolveBackupPath(rootDir, backupDir, findDatabasePath(paths, 'core'))),
    agent: openReadonlyDatabase(resolveBackupPath(rootDir, backupDir, findDatabasePath(paths, 'agent'))),
    memory: openReadonlyDatabase(resolveBackupPath(rootDir, backupDir, findDatabasePath(paths, 'memory'))),
    task: openReadonlyDatabase(resolveBackupPath(rootDir, backupDir, findDatabasePath(paths, 'task'))),
    workspace: openReadonlyDatabase(
      resolveBackupPath(rootDir, backupDir, findDatabasePath(paths, 'plugin:@roc/plugin-workspace'))
    ),
    diagnostics: openReadonlyDatabase(
      resolveBackupPath(rootDir, backupDir, findDatabasePath(paths, 'plugin:@roc/plugin-diagnostics'))
    )
  };
}

function closeSources(sources: OpenedSourceDatabases | null): void {
  if (sources === null) {
    return;
  }
  for (const db of Object.values(sources)) {
    if (db !== null) {
      db.close();
    }
  }
}

function resolveManagedDatabasePaths(rootDir: string): ManagedDatabasePath[] {
  const pool = new DatabasePool(rootDir);
  try {
    return managedDatabaseNames.map((name) => ({
      name,
      path: pool.getDatabasePath(name)
    }));
  } finally {
    pool.closeAll();
  }
}

function findDatabasePath(paths: readonly ManagedDatabasePath[], name: RocLogicalDatabaseName): string {
  for (const entry of paths) {
    if (entry.name === name) {
      return entry.path;
    }
  }
  throw new Error('database_rebuild_path_missing');
}

function databaseFileVariants(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

function resolveBackupPath(rootDir: string, backupDir: string, sourcePath: string): string {
  assertInsideRoot(rootDir, sourcePath);
  return join(backupDir, relative(resolve(rootDir), resolve(sourcePath)));
}

function assertInsideRoot(rootDir: string, filePath: string): void {
  const relativePath = relative(resolve(rootDir), resolve(filePath));
  if (relativePath.startsWith('..')) {
    throw new Error('database_rebuild_path_outside_root');
  }
  if (isAbsolute(relativePath)) {
    throw new Error('database_rebuild_path_outside_root');
  }
}

function openReadonlyDatabase(path: string): DatabaseConnection | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

function readRows<TRow>(db: DatabaseConnection | null, sql: string): TRow[] {
  if (db === null) {
    return [];
  }
  try {
    return db.prepare(sql).all() as TRow[];
  } catch {
    return [];
  }
}

function importRows<TRow>(rows: readonly TRow[], statement: RunnableStatement, mapRow: (row: TRow) => unknown[]): void {
  for (const row of rows) {
    try {
      statement.run(...mapRow(row));
    } catch {
      continue;
    }
  }
}

function importAgentThreads(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    kind: string;
    title: string;
    goal: string;
    status: string;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, kind, title, goal, status, created_at, updated_at, archived_at
     FROM task_threads`
  );
  const statement = target.prepare(
    `INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.kind,
    row.title,
    row.goal,
    row.status,
    row.created_at,
    row.updated_at,
    row.archived_at
  ]);
}

function importAgentRuns(source: DatabaseConnection | null, target: DatabaseConnection, now: () => string): void {
  type Row = {
    id: string;
    thread_id: string;
    run_number: number;
    user_input: string;
    status: string;
    started_at: string;
    ended_at: string | null;
    model_id: string | null;
    enabled_capabilities_json: string;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
     FROM task_runs`
  );
  const statement = target.prepare(
    `INSERT INTO agent_runs (
      id, thread_id, run_number, user_input, status, started_at, ended_at, provider_id, model_id,
      enabled_capabilities_json, workspace_path, task_source, workflow_hint, snapshot_error_code
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => {
    const isNonTerminal = row.status === 'running' || row.status === 'waiting_next_turn' || row.status === 'waiting_user';
    return [
      row.id,
      row.thread_id,
      row.run_number,
      row.user_input,
      isNonTerminal ? 'interrupted' : row.status,
      row.started_at,
      isNonTerminal ? now() : row.ended_at,
      null,
      row.model_id,
      row.enabled_capabilities_json,
      null,
      null,
      null,
      isNonTerminal ? 'legacy_snapshot_missing' : null
    ];
  });
  target
    .prepare(
      `UPDATE agent_threads
       SET status = 'interrupted', updated_at = ?
       WHERE id IN (
         SELECT thread_id
         FROM agent_runs
         WHERE snapshot_error_code = 'legacy_snapshot_missing'
       )`
    )
    .run(now());
}

function importAgentEvents(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    rowid: number;
    id: string;
    thread_id: string;
    run_id: string;
    type: string;
    payload_json: string;
    created_at: string;
  };
  const rows = readRows<Row>(
    source,
    `SELECT rowid, id, thread_id, run_id, type, payload_json, created_at
     FROM task_events
     ORDER BY rowid ASC`
  );
  const statement = target.prepare(
    `INSERT INTO agent_events (id, thread_id, run_id, sequence, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.thread_id,
    row.run_id,
    row.rowid,
    row.type,
    row.payload_json,
    row.created_at
  ]);
}

function importSessionMessages(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    thread_id: string;
    role: string;
    content: string;
    token_count: number | null;
    phase: string;
    workspace_hash: string | null;
    created_at: string;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, thread_id, role, content, token_count, phase, workspace_hash, created_at
     FROM session_messages`
  );
  const statement = target.prepare(
    `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.thread_id,
    row.role,
    row.content,
    row.token_count,
    row.phase,
    row.workspace_hash,
    row.created_at
  ]);
}

function importPendingInterrupts(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    run_id: string;
    thread_id: string;
    interrupt_id: string;
    position: number;
    payload_json: string;
    created_at: string;
    updated_at: string;
  };
  const columns = readRows<{ name: string }>(source, 'PRAGMA table_info(agent_pending_interrupts)');
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['run_id', 'thread_id', 'interrupt_id', 'payload_json', 'created_at', 'updated_at'];
  if (requiredColumns.some((column) => !columnNames.has(column))) {
    return;
  }
  const positionColumn = columns.some((column) => column.name === 'position') ? 'position' : '0 AS position';
  const rows = readRows<Row>(
    source,
    `SELECT run_id, thread_id, interrupt_id, ${positionColumn}, payload_json, created_at, updated_at
     FROM agent_pending_interrupts`
  );
  const statement = target.prepare(
    `INSERT INTO agent_pending_interrupts (
      run_id, thread_id, interrupt_id, position, payload_json, created_at, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.run_id,
    row.thread_id,
    row.interrupt_id,
    row.position,
    row.payload_json,
    row.created_at,
    row.updated_at
  ]);
}

function importContextArtifacts(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    run_id: string;
    thread_id: string;
    kind: string;
    tool_call_id: string | null;
    tool_name: string | null;
    sha256: string;
    original_chars: number;
    preview: string;
    content: string;
    workspace_hash: string | null;
    created_at: string;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars,
       preview, content, workspace_hash, created_at
     FROM context_artifacts`
  );
  const statement = target.prepare(
    `INSERT INTO context_artifacts (
      id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars,
      preview, content, workspace_hash, created_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.run_id,
    row.thread_id,
    row.kind,
    row.tool_call_id,
    row.tool_name,
    row.sha256,
    row.original_chars,
    row.preview,
    row.content,
    row.workspace_hash,
    row.created_at
  ]);
}

function importLangGraphStoreItems(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    namespace_key: string;
    namespace_json: string;
    key: string;
    value_json: string;
    created_at: string;
    updated_at: string;
  };
  const rows = readRows<Row>(
    source,
    `SELECT namespace_key, namespace_json, key, value_json, created_at, updated_at
     FROM langgraph_store_items`
  );
  const statement = target.prepare(
    `INSERT OR IGNORE INTO langgraph_store_items (namespace_key, namespace_json, key, value_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.namespace_key,
    row.namespace_json,
    row.key,
    row.value_json,
    row.created_at,
    row.updated_at
  ]);
}

function importMemoryEvents(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    type: string;
    thread_id: string | null;
    run_id: string | null;
    summary: string;
    payload_json: string;
    created_at: string;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, type, thread_id, run_id, summary, payload_json, created_at
     FROM memory_events`
  );
  const statement = target.prepare(
    `INSERT INTO memory_events (id, type, thread_id, run_id, summary, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.type,
    row.thread_id,
    row.run_id,
    row.summary,
    row.payload_json,
    row.created_at
  ]);
}

function importMemoryAutoAudit(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    action: string;
    memory_type: string;
    scope: string;
    confidence: string;
    memory_key: string;
    summary: string;
    source_run_id: string;
    reason: string;
    workspace_path: string | null;
    target_path: string | null;
    created_at: string;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, action, memory_type, scope, confidence, memory_key, summary, source_run_id,
       reason, workspace_path, target_path, created_at
     FROM memory_auto_audit`
  );
  const statement = target.prepare(
    `INSERT INTO memory_auto_audit (
      id, action, memory_type, scope, confidence, memory_key, summary, source_run_id,
      reason, workspace_path, target_path, created_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.action,
    row.memory_type,
    row.scope,
    row.confidence,
    row.memory_key,
    row.summary,
    row.source_run_id,
    row.reason,
    row.workspace_path,
    row.target_path,
    row.created_at
  ]);
}

function importBackgroundTasks(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    thread_id: string;
    run_id: string;
    goal: string;
    status: string;
    scheduled: number;
    trigger_type: string;
    trigger_description: string;
    next_run_at: string | null;
    cron_expression: string | null;
    workspace_path: string;
    allowed_actions_json: string;
    forbidden_actions_json: string;
    failure_policy: string;
    notification_policy: string;
    risk_level: string;
    requires_confirmation: number;
    last_run_at: string | null;
    last_run_status: string | null;
    run_count: number;
    created_at: string;
    updated_at: string;
    enabled_capabilities_json: string | null;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description,
       next_run_at, cron_expression, workspace_path, allowed_actions_json, forbidden_actions_json,
       failure_policy, notification_policy, risk_level, requires_confirmation, last_run_at,
       last_run_status, run_count, created_at, updated_at, enabled_capabilities_json
     FROM background_tasks`
  );
  const statement = target.prepare(
    `INSERT INTO background_tasks (
      id, thread_id, run_id, goal, status, scheduled, trigger_type, trigger_description,
      next_run_at, cron_expression, workspace_path, allowed_actions_json, forbidden_actions_json,
      failure_policy, notification_policy, risk_level, requires_confirmation, last_run_at,
      last_run_status, run_count, created_at, updated_at, enabled_capabilities_json
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.thread_id,
    row.run_id,
    row.goal,
    row.status,
    row.scheduled,
    row.trigger_type,
    row.trigger_description,
    row.next_run_at,
    row.cron_expression,
    row.workspace_path,
    row.allowed_actions_json,
    row.forbidden_actions_json,
    row.failure_policy,
    row.notification_policy,
    row.risk_level,
    row.requires_confirmation,
    row.last_run_at,
    row.last_run_status,
    row.run_count,
    row.created_at,
    row.updated_at,
    row.enabled_capabilities_json
  ]);
}

function importScheduledTaskRuns(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    background_task_id: string;
    task_run_id: string | null;
    scheduled_at: string;
    triggered_at: string | null;
    status: string;
    skip_reason: string | null;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason
     FROM scheduled_task_runs`
  );
  const statement = target.prepare(
    `INSERT INTO scheduled_task_runs (id, background_task_id, task_run_id, scheduled_at, triggered_at, status, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.background_task_id,
    row.task_run_id,
    row.scheduled_at,
    row.triggered_at,
    row.status,
    row.skip_reason
  ]);
}

function importRecoveryPoints(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    relative_path: string;
    snapshot_path: string;
    content_sha256: string;
    source: string;
    created_at: string;
    restored: number;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, relative_path, snapshot_path, content_sha256, source, created_at, restored
     FROM recovery_points`
  );
  const statement = target.prepare(
    `INSERT INTO recovery_points (id, relative_path, snapshot_path, content_sha256, source, created_at, restored)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.relative_path,
    row.snapshot_path,
    row.content_sha256,
    row.source,
    row.created_at,
    row.restored
  ]);
}

function importPerformanceSamples(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    sampled_at: string;
    mode: string;
    uptime_seconds: number;
    rss_mb: number;
    heap_used_mb: number;
    heap_total_mb: number;
    memory_budget_mb: number;
    exceeds_budget: number;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, sampled_at, mode, uptime_seconds, rss_mb, heap_used_mb, heap_total_mb, memory_budget_mb, exceeds_budget
     FROM performance_samples`
  );
  const statement = target.prepare(
    `INSERT INTO performance_samples (
      id, sampled_at, mode, uptime_seconds, rss_mb, heap_used_mb, heap_total_mb, memory_budget_mb, exceeds_budget
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.sampled_at,
    row.mode,
    row.uptime_seconds,
    row.rss_mb,
    row.heap_used_mb,
    row.heap_total_mb,
    row.memory_budget_mb,
    row.exceeds_budget
  ]);
}

function importDiagnosticPackages(source: DatabaseConnection | null, target: DatabaseConnection): void {
  type Row = {
    id: string;
    task_id: string;
    path: string;
    created_at: string;
    includes_json: string;
    redacted: number;
  };
  const rows = readRows<Row>(
    source,
    `SELECT id, task_id, path, created_at, includes_json, redacted
     FROM diagnostic_packages`
  );
  const statement = target.prepare(
    `INSERT INTO diagnostic_packages (id, task_id, path, created_at, includes_json, redacted)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  importRows(rows, statement, (row) => [
    row.id,
    row.task_id,
    row.path,
    row.created_at,
    row.includes_json,
    row.redacted
  ]);
}
