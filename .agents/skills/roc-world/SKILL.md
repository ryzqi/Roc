---
name: roc-world
description: Use with eval-engineering when designing Roc harness evaluation tasks. Routes to the real runtime, independent verifiers, manual benchmark workflow and known environment limits.
---

# Roc evaluation world knowledge

Status: Draft; agent-reviewed, unreviewed by the user. This is control-plane knowledge, never agent-visible benchmark input.

Read eval-engineering for the general method. Project paths below are relative to the repository root.

## Sources and reusable boundaries

- `evaluation/README.md`: canonical `pnpm evaluate` lifecycle, four registry tracks, profiles, budgets, safe unsealed resume, failure taxonomy and evidence audit commands. `pnpm harness:bench` is the same CLI's compatibility alias.
- `evaluation/runtime/harness-worker.ts` and `evaluation/lib/harness.mjs`: actual production graph runs, precise crash-boundary exits, original-run recovery, controller-released approval decisions and isolated native process groups.
- `evaluation/lib/harness-verifier.mjs`: independent read-only SQLite, raw file bytes, ordered transport evidence and per-criterion harness gate; imports no production verifier helpers.
- `evaluation/runtime/application-worker.ts`: actual AgentPluginRuntime/DeepAgentExecutor, checkpoint/database, stdio model bridge, isolation probes and production capability calls.
- `evaluation/runtime/research-tool-correlation.ts`: binds production-normalized requests and pinned project to pending proposals, with operation tool-call ID when present. Read-only same-name tools may execute out of proposal order; receipt identity cannot rely on name/order alone.
- `evaluation/runtime/agent-task-view.ts`: shared worker-visible task schema. S01 validation lives in `evaluation/adapters/s01/`; fixture expectations remain in `tests/fixtures/quality-evaluation/expected/`.
- `evaluation/runtime/benchmark-runtime.ts`: explicit benchmark tool manifests. Tool availability is part of task fairness; adding a capability requires a task-spec review.
- `evaluation/lib/application.mjs`: native macOS sandbox, private workspace per trial, complete transport traces and process cleanup. It excludes evaluator code from the worker bundle.
- `evaluation/lib/application-verifier.mjs`: host-only raw SQLite/checkpoint, transport, ledger, workspace and cleanup checks. It binds the final checkpoint assistant to the terminal model response before scoring; serialized constructors remain data.
- `src/main/services/deep-agent/execution-grant-broker.ts`: execution requires a consumed grant, bound command/cwd and resource limits. A capability declaration alone is not execution authority.
- `evaluation/lib/data.mjs` and `report.mjs`: frozen source/provenance, independent scoring, evidence seals, per-task comparisons and request/token/cost/unknown summaries. Reports retain runner `traces.artifacts` receipt/verification paths with hashes. Seals detect drift; they are not signatures.
- `evaluation/lib/execution.mjs`, `lifecycle.mjs` and `budget-ledger.mjs`: durable plan, trial lifecycle, sequenced journal, scoped accounting and exclusive resume ownership. Admission estimates are distinct from measured usage.
- `evaluation/lib/experiment.mjs`, `comparison.mjs`, `ablation.mjs` and `evaluation/EXPERIMENTS.md`: pre-execution claims, fixed contracts, two-fresh-arm ablation, paired cluster bootstrap and frozen quality/resource gates.
- `evaluation/adapters/rag/{data,environment,evidence,verification,run}.mjs`, `evaluation/runtime/production-rag.ts` and `evaluation/graders/`: real isolated research repository/embedding service, hash-bound source mapping and independent component/E2E evidence.
- `evaluation/tests/harness-bench-application.test.mjs`: real file tool visibility, consumed execution grants and cancellation cleanup; synthetic responses do not establish model quality.

## Task families and evidence

