# SQLite checkpointer compatibility decision

## Decision

**No-go for replacing `RocSqliteCheckpointer` with the official SQLite saver. Keep the current runtime.** The saver reads a copied Roc database after a one-way data copy, but the required Roc facades do not follow writes in the official schema, and the dependency resolution adds a second `better-sqlite3` version.

No production code or dependency changed for this evaluation.

## Versions and schema

The evaluated package is `@langchain/langgraph-checkpoint-sqlite@1.1.0` (npm metadata retrieved 2026-10-27). It depends on `better-sqlite3 ^12.10.0`; Roc pins `better-sqlite3 13.0.3`. From `.planning/2026-10-27-roc-architecture-repair-plan/pr9-prototype/dependency-simulation/`, run:

```sh
rtk proxy pnpm install --lockfile-only --ignore-scripts --ignore-workspace --lockfile-dir .
```

The command completed with pnpm 12.5.1 and resolved both `better-sqlite3@12.11.1` and `better-sqlite3@13.0.3`. The resulting lockfile is `.planning/2026-10-27-roc-architecture-repair-plan/pr9-prototype/dependency-simulation/pnpm-lock.yaml`.

The official saver creates `checkpoints` and `writes`. Roc currently uses `langgraph_checkpoints` and `langgraph_checkpoint_writes`. The official checkpoint row has one serializer `type` for both checkpoint and metadata and no `created_at`; Roc stores separate checkpoint and metadata types and a timestamp. The official writes table also has no timestamp. The prototype only copied rows whose checkpoint and metadata serializer types matched.

## Copy-only prototype

The prototype created a database with Roc's current migrations, wrote three checkpoints and four pending writes, made a SQLite backup copy, initialized the official schema on that copy, and copied the rows into the official tables. It then exercised the official saver against that copy. It did not alter a project database.

Run from the repository root:

```sh
rtk proxy node .planning/2026-10-27-roc-architecture-repair-plan/pr9-prototype/prototype.mjs
```

The script, downloaded package files, dependency-resolution lockfile, and disposable databases are local ignored artifacts under `.planning/2026-10-27-roc-architecture-repair-plan/pr9-prototype/`.

The passing run created the candidate database and official-format backup in `.planning/2026-10-27-roc-architecture-repair-plan/pr9-prototype/run-A55cT1/`.

| Gate | Result | Evidence and limit |
| --- | --- | --- |
| Migration and read | Pass for the fixture | Copied 3 checkpoints and 4 writes; official saver read checkpoint values, metadata, and parent id. The fixture required matching checkpoint/metadata serializer types. |
| Pending-write order and interrupt payload | Pass for the fixture | Returned task writes by `(task_path, task_id, idx)` and decoded `__interrupt__`. Full graph resume was not run. |
| Parallel task writes | Pass for the fixture | Eight concurrent tasks each wrote two values without lost rows. |
| Subgraph namespace isolation | Pass for the fixture | Root and `child:agent` checkpoints remained independently addressable; root listing excluded the child namespace. |
| Crash and restart | Pass after committed writes | A child process was killed with `SIGKILL` after checkpoint and pending-write calls committed; reopening recovered both. A crash during an in-flight SQLite transaction was not simulated. |
| SQLite backup and reopen | Pass for the official saver | An official-format backup reopened and returned checkpoint data. |
| Roc retention facade | **Fail** | `deleteExcessCheckpoints()` only queries `langgraph_checkpoints`; an official-only checkpoint is unaffected. Official schema also lacks `created_at`. |
| Roc interrupt projection | **Fail** | `readPendingInterrupts()` only queries Roc tables and returned no interrupt for a thread written only by the official saver. |
| Roc restore facade | **Fail** | `restoreFrom()` copies only Roc table names; an official-only checkpoint was absent after restore. |
| Duplicate saver writes | Pass for an ordinary write key | Repeating the same task/path/index did not add a row. External tool side effects and full resume idempotency were not exercised. |
| Native dependency and packaging | **Fail** | The resolved graph contains both SQLite binding versions. Packaging against supported macOS architectures was not run. |

These failures cross the plan's replacement gate. The table-name mismatch also affects the database fast probe: its required-table list names the Roc tables, so leaving those empty tables beside official tables would make the probe report schema presence without measuring official checkpoint data.

## Current runtime contract coverage

The published npm tarball contains no contract-test files, so keep the existing project-side checks for the upstream saver semantics. In particular, [checkpoint-write-order.test.mjs](../tests/unit/checkpoint-write-order.test.mjs) pins pending-write sorting, task paths, special interrupt writes, namespace-scoped integrity, and legacy restore behavior. It passes 8/8 with `rtk proxy node --test tests/unit/checkpoint-write-order.test.mjs`. These checks remain the constraint on the current implementation while the replacement is deferred.

Reconsider the switch only after the retention, interrupt projection, backup/restore, diagnostics, serializer migration, and native packaging gates have been adapted and pass against the official schema, followed by full interrupt/resume and duplicate-side-effect coverage.
