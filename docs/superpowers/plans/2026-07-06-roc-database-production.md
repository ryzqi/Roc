# Roc Database Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Roc's local SQLite persistence into a production-ready single-machine database layer with canonical agent data, destructive rebuild migration, runtime health, backup/restore, retention, performance verification, review gates, and phase commits.

**Architecture:** Keep the plugin database split, but make `@roc/plugin-agent.db` the canonical session/run/event/runtime store, `@roc/plugin-memory.db` the long-term memory store, `@roc/plugin-task.db` the background-task projection store, and `core.db` the platform metadata/config/secrets store. Auxiliary plugin DBs stay plugin-private, but are covered by the same migration, health, backup, and cleanup rules.

**Tech Stack:** TypeScript 6.0.3, Electron main process, better-sqlite3 12.11.1, Vitest 4.1.9, LangGraph Store/checkpointer, DeepAgents 1.10.5, PowerShell on Windows 11.

## Global Constraints

- User-facing replies use Simplified Chinese; code identifiers, commands, logs, errors, and protocol fields keep their original language.
- Show command examples only in PowerShell.
- Use UTF-8 without BOM.
- Do not use `??`, `||`, or equivalent defaults to hide missing critical fields, invalid states, or broken contracts.
- Do not add old schema compatibility runtime paths after the destructive rebuild cutover.
- Do not migrate old task plugin `task_threads`, `task_runs`, or `task_events` history.
- Migration may discard failed records and must not persist migration reports, summaries, failed record audits, or failed raw data.
- Runtime production reliability is mandatory: versioned migrations, health, backup/restore, retention, performance verification, and cleanup are all in scope.
- Every implementation phase ends with review, fixes when needed, verification, and a commit before the next phase.

---

## File Structure

- Create `src/main/infrastructure/database-pragmas.ts`: one place to configure opened SQLite connections.
- Create `src/main/infrastructure/database-migrations.ts`: migration ledger, checksums, ordered execution, schema metadata.
- Create `src/main/infrastructure/database-schemas.ts`: target migrations for `core`, `agent`, `memory`, and `task`.
- Add migration registrations for auxiliary plugin DBs that already persist data, including workspace and diagnostics.
- Modify `src/main/infrastructure/database-pool.ts`: configure all connections with shared PRAGMA policy and expose logical DB paths.
- Modify `src/main/infrastructure/config-store.ts`: use core schema instead of private `ensureTable()`.
- Modify `src/main/infrastructure/secret-manager.ts`: use core schema instead of private `ensureTable()`.
- Create `src/main/infrastructure/database-rebuild.ts`: destructive export/rebuild/import/cleanup orchestration.
- Create `src/main/infrastructure/database-health.ts`: quick check, integrity check, schema drift, FTS trigger and index checks.
- Create `src/main/infrastructure/database-backup.ts`: online backup and restore manifest handling.
- Create `src/main/infrastructure/database-retention.ts`: cleanup policies for terminal/archived data.
- Create `src/main/infrastructure/query-plan.ts`: `EXPLAIN QUERY PLAN` helpers for hot query tests.
- Modify `src/main/kernel/types.ts`: database facade gains named database accessors used by plugins.
- Modify `src/main/kernel/kernel-runtime.ts`: run rebuild/migrations/health before plugin load and expose named database facade.
- Modify `src/main/plugins/agent/schema.ts`: delegate to target agent schema and remove old task-named schema ownership.
- Modify `src/main/plugins/agent/session-repository.ts`: read/write `agent_threads`, `agent_runs`, and `agent_events`.
- Modify `src/main/plugins/agent/run-event-log.ts`: keep streaming replay in agent DB under migration-managed schema.
- Modify `src/main/plugins/agent/index.ts`: use agent DB for checkpoints, tool effects, context artifacts; use memory DB store facade for long-term memory.
- Modify `src/main/services/deep-agent/sqlite-checkpointer.ts`: schema is applied by migrations; repository no longer owns table creation.
- Modify `src/main/services/deep-agent/tool-effect-store.ts`: schema is applied by migrations; repository no longer owns table creation.
- Modify `src/main/services/deep-agent/context/context-artifact-store.ts`: schema is applied by migrations; repository no longer owns table creation.
- Modify `src/main/services/memory/sqlite-store.ts`: schema is applied by migrations; store no longer owns table creation.
- Modify `src/main/plugins/memory/schema.ts`: delegate to target memory schema.
- Modify `src/main/plugins/memory/index.ts`: use memory DB for `RocSqliteStore`.
- Modify `src/main/plugins/task/schema.ts`: only background task and scheduled run tables remain.
- Modify `src/main/plugins/task/task-repository*.ts`: remove local task thread/run/event writes and query canonical agent data through a bridge.
- Create `src/main/plugins/task/agent-task-history.ts`: task plugin read-only bridge for thread/run/event history from agent DB.
- Test files:
  - `tests/main/infrastructure/database-pragmas.test.ts`
  - `tests/main/infrastructure/database-migrations.test.ts`
  - `tests/main/infrastructure/database-schemas.test.ts`
  - `tests/main/infrastructure/database-rebuild.test.ts`
  - `tests/main/infrastructure/database-health.test.ts`
  - `tests/main/infrastructure/database-backup.test.ts`
  - `tests/main/infrastructure/database-retention.test.ts`
  - `tests/main/infrastructure/query-plan.test.ts`
  - update existing agent/task/memory/database-pool tests.

## Task 1: Shared SQLite Connection Policy

**Files:**
- Create: `src/main/infrastructure/database-pragmas.ts`
- Modify: `src/main/infrastructure/database-pool.ts`
- Test: `tests/main/infrastructure/database-pragmas.test.ts`
- Test: `tests/main/infrastructure/database-pool.test.ts`

**Interfaces:**
- Produces: `configureRocDatabaseConnection(db: DatabaseConnection, input: RocDatabaseConnectionOptions): RocDatabasePragmaState`
- Produces: `RocLogicalDatabaseName = 'core' | 'agent' | 'memory' | 'task' | \`plugin:${string}\``
- Produces: `DatabasePool.getDatabasePath(name: RocLogicalDatabaseName): string`
- Consumes: existing `DatabasePool.getConnection(pluginId)` and `getCoreConnection()`

- [ ] **Step 1: Write failing PRAGMA policy tests**

Add `tests/main/infrastructure/database-pragmas.test.ts`:

```ts
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { configureRocDatabaseConnection } from '../../../src/main/infrastructure/database-pragmas';

let db: Database.Database | null = null;

afterEach(() => {
  if (db !== null) {
    db.close();
    db = null;
  }
});

describe('configureRocDatabaseConnection', () => {
  it('enables the shared SQLite production pragmas', () => {
    db = new Database(':memory:');

    const state = configureRocDatabaseConnection(db, {
      databaseName: 'agent',
      busyTimeoutMs: 5000,
      synchronous: 'NORMAL'
    });

    expect(state).toEqual({
      databaseName: 'agent',
      busyTimeoutMs: 5000,
      foreignKeys: 1,
      journalMode: 'memory',
      synchronous: 1
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('rejects invalid busy timeout values instead of hiding bad configuration', () => {
    db = new Database(':memory:');

    expect(() =>
      configureRocDatabaseConnection(db!, {
        databaseName: 'core',
        busyTimeoutMs: 0,
        synchronous: 'NORMAL'
      })
    ).toThrow('database_busy_timeout_invalid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-pragmas.test.ts
```

