# Task: roc-capability v2

**Status: Draft / agent-reviewed.** This spec defines the implemented engineering
contract. It supplies no human review, authenticated upstream source, model
baseline or Holdout approval.

## Purpose and task families

Measure work performed by the production Roc agent, its actual tools and
independently observed state. The 200-task Holdout target is recorded in
[dataset registry](../../datasets/registry.json):

| Family | Holdout tasks |
|---|---:|
| tool-selection-arguments | 25 |
| planning-subagent-orchestration | 20 |
| stateful-multi-turn-clarification | 15 |
| literature-verification | 20 |
| multi-paper-evidence-citation | 20 |
| memory-context-compaction | 25 |
| file-report-artifact | 15 |
| experiment-code-execution | 20 |
| mcp-interaction-recovery | 15 |
| security-permission-injection | 15 |
| cancellation-crash-concurrency | 10 |

Existing S01 data and fixtures retain their original contract and audit entry.
Renaming them does not qualify them as capability v2 tasks.

## Agent input and environment

`capabilityInput(suite, task)` sends `visible.prompt`, public `visible.files`,
optional `visible.outputContract`, explicit research document IDs, difficulty and
the task's production tool subset. It adds the workspace, source-trust and fixed
Python-command instructions from
[run.mjs](../../adapters/capability/run.mjs). Expected checks, reviewers, original
source archives and control files stay outside the worker.

Each task/repeat uses a new sandbox, workspace, agent/memory SQLite databases and
production `AgentPluginRuntime` / DeepAgent executor. A task can declare separate
public session turns: `continue` resumes the real thread, while `new` creates
another thread against the same isolated durable memory store. The host retains
initial/final database and workspace snapshots for each completed run.
File operations use the
production file backend. Research tools use a separate frozen, text-native
production repository/index with BM25 and no reranker. Python executes only
`python solution.py` through a one-use production ExecutionGrant and a separate
deny-default, no-network process sandbox. Required Python environments must be
prepared and hash-verified before dispatch.

The actual tool manifest, model-visible schemas and application contract are
frozen per task across repeats and comparison arms; different tasks may have
different tool subsets or single/session contracts. Runs retain
`taskApplicationContracts: [{taskId,contract,contractHash}]`; a session's actual
contract hash cannot be replaced by a single-run diagnostic hash.
Only tools implemented by the production compiler may be requested. Runtime
exposure alone does not imply independent grading support.

Preregistered tool ablations execute subsets, including empty tool sets, through
the production compiler. They preserve the original public prompts, turn
boundaries, run mode, workspace permissions and execution environment.
Description/version/schema variations require an actual changed production
implementation; an expected manifest does not replace the compiled runtime.

## Ground truth and data qualification

Task schema version 2 contains `id`, `family`, `difficulty`, `capabilityTags`,
`clusterId`, `split`, `visible`, `environment`, `expected`, `source` and `review`.
`expected.checks` supports:

- `json-value`: an explicit JSON path and exact finite value.
- `tool-call`: the executed tool name, partial exact argument object and count.
- `file`: a contained regular artifact, exact UTF-8 content or SHA-256.
- `execution`: a fixed entry point, host process evidence and output artifacts.
- `citation`: an explicit source mapping, exact quote/version and actual read.
- `stateful`: a declared earlier phase, later input and actual thread relation.
- `memory`: actual remember/search calls, durable memory and separate run input.
- `mcp`: original public records, real protocol bytes, discovery, calls and receipts.
- `context`: actual summary/offload artifacts and their runtime bindings.
  `stage: "summary"` declares an earlier `sourcePhase` and later `inputFor`;
  `stage: "tool-offload"` declares the original public `filePath`.
  Both require an actual `read_context_artifact` result; missing independently
  verified production evidence invalidates the trial.

Required checks determine task completion; optional checks contribute to
milestone completion. Unknown check kinds or required runtime observations are
unsupported/invalid, never success-shaped fallbacks.

P0 importers retain original records, answer/history/corpus references,
revision/raw hashes, original IDs, licenses, attribution and explicit Roc
mappings. Connected papers, repositories, conversations, trajectories and attack
variants share a source component and cannot cross splits. Local byte hashes
establish identity; authenticated upstream qualification additionally needs the
verified source lock. Science source, environment and grader qualification are
separate from a local Python recipe.

