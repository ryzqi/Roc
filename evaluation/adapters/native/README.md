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
- [S01](../s01/Task.md) retains contract fixtures; its reviewed holdout target and qualification rules are separate. `pnpm evaluation:s01:check` audits data without model calls; its application adapter uses the [shared isolated worker](../../runtime/application-worker.ts). Scientific data, real effect observers and blinded review remain separate requirements.

## Evidence and acceptance

Use the [native Task Spec](../../tasks/roc-native/Task.md) for the exact case-count and completeness contract. Inspect the newly sealed run and retain its full native artifacts. Case inventory, synthetic optimizer scores and past summaries do not establish a current pass, model quality, optimizer adoption or release approval. Shared [validation methods](../../README.md#验证方法) describe commands and raw-evidence requirements.
