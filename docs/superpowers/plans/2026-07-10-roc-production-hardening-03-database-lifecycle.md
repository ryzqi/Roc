# Roc Database Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把数据库 fast probe、完整健康检查、retention、backup 和 staging restore 接入真实启动、运行、停机和离线 CLI 生命周期。

**Architecture:** `KernelRuntime` 持有唯一 `DatabasePool`、app maintenance lease 和 `DatabaseMaintenanceService`。启动只运行 migration/required-table/read/write-lock fast probe；主窗口 ready 后启动延迟 full check 与 retention timer；shutdown 先停止 timer、等待活动 job，再关闭 plugin、logger、pool 和 lease。离线 CLI 使用同一 PID lease，backup 用 SQLite backup API，restore 在 sibling staging generation 验证后目录切换并支持 rollback。

**Tech Stack:** Electron main、electron-vite multi-entry、better-sqlite3 backup API、Node `fs` 原子文件操作、SQLite migrations/PRAGMA、Vitest fake timers、PowerShell package scripts。

## Global Constraints

- 启动首窗前不得执行 `PRAGMA quick_check` 或写入 health rows。
- fast probe 必须应用 migration、验证 schema version/required tables、执行最小 read，并用 `BEGIN IMMEDIATE`/`ROLLBACK` 验证写锁。
- full check 首次延迟 2 分钟，之后每 24 小时；retention 首次延迟 5 分钟，之后每 24 小时。
- retention 固定为 terminal payload 90 天、每 thread 最近 100 checkpoints、automatic memory audit 180 天。
- retention 不删除 thread、run、session message、background task、active/recovering/waiting-user/pending-interrupt 连续性状态。
- main 与 CLI 使用同一个 PID lease；owner 存活或无法证明已退出时显式失败；只删除可证明 owner 已退出的 stale lease并只重试一次。
- backup 不再 checkpoint 后复制活动文件；每个库使用 `Database.backup(destination)`。
- restore 在 staging 全部验证前不触碰 current `data`；切换或最终 fast probe 失败必须恢复 rollback generation。
- CLI 不通过 renderer IPC 暴露，不接受 `/workspace/`，参数和路径缺失必须失败。
- migration 只新增 core v2；不修改 core v1 或其他已提交 migration。
- 本批只在最终 review 和验证后提交一次。

---

### Task 1: Replace synchronous startup health check with a fast probe on the shared pool

**Files:**
- Create: `src/main/infrastructure/database-fast-probe.ts`
- Modify: `src/main/infrastructure/database-health.ts`
- Modify: `src/main/infrastructure/database-pool.ts`
- Modify: `src/main/kernel/kernel-runtime.ts:1-99`
- Modify: `tests/main/infrastructure/database-health.test.ts`
- Create: `tests/main/infrastructure/database-fast-probe.test.ts`
- Modify: `tests/main/kernel-main-integration.test.ts`

**Interfaces:**
- Consumes: the one `DatabasePool` created by `KernelRuntime.start()`.
- Produces: `runDatabaseFastProbe(input: { pool: DatabasePool; now: () => string }): RocDatabaseFastProbeReport` and exported managed-database definitions reused by full check/backup.

- [ ] **Step 1: Write failing fast-probe and startup tests**

Test the observable probe result and write-lock behavior:

```ts
const report = runDatabaseFastProbe({
  pool,
  now: () => '2026-07-10T00:00:00.000Z'
});

expect(report.status).toBe('healthy');
expect(report.databases.map((item) => item.dbName).sort()).toEqual([
  'agent',
  'core',
  'memory',
  'plugin:@roc/plugin-diagnostics',
  'plugin:@roc/plugin-workspace',
  'task'
]);
expect(report.databases.every((item) => item.readProbe === 'ok')).toBe(true);
expect(report.databases.every((item) => item.writeLockProbe === 'ok')).toBe(true);
expect(pool.getCoreConnection().prepare('SELECT COUNT(*) FROM database_health_checks').pluck().get()).toBe(0);
```

Update the full-health test's version expectations for this batch to `{ core: 2, agent: 1, memory: 1, task: 2, workspace: 1, diagnostics: 1 }`; batch four raises agent to version 2 when it adds the sequence cursor index. Do not keep the old assertion that every database is version 1.

