# Release Candidate Rollback

## Manual Procedure

Rollback is manual. It does not happen automatically.

1. Close Roc.
2. Restore the backup database created by migration to the original source database path.
3. Remove the `plugin-data` directory from the Roc data root.
4. Restart the previous Roc version.

## Evidence To Keep

- Original source database path.
- Backup database path.
- Removed `plugin-data` path.
- Previous Roc version restarted after rollback.
