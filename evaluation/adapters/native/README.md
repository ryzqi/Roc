# Native deterministic harness checks

Run `pnpm evaluation:native:check` from the repository root, or capture the same adapter in the sealed workflow with `pnpm evaluate run --suite roc-native`. The CLI workflow and retention rules are in [evaluation](../../README.md); the exact acceptance contract is in [Task.md](../../tasks/roc-native/Task.md).

## Current contract

[run.mjs](run.mjs) requires exactly 94 passing cases. [scenarios.mjs](scenarios.mjs) supplies 48 synthetic tasks; additional cases exercise crash recovery, usage, context, memory/Skill pinning, effects, isolation, optimizer/release plumbing and the S01 contract. The adapter uses installed Deep Agents and Roc infrastructure with scripted local transport. It needs installed dependencies and supported macOS, with no credentials, remote provider, user configuration or real project.

Each run saves [inventory](inventory.mjs), per-case trajectories, SQLite databases, synthetic workspaces and a machine-readable report under `evaluation/.runtime/native/`. Source drift invalidates the run. Failure classes are infra / provider / policy / effect / state / verifier / agent. Fixed token usage and fixture quality scores are transport evidence, not model resource or scientific-quality measurements.

## Scope limits

- Lifecycle cases that restart the real production graph and independently verify tool effects belong to [roc-harness](../../tasks/roc-harness/Task.md).
- Optimizer cases test allowed changes, isolated candidates, invocation journals, artifact-based selection and dataset separation. Their 240 scenarios / 48 clusters are synthetic, with one repetition per scenario; the selector is in-process.
- Experience transfer strata reuse the same adapter/data under different labels. They do not establish transfer across real models or projects.
- Pilot product-path cases test manifest narrowing, enrollment, cancellation, rollback and continued execution past historical quotas. They do not start candidate search. Release activation and upgrade gates are not wired into the production run path.
- [S01](../s01/Task.md) has 16 contract fixtures and 0/200 independent reviewed tasks. `pnpm evaluation:s01:check` audits data without model calls; its application adapter uses the [shared isolated worker](../../runtime/application-worker.ts). Scientific data, real effect observers and blinded review remain separate requirements.

## Historical checkpoints

These are summaries from 2026-10-21, not current-run results. The former `.artifacts/harness-eval/` evidence directory has been removed; these counts cannot supply inspectable comparison evidence.

| Checkpoint | Cases passed | Historical scope |
| --- | ---: | --- |
| P0, Roc `76d9ad0` | 51/51 | Pilot/crash contracts; three behavior defects recorded |
| P1 | 63/63 | Usage accounting and corrected defect expectations |
| P2 context | 68/68 | Summary/checkpoint recovery and artifact reads |
| P2 memory/skills | 70/70 | Version, expiry, license/hash and symlink checks |
| P3 | 80/80 | Effects, resources, MCP lifecycle and macOS isolation |
| P5 | 86/86 | Offline optimizer plumbing on synthetic data |
| P6 | 91/91 | Experience, release and pilot modules |

The current 94-case count additionally includes pilot product-path/dispatch and unified quality-contract coverage. Historical build, smoke and fixture results do not authorize optimizer adoption or release. Current quality comparisons require fresh, matched evidence under the relevant Task Spec.
