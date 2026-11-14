# Task: qasper-paper-evidence

**Status:** Draft — agent-reviewed; exact spec not yet user-approved.

This control-plane spec is never copied into the worker. The runnable implementation is the repository-native `evaluation/lib` adapter; no Harbor task.toml is provided.

## Purpose and evidence

Test actual Roc paper reading and evidence selection with independently annotated QASPER answers. Existing native fixtures establish runtime contracts but do not measure literature-answer quality. Source: locked official QASPER v0.3 train/dev archive, dev member, CC BY 4.0; archive/member SHA-256 are in sources.lock.json. Text adaptation excludes questions with visual/unmapped evidence in any annotation, reports exclusions, and does not claim the official full benchmark score.

## Agent input

Each dataset question generates exactly the prompt in `qasperInput(task)`:

> Read /workspace/paper.json using the available file tools. Answer this question about the paper: {question}
> Return only JSON with keys "answer" (string) and "evidence" (array of paragraph IDs such as p0). Use "Unanswerable" with no evidence if the paper does not answer the question. Cite only paragraphs supporting your answer.

`paper.json` contains title, abstract and ordered section paragraphs with generated paragraph IDs. The adapter adds an explicit production `responseContract` from these public IDs: exactly a nonempty answer string and an evidence array of declared, unique paragraph IDs. Empty visible source permits only empty evidence. The contract uses no annotation references and is frozen in the runtime snapshot. There is no later external human turn; the production graph may append one format-correction feedback message. The exact question/paper bytes are frozen in tasks.json and the per-trial workspace. Annotation references are evaluator-only.

## Relevant agent conditions

Real AgentPluginRuntime and DeepAgent executor in chat mode, fresh thread/database/checkpointer per repeat; only ls/read_file tools. The innermost model wrapper filters framework-added tools by the current scope manifest. Before dispatch, the host independently requires exactly these two names and retains the complete actual schema in tool-schema.json; schema drift within or between trials invalidates the run. Tools and prompt can affect results. No retrieval service, memory history, PDF vision, web browsing, subagents or production Electron UI is tested. Model uses the host stdio bridge; fixture mode makes two scripted requests and is wiring evidence only. Live calls use the existing Roc configured model through a read-only Electron model host and the production model factory; worker never receives credentials. The selected provider/model and actual context/output limits are frozen in both the run manifest and persisted runtime snapshot.

Framework filesystem descriptions encourage direct reads of known paths. The todo tool and its operating instructions are disabled when write_todos is unauthorized, including model-profile additions; framework memory injection preserves original content and replaces unavailable edit guidance. The main graph validates whole terminal JSON and may make one additional ordinary model call for correction. Its run-scoped count survives checkpoint restart; responses, feedback, usage and checkpoints remain recorded. Exhaustion completes generation with failed response acceptance and retains the native bad answer for independent grading. No output repair, truncation or schema tool is introduced.

## Environment

macOS sandbox-exec allows runtime dependencies and private trial files, denies host user files, child process-group escape and network. Paper workspace is read-only. Setup freezes source bytes/lockfile, actual tool manifest/schema, dataset identity/inventory and selected task IDs/clusters, model config, scorerHash, metricsHash/taskSchemaHash, environment/permissions and executionPolicy. Isolation probes must pass before acceptance. Reset is a new worker/workspace/SQLite per task/repeat; kill the process group and retain cleanup evidence.

Canonical entry: `pnpm evaluate run --suite qasper --dataset PATH --profile full`; `pnpm harness:bench` is a compatibility alias. Default concurrency=2, configurable 1–8 with isolated trial state. Request/task timeouts, input bytes, output tokens and transcript limits remain explicit. `--budget-options FILE` adds frozen cumulative request/input-output token/cost/task/run duration policy; cost needs an applicable frozen pricing table and actual usage. Admission reservations are not measurements. External provider transport is the permitted host network during live execution.

