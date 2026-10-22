# Offline harness pilot

Run `pnpm harness:eval` from repository root. Requires installed Node dependencies; no credentials,
remote provider, user config or real project. Each run retains inventory, per-case trajectories,
SQLite databases, synthetic workspaces and a machine-readable report under `.artifacts/harness-eval/`.

The 48 pilot cases exercise deterministic fixture transport and tools through installed Deep Agents,
plus Roc's checkpointer, event log, outcome/budget/loop checks and effect store. Mock quality and
fixed token usage are transport evidence only; USD cost is unknown, never zero. The report separates
known behavior defects from runner failures. Pilot cases are not independent real-model research
quality measurements and cannot authorize optimizer adoption or release.

Failure classes: infra / provider / policy / effect / state / verifier / agent.

P0 baseline (2026-10-21, Roc `76d9ad0`): 51/51 pilot/crash cases; `pnpm typecheck`,
`pnpm build`, and `ROC_SMOKE_TARGET=dist pnpm verify:p4-assistant` passed (52/52 assertions).
Evidence: `.artifacts/harness-eval/2026-10-21T08-16-47.249Z-10479/report.json`,
`.artifacts/p4-gates/report.json`. Independent subagent review completed; findings fixed.
Observed defects: cumulative-window conflation, pagination loop false positive, reasoning without conclusion.

P1 (2026-10-21): 63/63 source graph cases, including actual three-call 45k usage,
pre-dispatch limits, retry attempts, unknown usage, restart, child tools and correction ownership.
The three P0 defects now match expected behavior. Build, existing 264 tests, IPC generation check,
renderer chunk check and full Electron 52-assertion flow passed. Final child-accounting change is
covered by the source graph fixture; Electron evidence uses the preceding build.
Evidence: `.artifacts/harness-eval/2026-10-21T08-45-01.589Z-16438/report.json`,
`.artifacts/harness-eval/ui-p1.log`. Independent review findings fixed.

P2 context: 68/68 deterministic cases; two summary boundaries plus checkpoint restore retain
13 complete user messages and existing acceptance IDs. Artifact pagination, corruption, expiration
and wrong-scope reads checked. Text token measurements use local OpenAI encoding; message framing
and other providers remain estimates. Build, chunk check and Electron startup/model run smoke
passed (12/12). No real-model quality or cost improvement claim.
Evidence: `.artifacts/harness-eval/2026-10-21T09-12-07.732Z-21066/report.json`,
`.artifacts/harness-eval/smoke-p2-context.log`. Context review passed; P2 memory/skills remain pending.

P2 memory/skills: 70/70 cases, including version mismatch, archived revocation after TTL
maintenance, probe writes, skill byte/license drift and symlinks. Independent review findings
fixed. Build, existing 264 tests, IPC/chunks and Electron12/12 passed. Evidence:
`.artifacts/harness-eval/2026-10-21T09-43-26.930Z-27961/report.json`,
`.artifacts/harness-eval/smoke-p2-memory.log`. Expired latest states remain as invalidation markers;
archive capacity can explicitly reject further writes rather than revive old experience.

P3: 80/80 deterministic cases, including cross-run exclusive writes, main/child shared
admission, final guard mutations, crash reservations/explicit receipts, atomic writes, real
MCP subprocess leases, failed-plugin cleanup and macOS sandbox filesystem/network/process
checks. Review fixed setsid escape and cleanup errors. The probe provider permits OS runtime
reads and denies external user files/network; production shell remains an explicit host path.
Build,264 existing tests,IPC/chunks and Electron52/52 passed. UI evidence precedes only final
isolated-provider cleanup and missing-MCP-tool diagnostics (source cases/review cover these).
Evidence: `.artifacts/harness-eval/2026-10-21T11-40-56.970Z-36602/report.json`,
`.artifacts/harness-eval/ui-p3.log`. Resource scheduling deliberately serializes all mutations
across runs to protect shared memory and overlapping workspace roots.

