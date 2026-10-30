# Roc Agent Harness PR-02 Budget and Usage

Status: PR-02 implementation and deterministic validation complete. This report describes the persisted budget boundary and its current coverage; it is not a real-provider cost guarantee.

## Budget policy

A new Run freezes policy version 1 and pricing catalog version `roc-pricing-2026-10-29-v1` into snapshot schema v9. Defaults are 100 model calls, 500 tool calls, 8 child tasks, concurrency of 4 model calls, 4 tool calls and 2 child tasks, and a 30-minute deadline. The context window is taken from the selected model, with a 500,000-token fallback when unavailable. The provider output cap is the minimum of the configured lower cap, 16,384 tokens, and one quarter of the context window.

Each model attempt reserves `contextWindowTokens + max(128, ceil(contextWindowTokens * 5%)) + maxOutputTokens` in an immediate SQLite transaction before entering the provider handler. The default total-token allowance is four such reservations, matching maximum model concurrency. Actual provider usage is settled only when input, output and total token counts are valid and consistent. Missing usage, errors with uncertain consumption and process interruption retain the full reservation as unknown; startup reconciliation changes pending reservations to unknown. Every model invocation, including retries, gets its own durable call id. Subagents and context summaries use the same root ledger.

The model factory enforces the same output maximum recorded in the snapshot. LangChain `wrapModelCall` performs reservation outside callback hooks; LangChain may log and swallow a callback exception, so callbacks do not enforce budget. Direct structured and fallback summary invokes use the same explicit reserve/invoke/settle wrapper. Subagents, background-task Runs and context summaries share their enclosing Run's ledger; an independently scheduled background Run is its own root.

## Cost and display

The versioned pricing catalog is intentionally empty. Provider aliases are mutable and custom endpoints do not provide a verifiable rate identity. Token-only runs therefore display cost as unknown, never zero. A configured dollar cap fails closed when the exact model price or usage cannot be verified. Costs are stored and compared as integer microdollars. Usage with malformed cache counts or inconsistent totals is unknown.

The persisted `run_budget` event carries known, unknown, reserved and remaining tokens, model/tool/child call counts, cost status, pricing version, deadline and stop reason. Replay restores the latest snapshot. The assistant header displays the compact budget state. The renderer receives no secrets or raw prompt content from the ledger.

## Snapshot and database migration

Database migration v8 adds reservation/settlement microdollar fields, pricing version and the first durable budget stop reason. Snapshot schema v9 stores finite policy values. Legacy v7/v8 snapshots migrate to the tighter of their prior finite allowance and the current finite policy; existing workspace identity is preserved. A v7/v8 snapshot with a workspace but no trustworthy workspace identity is refused rather than issued an execution grant. The grant broker and session repository both validate the current and supported legacy snapshot versions.

## Research execution boundary

Research workflow stages use separate persisted `research_run_<UUID>` identities and can also be started through renderer-accessible IPC. That IPC does not accept a trusted parent Run id. Therefore a renderer-supplied parent id is not used to charge research model calls to the originating chat Run. Research stages remain a separate execution domain with their existing `maxSteps` range 2–100 (default 30), timeout range 1,000–600,000 ms (default 180,000 ms), and the provider-enforced per-call output cap described above. The deterministic agent budget ledger does not claim aggregate token accounting or cost attribution for research-stage model calls; their cost remains unknown. Establishing shared accounting would require a main-process-validated parent capability and is outside this PR-02 change.

External MCP servers and their descendants remain a separate trust boundary, as documented in `docs/agent-harness-pr01-execution-boundary.md`.

## Evidence

Measured on the same macOS 27.0.1 (Build 26A434), Darwin 27.0.0 arm64, Node v26.12.1 and pnpm 12.5.1 environment as PR-01. The harness is deterministic and does not measure real provider quality or cost.

| Check | Result |
| --- | --- |
| Focused run-budget policy, ledger, invocation and event tests | Pass, 12/12 |
| Snapshot migration and execution-grant tests | Pass, 22/22 |
| Full unit suite (`pnpm test:unit`) | Pass, 502/502 |
| Renderer suite (`pnpm test:renderer`) | Pass, 31/31 |
| TypeScript (`pnpm typecheck`) | Pass |
| IPC generated-file check (`pnpm check:ipc`) | Pass |
| Production build (`pnpm build`) | Pass |
| Renderer chunk check (`pnpm check:renderer-chunks`) | Pass, 1,130,127 eager JS bytes across 6 files |
| Deterministic harness (`pnpm harness:eval`) | Pass, 93/93 fixture cases |
| Changed-path LSP error diagnostics | 0 errors across 18 paths |
| Diff whitespace check (`git diff --check`) | Pass |

Harness report: `.artifacts/harness-eval/2026-10-30T02-35-23.588Z-91733/report.json` (local generated artifact, not committed). The `budget-token`, `budget-unknown` and `budget-restart` cases each made exactly one model request and then stopped at the appropriate budget limit; unknown usage remained recorded with a null actual token count. `tests/unit/run-budget-observer.test.mjs` also asserts that a failed reservation leaves the provider handler call count at zero.

The renderer suite passed 31/31 on an isolated full rerun. During a parallel run with several build/test gates, its existing transcript-anchor test timed out; the single test passed when isolated, and the full renderer suite passed serially. The budget change does not touch that transcript path.

The budget boundary covers Roc agent runs, their LangChain subagents and context summaries. It does not claim aggregate accounting for the separate research workflow, real-provider billing accuracy, or cost coverage for arbitrary external MCP server activity.

## Review boundary

The token reservation is a conservative full-context upper bound plus output cap and margin. Providers must honor the configured output cap; malformed or missing usage is retained as unknown. The harness uses deterministic provider fixtures. Production pricing entries require an attributable exact provider/model id, effective date and source; until such entries exist, dollar balances stay unknown and dollar-capped model calls fail closed.
