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
