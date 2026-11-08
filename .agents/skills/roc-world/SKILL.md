---
name: roc-world
description: Use with eval-engineering when designing Roc harness evaluation tasks. Routes to the real runtime, independent verifiers, manual benchmark workflow and known environment limits.
---

# Roc evaluation world knowledge

Status: Draft; agent-reviewed, unreviewed by the user. This is control-plane knowledge, never agent-visible benchmark input.

Read eval-engineering for the general method. Project paths below are relative to the repository root.

## Sources and reusable boundaries

- `evaluation/README.md`: manual lifecycle, registry, profiles, failure taxonomy, budgets and evidence audit commands.
- `evaluation/runtime/application-worker.ts`: actual AgentPluginRuntime/DeepAgentExecutor, checkpoint/database, stdio model bridge, isolation probes and production capability calls.
- `evaluation/runtime/benchmark-runtime.ts`: explicit benchmark tool manifests. Tool availability is part of task fairness; adding a capability requires a task-spec review.
- `evaluation/lib/application.mjs`: native macOS sandbox, private workspace per trial, complete transport traces and process cleanup. It excludes evaluator code from the worker bundle.
- `src/main/services/deep-agent/execution-grant-broker.ts`: execution requires a consumed grant, bound command/cwd and resource limits. A capability declaration alone is not execution authority.
- `evaluation/lib/data.mjs` and `report.mjs`: frozen source/provenance, independent scoring records, evidence seals, cluster comparisons. Seals detect drift; they are not signatures.
- `evaluation/tests/harness-bench-application.test.mjs`: real file tool visibility, consumed execution grants and cancellation cleanup; synthetic responses do not establish model quality.

## Task families and evidence

- Paper reading/evidence: `evaluation/tasks/qasper/Task.md`.
- Scientific result generation: `evaluation/tasks/scienceagentbench/Task.md`.
- Native reliability: `evaluation/tasks/roc-native/Task.md`.
- S01 remains under `scripts/harness-eval/quality-evaluation/`; public benchmark performance is not S01 holdout evidence.

Keep exact questions, references, expected output and scoring criteria in task specs and evaluator-side datasets. Avoid teaching the evaluated agent answers through a project skill. Group related questions by paper/repo before splitting or resampling.

## Environment and audit limits

Workers and scientific Python need macOS sandbox-exec. Scientific dependencies live in dedicated evaluation/environments venvs; manifests are checked each use. No network, subprocesses or dependency installation occurs during scientific execution. The independent grader sees only allowlisted data outputs and hidden truth. Five calibration cases are re-executed before tasks. There is no total memory/disk hard quota or complete system-library snapshot.

Manual commands are documented in the workflow README. Trace evidence is under `evaluation/runs/`, with no automatic external upload. Inspect request/response, tool result, checkpoint, final output, grade, process exit and cleanup together. Treat incomplete runs and unknown cost explicitly. The model host reads Roc configuration and credentials without application startup or writeback. Credentials remain host-only; configuration hashes and fixed errors are recorded. Local controlled-provider and synthetic science tests pass; actual configured credential access and official Science tasks still need separate evidence before quality claims.

## Maintenance

Add only reusable facts supported by code or runs; keep per-task truth in the collocated Task.md. Reconcile Draft changes with the user before calling this knowledge accepted. Do not infer broader benchmark coverage from entries marked planned/deferred.