- Production harness lifecycle/tool effects (default): `evaluation/tasks/roc-harness/Task.md`. Ten cases, seven dimensions; smoke 3x1, fast 10x1, full 10x3. Controlled stdio responses use the real model adapter with zero inference. There is no model-quality release profile.
- RAG component: `evaluation/tasks/rag-retrieval/Task.md`. Production indexing/BM25/embedding/RRF/reranking with host-only request/receipt verification; normal evidence is production-component. No generation model, applicationContract/runtimeVerification or checkpoint claim.
- RAG E2E: `evaluation/tasks/rag-paper-qa/Task.md`. Real agent research search/context tools; live quality evidence requires application verification plus checkpoint ToolMessage/wire content bound to host capability, ranking/context and SQLite hashes.
- Paper reading/evidence: `evaluation/tasks/qasper/Task.md`. QASPER uses real Roc text file tools and native answer/evidence scoring, distinct from source-span RAG scores. Fresh `manifest.qasperQualification` binds locked official archive, its actual member and complete deterministic adapted tasks. Comparison needs the readable original `manifest.dataset.path` to recheck current source/derivation contract, saved qualification and selected official tasks; missing, forged or unverified proof returns qasper_quality_provenance_unverified. Locally sealed synthetic data or self-declared official provenance remains engineering-only even with complete configured-model/runtime evidence. Preserve historical manifests without upgrading missing qualification.
- Scientific result generation: `evaluation/tasks/scienceagentbench/Task.md`. Current local recipes are engineering diagnostics: new dataset provenance=engineering_fixture and preflight/run evidence=engineering-fixture. Arbitrary revision, supplied hashes, calibration or self-declared review do not authenticate official assets/environment/grader. All current and legacy local Science recipes, including old live-model labels, remain insufficient/science_quality_provenance_unverified for quality comparison and blocked for adoption until a separately audited import contract exists.
- Native contract regression supplement: `evaluation/tasks/roc-native/Task.md`, implemented by `evaluation/adapters/native/run.mjs` with scenarios, runtime and inventory in that directory. `pnpm evaluate run --suite roc-native` captures the suite; `pnpm evaluation:native:check` runs the adapter directly. Its 94 fixtures include synthetic pilot tools; their aggregate does not establish production graph recovery.
- S01 contracts live in `evaluation/adapters/s01/`: `Task.md`, `dataset.ts`, `protocol.ts`, `runner.ts`, `validators.ts` and `application-adapter.ts`. `pnpm evaluate check --suite roc-s01` seals the offline readiness audit; an external manifest needs explicit dataset-sha256. Its real quality dataset is not ready.
- `pnpm evaluate check --suite frozen-retrieval --corpus PATH` seals an offline frozen-ranking audit. Checks make zero agent/model/external calls, retain engineering-fixture evidence and regressionAcceptance=not_evaluated. auditPassRate=1 means the audit completed, without retrieval-threshold acceptance; direct adapter aliases remain available.

Keep exact questions, references, expected output and scoring criteria in task specs and evaluator-side datasets. Avoid teaching the evaluated agent answers through a project skill. Group related questions by paper/repo; RAG uses source-connected components, including old versions and multi-paper links, without cross-split leakage.

RAG quality comparisons require human_reviewed provenance, review.draft=0 and reviewed datasetReview attesting each selection contentHash=hash({visible,expected}). At least two distinct reviewers independent of producer must attest; disagreement requires a third independent arbiter. Agent-reviewed Drafts and synthetic ten-question × three-repeat fixtures do not establish human review, quality or holdout evidence.

## Environment and audit limits

Workers and scientific Python need macOS sandbox-exec. Scientific dependencies live in dedicated evaluation/environments venvs; manifests are checked each use. No network, subprocesses or dependency installation occurs during scientific execution. The independent grader sees only allowlisted data outputs and hidden truth. Five calibration cases are re-executed before tasks. There is no total memory/disk hard quota or complete system-library snapshot.