P5 offline optimizer: 86/86 cases. `optimizer-surface` rejects all 12 out-of-surface
proposals (permissions, budget, scorer, verifier, absolute/traversal paths, holdout
identifiers, unknown or duplicate components) and shows stable materialise/trajectory
serialisation. `optimizer-isolation` gives each candidate its own directory, SQLite
ledger, workspace and credential scope; it measures the write scope (every created file
stays under the case root and an outside sentinel is byte-identical) and falls back to
the base surface after one budgeted retry of an invalid proposal. `optimizer-adopt`
keeps the base for verifier failure, missing artifacts, cost overruns and an
inconclusive selector, and records an anonymous A/B comparison whose scores come from
artifact bytes (artifact present, existing citation verifier, user heading kept, numeric
result restated as an appended `% roc-checked` line absent from the input draft) rather
than from the candidate's own prompt strings; the comparison uses the full dev split
(45 scenarios / 9 clusters) and no finals-only delivery. `optimizer-dataset` freezes 240 scenarios in 48 clusters (train 120 / dev 45 /
holdout 75); the holdout key is a private secret, so a key forged from the public hash is
rejected, as is access after mutation or by rewriters/selectors. It reports paired
cluster-bootstrap quality intervals with failures in the denominator, real per-scenario
timing, and four real ablations (full candidate vs constraint-only, numbers-only and a
citation-check removal). `optimizer-cost-manifest` accounts retries, summaries, children,
selection, reflection and judge calls, keeps a budget stop in the ledger, and resumes
without repeated charges, repeated stage side effects or a changed call-table digest.
Scores use a deterministic fixture rubric with a single repetition per scenario (k=1, per
P5-02) and the fixture price is not a provider price, so none of this is real-model
quality or cost evidence. The anonymous selector hides base/candidate labels from its own
input, but remains in-process; it is not a security boundary. Evidence:
`.artifacts/harness-eval/2026-10-21T15-45-54.415Z-23660/report.json`.

P6 experience, release and pilot: 91/91 cases. `experience-records` stores an adopted
candidate lesson only with a hashed adoption record and evidence, rejects holdout wording,
absolute paths (any root), e-mail addresses and unknown fields, refuses a cue learned in a
future task, refuses a different execution revision, and keeps quarantine/revocation
append-only (revoke needs a counterexample and is terminal; rewriting a quarantined lesson
keeps it quarantined). `experience-transfer` reports single-task and the three transfer
strata separately with cluster-bootstrap intervals and downgrades a claim to
`single-task-only` when a stratum shows no gain; the strata are currently **label-only**
(the same deterministic adapter and dev scenarios relabelled), so this is plumbing, not a
real cross-model/cross-project transfer result. `experience-retention` turns a production
failure into an allowlisted, redacted fixture (shared credential policy, any absolute
path), purges records and events on delete, and keeps the upgrade gate closed until a
matching version re-test with a known receipt passes. `harness-release` signs a release
(HMAC), re-reads the stored review report, rejects tampering, a widened baseline, an
invalid interval, verifier failures, a non-positive holdout interval and a forged
signature, reproduces a release from identical inputs, pins the release for a run so later
activation leaves old runs untouched, and rolls back to the previous release.
`pilot-gate` is off by default (normal requests never start a candidate search), requires
an explicit budget acknowledgement, buckets by taskId, and trips a breaker on repeated
failure or when the granted allowance runs out; the user can roll back at any time.

The pilot now has two further cases that cover the product path rather than the gate module:

- `pilot-product-path` — derives grants/effect classes from a frozen manifest, narrows the
  manifest for a profile and re-seals its hash (identity-preserving when nothing is
  removed), then exercises the real `agent_pilot_runs` table through `RunBudgetLedger`:
  an ordinary run keeps the exact old budget errors and gets no pilot row, a granted run
  overshoots by exactly the granted model/tool/token allowance, exhaustion is marked after
  the reservation transaction rolls back and maps through `toRunFailure` to
  `run_pilot_allowance_exhausted`, and completion/cancellation/rollback each land in their
  own state.
- `pilot-dispatch` — drives the real `AgentPluginRuntime.startRun`: the frozen snapshot and
  the `agent.run.started` preview both carry the narrowed manifest hash, the bound tool set
  really shrinks, the run gets its pilot row and disclosure, and cancelling it records
  `cancelled` instead of `finished`. Reverting the snapshot seeding line makes this case
  fail with `run_execution_snapshot_manifest_mismatch`, so it guards that wiring.

Scope: release activation and the upgrade gate are still not wired into the production run
path, the pilot does not start a candidate search (P5's numbers are fixture evidence), and
the disclosed microusd ceiling is never metered (no price table, so cost stays `unknown`;
only model calls, tool calls and tokens are metered). P6-02 (real transfer conditions)
therefore remains in progress.