Only an unsealed run can use `pnpm evaluate run --resume PATH`: unchanged source/manifest/plan/journal/budget/owner and experiment binding must verify. Complete dispatched evidence is independently reverified/regraded; uncertain calls are never reissued. Sealed historical or incomplete runs are immutable. See [README](../../README.md#安全续跑).

## Verification

Adapter `qasper-roc-runtime-v3`, application contract schemaVersion 2, scores the final no-tool assistant message from the last root checkpoint after the host-only verifier independently binds it to the terminal model response and checks the frozen response contract against public task inputs. Serialized message constructors are parsed as data, never revived. The original aggregate completion/session text remains in output.json; selected final text is written to final-answer.json only after verification. No prose removal, fence stripping or JSON repair is performed.

| ID | Result | Independent evidence and exact check | Pass condition |
|---|---|---|---|
| Q1 | Structured answer | Plain JSON, exactly answer:string and evidence:string[] | Invalid output is agent failure, all metrics 0 |
| Q2 | Answer correctness | Official lower/punctuation/article normalization, multiset token F1; maximum across annotations | Continuous answerF1, not all-or-nothing |
| Q3 | Evidence selection | Paragraph IDs resolve to exact source paragraph text; official evidence set overlap divided by original list lengths; maximum across annotations | Continuous evidenceF1; empty/empty=1 |
| Q4 | Valid citations | Every paragraph ID exists and is unique | citationValidity 1 or 0; invalid citations keep independently computed F1 and count as agent failure |
| Q5 | Valid evidence chain | Read-only SQLite completed run/thread/root checkpoint; frozen prompt/response contract, workspace identity, provider/model/limits and manifest; indexed and hashed request/response streams; checkpoint-to-terminal answer equality; persisted events and aggregate session output; usage receipts and observed tool inputs; unchanged public paper bytes; worker hash, isolation probes, process exit and cleanup | All checks pass before scoring; missing/corrupt evidence is non-agent invalid and run incomplete |

Alternative annotations are accepted independently for answer and evidence per upstream scoring semantics. Unanswerable annotations become answer Unanswerable with empty evidence. Empty normalized answer F1 is 0. Wrong answers remain in the denominator. Unknown provider usage does not invalidate an otherwise complete run, but cannot satisfy token/cost gates or generate invented P50/P95/cost-per-success measurements. Mean over valid trials is descriptive, not a release pass.

Ordinary comparison requires the same frozen runtime/final-answer/response/tool/schema contract, data/selection, model/config, scorer, metrics/task schema, permissions, environment/executionPolicy and budget, plus every trial's verified evidence. Fixture, one-repeat, fewer than five applicable paper clusters or incomplete runs cannot pass. Paired cluster bootstrap uses 2000 samples, noninferiority margin at most 0.05 and conservative metric multiplicity. Superiority requires preregistered primary metrics with a strictly positive benefit CI lower bound and all metrics noninferior; noninferior is not release approval. Exact declared tool/retrieval differences require a separate preregistered two-fresh-arm ablation, never a permissive ordinary comparison. Experiments also freeze absolute/individual quality floors and resource/budget gates.

Fresh runs freeze `manifest.qasperQualification`, binding the locked official archive, its actual member and the complete deterministic text-adapted task bytes. Both quality-comparison arms must retain a readable `manifest.dataset.path`: comparison reloads it and checks the current source/derivation contract, saved qualification and selected official tasks. Missing, forged or unverified qualification returns `qasper_quality_provenance_unverified`. A locally sealed synthetic dataset or self-declared official source cannot qualify, including when real configured model/runtime evidence is complete. Those runs remain engineering diagnostics. Historical manifests missing the current qualification are preserved without amended provenance, rescoring or resealing; fixed-contract and ablation share this source gate.

The response requirements, application contract and filesystem descriptions changed from v2. A live v3 full run was completed on 2026-11-13: 50 questions × 3, 150/150 scored, using verified final answers. Its historical result summary remains in [VALIDATION.md](../../VALIDATION.md). Previous raw runs and supporting generated records, including historical baselines, were removed during the user-requested cleanup on 2026-11-14. Their summaries are not inspectable evidence; comparisons require fresh matched current-contract runs. No historical result summary is rescored or upgraded. Native QASPER answer/evidence/citation scoring remains distinct from source-span RAG evidence metrics.

## Fairness and leakage

Each supported question has visible textual source evidence; tools can page through the whole paper. References, graders, manifests and Task.md are outside agent access. The public dataset may already be in model training; the local paper-grouped holdout does not fix contamination. Invalid/duplicate citations cannot gain citationValidity. A fabricated answer with a syntactically valid citation can score poorly in answer/evidence F1 even though citationValidity=1. No claim of semantic equivalence beyond native token scoring.

## Open decisions

The Roc default model is used unless an existing provider/model pair is selected. Request size/time/budget policy is evaluator-only and frozen before dispatch. Profiles: smoke=1x1, fast=up to 5x1, full=up to 50x3 development; release=all supported holdout x3, paper-level hash partition. No paid judge. Noninferiority margin 0.05 and minimum cluster count are initial engineering settings requiring human calibration before use as a production gate. User approves manual triggering; exact spec remains Draft. See [EXPERIMENTS](../../EXPERIMENTS.md) for fresh claims and safe experiment resume.