Manual commands are documented in the workflow README. Trace evidence is under `evaluation/runs/`, with no automatic upload. Inspect request/response, tool result, checkpoint when applicable, final output, grade, process exit and cleanup together. Production completion aggregates tool-turn narration: preserve output.json for diagnosis, score final-answer.json only after runtime-verification.json passes. Component trials instead require their distinct host request/receipt contract. Strict final JSON failures remain agent failures. In the harness gate one failed criterion fails its trial; missing/corrupt evidence is invalid/incomplete.

Both RAG boundaries use version=1/verification=sqlite-source-ranking-context-transport-v1. Save runtime.transportReceipts after host shutdown as reranker-transport-receipts.json, preserving late cancellation replies. Independent verification binds original provider receipt/correlation and reconstructed query/document hashes to journal budget dispatch/settlement/completion and content-addressed scores artifacts before accepting final ranking evidence. No reranker retains an empty receipt array. Old sqlite-source-ranking-context-v1 evidence cannot qualify through a recomputed hash.

Runs default to two isolated trial slots (range 1–8). Generation/embedding/rerank share host request/token/duration/cost budgets; frozen prices and actual usage are required for cost values/gates. Unknown usage is not zero and cannot supply missing per-trial quantiles or cost-per-success. No CPU/memory/energy measurements are inferred.

Safe resume accepts only unsealed, unfinalized runs with unchanged source/manifest/plan/journal/budget, a departed previous owner and preserved experiment binding. It independently verifies complete dispatched evidence, never blindly redispatches uncertain work. SIGINT/SIGTERM normally seal incomplete results; only a valid unsealed interruption can resume. Existing experiment claims are reused, not recreated.

Ordinary comparison freezes tools/schema, data/selection/repeats, provider/retrievalProvider/config, permissions/environment/executionPolicy/budget and scoring/runtime/final-answer contracts, including metricsHash/taskSchemaHash. Different tools remain incompatible. Only an experiment preregistered before two fresh arms may allow exact spec.ablation retrieval/capability differences; seed is not a scored arm. Old applicationContract versions/evidence are not relaxed.

`compare --protocol` and `experiment assess` use frozen acceptance exit codes: eligible=0, blocked=2, rejected=3. Statistical noninferiority cannot override failed absolute/trial/resource/budget gates; unknown cost fails a configured cost gate. Ordinary compare retains its statistical exit behavior.

Explicit null + metricApplicability=not_applicable is the only legitimate NA; otherwise metrics must be finite measured values. Applicability is task/repeat/arm invariant. Each metric needs at least five applicable independent clusters and three repeats; NA clusters cannot satisfy the gate. RAG wrongSourceRate/staleHitRate must be measured zero on every trial. Paired bootstrap uses 2000 samples, margin at most .05 and conservative multiplicity. Superior needs preregistered primary benefit CI lower >0; noninferior is not improvement/release. Frozen absolute quality floors/ceilings and resource/budget gates still apply.

The configured-model host reads Roc configuration/credentials without startup writeback; credentials remain host-only. `evaluation/local/background/qasper-v3-full-20261113T130738Z/RESULT.md` records an established live v3 full baseline: 150/150 scored on 2026-11-13. Earlier aggregate-answer/v2 and provider-interrupted records remain in `evaluation/VALIDATION.md`. Preserve all original grades/seals; expanded current contracts require matched current-contract runs, not retrofitted historical manifests. Official Science tasks still need separately imported and audited environments; no official scientific quality is established.

Generated-output cleanup must retain real baselines and relevant failure evidence and consider comparison/incident/experiment dependencies. Tests own their temporary output roots and clean runs, caches and venvs even on failure. One-time cleanup audits live under `evaluation/local/cleanup/`.

## Maintenance

Add only reusable facts supported by code or runs; keep per-task truth in the collocated Task.md. Reconcile Draft changes with the user before calling this knowledge accepted. Do not infer broader benchmark coverage from entries marked planned/deferred.
