# Microkernel Migration Evidence

## Scope

This dry run covers the Phase 6 Windows release candidate path for moving existing Roc data from the monolith database into `plugin-data`. It does not publish installers, configure auto-update, enable signing, or modify release credentials.

## Paths

- Source database path: `%APPDATA%\Roc\data\roc.db` for the installed Windows app, or `<ROC_DATA_ROOT>\data\roc.db` when `ROC_DATA_ROOT` is set during smoke or local validation.
- Backup path: `<source database path>.phase1-backup-<timestamp>`, created before table copy starts.
- Target plugin data path: `%APPDATA%\Roc\plugin-data` for the installed Windows app, or `<ROC_DATA_ROOT>\plugin-data` when `ROC_DATA_ROOT` is set.
- Staging path: `<source database directory>\plugin-data-next`, removed before each migration attempt and promoted to `plugin-data` only after completion marker creation.

## Completion Marker

The migration is complete only when `<plugin-data>\.migration-complete.json` exists with these fields:

- `sourceDatabasePath`: absolute path of the source monolith database, or `null` for a fresh profile without a source database.
- `sourceChecksum`: SHA-256 checksum of the source database before migration, or `null` for a fresh profile without a source database.
- `pluginDatabaseChecksums`: plugin-id keyed table checksum evidence.
- `completedAt`: ISO timestamp written after plugin databases are populated.

## Required Evidence

Capture this evidence for the release candidate:

- Source database path used for the dry run.
- Backup path created by the migration.
- Target plugin data path.
- Full `.migration-complete.json` path.
- Row count and checksum evidence from `pluginDatabaseChecksums` for each migrated plugin table.
- `migration_runs` row count from `<plugin-data>\data\core.db`.
- `pnpm test -- tests/main/migration/runtime-activation.test.ts` output.

## Rollback Evidence

Rollback uses the backup database copy created before migration. Keep the backup path with the release candidate evidence so the owner can restore the previous data layout if the candidate is rejected.