Expected: FAIL because `database-pragmas.ts` does not exist.

- [ ] **Step 3: Add shared PRAGMA helper**

Create `src/main/infrastructure/database-pragmas.ts`:

```ts
import type { Database as DatabaseConnection } from 'better-sqlite3';

export type RocLogicalDatabaseName = 'core' | 'agent' | 'memory' | 'task' | `plugin:${string}`;

export type RocDatabaseConnectionOptions = {
  databaseName: RocLogicalDatabaseName;
  busyTimeoutMs: number;
  synchronous: 'NORMAL' | 'FULL';
};

export type RocDatabasePragmaState = {
  databaseName: RocLogicalDatabaseName;
  busyTimeoutMs: number;
  foreignKeys: number;
  journalMode: string;
  synchronous: number;
};

export function configureRocDatabaseConnection(
  db: DatabaseConnection,
  input: RocDatabaseConnectionOptions
): RocDatabasePragmaState {
  if (!Number.isInteger(input.busyTimeoutMs) || input.busyTimeoutMs <= 0) {
    throw new Error('database_busy_timeout_invalid');
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${input.busyTimeoutMs}`);
  db.pragma(`synchronous = ${input.synchronous}`);
  return {
    databaseName: input.databaseName,
    busyTimeoutMs: input.busyTimeoutMs,
    foreignKeys: Number(db.pragma('foreign_keys', { simple: true })),
    journalMode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
    synchronous: Number(db.pragma('synchronous', { simple: true }))
  };
}
```

- [ ] **Step 4: Wire `DatabasePool` through the helper**

Modify `src/main/infrastructure/database-pool.ts`:

```ts
import { configureRocDatabaseConnection, type RocLogicalDatabaseName } from './database-pragmas';

const defaultBusyTimeoutMs = 5000;
const defaultSynchronous = 'NORMAL' as const;

const pluginDatabaseNames = new Map<string, RocLogicalDatabaseName>([
  ['@roc/plugin-agent', 'agent'],
  ['@roc/plugin-memory', 'memory'],
  ['@roc/plugin-task', 'task']
]);

