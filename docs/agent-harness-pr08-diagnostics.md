# PR-08: Local Trace, Context Contracts and Run Diagnostics

## Scope

Continue the PR-08 handoff on top of PR-07 commit
`58184a002969aec29a90248eda52cd2ecb10e0ce`. Implement local, bounded diagnostics
and deterministic long-task regression coverage. PR-06 L2/L3 remains blocked:
no isolated provider credential and finite approved spend were supplied.
This work does not authorize a live-model experiment or production release.

## Trace and Privacy Contract

- Telemetry remains local in `agent_run_telemetry`; no exporter or upload is added.
- The strict v1 envelope adds defaulted trace, audit and unknown-usage fields so
  existing rows remain readable. Unknown fields and identity drift are rejected.
- Keep at most 256 spans per run. Keep the first spans and count later dropped
  spans explicitly; aggregate usage and admission measurements continue.
- Span operations cover run, agent model, summary model, compaction, summary
  stage, tool effect, tool admission, approval wait, subagent, recovery and
  checkpoint resume. Store generated aliases, parent relationships, relative
  durations, allowlisted statuses, estimates and nullable actual usage.
- Original tool/interrupt identities are process-only hash keys, never persisted
  span fields. Correlation maps are bounded. After restart, anonymous approval
  waits cannot establish which original approval completed; mark them interrupted
  instead of inventing that association.
- Context-cycle IDs are generated UUIDs. AsyncLocalStorage links simultaneous
  summary calls to their compaction span without mixing concurrent cycles.
- No raw prompt, tool name, arguments, provider error body, path, document content,
  artifact content or arbitrary event payload enters spans or the diagnostics API.
  Existing budget/effect/event stores retain their separate pre-existing contracts.
- Persist telemetry on lifecycle events, not each streaming text delta. Identity
  checks and terminal transactions fence late callbacks from overwriting final
  records. A crash can still lose the in-flight portion before its next lifecycle
  write; model observations describe settled/failed calls, not provider-side proof
  of an unfinished call.
- Prune completed/failed/cancelled telemetry after 30 days from its last update,
  on startup and reads. Preserve active/interrupted records and corrupt records
  pending explicit corruption handling. Run/thread deletion also removes telemetry
  through the existing foreign-key contract; unresolved effects still block
  destructive history deletion.

## Context and Usage Contract

`pinContextContractWithAudit()` preserves user constraints, acceptance IDs and
descriptions, pending effects/approvals, correction identity/content, valid
artifact locators and workspace-version history independently of lossy summaries.
The audit reports counts only, including historical requirements and valid
locators lost at capacity.

Bounds: 128 moved user constraints, 20 acceptance conditions, 128 pending
effects/approvals, 32 corrections, 32 evidence locators and 8 workspace versions.
Critical requirement or evidence loss stops compaction with
`context_contract_required_data_lost`. This remains a non-retryable system/context
failure, not a provider failure. Corrupt contract/locator data is excluded and
counted; locator formatting alone does not prove the underlying evidence.
Artifact reads continue checking scope and the content hash.

The compaction middleware now passes its budget observer into summary calls,
closing the previous summary override's accounting gap. Agent requests estimate
message plus system/tool overhead; summary requests estimate their message and
schema input. Provider framing remains approximate. Record actual usage when
valid; record unknown usage separately, never as zero. Aggregate token values
are known subtotals when any call lacks usage, and summary calls are included
without double-counting the event-stream usage projection.

## Diagnostics Surface

`agent.run.diagnostics.get` / `window.roc.agent.getRunDiagnostics({runId,threadId})`
is a separate, strict read capability. It checks run/thread identity and the
frozen snapshot for both live and persisted records. It does not put full
telemetry into event replay.

The existing AssistantPanel header exposes the current or locally known recent
run. The disclosure fetches only when opened, refreshed or its lifecycle changes.
Thread changes clear data; stale responses and identity mismatches never render.
Keyboard disclosure/refresh, focus, light/dark tokens, bounded scrolling and the
existing drawer layout remain intact. No second shell, route or localStorage
state is added. Opening arbitrary historical runs is outside this surface.

