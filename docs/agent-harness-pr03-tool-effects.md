# Roc Agent Harness PR-03 Tool Effects and Recovery

Status: PR-03 implementation and deterministic validation complete. This report describes the durable operation boundary and its limits; it does not claim a transaction with remote providers.

## Operation identity and lease

Each persisted operation has identity version 1 and canonicalization version `roc-json-sort-v1`. The parameter hash covers the tool name and normalized arguments. The operation ID additionally binds the run, thread, execution path, checkpoint, tool-call ID, canonical manifest tool identity, and manifest tool version. Its idempotency key is `roc-tool-effect-v1:<operationId>`. Object keys are sorted by code point; undefined object properties are omitted, undefined array entries become null, and other unsupported non-JSON values are rejected.

`AgentToolEffectStore.beginOperation()` atomically creates or acquires an attempt lease, or returns the completed ToolMessage for replay. Each attempt has a fresh attempt ID and increasing lease generation. All start, receipt, success, error, and reconciliation transitions compare the stored identity and lease generation, so an older worker cannot complete a retried operation. Parameter or identity drift is rejected. Completed results are replayed only for the same persisted operation identity.

The durable state distinguishes reserved, in-progress, succeeded, retryable failure, final failure, and unknown. Restart recovery maps reserved operations to retryable because dispatch had not started; interrupted in-progress and ambiguous manual-confirmation failures become unknown. The order of these updates is covered by Harness Eval. Explicit reconciliation requires the operation identity and expected lease generation, validates the receipt shape and evidence-hash format, stores the supplied reference and hash, appends reconciliation history, and either records an applied result for replay or marks a proven not-applied operation retryable. The store records the evidence reference and hash; it does not independently retrieve or verify the referenced external evidence.

Database migration v9 adds operation identity, attempt and lease-generation fields, receipts, expected/result hashes, and reconciliation metadata. Legacy reserved operations become retryable; legacy in-progress and manual-confirmation retryable operations become unknown. Restore from an older database introspects available columns, clears old attempt ownership, advances the generation, preserves reconciliation history, and applies the same conservative status mapping. Retention and explicit thread/run deletion preserve reserved, in-progress, and unknown operations; deletion is allowed after successful or explicitly resolved outcomes.

## Capability and tool calls

`createToolEffectIdempotencyMiddleware` freezes the identity from the run execution path and capability manifest, reserves and starts the lease before invoking the tool handler, and runs the handler inside an internal `AsyncLocalStorage` context. `CapabilityRegistry.invoke<TInput,TOutput>(name:string,input:TInput):Promise<TOutput>` keeps its public arguments unchanged. It passes an optional main-process-only context to registered handlers, recording `request_sent` before handler execution. Successful ToolMessages are persisted for replay. Ambiguous manual-confirmation outcomes remain unknown and are not automatically retried.

The generated idempotency key is available to trusted handlers, but current workspace, research, and MCP adapters do not provide a generic way to pass or verify it with every remote provider. This change does not claim that external providers honor the key, support receipt lookup, or participate in a SQLite transaction. Unsupported or ambiguous remote outcomes require reconciliation. External services and their descendants remain a separate trust boundary.

## Workspace file writes

`AtomicFilesystemBackend.write()` and `edit()` serialize same-path writes within this process. They capture the expected content hash, stage in the same directory, fsync staged bytes, revalidate the root and parent, reopen the target without following a final symlink, and compare its hash immediately before same-directory rename. Each prepared, published, and durable phase updates a monotonically numbered latest-receipt snapshot with expected and result hashes; the operation row keeps the latest snapshot and sequence, not the full phase history. Publication is marked in memory immediately after rename so later receipt or directory-fsync failures remain unknown. `edit()` carries the original version through publication.

This is an application-level version check with a process-local path lock; portable Node rename does not provide a cross-process compare-and-swap primitive. The separate `delete_file` capability calls `FileService.deleteFile()` directly and has no expected-hash delete receipt. Its operation uses manual-confirmation recovery, so an interrupted or ambiguous deletion remains unknown and cannot be retried blindly.

## Evidence

Measured on the same macOS 27.0.1 (Build 26A434), Darwin 27.0.0 arm64, Node v26.12.1 and pnpm 12.5.1 environment recorded for PR-01/02. The harness uses deterministic fixtures; it is not a real-provider reliability or idempotency test.

| Check | Result |
| --- | --- |
| Operation store and identity tests | Pass, 5/5 |
| Capability operation-context tests | Pass, 2/2 |
| Migration tests | Pass, 10/10 |
| Retention tests | Pass, 7/7 |
| Atomic filesystem tests | Pass, 4/4 |
| Full unit suite (`pnpm test:unit`) | Pass, 514/514 |
| Renderer suite (`pnpm test:renderer`) | Pass, 31/31 |
| TypeScript (`pnpm typecheck`) | Pass |
| IPC generated-file check (`pnpm check:ipc`) | Pass |
| Production build (`pnpm build`) | Pass |
| Renderer chunk check (`pnpm check:renderer-chunks`) | Pass, 1,130,127 eager JS bytes across 6 files |
| Deterministic harness (`pnpm harness:eval`) | Pass, 93/93 fixture cases |
| Changed-path LSP errors | 0 across 11 paths; 9 confirmed clean, 2 servers silent on clean files |
| Diff whitespace check (`git diff --check`) | Pass |

Harness report: `.artifacts/harness-eval/2026-10-30T06-18-57.825Z-10863/report.json` (local generated artifact, not committed). The restart cases prove reserved-but-not-dispatched operations remain retryable, while interrupted manual-confirmation effects become unknown and are not automatically repeated.

Warning-level LSP review found 44 advisories on 4 paths, mostly extensionless imports and existing Harness Eval style. The nullable/undefined read guard in restore remains necessary because pre-v9 database rows do not contain the new columns.

## Review boundary

The deterministic tests establish local SQLite lease fencing, replay, conservative migration/restore, retention guards, capability-context propagation, and workspace write conflict handling for the tested paths. They do not establish exactly-once behavior across a database and remote service, generic provider idempotency, cross-process filesystem CAS, or expected-version deletion. In each unsupported ambiguous case, the operation remains unknown for explicit reconciliation instead of being blindly retried.
