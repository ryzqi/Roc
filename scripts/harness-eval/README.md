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