Spy on database preparation in the kernel test and assert startup does not issue `PRAGMA quick_check`. Corrupt/remove a required table and assert `kernel.start()` rejects `database_fast_probe_unhealthy` while preserving the existing DB file.

- [ ] **Step 2: Run Task 1 tests and verify RED**

```powershell
pnpm test -- tests/main/infrastructure/database-fast-probe.test.ts tests/main/infrastructure/database-health.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: FAIL because kernel still constructs a second pool through `checkRocDatabases()` and runs six synchronous `quick_check` calls.

- [ ] **Step 3: Define the managed database catalog and fast probe**

In `database-fast-probe.ts`, export one catalog used by fast/full/backup paths:

```ts
export type ManagedDatabaseDefinition = {
  dbName: RocLogicalDatabaseName;
  backupFileName: string;
  requiredTables: readonly string[];
  open(pool: DatabasePool): DatabaseConnection;
  applySchema(db: DatabaseConnection, now: () => string): void;
};

export const managedDatabaseDefinitions: readonly ManagedDatabaseDefinition[] = [
  {
    dbName: 'core',
    backupFileName: 'core.db',
    requiredTables: [
      'plugin_config',
      'plugin_secrets',
      'database_health_checks',
      'database_backup_manifests',
      'database_maintenance_runs',
      'schema_migrations',
      'schema_metadata'
    ],
    open: (pool) => pool.getCoreConnection(),
    applySchema: applyCoreDatabaseSchema
  },
  {
    dbName: 'agent',
    backupFileName: '@roc-plugin-agent.db',
    requiredTables: [
      'agent_threads', 'agent_runs', 'agent_events', 'session_messages', 'session_messages_fts',
      'agent_pending_interrupts', 'agent_run_events', 'langgraph_checkpoints',
      'langgraph_checkpoint_writes', 'agent_tool_effects', 'context_artifacts',
      'schema_migrations', 'schema_metadata'
    ],
    open: (pool) => pool.getConnection('@roc/plugin-agent'),
    applySchema: applyAgentDatabaseSchema
  },
  {
    dbName: 'memory',
    backupFileName: '@roc-plugin-memory.db',
    requiredTables: ['langgraph_store_items', 'memory_events', 'memory_auto_audit', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-memory'),
    applySchema: applyMemoryDatabaseSchema
  },
  {
    dbName: 'task',
    backupFileName: '@roc-plugin-task.db',
    requiredTables: ['background_tasks', 'scheduled_task_runs', 'thread_deletion_journal', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-task'),
    applySchema: applyTaskDatabaseSchema
  },
  {
    dbName: 'plugin:@roc/plugin-workspace',
    backupFileName: '@roc-plugin-workspace.db',
    requiredTables: ['recovery_points', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-workspace'),
    applySchema: applyWorkspaceDatabaseSchema
  },
  {
    dbName: 'plugin:@roc/plugin-diagnostics',
    backupFileName: '@roc-plugin-diagnostics.db',
    requiredTables: ['performance_samples', 'diagnostic_packages', 'schema_migrations', 'schema_metadata'],
    open: (pool) => pool.getConnection('@roc/plugin-diagnostics'),
    applySchema: applyDiagnosticsDatabaseSchema
  }
];
```

Implement each item without `quick_check`:

```ts
function probeManagedDatabase(
  pool: DatabasePool,
  definition: ManagedDatabaseDefinition,
  now: () => string
): RocDatabaseFastProbeItem {
  const db = definition.open(pool);
  definition.applySchema(db, now);
  const schemaVersion = readRequiredSchemaVersion(db, definition.dbName);
  requireTables(db, definition.requiredTables);
  db.prepare('SELECT 1').pluck().get();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('SELECT 1').pluck().get();
  } finally {
    db.exec('ROLLBACK');
  }
  return {
    dbName: definition.dbName,
    schemaVersion,
    readProbe: 'ok',
    writeLockProbe: 'ok'
  };
}
```

Catch only per-database probe boundaries to construct an unhealthy report; kernel throws if any item fails.

- [ ] **Step 4: Make full health check consume the existing pool**

Change `checkRocDatabases` to:

```ts
export function checkRocDatabases(input: {
  pool: DatabasePool;
  now: () => string;
}): RocDatabaseHealthReport {
  const checkedAt = input.now();
  const databases = managedDatabaseDefinitions.map((definition) =>
    checkManagedDatabase(input.pool, definition, () => checkedAt)
  );
  const report = { status: aggregateStatus(databases), databases, checkedAt };
  persistHealthReport(input.pool.getCoreConnection(), report);
  return report;
}
```

It remains the full `PRAGMA quick_check` operation, but it no longer creates/closes a second pool.

- [ ] **Step 5: Use one pool during kernel startup**

Replace the current health block:

```ts
const databasePool = new DatabasePool(this.options.rootDir);
const fastProbe = runDatabaseFastProbe({
  pool: databasePool,
  now: () => new Date().toISOString()
});
if (fastProbe.status === 'unhealthy') {
  databasePool.closeAll();
  throw new Error('database_fast_probe_unhealthy');
}
```

The same `databasePool` then goes into `ConfigStore`, `SecretManager`, plugin facades and later maintenance service.

- [ ] **Step 6: Run Task 1 tests and verify GREEN**

```powershell
pnpm test -- tests/main/infrastructure/database-fast-probe.test.ts tests/main/infrastructure/database-health.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: PASS; kernel startup applies migrations and probes basic read/write without `quick_check` or health-row persistence.

### Task 2: Add maintenance run migration and runtime scheduler

**Files:**
- Modify: `src/main/infrastructure/database-schemas.ts` in `coreMigrations`
- Create: `src/main/infrastructure/database-maintenance.ts`
- Modify: `src/main/kernel/kernel-runtime.ts`
- Modify: `src/main/main-kernel-bootstrap.ts:41-125`
- Modify: `src/main/index.ts:229-430`
- Modify: `tests/main/infrastructure/database-schemas.test.ts`
- Create: `tests/main/infrastructure/database-maintenance.test.ts`
- Modify: `tests/main/kernel-main-integration.test.ts`

**Interfaces:**
- Consumes: shared pool, `checkRocDatabases()`, `runDatabaseRetention()`, infrastructure logger and timers.
- Produces: `DatabaseMaintenanceService.start()` and `stopAndWait(): Promise<void>`; `KernelRuntime.startDatabaseMaintenance()`.

- [ ] **Step 1: Write failing migration and fake-timer tests**

Assert core v2 schema:

```ts
expect(columnNames(coreDb, 'database_maintenance_runs')).toEqual([
  'id', 'kind', 'status', 'started_at', 'finished_at', 'detail_json', 'error_message'
]);
expect(indexNames(coreDb, 'database_maintenance_runs')).toContain(
  'idx_core_database_maintenance_runs_kind_finished'
);
```

With fake timers, assert exact delays and no reentry:

```ts
service.start();
await vi.advanceTimersByTimeAsync(119_999);
expect(runFullHealthCheck).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1);
expect(runFullHealthCheck).toHaveBeenCalledTimes(1);

await vi.advanceTimersByTimeAsync(180_000);
expect(runRetention).toHaveBeenCalledTimes(1);

runFullHealthCheck.mockImplementation(() => pending.promise);
await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
expect(runFullHealthCheck).toHaveBeenCalledTimes(2);
expect(runRetention).toHaveBeenCalledTimes(1);
```

Resolve the pending job, call `stopAndWait()`, and assert no later timer runs. Add failure tests that persist `status='failed'`, `error_message`, log a warning, and allow the next 24-hour run.

- [ ] **Step 2: Run Task 2 tests and verify RED**

```powershell
pnpm test -- tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-maintenance.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: FAIL because core v2 and maintenance service do not exist.

- [ ] **Step 3: Add core migration v2**

Append without editing v1:

```ts
{
  version: 2,
  name: 'database_maintenance_runs',
  sql: `
    CREATE TABLE database_maintenance_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('retention','full_health_check')),
      status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      detail_json TEXT NOT NULL,
      error_message TEXT
    );

    CREATE INDEX idx_core_database_maintenance_runs_kind_finished
      ON database_maintenance_runs(kind, finished_at DESC);
  `
}
```

- [ ] **Step 4: Implement fixed-policy maintenance scheduling**

Create explicit constants and one non-reentrant runner:

```ts
const fullCheckInitialDelayMs = 2 * 60 * 1000;
const retentionInitialDelayMs = 5 * 60 * 1000;
const maintenanceIntervalMs = 24 * 60 * 60 * 1000;
const productionRetentionPolicy: RocDatabaseRetentionPolicy = {
  terminalRunRetentionDays: 90,
  maxCheckpointsPerThread: 100,
  autoMemoryAuditRetentionDays: 180
};

export class DatabaseMaintenanceService {
  private timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  private activeJob: Promise<void> | null = null;
  private started = false;

  start(): void;
  async stopAndWait(): Promise<void>;
}
```

Construct it with the explicit runtime boundary used by tests and production:

```ts
export type DatabaseMaintenanceJobs = {
  runFullHealthCheck(): RocDatabaseHealthReport;
  runRetention(): RocDatabaseRetentionResult;
};

export type DatabaseMaintenanceServiceInput = {
  coreDb: DatabaseConnection;
  logger: { warn(message: string, metadata?: Record<string, unknown>): void };
  jobs: DatabaseMaintenanceJobs;
  now: () => string;
};
```

KernelRuntime supplies jobs closed over the shared pool. Tests supply deferred jobs to assert scheduling and non-reentry; this is the existing infrastructure/service dependency boundary, not a production configuration surface.

`start()` schedules a timeout for each initial delay; each timeout runs its job and installs the corresponding 24-hour interval. `runExclusive(kind, job)` returns without starting when `activeJob !== null`. Before invoking a job insert a `running` row; on success update `complete` with JSON detail; on failure update `failed`, store the error message, and call:

```ts
logger.warn('Database maintenance job failed.', {
  kind,
  error: error instanceof Error ? error.message : String(error)
});
```

Retention invokes:

```ts
runDatabaseRetention({
  agentDb: pool.getConnection('@roc/plugin-agent'),
  memoryDb: pool.getConnection('@roc/plugin-memory'),
  policy: productionRetentionPolicy,
  now: new Date()
});
```

Full check invokes `checkRocDatabases({ pool, now })`; unhealthy results are recorded as failed with the report in `detail_json`, but do not terminate the running application.

- [ ] **Step 5: Wire ready/start and shutdown ordering**

Extend runtime infrastructure with `maintenanceService`. Add:

```ts
startDatabaseMaintenance(): void {
  if (this.infrastructure === null || !this.started) {
    throw new Error('kernel_runtime_not_started');
  }
  this.infrastructure.maintenanceService.start();
}
```

Shutdown order must be:

```ts
await this.infrastructure.maintenanceService.stopAndWait();
await this.infrastructure.loader.shutdown();
await this.infrastructure.logger.close();
this.infrastructure.databasePool.closeAll();
```

Expose `startDatabaseMaintenance()` from `MainKernelBootstrap`. Call it inside `showMainWindowOnce()` before the first show, so both `ready-to-show` and `did-finish-load` fallback paths start the same idempotent service exactly once:

```ts
function showMainWindowOnce(label: string): void {
  if (mainWindowShown) {
    return;
  }
  mainWindowShown = true;
  kernel.startDatabaseMaintenance();
  kernel.performanceObserverService.record({
    phase: 'ready_to_show',
    label,
    startedAtMs: mainReadyStartedAtMs,
    durationMs: performance.now() - mainReadyStartedAtMs,
    metadata: { window: 'main' }
  });
  mainWindow?.show();
}
```

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

```powershell
pnpm test -- tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/infrastructure/database-maintenance.test.ts tests/main/infrastructure/database-retention.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: PASS; initial delays, 24-hour cadence, non-reentry, failure records, retention protection and shutdown wait are directly asserted.

### Task 3: Add a shared PID maintenance lease

**Files:**
- Create: `src/main/infrastructure/database-maintenance-lease.ts`
- Modify: `src/main/kernel/kernel-runtime.ts`
- Create: `tests/main/infrastructure/database-maintenance-lease.test.ts`
- Modify: `tests/main/kernel-main-integration.test.ts`

**Interfaces:**
- Consumes: real database root (`<Roc data root>\plugin-data`) and owner PID.
- Produces: `acquireDatabaseMaintenanceLease()` returning `DatabaseMaintenanceLease.release()`.

- [ ] **Step 1: Write failing lease tests**

Cover exclusive acquisition, live owner, unknown owner, stale cleanup, one retry and token-safe release:

```ts
const lease = acquireDatabaseMaintenanceLease({
  rootDir,
  owner: { kind: 'app', pid: 100 },
  isProcessAlive: () => false
});
expect(readLease(rootDir)).toMatchObject({ kind: 'app', pid: 100 });

expect(() => acquireDatabaseMaintenanceLease({
  rootDir,
  owner: { kind: 'cli', pid: 200 },
  isProcessAlive: () => true
})).toThrow('database_maintenance_locked');

lease.release();
expect(leasePathExists(rootDir)).toBe(false);
```

Write a stale JSON lease with a dead PID; assert the stale file is deleted and acquisition retries once. Write malformed JSON or make process liveness throw a non-`ESRCH` error; assert `database_maintenance_owner_unknown` and keep the file.

- [ ] **Step 2: Run lease tests and verify RED**

```powershell
pnpm test -- tests/main/infrastructure/database-maintenance-lease.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: FAIL because no common lease exists.

- [ ] **Step 3: Implement create-exclusive acquisition**

Use a fixed lease path and unique token:

```ts
const leaseFileName = '.database-maintenance.lock';

export type DatabaseMaintenanceLeaseOwner = {
  kind: 'app' | 'cli';
  pid: number;
};

export function acquireDatabaseMaintenanceLease(input: {
  rootDir: string;
  owner: DatabaseMaintenanceLeaseOwner;
  isProcessAlive?: (pid: number) => boolean;
}): DatabaseMaintenanceLease {
  mkdirSync(input.rootDir, { recursive: true });
  return acquireWithAtMostOneStaleRetry(input, 0);
}
```

Acquisition uses `openSync(path, 'wx')`, writes `{ kind, pid, token, acquiredAt }`, flushes/closes, and returns a release closure. On `EEXIST`, parse the existing file and call the liveness function. The production liveness check is:

```ts
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') {
      return false;
    }
    throw new Error('database_maintenance_owner_unknown');
  }
}
```

Release rereads the file and removes it only when its token matches the holder; otherwise it throws `database_maintenance_lease_replaced` and does not delete another owner's lease.

- [ ] **Step 4: Hold the app lease for the entire KernelRuntime lifecycle**

Acquire at the beginning of `KernelRuntime.start()` after ensuring `rootDir` exists and before `activateMigration` or any database open. Store the lease in `KernelInfrastructure`. On activation/probe/plugin start failure, close pool/logger as applicable and release the lease. On shutdown, release only after maintenance, plugins, logger and pool have closed.

- [ ] **Step 5: Run Task 3 tests and verify GREEN**

```powershell
pnpm test -- tests/main/infrastructure/database-maintenance-lease.test.ts tests/main/kernel-main-integration.test.ts
```

Expected: PASS; a live app blocks CLI-style acquisition, a provably dead owner is cleaned once, and shutdown releases the app lease last.

### Task 4: Replace file-copy backup with SQLite backup API and atomic manifest

**Files:**
- Modify: `src/main/infrastructure/database-backup.ts`
- Modify: `tests/main/infrastructure/database-backup.test.ts`

**Interfaces:**
- Consumes: acquired maintenance lease and `managedDatabaseDefinitions`.
- Produces: async `backupRocDatabases()` with complete manifest or failed artifact.

- [ ] **Step 1: Write failing WAL-consistency and failure-artifact tests**

Keep a WAL-mode connection open, insert committed rows without truncating WAL, then backup:

```ts
const manifest = await backupRocDatabases({
  pool,
  rootDir,
  backupRootDir,
  backupId: 'manual-wal',
  now: () => '2026-07-10T00:00:00.000Z'
});

