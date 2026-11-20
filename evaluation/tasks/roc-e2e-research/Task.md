# Task: roc-e2e-research

**Status: Draft / agent-reviewed.** The four workflow contracts and readiness
gates are implemented; this document is not evidence of 24 reviewed research
tasks or independently accepted scientific results.

## Purpose and workflows

Evaluate a research workflow through the same production runtime, tool host,
sealed dataset, independent graders and budget as
[capability v2](../roc-capability/Task.md). Each workflow needs six independent
source-connected clusters, for a minimum of 24:

| Workflow | Required evidence |
|---|---|
| literature-research | Frozen research question/corpus, actual search and context reads, source-bound answer/report |
| systematic-review | Explicit inclusion/exclusion rubric, source evidence and independently checked review artifacts |
| experiment-reproduction | Original paper/repository and inputs, qualified environment/grader, actual execution and verified outputs |
| writing-publication | Reviewed source facts and writing rubric, checked manuscript/export artifacts |

Task inputs, schema v2, source pinning, independent review, source clustering,
tool manifests, verification, eight quality metrics and nine safety metrics
follow the shared capability contract. Milestones are explicit
`expected.checks` with stable IDs and optional/required status. A final summary
alone cannot complete a workflow.

## Current execution boundary

Engineering controls stage frozen text-native production research repositories,
read source contexts, write contained report files and, when a prepared Python
lock is supplied, run a local standard-library experiment through actual
ExecutionGrants. Source/experiment/report artifacts have independently checked
bytes and hashes.

These controls do not authenticate scientific methodology, upstream verified
environments, research value, manuscript quality, LaTeX/PDF export or external
publication. Such tasks remain unsupported until the environment, rubric,
grader and original-source evidence exist. Independent LLM judges require
separate human calibration and a blind human review boundary; the evaluated
model never grades itself.

## Qualification and run

`capabilityReadiness()` checks workflow quotas, source-connected cluster roots,
support, original sources and two independent task-content-bound reviews. Each
workflow needs six qualified independent clusters in each requested split;
multiple tasks from one connected source count as one cluster.
Missing workflow/source/environment/review evidence keeps
`holdoutDatasetReady` (also `fullDatasetReady`) or `releaseDatasetReady` false.
Holdout and release dispatch select separate splits and are blocked before
model calls when their corresponding gate fails.
Fixture scores and a valid offline audit establish engineering behavior only.

```sh
pnpm evaluate prepare roc-e2e-research --fixture
pnpm evaluate check --suite roc-e2e-research --dataset /absolute/prepared-dataset
pnpm evaluate run --suite roc-e2e-research --dataset /absolute/prepared-dataset --profile full --fixture
pnpm evaluate source-import roc-e2e-research --spec /absolute/source-imports.json
```

All attempts, failures, source exclusions, tool/checkpoint/host execution
evidence and resource unknowns remain in the report. Matched comparisons and
safe resume use the shared contracts, not a second workflow runner. See the
[evaluation guide](../../README.md) for interfaces and data preparation, and
[validation methods](../../README.md#验证方法) for required evidence and acceptance
boundaries.
