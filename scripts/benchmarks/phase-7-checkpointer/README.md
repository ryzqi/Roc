# Phase 7 Checkpointer Prototype

This isolated package compares the pinned Roc checkpointer with `@langchain/langgraph-checkpoint-sqlite@1.1.0`. The candidate's SQLite driver version `12.10.0` is development-only and is not a root application dependency.

Run `npm install` once from this directory, then `npm test`. The suite imports Roc's current TypeScript checkpointer, migrations, and tool-effect middleware from the repository. It creates disposable databases and process logs under the ignored `.runtime` directory.

The contracts cover namespace and write behavior, metadata filtering, transaction rollback, Roc schema migration compatibility, retention/integrity, SQLite backup restore, interrupt recovery after a true process restart, SIGKILL during `putWrites`, RunControl drain, AbortSignal cancellation, and replay of a completed tool side effect through the real middleware after process restart. A dedicated Electron Node-mode probe intentionally asserts the candidate native module's current ABI mismatch: Node v26 builds ABI 147 while Electron 45's Node v24 requires ABI 150. This probe is an expected no-go result, so the overall `npm test` command still passes.

The candidate replay probe skips Roc's schema validator only when reopening the candidate database, solely to isolate effect-ledger replay behavior; a separate test proves candidate-created tables make normal `applyDatabaseMigrations()` fail with `database_schema_rebuild_required`. A passing base-saver comparison does not authorize migration. The production gate also requires data conversion, backup rollback, retention, and native packaging to work together.