expect(manifest.status).toBe('complete');
expect(manifest.databases.every((item) => item.sizeBytes > 0)).toBe(true);
expect(readBackedUpThread(manifest.backupDir, 'thread-wal')).toBe('WAL committed');
expect(existsSync(join(manifest.backupDir, 'manifest.tmp'))).toBe(false);
```

Inject failure on the third `db.backup()` call and assert `manifest.json` is absent, `failure.json` exists, and current data remains unchanged.

- [ ] **Step 2: Run backup tests and verify RED**

```powershell
pnpm test -- tests/main/infrastructure/database-backup.test.ts
```

Expected: FAIL because current backup truncates WAL, copies files synchronously, lacks `sizeBytes/status`, and writes a success manifest before a failure artifact contract exists.

- [ ] **Step 3: Implement async SQLite backups**

Change the manifest item and function:

```ts
export type RocDatabaseBackupManifest = {
  id: string;
  status: 'complete';
  createdAt: string;
  backupDir: string;
  databases: Array<{
    dbName: RocLogicalDatabaseName;
    fileName: string;
    sha256: string;
    schemaVersion: number;
    sizeBytes: number;
  }>;
};

export async function backupRocDatabases(input: {
  pool: DatabasePool;
  rootDir: string;
  backupRootDir: string;
  backupId: string;
  now: () => string;
}): Promise<RocDatabaseBackupManifest>;
```

For each definition:

```ts
const db = definition.open(input.pool);
const targetPath = join(backupDir, definition.backupFileName);
await db.backup(targetPath);
const schemaVersion = readRequiredSchemaVersion(db, definition.dbName);
const sizeBytes = statSync(targetPath).size;
return {
  dbName: definition.dbName,
  fileName: definition.backupFileName,
  sha256: sha256File(targetPath),
  schemaVersion,
  sizeBytes
};
```

After all six complete, write `manifest.tmp` with UTF-8 and atomically `renameSync()` it to `manifest.json`; only then persist `database_backup_manifests`. On failure write `failure.json` with backup id, failedAt and error message, keep copied diagnostic files, and rethrow. Do not write a partial success manifest.

- [ ] **Step 4: Run Task 4 tests and verify GREEN**

```powershell
pnpm test -- tests/main/infrastructure/database-backup.test.ts
```

Expected: PASS; WAL data is present in the backup and injected failure leaves only a failed artifact.

### Task 5: Implement staging restore, rollback, and the offline CLI

**Files:**
- Modify: `src/main/infrastructure/database-backup.ts`
- Create: `src/main/infrastructure/database-maintenance-cli.ts`
- Modify: `electron.vite.config.ts:45-56`
- Modify: `package.json` scripts
- Modify: `tests/main/infrastructure/database-backup.test.ts`
- Create: `tests/main/infrastructure/database-maintenance-cli.test.ts`
- Modify: `tests/main/main-bundle-boundaries.test.ts`

**Interfaces:**
- Consumes: complete manifest, shared lease, fast/full probes and `<data-root>\plugin-data` mapping.
- Produces: async staging `restoreRocDatabaseBackup()` and CLI commands `database:backup` / `database:restore`.

- [ ] **Step 1: Write failing staging/rollback tests**

Add tests for manifest path boundary, complete set, hash, size, schema version and quick-check. Inject failures at staging verification, first directory rename and final fast probe:

```ts
const before = readCurrentMarker(rootDir);
vi.mocked(runDatabaseFastProbe).mockReturnValueOnce({
  status: 'unhealthy',
  checkedAt: '2026-07-10T00:00:00.000Z',
  databases: []
});
await expect(restoreRocDatabaseBackup({
  rootDir,
  backupDir: manifest.backupDir,
  generationId: 'restore-fail',
  now: () => '2026-07-10T00:00:00.000Z'
})).rejects.toThrow('database_restore_final_probe_failed');

