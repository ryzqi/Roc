---
name: roc-world
description: Use with eval-engineering when designing Roc harness evaluation tasks. Routes to the real runtime, independent verifiers, manual benchmark workflow and known environment limits.
---

# Roc evaluation world knowledge

Status: Draft; agent-reviewed, unreviewed by the user. This is control-plane knowledge, never agent-visible benchmark input.

Read eval-engineering for the general method. Project paths below are relative to the repository root.

## Sources and reusable boundaries

- `evaluation/README.md`: manual lifecycle, default controlled-model harness, supplementary tracks, profiles, failure taxonomy and evidence audit commands.
- `evaluation/runtime/harness-worker.ts` and `evaluation/lib/harness.mjs`: actual production graph runs, precise crash-boundary exits, original-run recovery, controller-released approval decisions and isolated native process groups.
- `evaluation/lib/harness-verifier.mjs`: independent read-only SQLite, raw file bytes, ordered transport evidence and per-criterion harness gate; imports no production verifier helpers.
- `evaluation/runtime/application-worker.ts`: actual AgentPluginRuntime/DeepAgentExecutor, checkpoint/database, stdio model bridge, isolation probes and production capability calls.
- `evaluation/runtime/benchmark-runtime.ts`: explicit benchmark tool manifests. Tool availability is part of task fairness; adding a capability requires a task-spec review.
- `evaluation/lib/application.mjs`: native macOS sandbox, private workspace per trial, complete transport traces and process cleanup. It excludes evaluator code from the worker bundle.
- `src/main/services/deep-agent/execution-grant-broker.ts`: execution requires a consumed grant, bound command/cwd and resource limits. A capability declaration alone is not execution authority.
- `evaluation/lib/data.mjs` and `report.mjs`: frozen source/provenance, independent scoring records, evidence seals, cluster comparisons. Seals detect drift; they are not signatures.
- `evaluation/tests/harness-bench-application.test.mjs`: real file tool visibility, consumed execution grants and cancellation cleanup; synthetic responses do not establish model quality.

## Task families and evidence

- Production harness lifecycle/tool effects (default): `evaluation/tasks/roc-harness/Task.md`. Ten cases, seven dimensions; smoke 3x1, fast 10x1, full 10x3. Controlled stdio responses use the real model adapter with zero inference. There is no model-quality release profile.
- Paper reading/evidence: `evaluation/tasks/qasper/Task.md`.
- Scientific result generation: `evaluation/tasks/scienceagentbench/Task.md`.
- Native contract regression supplement: `evaluation/tasks/roc-native/Task.md`. Its 94 fixtures include synthetic pilot tools; their aggregate does not establish production graph recovery.
- S01 remains under `scripts/harness-eval/quality-evaluation/`; public benchmark performance is not S01 holdout evidence.

Keep exact questions, references, expected output and scoring criteria in task specs and evaluator-side datasets. Avoid teaching the evaluated agent answers through a project skill. Group related questions by paper/repo before splitting or resampling.

## Environment and audit limits

Workers and scientific Python need macOS sandbox-exec. Scientific dependencies live in dedicated evaluation/environments venvs; manifests are checked each use. No network, subprocesses or dependency installation occurs during scientific execution. The independent grader sees only allowlisted data outputs and hidden truth. Five calibration cases are re-executed before tasks. There is no total memory/disk hard quota or complete system-library snapshot.

Manual commands are documented in the workflow README. Trace evidence is under `evaluation/runs/`, with no automatic external upload. Inspect request/response, tool result, checkpoint, final output, grade, process exit and cleanup together. In the default harness gate, a failed criterion fails its trial; missing/corrupt evidence makes it invalid/incomplete. Controlled-model evidence never establishes model quality.

The public-track model host reads Roc configuration and credentials without application startup or writeback. Credentials remain host-only; configuration hashes and fixed errors are recorded. A complete live QASPER 150-trial baseline and a preceding provider-interrupted run from 2026-11-13 are retained; see `evaluation/VALIDATION.md` and revalidate their seals before use. They are historical quality evidence, not improvement evidence. Official Science tasks still need separate audited environments.

Generated-output cleanup must retain real baselines and relevant failure evidence and consider comparison/incident/experiment dependencies. Tests own their temporary output roots and clean runs, caches and venvs even on failure. One-time cleanup audits live under `evaluation/local/cleanup/`.

## Maintenance

Add only reusable facts supported by code or runs; keep per-task truth in the collocated Task.md. Reconcile Draft changes with the user before calling this knowledge accepted. Do not infer broader benchmark coverage from entries marked planned/deferred.