function resolvePluginDatabaseName(pluginId: string): RocLogicalDatabaseName {
  const knownName = pluginDatabaseNames.get(pluginId);
  if (knownName !== undefined) {
    return knownName;
  }
  return `plugin:${pluginId}`;
}
```

Replace both direct PRAGMA blocks with:

```ts
configureRocDatabaseConnection(connection, {
  databaseName: resolvePluginDatabaseName(pluginId),
  busyTimeoutMs: defaultBusyTimeoutMs,
  synchronous: defaultSynchronous
});
```

For `getCoreConnection()`, use:

```ts
configureRocDatabaseConnection(connection, {
  databaseName: 'core',
  busyTimeoutMs: defaultBusyTimeoutMs,
  synchronous: defaultSynchronous
});
```

Add:

```ts
getDatabasePath(name: RocLogicalDatabaseName): string {
  if (name === 'core') {
    return join(this.rootDir, 'data', 'core.db');
  }
  if (name === 'agent') {
    return this.pluginDatabasePath('@roc/plugin-agent');
  }
  if (name === 'memory') {
    return this.pluginDatabasePath('@roc/plugin-memory');
  }
  if (name === 'task') {
    return this.pluginDatabasePath('@roc/plugin-task');
  }
  if (name.startsWith('plugin:')) {
    return this.pluginDatabasePath(name.slice('plugin:'.length));
  }
  throw new Error('database_name_invalid');
}
```

- [ ] **Step 5: Extend `database-pool` tests**

In `tests/main/infrastructure/database-pool.test.ts`, add assertions:

```ts
expect(agentDb.pragma('busy_timeout', { simple: true })).toBe(5000);
expect(pool.getDatabasePath('core')).toBe(join(root, 'data', 'core.db'));
expect(pool.getDatabasePath('agent')).toBe(join(root, 'data', 'plugins', '@roc', 'plugin-agent.db'));
expect(pool.getDatabasePath('memory')).toBe(join(root, 'data', 'plugins', '@roc', 'plugin-memory.db'));
expect(pool.getDatabasePath('task')).toBe(join(root, 'data', 'plugins', '@roc', 'plugin-task.db'));
```

- [ ] **Step 6: Verify Task 1**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-pragmas.test.ts tests/main/infrastructure/database-pool.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS for both Vitest files, PASS for typecheck, no diff whitespace errors.

- [ ] **Step 7: Review and commit Task 1**

Review:

```powershell
git diff -- src/main/infrastructure/database-pragmas.ts src/main/infrastructure/database-pool.ts tests/main/infrastructure/database-pragmas.test.ts tests/main/infrastructure/database-pool.test.ts
```

Commit:

```powershell
git add src/main/infrastructure/database-pragmas.ts src/main/infrastructure/database-pool.ts tests/main/infrastructure/database-pragmas.test.ts tests/main/infrastructure/database-pool.test.ts
git commit -m "feat: centralize sqlite connection policy"
```

## Task 2: Versioned Migration Framework

**Files:**
- Create: `src/main/infrastructure/database-migrations.ts`
- Test: `tests/main/infrastructure/database-migrations.test.ts`

**Interfaces:**
- Consumes: `RocLogicalDatabaseName`
- Produces: `RocDatabaseMigration`
- Produces: `applyDatabaseMigrations(db, { dbName, migrations, now })`
- Produces: `readSchemaMetadata(db, dbName)`

- [ ] **Step 1: Write failing migration tests**

Create `tests/main/infrastructure/database-migrations.test.ts`:

```ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDatabaseMigrations,
  readSchemaMetadata,
  type RocDatabaseMigration
} from '../../../src/main/infrastructure/database-migrations';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('database migrations', () => {
  it('applies migrations once in version order and records metadata', () => {
    const migrations: RocDatabaseMigration[] = [
      {
        version: 1,
        name: 'create_first',
        sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);"
      },
      {
        version: 2,
        name: 'create_second',
        sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY);"
      }
    ];

    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations,
      now: () => '2026-07-06T00:00:00.000Z'
    });
    applyDatabaseMigrations(db, {
      dbName: 'agent',
      migrations,
      now: () => '2026-07-06T00:00:01.000Z'
    });

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'first_table'").pluck().get()).toBe('first_table');
    expect(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(2);
    expect(readSchemaMetadata(db, 'agent')).toMatchObject({
      dbName: 'agent',
      currentVersion: 2
    });
  });

  it('rejects checksum drift for an already-applied migration', () => {
    applyDatabaseMigrations(db, {
      dbName: 'memory',
      migrations: [{ version: 1, name: 'create_items', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY);' }],
      now: () => '2026-07-06T00:00:00.000Z'
    });

    expect(() =>
      applyDatabaseMigrations(db, {
        dbName: 'memory',
        migrations: [{ version: 1, name: 'create_items', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT);' }],
        now: () => '2026-07-06T00:00:01.000Z'
      })
    ).toThrow('database_migration_checksum_drift');
  });

  it('rejects non-contiguous migration versions', () => {
    expect(() =>
      applyDatabaseMigrations(db, {
        dbName: 'task',
        migrations: [
          { version: 1, name: 'one', sql: 'CREATE TABLE one (id TEXT PRIMARY KEY);' },
          { version: 3, name: 'three', sql: 'CREATE TABLE three (id TEXT PRIMARY KEY);' }
        ],
        now: () => '2026-07-06T00:00:00.000Z'
      })
    ).toThrow('database_migration_version_gap');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-migrations.test.ts
```

Expected: FAIL because `database-migrations.ts` does not exist.

- [ ] **Step 3: Implement migration framework**

Create `src/main/infrastructure/database-migrations.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { RocLogicalDatabaseName } from './database-pragmas';

export type RocDatabaseMigration = {
  version: number;
  name: string;
  sql: string;
};

export type RocSchemaMetadata = {
  dbName: RocLogicalDatabaseName;
  currentVersion: number;
  schemaChecksum: string;
  createdAt: string;
  updatedAt: string;
};

export function applyDatabaseMigrations(
  db: DatabaseConnection,
  input: {
    dbName: RocLogicalDatabaseName;
    migrations: readonly RocDatabaseMigration[];
    now?: () => string;
  }
): void {
  const now = input.now === undefined ? () => new Date().toISOString() : input.now;
  ensureLedgerTables(db);
  validateMigrationList(input.migrations);
  const applied = readAppliedMigrations(db, input.dbName);
  validateAppliedMigrations(applied, input.migrations);
  const applyPending = db.transaction(() => {
    for (const migration of input.migrations) {
      const checksum = checksumMigration(migration);
      const existing = applied.get(migration.version);
      if (existing !== undefined) {
        if (existing.checksum !== checksum || existing.name !== migration.name) {
          throw new Error('database_migration_checksum_drift');
        }
        continue;
      }
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_migrations (db_name, version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(input.dbName, migration.version, migration.name, checksum, now());
    }
    writeMetadata(db, input.dbName, input.migrations, now());
  });
  applyPending();
}

export function readSchemaMetadata(db: DatabaseConnection, dbName: RocLogicalDatabaseName): RocSchemaMetadata | null {
  ensureLedgerTables(db);
  const row = db
    .prepare(
      `SELECT db_name, current_version, schema_checksum, created_at, updated_at
       FROM schema_metadata
       WHERE db_name = ?`
    )
    .get(dbName) as
    | {
        db_name: RocLogicalDatabaseName;
        current_version: number;
        schema_checksum: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    dbName: row.db_name,
    currentVersion: row.current_version,
    schemaChecksum: row.schema_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ensureLedgerTables(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      db_name    TEXT NOT NULL,
      version    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(db_name, version)
    );

    CREATE TABLE IF NOT EXISTS schema_metadata (
      db_name         TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL,
      schema_checksum TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);
}

function validateMigrationList(migrations: readonly RocDatabaseMigration[]): void {
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error('database_migration_version_gap');
    }
    if (migration.name.trim().length === 0) {
      throw new Error('database_migration_name_empty');
    }
    if (migration.sql.trim().length === 0) {
      throw new Error('database_migration_sql_empty');
    }
    expected += 1;
  }
}

function readAppliedMigrations(
  db: DatabaseConnection,
  dbName: RocLogicalDatabaseName
): Map<number, { name: string; checksum: string }> {
  const rows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations WHERE db_name = ? ORDER BY version ASC')
    .all(dbName) as Array<{ version: number; name: string; checksum: string }>;
  return new Map(rows.map((row) => [row.version, { name: row.name, checksum: row.checksum }]));
}

function validateAppliedMigrations(
  applied: ReadonlyMap<number, { name: string; checksum: string }>,
  migrations: readonly RocDatabaseMigration[]
): void {
  const knownVersions = new Set(migrations.map((migration) => migration.version));
  for (const version of applied.keys()) {
    if (!knownVersions.has(version)) {
      throw new Error('database_migration_unknown_applied_version');
    }
  }
}

function writeMetadata(
  db: DatabaseConnection,
  dbName: RocLogicalDatabaseName,
  migrations: readonly RocDatabaseMigration[],
  timestamp: string
): void {
  const currentVersion = migrations.length;
  const schemaChecksum = checksumText(migrations.map(checksumMigration).join('\n'));
  const existing = db.prepare('SELECT created_at FROM schema_metadata WHERE db_name = ?').get(dbName) as
    | { created_at: string }
    | undefined;
  const createdAt = existing === undefined ? timestamp : existing.created_at;
  db.prepare(
    `INSERT INTO schema_metadata (db_name, current_version, schema_checksum, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(db_name) DO UPDATE SET
       current_version = excluded.current_version,
       schema_checksum = excluded.schema_checksum,
       updated_at = excluded.updated_at`
  ).run(dbName, currentVersion, schemaChecksum, createdAt, timestamp);
}

function checksumMigration(migration: RocDatabaseMigration): string {
  return checksumText(`${migration.version}\n${migration.name}\n${migration.sql}`);
}

function checksumText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Verify Task 2**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-migrations.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS for migration tests, PASS for typecheck, no diff whitespace errors.

- [ ] **Step 5: Review and commit Task 2**

Review:

```powershell
git diff -- src/main/infrastructure/database-migrations.ts tests/main/infrastructure/database-migrations.test.ts
```

Commit:

```powershell
git add src/main/infrastructure/database-migrations.ts tests/main/infrastructure/database-migrations.test.ts
git commit -m "feat: add sqlite migration ledger"
```

## Task 3: Target Database Schemas

**Files:**
- Create: `src/main/infrastructure/database-schemas.ts`
- Modify: `src/main/infrastructure/config-store.ts`
- Modify: `src/main/infrastructure/secret-manager.ts`
- Test: `tests/main/infrastructure/database-schemas.test.ts`
- Test: `tests/main/infrastructure/config-store.test.ts`
- Test: `tests/main/infrastructure/secret-manager.test.ts`

**Interfaces:**
- Consumes: `applyDatabaseMigrations`
- Produces: `applyCoreDatabaseSchema(db, now?)`
- Produces: `applyAgentDatabaseSchema(db, now?)`
- Produces: `applyMemoryDatabaseSchema(db, now?)`
- Produces: `applyTaskDatabaseSchema(db, now?)`
- Produces: `applyWorkspaceDatabaseSchema(db, now?)`
- Produces: `applyDiagnosticsDatabaseSchema(db, now?)`

- [ ] **Step 1: Write target schema tests**

Create `tests/main/infrastructure/database-schemas.test.ts`:

```ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAgentDatabaseSchema,
  applyCoreDatabaseSchema,
  applyDiagnosticsDatabaseSchema,
  applyMemoryDatabaseSchema,
  applyWorkspaceDatabaseSchema,
  applyTaskDatabaseSchema
} from '../../../src/main/infrastructure/database-schemas';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('target database schemas', () => {
  it('creates core platform metadata tables', () => {
    applyCoreDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining([
      'plugin_config',
      'plugin_secrets',
      'database_health_checks',
      'database_backup_manifests',
      'schema_migrations',
      'schema_metadata'
    ]));
  });

  it('creates canonical agent runtime tables without task-owned table names', () => {
    applyAgentDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining([
      'agent_threads',
      'agent_runs',
      'agent_events',
      'session_messages',
      'session_messages_fts',
      'agent_pending_interrupts',
      'agent_run_events',
      'langgraph_checkpoints',
      'langgraph_checkpoint_writes',
      'agent_tool_effects',
      'context_artifacts'
    ]));
    expect(tableNames()).not.toContain('task_threads');
    expect(tableNames()).not.toContain('task_runs');
    expect(tableNames()).not.toContain('task_events');
  });

  it('creates memory store and audit tables', () => {
    applyMemoryDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining([
      'langgraph_store_items',
      'memory_events',
      'memory_auto_audit'
    ]));
  });

  it('creates only background task projection tables in task db', () => {
    applyTaskDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining(['background_tasks', 'scheduled_task_runs']));
    expect(tableNames()).not.toContain('task_threads');
    expect(tableNames()).not.toContain('task_runs');
    expect(tableNames()).not.toContain('task_events');
  });

  it('creates workspace private tables under migration control', () => {
    applyWorkspaceDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toContain('recovery_points');
  });

  it('creates diagnostics private tables under migration control', () => {
    applyDiagnosticsDatabaseSchema(db, () => '2026-07-06T00:00:00.000Z');

    expect(tableNames()).toEqual(expect.arrayContaining(['performance_samples', 'diagnostic_packages']));
  });
});

function tableNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-schemas.test.ts
```

Expected: FAIL because `database-schemas.ts` does not exist.

- [ ] **Step 3: Implement target schema migrations**

Create `src/main/infrastructure/database-schemas.ts` with these exported functions and migration arrays:

```ts
import type { Database as DatabaseConnection } from 'better-sqlite3';

import { applyDatabaseMigrations, type RocDatabaseMigration } from './database-migrations';

type Clock = () => string;

export function applyCoreDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applyDatabaseMigrations(db, { dbName: 'core', migrations: coreMigrations, now });
}

export function applyAgentDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applyDatabaseMigrations(db, { dbName: 'agent', migrations: agentMigrations, now });
}

export function applyMemoryDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applyDatabaseMigrations(db, { dbName: 'memory', migrations: memoryMigrations, now });
}

export function applyTaskDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applyDatabaseMigrations(db, { dbName: 'task', migrations: taskMigrations, now });
}

export function applyWorkspaceDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applyDatabaseMigrations(db, { dbName: 'plugin:@roc/plugin-workspace', migrations: workspaceMigrations, now });
}

export function applyDiagnosticsDatabaseSchema(db: DatabaseConnection, now?: Clock): void {
  applyDatabaseMigrations(db, { dbName: 'plugin:@roc/plugin-diagnostics', migrations: diagnosticsMigrations, now });
}

export const coreMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'core_platform_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS plugin_config (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS plugin_secrets (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        ciphertext_base64 TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );

      CREATE TABLE IF NOT EXISTS database_health_checks (
        id TEXT PRIMARY KEY,
        db_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('healthy','degraded','unhealthy')),
        detail_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_database_health_checks_db_checked
        ON database_health_checks(db_name, checked_at DESC);

      CREATE TABLE IF NOT EXISTS database_backup_manifests (
        id TEXT PRIMARY KEY,
        backup_dir TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  }
];

export const agentMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'agent_canonical_runtime_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('chat','plan','background')),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_number INTEGER NOT NULL,
        user_input TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        provider_id TEXT,
        model_id TEXT,
        enabled_capabilities_json TEXT NOT NULL,
        workspace_path TEXT,
        task_source TEXT,
        workflow_hint TEXT,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id),
        FOREIGN KEY(run_id) REFERENCES agent_runs(id)
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id             TEXT PRIMARY KEY,
        thread_id      TEXT NOT NULL,
        role           TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content        TEXT NOT NULL,
        token_count    INTEGER,
        phase          TEXT NOT NULL DEFAULT 'visible' CHECK(phase IN ('visible','pre_compaction_flush')),
        workspace_hash TEXT,
        created_at     TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        content,
        content='session_messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS session_messages_au AFTER UPDATE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
        INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE IF NOT EXISTS agent_pending_interrupts (
        run_id                  TEXT PRIMARY KEY,
        thread_id               TEXT NOT NULL,
        interrupt_id            TEXT NOT NULL,
        payload_json            TEXT NOT NULL,
        mode                    TEXT NOT NULL,
        task_source             TEXT,
        workflow_hint           TEXT,
        workspace_path_state    TEXT NOT NULL CHECK(workspace_path_state IN ('undefined','null','value')),
        workspace_path          TEXT,
        explicit_skill_ids_json TEXT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(id),
        FOREIGN KEY(thread_id) REFERENCES agent_threads(id)
      );

      CREATE TABLE IF NOT EXISTS agent_run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_type TEXT NOT NULL,
        checkpoint_blob BLOB NOT NULL,
        metadata_type TEXT NOT NULL,
        metadata_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );

      CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        value_type TEXT NOT NULL,
        value_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );

      CREATE TABLE IF NOT EXISTS agent_tool_effects (
        run_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('in_progress','success','error','unknown')),
        result_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, tool_call_id)
      );

      CREATE TABLE IF NOT EXISTS context_artifacts (
        id             TEXT PRIMARY KEY,
        run_id         TEXT NOT NULL,
        thread_id      TEXT NOT NULL,
        kind           TEXT NOT NULL CHECK(kind IN ('tool_result','transcript','summary_index')),
        tool_call_id   TEXT,
        tool_name      TEXT,
        sha256         TEXT NOT NULL,
        original_chars INTEGER NOT NULL,
        preview        TEXT NOT NULL,
        content        TEXT NOT NULL,
        workspace_hash TEXT,
        created_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_threads_updated
        ON agent_threads(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_run_number
        ON agent_runs(thread_id, run_number DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_events_thread_run_sequence
        ON agent_events(thread_id, run_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_events_thread_created
        ON agent_events(thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_session_messages_thread_created
        ON session_messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_session_messages_workspace_created
        ON session_messages(workspace_hash, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_pending_interrupts_thread
        ON agent_pending_interrupts(thread_id);
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_sequence
        ON agent_run_events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_thread_checkpoint
        ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_tool_effects_thread_updated
        ON agent_tool_effects(thread_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_artifacts_thread_created
        ON context_artifacts(thread_id, created_at);
    `
  }
];

export const memoryMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'memory_store_and_audit_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS langgraph_store_items (
        namespace_key TEXT NOT NULL,
        namespace_json TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace_key, key)
      );

      CREATE INDEX IF NOT EXISTS idx_langgraph_store_items_namespace_key
        ON langgraph_store_items(namespace_key);

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        thread_id TEXT,
        run_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_events_created
        ON memory_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_auto_audit (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        confidence TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        workspace_path TEXT,
        target_path TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_auto_audit_created
        ON memory_auto_audit(created_at DESC);
    `
  }
];

export const taskMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'background_task_projection_tables',
    sql: `
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
        enabled_capabilities_json TEXT
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
      CREATE INDEX IF NOT EXISTS idx_task_plugin_background_tasks_status_updated
        ON background_tasks(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_plugin_scheduled_task_runs_task_status
        ON scheduled_task_runs(background_task_id, status, scheduled_at DESC);
    `
  }
];

export const workspaceMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'workspace_private_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS recovery_points (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_recovery_points_created
        ON recovery_points(created_at DESC);
    `
  }
];