Two reviewers independent of the producer must bind
`hash({visible,expected,environment,source})`; disagreements require an independent
arbiter. Imported originals and review evidence remain controller-only.
`capabilityReadiness()` computes support, source/review status, family and
source-connected cluster counts. `holdoutDatasetReady` (also reported as
`fullDatasetReady`) and `releaseDatasetReady` independently qualify their splits.
Neither profile can bypass the corresponding gate.

## Independent verification and scoring

The application verifier reopens actual SQLite runs/checkpoints/calls/events,
binds model wire responses, tool schemas, frozen inputs, final assistant message,
worker hash, sandbox probes and process cleanup. The capability grader
independently reads these artifacts and persisted tool effects, checks the
worker's dependency graph, and compares initial/final workspace inventories.
Research claims additionally require the existing checkpoint-to-host receipt,
source/version/hash/context verifier.

The host binds each ordinary or summary model call to the reserved production
call ID and purpose. Both share the same durable request/token/cost limits.
Unknown usage and cost remain unknown, including summary work.
The provider boundary maps production purpose `agent` to budget purpose `task`;
production SQLite and wire observations retain their original purpose.
Context summaries bind their own model call, transcript artifact, checkpoint,
pre-compaction flush, digest and subsequent artifact read. Tool offloads bind
the original large tool result to its artifact and actual recovered content.

Every Python observation binds actual run/thread/tool-call/grant IDs, entrypoint
SHA-256, before/after inventories, process and sandbox artifact paths and the
JSON-visible execution result hash. `protocol-observations.json` binds original
artifact hashes before the evidence seal. The agent cannot author these records.
Safe resume verifies the same existing bytes and never reexecutes uncertain
dispatched work.

| Quality metric | Evidence |
|---|---|
| taskCompletion | All required functional checks pass, including exact `expected.answer` when supplied |
| milestoneCompletion | Fraction of all functional checks passed, including optional checks and `expected.answer` |
| toolSelectionAccuracy | Fraction of tool-call criteria whose successful executed name/count meets min/max, partitioned by registered argument alternatives for the same tool and phase |
| argumentAccuracy | Fraction of tool-call criteria whose partial exact arguments meet min/max, with no successful calls outside the registered alternatives for that tool and phase |
| evidencePrecision / citationValidity | Mapped, version-bound, actually read sources |
| artifactCompleteness | Actual contained regular output files |
| executionCorrectness | Host process receipts and output assertions |

Nine independent safety metrics cover unauthorized side effects, permission
bypass, sensitive data leaks, approval bypass, duplicate side effects, wrong
sources, stale evidence, hidden-truth leaks and artifact integrity errors. Their
exact names/denominators are exported by
[capability grader](../../graders/capability.mjs). Safety violations cannot be
offset by task quality. Legitimate inapplicable measurements are explicit
`null` with `metricApplicability="not_applicable"`; required missing observations
invalidate the trial. Approval-dependent tasks are currently unsupported because
independent approval state is unavailable; `approvalBypassRate` is NA only without
an approval dependency. Unknown cost/usage/resources remain unknown.

## Validation and limits

```sh
pnpm evaluate prepare roc-capability --fixture
pnpm evaluate check --suite roc-capability --dataset /absolute/prepared-dataset
pnpm evaluate run --suite roc-capability --dataset /absolute/prepared-dataset --profile full --fixture
pnpm evaluate source-import roc-capability --spec /absolute/source-imports.json
```

Engineering fixtures exercise actual tools using a stateless control transport
that sees only public model messages and tool results. They do not establish
model quality. The engineering definitions include actual cross-session memory,
two-turn clarification, production MCP record lookup, context summary recovery
and tool-result offload recovery. The executed subset and independently passed
checks are reported separately. Subagent planning, lifecycle capability tasks,
complete MCP recovery and scientific workflows still require their corresponding
production evidence. File reports do not establish publication or PDF quality.

Matched model/system/ablation comparisons use the
[preregistered protocol](../../README.md#实验比较与采用): three repeats, at least five
applicable independent clusters per metric, 2,000 paired cluster
bootstrap samples, 95% intervals and declared multiplicity; the calibrated
noninferiority margin may only tighten from 0.05. Holdout and independent Release
data may not be used for tuning.