expect(readCurrentMarker(rootDir)).toBe(before);
expect(listRollbackGenerations(rootDir)).toHaveLength(1);
```

Successful restore must leave current `data`, one rollback generation and `restore-receipt.json`; it must not auto-delete rollback.

Use a partial Vitest module mock of `node:fs` to make a selected `renameSync` call throw for directory-switch failure, and a module mock of `runDatabaseFastProbe` for final-probe failure. Do not add `hooks`, callbacks or failure-injection fields to the production restore API.

CLI tests invoke exported `runDatabaseMaintenanceCli(args, io)` and assert missing args, app-held lease and outside-root paths return exit code `1` with exact error codes. Valid backup/restore return `0`.

- [ ] **Step 2: Run Task 5 tests and verify RED**

```powershell
pnpm test -- tests/main/infrastructure/database-backup.test.ts tests/main/infrastructure/database-maintenance-cli.test.ts tests/main/main-bundle-boundaries.test.ts
```

Expected: FAIL because restore deletes current files in place and no CLI entry exists.

- [ ] **Step 3: Restore into a sibling staging generation**

Use a staging root whose child is a normal `data` directory, so the unchanged `DatabasePool` can validate it:

```ts
const currentDataDir = join(input.rootDir, 'data');
const stagingRootDir = join(input.rootDir, `.restore-${input.generationId}.staging`);
const stagingDataDir = join(stagingRootDir, 'data');
const rollbackDataDir = join(input.rootDir, `data.rollback-${input.generationId}`);
```

Validate the manifest before creating staging. Copy each backed-up database into the same relative path it would have under `stagingRootDir\data`; verify hash/size/schema against the manifest. Open `new DatabasePool(stagingRootDir)`, then run migration compatibility, required-table checks and six `PRAGMA quick_check` calls.

Switch and rollback explicitly:

```ts
renameSync(currentDataDir, rollbackDataDir);
try {
  renameSync(stagingDataDir, currentDataDir);
  const currentPool = new DatabasePool(input.rootDir);
  try {
    const report = runDatabaseFastProbe({ pool: currentPool, now: input.now });
    if (report.status !== 'healthy') {
      throw new Error('database_restore_final_probe_failed');
    }
  } finally {
    currentPool.closeAll();
  }
} catch (error) {
  if (existsSync(currentDataDir)) {
    renameSync(currentDataDir, `${stagingDataDir}.failed`);
  }
  renameSync(rollbackDataDir, currentDataDir);
  throw error;
}
```

On success write a receipt containing backup id, restoredAt, rollback path and current path. Do not remove rollback.

- [ ] **Step 4: Implement strict CLI parsing and lease ownership**

Export a testable runner:

```ts
export async function runDatabaseMaintenanceCli(
  args: readonly string[],
  io: { stdout(message: string): void; stderr(message: string): void }
): Promise<number>;
```

Accepted forms are exactly:

```text
backup --data-root <path> --backup-root <path> --id <id>
restore --data-root <path> --backup-dir <path>
```

Resolve `rootDir = join(resolve(dataRoot), 'plugin-data')`, reject `/workspace/` and unknown/duplicate/missing flags, acquire `{ kind: 'cli', pid: process.pid }`, call the async operation, and release in `finally`. Guard the module entry before converting the path:

```ts
const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await runDatabaseMaintenanceCli(process.argv.slice(2), {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message)
  });
}
```

For `backup`, acquire the lease, create one `DatabasePool`, run `runDatabaseFastProbe()` to initialize/validate the six databases, then pass that pool to `backupRocDatabases()`. Close the pool before releasing the lease. `restore` validates the manifest/staging without initializing current data.

- [ ] **Step 5: Add the electron-vite main entry and package scripts**

```ts
input: {
  index: resolve(__dirname, 'src/main/index.ts'),
  'database-maintenance-cli': resolve(__dirname, 'src/main/infrastructure/database-maintenance-cli.ts')
}
```

Add scripts:

```json
"database:backup": "node dist/main/database-maintenance-cli.js backup",
"database:restore": "node dist/main/database-maintenance-cli.js restore"
```

The operational commands after `pnpm build` are:

```powershell
pnpm database:backup -- --data-root C:\Users\任彦舟\AppData\Roaming\Roc --backup-root D:\RocBackups --id manual-20260710
pnpm database:restore -- --data-root C:\Users\任彦舟\AppData\Roaming\Roc --backup-dir D:\RocBackups\manual-20260710
```

- [ ] **Step 6: Run Task 5 tests and verify GREEN**

```powershell
pnpm test -- tests/main/infrastructure/database-backup.test.ts tests/main/infrastructure/database-maintenance-cli.test.ts tests/main/main-bundle-boundaries.test.ts
```

Expected: PASS; staging failure leaves current unchanged, post-switch failure rolls back, and CLI refuses live app leases and invalid paths.

### Task 6: Review, package-verify, and commit the database batch

**Files:**
- Review: all files changed in Tasks 1-5
- Verify: main build entry, native dependency packaging and offline commands

**Interfaces:**
- Consumes: final shared pool, maintenance service, lease, backup and restore lifecycle.
- Produces: one reviewed database lifecycle commit.

- [ ] **Step 1: Run the complete database focused suite**

```powershell
pnpm test -- tests/main/infrastructure/database-fast-probe.test.ts tests/main/infrastructure/database-health.test.ts tests/main/infrastructure/database-retention.test.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/infrastructure/database-maintenance.test.ts tests/main/infrastructure/database-maintenance-lease.test.ts tests/main/infrastructure/database-backup.test.ts tests/main/infrastructure/database-maintenance-cli.test.ts tests/main/kernel-main-integration.test.ts tests/main/main-bundle-boundaries.test.ts
```

Expected: PASS.

- [ ] **Step 2: Review the current diff before committing**

```powershell
git diff -- src/main/infrastructure src/main/kernel src/main/main-kernel-bootstrap.ts src/main/index.ts electron.vite.config.ts package.json tests/main
```

Review in this order:

1. Critical: restore can touch current data before staging verification or fail after switch without restoring rollback.
2. Critical: CLI can acquire a live app lease, remove an unproven owner, escape root paths, or accept `/workspace/`.
3. High: startup still executes `quick_check`, creates a second pool, or persists health rows before window creation.
4. High: shutdown closes pool/logger before waiting maintenance, or timer can start after stop.
5. High: backup copies live DB files, writes partial success manifest, or misses WAL content.
6. Medium: retention changes fixed policy/protection, migration v1 drifted, or package build omits the CLI entry.

Record findings with file and line. Fix every finding and rerun its direct test. If none exist, record `未发现问题` and note that rollback generations are intentionally retained for explicit manual cleanup.

- [ ] **Step 3: Run build, native and package verification**

```powershell
pnpm typecheck
pnpm build
pnpm verify:native-packaging
pnpm package:dir
git diff --check
```

Expected: every command exit code `0`; `dist\main\database-maintenance-cli.js` exists after build and package verification preserves `better-sqlite3` loading.

- [ ] **Step 4: Run a temporary-root CLI smoke**

```powershell
$suffix = [guid]::NewGuid().ToString('N')
$root = Join-Path $env:TEMP "roc-maintenance-plan-smoke-$suffix"
$backups = Join-Path $env:TEMP "roc-maintenance-plan-backups-$suffix"
pnpm database:backup -- --data-root $root --backup-root $backups --id smoke
pnpm database:restore -- --data-root $root --backup-dir (Join-Path $backups 'smoke')
```

Expected: both commands exit code `0`, restore receipt and rollback generation exist, and no path outside the two temporary roots is modified.

- [ ] **Step 5: Commit only the reviewed database lifecycle batch**

```powershell
$batchFiles = @(
  'src/main/infrastructure/database-fast-probe.ts'
  'src/main/infrastructure/database-health.ts'
  'src/main/infrastructure/database-pool.ts'
  'src/main/infrastructure/database-maintenance.ts'
  'src/main/infrastructure/database-maintenance-lease.ts'
  'src/main/infrastructure/database-maintenance-cli.ts'
  'src/main/infrastructure/database-backup.ts'
  'src/main/infrastructure/database-schemas.ts'
  'src/main/kernel/kernel-runtime.ts'
  'src/main/main-kernel-bootstrap.ts'
  'src/main/index.ts'
  'electron.vite.config.ts'
  'package.json'
  'tests/main/infrastructure/database-backup.test.ts'
  'tests/main/infrastructure/database-fast-probe.test.ts'
  'tests/main/infrastructure/database-health.test.ts'
  'tests/main/infrastructure/database-maintenance-cli.test.ts'
  'tests/main/infrastructure/database-maintenance-lease.test.ts'
  'tests/main/infrastructure/database-maintenance.test.ts'
  'tests/main/infrastructure/database-schemas.test.ts'
  'tests/main/kernel-main-integration.test.ts'
  'tests/main/main-bundle-boundaries.test.ts'
)
git add -- $batchFiles
git diff --cached --check
git commit -m "feat: activate database maintenance lifecycle"
```

Expected: commit succeeds and `git status --short` contains no database-batch leftovers.