## Fixed Long Tasks

Reuse the two frozen PR-06 pilot `long-memory` tasks, source snapshots, task hashes
and independent output validators. Compare the actual compaction pipeline against
an uncompressed fixture and run both lossy/poisoned-summary and recoverable-summary
failure variants. Completion here is an oracle over retained requirements, not
an LLM result.

| Task | Baseline estimate | Lossy summary estimate | Failure fallback estimate | Valid citations | Artifact reads / intentional repeats |
| --- | ---: | ---: | ---: | ---: | ---: |
| Release constraints | 32,918 | 3,310 | 3,267 | 1/1 | 4 / 2 |
| Study boundaries | 34,438 | 3,237 | 3,194 | 2/2 | 6 / 3 |

Each variant retains 7 user constraints, acceptance text, pending effect/approval,
the correction and workspace version. Missing/invalid audit counts are zero.
The uncompressed fixture exceeds the 4,000-input-token test cap and cannot be
dispatched; candidates fit that cap. Each candidate uses one fixture summary.
Protected-only overflow is denied without a summary call.

Counts use a UTF-16 character-based fixture estimate, not provider usage. Real
model/external calls are zero; actual provider tokens and cost are unknown.
The artifact read repetitions deliberately test recovery and do not demonstrate
an artifact-read efficiency improvement over the inline baseline.
Two pilot tasks cannot establish production quality, provider margins, token
savings, latency or cost improvement. L2/L3 release evidence is still required.

## Verification

All commands run from `/Users/Apple_501/Desktop/Roc/Roc`.
Host: macOS 27.0.1 (26A434), Darwin 27.0.0 arm64; Node 26.12.1, pnpm 12.5.1;
Electron 45.0.0 / Chromium 156.0.8078.48.

Status: `Verified passing` for PR-08 local implementation and L1 checks.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm check:ipc` | Pass; generated bindings current |
| `pnpm test:unit` | 571/571 |
| `pnpm test:renderer` | 37/37 |
| `pnpm harness:eval` | 94/94 |
| `pnpm build` | Pass; exercised main/preload/renderer build |
| `pnpm check:renderer-chunks` | Pass; 1,130,226 eager JS bytes / 6 files |
| `node scripts/verify-pr08-diagnostics.mjs` | 19/19 |
| `node --test tests/unit/context-compaction-pipeline.test.mjs tests/unit/context-contract-audit.test.mjs` | 15/15 |
| `git diff --check` | Pass |

Final harness report:
`.artifacts/harness-eval/2026-10-30T17-14-40.097Z-18964/report.json`.
The two context case directories contain `fixed-long-task-comparison.json` with
task/dataset hashes, audit counts, estimates, citation checks and read counts.

Evidence logs live in `.artifacts/pr08-verification/`. The full-app UI gate uses
one loopback scripted-provider request, an isolated temporary data root and zero
live provider calls. It tests disclosure by Enter, trace/state rendering,
wrong-thread IPC denial, hover/focus, themes and a real 980px assistant drawer.
The test temporarily lowers the native window minimum; the production minimum
is unchanged. Screenshots and four zero-cut clip audits live in
`.artifacts/pr08-diagnostics/`.

SQLite and unit tests cover legacy defaults, privacy/allowlist rejection,
capacity, cancellation, context/recovery/checkpoint durations, concurrent summary
correlation, live-write identity/terminal fencing, retention and thread deletion.
A 140-requirement regression loses 11 at the configured bound and is denied
without a completed event or history flush.

## Remaining Release Gate

PR-08 local implementation and L1 regression work can be committed separately.
PR-06 L2/L3, the 200-task target, independently reviewed held-out samples, blind
review and protected live-provider/pilot evidence are not complete. Do not turn
these deterministic results into a model-quality or release claim. Resume that
gate only with an isolated credential, finite approved spend and explicit pilot
authorization where applicable.