export const diagnosticsMigrations: RocDatabaseMigration[] = [
  {
    version: 1,
    name: 'diagnostics_private_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS performance_samples (
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

      CREATE INDEX IF NOT EXISTS idx_performance_samples_sampled
        ON performance_samples(sampled_at DESC);

      CREATE TABLE IF NOT EXISTS diagnostic_packages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        includes_json TEXT NOT NULL,
        redacted INTEGER NOT NULL
      );
    `
  }
];
```

- [ ] **Step 4: Make config and secrets use core schema**

In `src/main/infrastructure/config-store.ts`, import `applyCoreDatabaseSchema` and change `ensureTable()` to:

```ts
private ensureTable(): void {
  applyCoreDatabaseSchema(this.databasePool.getCoreConnection());
}
```

In `src/main/infrastructure/secret-manager.ts`, import `applyCoreDatabaseSchema` and change `ensureTable()` to the same body.

- [ ] **Step 5: Verify Task 3**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/config-store.test.ts tests/main/infrastructure/secret-manager.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS for all listed tests, PASS for typecheck, no diff whitespace errors.

- [ ] **Step 6: Review and commit Task 3**

Review:

```powershell
git diff -- src/main/infrastructure/database-schemas.ts src/main/infrastructure/config-store.ts src/main/infrastructure/secret-manager.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/config-store.test.ts tests/main/infrastructure/secret-manager.test.ts
```

Commit:

```powershell
git add src/main/infrastructure/database-schemas.ts src/main/infrastructure/config-store.ts src/main/infrastructure/secret-manager.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/config-store.test.ts tests/main/infrastructure/secret-manager.test.ts
git commit -m "feat: define target database schemas"
```

## Task 4: Destructive Rebuild Importer

**Files:**
- Create: `src/main/infrastructure/database-rebuild.ts`
- Test: `tests/main/infrastructure/database-rebuild.test.ts`
- Modify: `src/main/kernel/kernel-runtime.ts` only after importer tests pass

**Interfaces:**
- Produces: `rebuildRocDatabases(input: RocDatabaseRebuildInput): RocDatabaseRebuildResult`
- Produces: `createMigrationBackup(input: RocMigrationBackupInput): RocMigrationBackupManifest`
- Consumes: `DatabasePool.getDatabasePath()`
- Consumes: `applyCoreDatabaseSchema`, `applyAgentDatabaseSchema`, `applyMemoryDatabaseSchema`, `applyTaskDatabaseSchema`

- [ ] **Step 1: Write destructive rebuild tests**

Create `tests/main/infrastructure/database-rebuild.test.ts` with fixtures that create old `core.db`, old agent DB, old memory DB, old task DB, old workspace DB, and old diagnostics DB. Test these behaviors:

```ts
it('rebuilds target databases, imports allowed rows, deletes old work databases, and keeps one backup', () => {
  // Arrange old databases with agent rows, memory rows, background task rows, and old task event rows.
  // Act with rebuildRocDatabases({ rootDir, now, backupId }).
  // Assert new agent db has agent_threads/agent_runs/agent_events/session_messages.
  // Assert new memory db has langgraph_store_items.
  // Assert new task db has background_tasks/scheduled_task_runs.
  // Assert new task db does not have task_threads/task_runs/task_events.
  // Assert new workspace db has recovery_points.
  // Assert new diagnostics db has performance_samples and diagnostic_packages.
  // Assert backup directory exists.
});
```

Use concrete assertions:

```ts
expect(agentDb.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_threads'").pluck().get()).toBe('agent_threads');
expect(taskDb.prepare("SELECT name FROM sqlite_master WHERE name = 'task_events'").pluck().get()).toBeUndefined();
expect(taskDb.prepare('SELECT COUNT(*) FROM background_tasks').pluck().get()).toBe(1);
expect(memoryDb.prepare('SELECT COUNT(*) FROM langgraph_store_items').pluck().get()).toBe(1);
expect(workspaceDb.prepare('SELECT COUNT(*) FROM recovery_points').pluck().get()).toBe(1);
expect(diagnosticsDb.prepare('SELECT COUNT(*) FROM performance_samples').pluck().get()).toBe(1);
expect(existsSync(join(root, 'backups', 'migration-pre-20260706'))).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-rebuild.test.ts
```

Expected: FAIL because `database-rebuild.ts` does not exist.

- [ ] **Step 3: Implement rebuild interfaces**

Create `src/main/infrastructure/database-rebuild.ts` with this exported surface:

```ts
export type RocDatabaseRebuildInput = {
  rootDir: string;
  now: () => string;
  backupId: string;
};

export type RocDatabaseRebuildResult = {
  backupDir: string;
  rebuilt: true;
};

export function rebuildRocDatabases(input: RocDatabaseRebuildInput): RocDatabaseRebuildResult {
  // The implementation opens old DB files readonly when they exist, copies them into backupDir,
  // deletes work DB files plus WAL/SHM, creates fresh DB files, applies target schemas,
  // imports allowed data with per-row try/catch at the import boundary, and returns backupDir.
}
```

Implement these internal functions with concrete names for later review:

```ts
function copyExistingDatabaseFiles(input: { rootDir: string; backupDir: string }): void;
function removeWorkDatabaseFiles(rootDir: string): void;
function createFreshTargetDatabases(rootDir: string, now: () => string): OpenedTargetDatabases;
function importAgentRows(input: ImportInput): void;
function importMemoryRows(input: ImportInput): void;
function importTaskRows(input: ImportInput): void;
function closeTargets(targets: OpenedTargetDatabases): void;
```

Boundary rule for row failures:

```ts
for (const row of rows) {
  try {
    statement.run(...mapRow(row));
  } catch {
    continue;
  }
}
```

This `catch` is allowed only in the importer boundary because the spec requires failed records to be discarded without persistent audit.

- [ ] **Step 4: Wire rebuild into kernel startup behind an explicit marker**

Modify `src/main/kernel/kernel-runtime.ts` to call rebuild only when the new schema marker is absent and legacy DB files are present:

```ts
if (this.options.activateMigration !== undefined) {
  await this.options.activateMigration();
}
```

Replace the migration option implementation later with a production bootstrap service; do not add UI prompts in this task.

- [ ] **Step 5: Verify Task 4**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-rebuild.test.ts tests/main/kernel/kernel-runtime.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS for rebuild and kernel runtime tests, PASS for typecheck, no diff whitespace errors.

- [ ] **Step 6: Review and commit Task 4**

Review:

```powershell
git diff -- src/main/infrastructure/database-rebuild.ts src/main/kernel/kernel-runtime.ts tests/main/infrastructure/database-rebuild.test.ts tests/main/kernel/kernel-runtime.test.ts
```

Commit:

```powershell
git add src/main/infrastructure/database-rebuild.ts src/main/kernel/kernel-runtime.ts tests/main/infrastructure/database-rebuild.test.ts tests/main/kernel/kernel-runtime.test.ts
git commit -m "feat: add destructive database rebuild"
```

## Task 5: Runtime Database Boundary Rewire

**Files:**
- Modify: `src/main/kernel/types.ts`
- Modify: `src/main/kernel/kernel-runtime.ts`
- Modify: `src/main/plugins/agent/schema.ts`
- Modify: `src/main/plugins/agent/session-repository.ts`
- Modify: `src/main/plugins/agent/run-event-log.ts`
- Modify: `src/main/plugins/agent/index.ts`
- Modify: `src/main/plugins/memory/schema.ts`
- Modify: `src/main/plugins/memory/index.ts`
- Modify: `src/main/plugins/task/schema.ts`
- Modify: `src/main/plugins/task/task-repository*.ts`
- Create: `src/main/plugins/task/agent-task-history.ts`
- Update related tests under `tests/main/plugins/agent`, `tests/main/plugins/memory`, `tests/main/plugins/task`, and `tests/main/services/deep-agent`

**Interfaces:**
- Produces on plugin context database facade:
  - `getCoreConnection(): Database`
  - `getAgentConnection(): Database`
  - `getMemoryConnection(): Database`
  - `getTaskConnection(): Database`
  - `getConnection(): Database` remains plugin-scoped
- Produces: `AgentTaskHistoryReader` for task repository.

- [ ] **Step 1: Write failing boundary tests**

Update `tests/main/plugins/agent/plugin.test.ts` so the DeepAgent executor creation asserts:

```ts
expect(agentDb.prepare("SELECT name FROM sqlite_master WHERE name = 'langgraph_checkpoints'").pluck().get()).toBe('langgraph_checkpoints');
expect(agentDb.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_tool_effects'").pluck().get()).toBe('agent_tool_effects');
expect(memoryDb.prepare("SELECT name FROM sqlite_master WHERE name = 'langgraph_store_items'").pluck().get()).toBe('langgraph_store_items');
expect(coreDb.prepare("SELECT name FROM sqlite_master WHERE name = 'langgraph_store_items'").pluck().get()).toBeUndefined();
```

Update `tests/main/plugins/task/task-repository.test.ts`:

```ts
expect(columnNames(taskDb, 'background_tasks')).toContain('thread_id');
expect(tableNames(taskDb)).not.toContain('task_threads');
expect(tableNames(taskDb)).not.toContain('task_runs');
expect(tableNames(taskDb)).not.toContain('task_events');
```

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/plugin.test.ts tests/main/plugins/task/task-repository.test.ts
```

Expected: FAIL because current wiring still uses core DB for runtime store and task DB still owns task tables.

- [ ] **Step 3: Extend plugin database facade**

Modify `src/main/kernel/types.ts`:

```ts
readonly database: {
  getConnection(): Database;
  getCoreConnection(): Database;
  getAgentConnection(): Database;
  getMemoryConnection(): Database;
  getTaskConnection(): Database;
};
```

Modify `DatabasePool.createPluginDatabaseFacade()` return object:

```ts
return {
  getConnection: () => this.getConnection(pluginId),
  getCoreConnection: () => this.getCoreConnection(),
  getAgentConnection: () => this.getConnection('@roc/plugin-agent'),
  getMemoryConnection: () => this.getConnection('@roc/plugin-memory'),
  getTaskConnection: () => this.getConnection('@roc/plugin-task')
};
```

- [ ] **Step 4: Apply schemas from plugin initialization**

Change schema files to delegate:

```ts
export function applyAgentPluginSchema(db: DatabaseConnection): void {
  applyAgentDatabaseSchema(db);
}
```

```ts
export function applyMemoryPluginSchema(db: DatabaseConnection): void {
  applyMemoryDatabaseSchema(db);
}
```

```ts
export function applyTaskPluginSchema(db: DatabaseConnection): void {
  applyTaskDatabaseSchema(db);
}
```

- [ ] **Step 5: Rewire agent plugin**

In `src/main/plugins/agent/index.ts`, change executor DB wiring:

```ts
const agentDb = context.database.getAgentConnection();
const memoryDb = context.database.getMemoryConnection();
return createAgentDeepAgentExecutor({
  capabilities: context.capabilities,
  checkpointer: new RocSqliteCheckpointer(agentDb),
  contextArtifactStore: new ContextArtifactStore(agentDb),
  getMemorySettings: option.getMemorySettings,
  hookRuntime: option.hookRuntime,
  metricsService: option.metricsService,
  paths: option.paths,
  store: new RocSqliteStore(memoryDb),
  toolEffectStore: new AgentToolEffectStore(agentDb)
});
```

- [ ] **Step 6: Rename repository SQL to canonical tables**

In `AgentSessionRepository`, replace table names:

- `task_threads` -> `agent_threads`
- `task_runs` -> `agent_runs`
- `task_events` -> `agent_events`

Add `provider_id`, `workspace_path`, `task_source`, and `workflow_hint` only where input contracts already carry them. Keep legacy fields nullable in schema and explicit in insert statements.

- [ ] **Step 7: Add task history bridge**

Create `src/main/plugins/task/agent-task-history.ts`:

```ts
import type { Database as DatabaseConnection } from 'better-sqlite3';

import type { TaskEvent, TaskRun, TaskThread } from '../../../shared/types';

export class AgentTaskHistoryReader {
  constructor(private readonly agentDb: DatabaseConnection) {}

  findActiveThread(threadId: string): TaskThread | null {
    const row = this.agentDb.prepare(
      `SELECT id, kind, title, goal, status, created_at, updated_at
       FROM agent_threads
       WHERE id = ? AND archived_at IS NULL`
    ).get(threadId) as TaskThreadRow | undefined;
    return row === undefined ? null : mapTaskThread(row);
  }

  listRunsForThread(threadId: string, limit: number): TaskRun[] {
    const rows = this.agentDb.prepare(
      `SELECT id, thread_id, run_number, user_input, status, started_at, ended_at, model_id, enabled_capabilities_json
       FROM agent_runs
       WHERE thread_id = ?
       ORDER BY run_number DESC
       LIMIT ?`
    ).all(threadId, limit) as TaskRunRow[];
    return rows.map(mapTaskRun);
  }

  listEventsForThread(threadId: string): TaskEvent[] {
    const rows = this.agentDb.prepare(
      `SELECT id, thread_id, run_id, type, payload_json, created_at
       FROM agent_events
       WHERE thread_id = ?
       ORDER BY sequence ASC, created_at ASC, id ASC`
    ).all(threadId) as TaskEventRow[];
    return rows.map(mapTaskEvent);
  }
}
```

Move or export mapper types from `task-repository-mappers.ts` so this file can map canonical rows without duplicating parsing logic.

- [ ] **Step 8: Rewire task repository constructor**

Change `TaskRepository` constructor to:

```ts
constructor(
  private readonly db: DatabaseConnection,
  private readonly agentHistory: AgentTaskHistoryReader
) {}
```

Use `agentHistory` for thread/run/event reads. Keep writes to `background_tasks` and `scheduled_task_runs` in task DB only.

- [ ] **Step 9: Verify Task 5**

Run:

```powershell
pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/plugins/agent/plugin.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/memory/plugin.test.ts tests/main/services/deep-agent/sqlite-checkpointer.test.ts tests/main/services/deep-agent/tool-effect-store.test.ts tests/main/services/deep-agent/context/context-artifact-store.test.ts
pnpm typecheck
pnpm check:ipc
git diff --check
```

Expected: PASS for listed tests, PASS for typecheck and IPC check, no diff whitespace errors.

- [ ] **Step 10: Review and commit Task 5**

Review:

```powershell
git diff -- src/main/kernel/types.ts src/main/kernel/kernel-runtime.ts src/main/plugins/agent src/main/plugins/memory src/main/plugins/task src/main/services/deep-agent src/main/services/memory tests/main/plugins tests/main/services
```

Commit:

```powershell
git add src/main/kernel/types.ts src/main/kernel/kernel-runtime.ts src/main/plugins/agent src/main/plugins/memory src/main/plugins/task src/main/services/deep-agent src/main/services/memory tests/main/plugins tests/main/services
git commit -m "feat: rewire database ownership boundaries"
```

## Task 6: Runtime Health, Backup, And Restore

**Files:**
- Create: `src/main/infrastructure/database-health.ts`
- Create: `src/main/infrastructure/database-backup.ts`
- Modify: `src/main/kernel/kernel-runtime.ts`
- Test: `tests/main/infrastructure/database-health.test.ts`
- Test: `tests/main/infrastructure/database-backup.test.ts`

**Interfaces:**
- Produces: `checkRocDatabases(input): RocDatabaseHealthReport`
- Produces: `backupRocDatabases(input): RocDatabaseBackupManifest`
- Produces: `restoreRocDatabaseBackup(input): RocDatabaseRestoreResult`

- [ ] **Step 1: Write health and backup tests**

Create tests covering:

```ts
expect(report.status).toBe('healthy');
expect(report.databases.map((item) => item.dbName).sort()).toEqual([
  'agent',
  'core',
  'memory',
  'plugin:@roc/plugin-diagnostics',
  'plugin:@roc/plugin-workspace',
  'task'
]);
expect(report.databases.every((item) => item.quickCheck === 'ok')).toBe(true);
expect(manifest.databases).toHaveLength(6);
expect(existsSync(join(backupDir, 'core.db'))).toBe(true);
expect(existsSync(join(backupDir, '@roc-plugin-workspace.db'))).toBe(true);
expect(existsSync(join(backupDir, '@roc-plugin-diagnostics.db'))).toBe(true);
expect(restoreResult.restored).toBe(true);
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-health.test.ts tests/main/infrastructure/database-backup.test.ts
```

Expected: FAIL because health and backup modules do not exist.

- [ ] **Step 3: Implement health checker**

Create `database-health.ts` with:

```ts
export type RocDatabaseHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export type RocDatabaseHealthItem = {
  dbName: RocLogicalDatabaseName;
  status: RocDatabaseHealthStatus;
  quickCheck: 'ok' | 'failed';
  schemaVersion: number | null;
  detail: string;
};

export type RocDatabaseHealthReport = {
  status: RocDatabaseHealthStatus;
  databases: RocDatabaseHealthItem[];
  checkedAt: string;
};

export function checkRocDatabases(input: {
  rootDir: string;
  now: () => string;
}): RocDatabaseHealthReport;
```

Each DB check runs:

```sql
PRAGMA quick_check;
SELECT current_version FROM schema_metadata WHERE db_name = ?;
```

`quick_check` result must equal `ok`.

- [ ] **Step 4: Implement backup and restore**

Create `database-backup.ts` with:

```ts
export type RocDatabaseBackupManifest = {
  id: string;
  createdAt: string;
  backupDir: string;
  databases: Array<{
    dbName: RocLogicalDatabaseName;
    fileName: string;
    sha256: string;
    schemaVersion: number;
  }>;
};

export function backupRocDatabases(input: {
  rootDir: string;
  backupRootDir: string;
  backupId: string;
  now: () => string;
}): RocDatabaseBackupManifest;

export function restoreRocDatabaseBackup(input: {
  rootDir: string;
  backupDir: string;
}): { restored: true };
```

Use `db.backup(destinationPath)` for opened DBs when a live connection is available. In tests, closed DB files can be copied only after checkpointing; production path uses backup API.

- [ ] **Step 5: Wire startup health**

In `KernelRuntime.start()`, after `DatabasePool` creation and before plugin load:

```ts
const health = checkRocDatabases({
  rootDir: this.options.rootDir,
  now: () => new Date().toISOString()
});
if (health.status === 'unhealthy') {
  throw new Error('database_health_unhealthy');
}
```

- [ ] **Step 6: Verify Task 6**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-health.test.ts tests/main/infrastructure/database-backup.test.ts tests/main/kernel/kernel-runtime.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS for listed tests, PASS for typecheck, no diff whitespace errors.

- [ ] **Step 7: Review and commit Task 6**

Review:

```powershell
git diff -- src/main/infrastructure/database-health.ts src/main/infrastructure/database-backup.ts src/main/kernel/kernel-runtime.ts tests/main/infrastructure/database-health.test.ts tests/main/infrastructure/database-backup.test.ts tests/main/kernel/kernel-runtime.test.ts
```

Commit:

```powershell
git add src/main/infrastructure/database-health.ts src/main/infrastructure/database-backup.ts src/main/kernel/kernel-runtime.ts tests/main/infrastructure/database-health.test.ts tests/main/infrastructure/database-backup.test.ts tests/main/kernel/kernel-runtime.test.ts
git commit -m "feat: add database health and backup services"
```

## Task 7: Retention And Compaction

**Files:**
- Create: `src/main/infrastructure/database-retention.ts`
- Test: `tests/main/infrastructure/database-retention.test.ts`
- Modify: plugin initialization only if a scheduled cleanup hook is needed.

**Interfaces:**
- Produces: `runDatabaseRetention(input): RocDatabaseRetentionResult`

- [ ] **Step 1: Write retention tests**

Create tests asserting:

```ts
expect(result.deleted.agentRunEvents).toBe(1);
expect(agentDb.prepare("SELECT COUNT(*) FROM agent_runs WHERE status = 'running'").pluck().get()).toBe(1);
expect(agentDb.prepare("SELECT COUNT(*) FROM agent_pending_interrupts").pluck().get()).toBe(1);
expect(agentDb.prepare("SELECT COUNT(*) FROM langgraph_checkpoints WHERE thread_id = 'active_thread'").pluck().get()).toBe(3);
```

Use fixture data with terminal old runs, active runs, recovering runs, waiting user interrupts, checkpoints, checkpoint writes, tool effects, context artifacts, and memory audit rows.

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-retention.test.ts
```

Expected: FAIL because `database-retention.ts` does not exist.

- [ ] **Step 3: Implement retention service**

Create exported types:

```ts
export type RocDatabaseRetentionPolicy = {
  terminalRunRetentionDays: number;
  maxCheckpointsPerThread: number;
  autoMemoryAuditRetentionDays: number;
};

export type RocDatabaseRetentionResult = {
  deleted: {
    agentEvents: number;
    agentRunEvents: number;
    checkpoints: number;
    checkpointWrites: number;
    toolEffects: number;
    contextArtifacts: number;
    memoryAudit: number;
  };
};

export function runDatabaseRetention(input: {
  agentDb: DatabaseConnection;
  memoryDb: DatabaseConnection;
  policy: RocDatabaseRetentionPolicy;
  now: Date;
}): RocDatabaseRetentionResult;
```

Deletion guards:

```sql
status NOT IN ('running','recovering','waiting_user')
```

Never delete rows for runs present in `agent_pending_interrupts`.

- [ ] **Step 4: Verify Task 7**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-retention.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS for retention tests, PASS for typecheck, no diff whitespace errors.

- [ ] **Step 5: Review and commit Task 7**

Review:

```powershell
git diff -- src/main/infrastructure/database-retention.ts tests/main/infrastructure/database-retention.test.ts
```

Commit:

```powershell
git add src/main/infrastructure/database-retention.ts tests/main/infrastructure/database-retention.test.ts
git commit -m "feat: add database retention cleanup"
```

## Task 8: Query Plan And FTS Performance Verification

**Files:**
- Create: `src/main/infrastructure/query-plan.ts`
- Test: `tests/main/infrastructure/query-plan.test.ts`
- Update schema indexes if a test proves a scan on a hot path.

**Interfaces:**
- Produces: `explainQueryPlan(db, sql, params): QueryPlanRow[]`
- Produces: `assertUsesIndex(plan, indexName)`

- [ ] **Step 1: Write query plan tests**

Create `tests/main/infrastructure/query-plan.test.ts` asserting these hot paths use indexes:

```ts
assertUsesIndex(
  explainQueryPlan(agentDb, 'SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY run_number DESC LIMIT ?', ['thread_1', 20]),
  'idx_agent_runs_thread_run_number'
);

assertUsesIndex(
  explainQueryPlan(taskDb, 'SELECT * FROM scheduled_task_runs WHERE background_task_id = ? ORDER BY scheduled_at DESC LIMIT ?', ['task_1', 20]),
  'idx_task_plugin_scheduled_task_runs_task_status'
);
```

Add an FTS rebuild check:

```ts
agentDb.prepare("INSERT INTO agent_threads (id, kind, title, goal, status, created_at, updated_at) VALUES ('thread_1','chat','title','goal','completed','2026-07-06','2026-07-06')").run();
agentDb.prepare("INSERT INTO session_messages (id, thread_id, role, content, phase, created_at) VALUES ('smsg_1','thread_1','assistant','payment-service evidence','visible','2026-07-06')").run();
expect(agentDb.prepare("SELECT COUNT(*) FROM session_messages_fts WHERE session_messages_fts MATCH 'payment'").pluck().get()).toBe(1);
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
pnpm test -- tests/main/infrastructure/query-plan.test.ts
```

Expected: FAIL because `query-plan.ts` does not exist.

- [ ] **Step 3: Implement query plan helper**

Create `src/main/infrastructure/query-plan.ts`:

```ts
import type { Database as DatabaseConnection } from 'better-sqlite3';

export type QueryPlanRow = {
  id: number;
  parent: number;
  notused: number;
  detail: string;
};

export function explainQueryPlan(db: DatabaseConnection, sql: string, params: readonly unknown[] = []): QueryPlanRow[] {
  if (sql.trim().length === 0) {
    throw new Error('query_plan_sql_empty');
  }
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as QueryPlanRow[];
}

export function assertUsesIndex(plan: readonly QueryPlanRow[], indexName: string): void {
  if (indexName.trim().length === 0) {
    throw new Error('query_plan_index_empty');
  }
  if (!plan.some((row) => row.detail.includes(indexName))) {
    throw new Error(`query_plan_index_not_used:${indexName}`);
  }
}
```

- [ ] **Step 4: Fix indexes proven missing by tests**

If a hot path test fails because the plan does not include the expected index, update `database-schemas.ts` migration SQL and, because checksum drift is expected during implementation before release, update tests to initialize fresh in-memory DBs.

- [ ] **Step 5: Verify Task 8**

Run:

```powershell
pnpm test -- tests/main/infrastructure/query-plan.test.ts tests/main/infrastructure/database-schemas.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS for query plan and schema tests, PASS for typecheck, no diff whitespace errors.

- [ ] **Step 6: Review and commit Task 8**

Review:

```powershell
git diff -- src/main/infrastructure/query-plan.ts src/main/infrastructure/database-schemas.ts tests/main/infrastructure/query-plan.test.ts tests/main/infrastructure/database-schemas.test.ts
```

Commit:

```powershell
git add src/main/infrastructure/query-plan.ts src/main/infrastructure/database-schemas.ts tests/main/infrastructure/query-plan.test.ts tests/main/infrastructure/database-schemas.test.ts
git commit -m "test: verify database query plans"
```

## Task 9: Legacy Cleanup And Final Production Audit

**Files:**
- Delete old task schema tests or rewrite them to target new task DB behavior.
- Delete private `apply*Schema()` table creation code that duplicates migration-managed schemas.
- Update docs if a path or command changed.
- Test: existing focused suites and full verification commands.

**Interfaces:**
- Consumes all prior tasks.
- Produces clean worktree with no stale old schema runtime writes.

- [ ] **Step 1: Search for stale old schema names**

Run:

```powershell
rg -n "task_threads|task_runs|task_events|getCoreConnection\\(\\).*RocSqliteStore|new RocSqliteCheckpointer\\(coreDb\\)|new AgentToolEffectStore\\(coreDb\\)|CREATE TABLE IF NOT EXISTS langgraph_store_items|PRAGMA table_info" src tests docs
```

Expected allowed hits:

- The new plan/spec docs.
- Migration importer tests proving old task tables are not migrated.
- No runtime writes in `src/main/plugins/task`.
- No core DB LangGraph runtime wiring in `src/main/plugins/agent/index.ts`.

- [ ] **Step 2: Remove stale code with evidence**

Delete or rewrite only hits contradicted by the expected allowed list. Keep tests that prove old data is rejected or not migrated.

- [ ] **Step 3: Run focused verification**

Run:

```powershell
pnpm test -- tests/main/infrastructure/database-pragmas.test.ts tests/main/infrastructure/database-migrations.test.ts tests/main/infrastructure/database-schemas.test.ts tests/main/infrastructure/database-rebuild.test.ts tests/main/infrastructure/database-health.test.ts tests/main/infrastructure/database-backup.test.ts tests/main/infrastructure/database-retention.test.ts tests/main/infrastructure/query-plan.test.ts
pnpm test -- tests/main/plugins/agent/session-repository.test.ts tests/main/plugins/agent/plugin.test.ts tests/main/plugins/task/task-repository.test.ts tests/main/plugins/task/plugin.test.ts tests/main/plugins/memory/plugin.test.ts
pnpm typecheck
pnpm check:ipc
git diff --check
```

Expected: all commands pass.

- [ ] **Step 4: Run strict unused scan**

Run:

```powershell
pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters
```

Expected: command exits `0`.

- [ ] **Step 5: Run full test and build verification**

Run:

```powershell
pnpm test
pnpm build
```

Expected: both commands exit `0`. If `node-pty` emits `AttachConsole failed` while command exit code is `0`, treat it as known teardown noise and record it in final evidence.

- [ ] **Step 6: Review final diff**

Run:

```powershell
git diff --stat
git diff --check
git status --short --branch
```

Expected: diff contains only database production work, no whitespace errors, branch is `main`.

- [ ] **Step 7: Commit cleanup and audit**

Commit:

```powershell
git add src tests docs
git commit -m "chore: complete database production cleanup"
```

## Completion Audit

Before marking the overall goal complete, prove each requirement with current evidence:

- Spec document exists and is committed.
- Plan document exists and is committed.
- Every implementation task has a commit.
- Runtime canonical model has only one session/run/event source.
- `core.db` no longer owns agent runtime or memory store business data.
- `agent.db` owns checkpoints, checkpoint writes, tool effects, context artifacts, sessions, FTS, and run events.
- `memory.db` owns `langgraph_store_items`, memory events, and auto memory audit.
- `task.db` owns only background task and scheduled run projections.
- Destructive rebuild preserves one pre-migration backup and does not persist migration reports or summaries.
- Failed import records are discarded at importer boundary.
- Versioned migrations exist for all managed DBs.
- Startup health checks and backup/restore tests exist and pass.
- Retention tests prove active/recovering/waiting_user rows are protected.
- Query plan tests prove hot paths use indexes.
- Stale old schema runtime paths are removed or documented as test fixtures.
- `pnpm typecheck`, `pnpm check:ipc`, strict unused scan, `pnpm test`, `pnpm build`, and `git diff --check` pass.

## Plan Self-Review

- Spec coverage: all spec sections map to tasks: connection policy Task 1, migrations Task 2, target schemas Task 3, destructive rebuild Task 4, runtime wiring Task 5, health/backup/restore Task 6, retention Task 7, performance Task 8, cleanup/final audit Task 9.
- Placeholder scan: no unresolved planning markers remain.
- Type consistency: database logical names use `RocLogicalDatabaseName`; migration functions use `DatabaseConnection`; plugin facade names match the names used by agent, memory, task, workspace, and diagnostics tasks.
