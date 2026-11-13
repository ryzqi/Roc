# Task: qasper-paper-evidence

**Status:** Draft — agent-reviewed; exact spec not yet user-approved.

This control-plane spec is never copied into the worker. The runnable implementation is the repository-native `evaluation/lib` adapter; no Harbor task.toml is provided.

## Purpose and evidence

Test actual Roc paper reading and evidence selection with independently annotated QASPER answers. Existing native fixtures establish runtime contracts but do not measure literature-answer quality. Source: locked official QASPER v0.3 train/dev archive, dev member, CC BY 4.0; archive/member SHA-256 are in sources.lock.json. Text adaptation excludes questions with visual/unmapped evidence in any annotation, reports exclusions, and does not claim the official full benchmark score.

## Agent input

Each dataset question generates exactly the prompt in `qasperInput(task)`:

> Read /workspace/paper.json using the available file tools. Answer this question about the paper: {question}
> Return only JSON with keys "answer" (string) and "evidence" (array of paragraph IDs such as p0). Use "Unanswerable" with no evidence if the paper does not answer the question. Cite only paragraphs supporting your answer.

`paper.json` contains title, abstract and ordered section paragraphs with generated paragraph IDs. No later human turn. The exact question/paper bytes are frozen in tasks.json and the per-trial workspace. Annotation references are evaluator-only.

## Relevant agent conditions

Real AgentPluginRuntime and DeepAgent executor in chat mode, fresh thread/database/checkpointer per repeat; only ls/read_file tools. The innermost model wrapper filters framework-added tools by the current scope manifest. Before dispatch, the host independently requires exactly these two names and retains the complete actual schema in tool-schema.json; schema drift within or between trials invalidates the run. Tools and prompt can affect results. No retrieval service, memory history, PDF vision, web browsing, subagents or production Electron UI is tested. Model uses the host stdio bridge; fixture mode makes two scripted requests and is wiring evidence only. Live calls use the existing Roc configured model through a read-only Electron model host and the production model factory; worker never receives credentials. The selected provider/model and actual context/output limits are frozen in both the run manifest and persisted runtime snapshot.

## Environment

macOS sandbox-exec allows runtime dependencies and private trial files, denies host user files, child process-group escape and network. Paper workspace is read-only. Setup freezes source bytes/lockfile, actual tool manifest, data identities, model config and scorer. Isolation probes must pass before a result can be accepted. Reset is a new worker/workspace/SQLite per task/repeat; kill the process group and retain cleanup evidence. Request/task timeouts, request input bytes, output tokens and transcript limits are explicit in config/code. There is no cumulative request/token quota or pricing table. External provider transport is the only permitted host network during live execution.

## Verification

Adapter `qasper-roc-runtime-v2` scores the final no-tool assistant message from the last root checkpoint after the host-only verifier independently binds it to the terminal model response. Serialized message constructors are parsed as data, never revived. The original aggregate completion/session text remains in output.json; selected final text is written to final-answer.json only after verification. No prose removal, fence stripping or JSON repair is performed.

| ID | Result | Independent evidence and exact check | Pass condition |
|---|---|---|---|
| Q1 | Structured answer | Plain JSON, exactly answer:string and evidence:string[] | Invalid output is agent failure, all metrics 0 |
| Q2 | Answer correctness | Official lower/punctuation/article normalization, multiset token F1; maximum across annotations | Continuous answerF1, not all-or-nothing |
| Q3 | Evidence selection | Paragraph IDs resolve to exact source paragraph text; official evidence set overlap divided by original list lengths; maximum across annotations | Continuous evidenceF1; empty/empty=1 |
| Q4 | Valid citations | Every paragraph ID exists and is unique | citationValidity 1 or 0; invalid citations keep independently computed F1 and count as agent failure |
| Q5 | Valid evidence chain | Read-only SQLite completed run/thread/root checkpoint; frozen prompt, workspace identity, provider/model/limits and manifest; indexed and hashed request/response streams; checkpoint-to-terminal answer equality; persisted events and aggregate session output; usage receipts and observed tool inputs; unchanged public paper bytes; worker hash, isolation probes, process exit and cleanup | All checks pass before scoring; missing/corrupt evidence is non-agent invalid and run incomplete |

Alternative annotations are accepted independently for answer and evidence per upstream scoring semantics. Unanswerable annotations become answer Unanswerable with empty evidence. Empty normalized answer F1 is 0. Wrong answers remain in the denominator. Unknown provider usage remains unknown and does not invalidate an otherwise complete run. Mean over all valid trials is descriptive, not a release pass. Version comparison uses the same frozen runtime/answer-boundary contract and per-trial verified evidence, alongside the other conditions and paired cluster bootstrap in report.mjs; fixture, one-repeat, fewer than five clusters or incomplete runs cannot pass a quality comparison. Earlier aggregate-answer runs remain diagnostic evidence and require a new live baseline; they are not rescored or upgraded.

## Fairness and leakage

Each supported question has visible textual source evidence; tools can page through the whole paper. References, graders, manifests and Task.md are outside agent access. The public dataset may already be in model training; the local paper-grouped holdout does not fix contamination. Invalid/duplicate citations cannot gain citationValidity. A fabricated answer with a syntactically valid citation can score poorly in answer/evidence F1 even though citationValidity=1. No claim of semantic equivalence beyond native token scoring.

## Open decisions

The Roc default model is used unless an existing provider/model pair is selected. Request size and time limits are evaluator-only. Profiles: smoke=1x1, fast=5x1, full=50x3 development; release=all supported holdout x3, paper-level hash partition. No paid judge. Non-inferiority margin 0.05 and minimum cluster count are initial engineering settings requiring human calibration before use as a production gate. User approves manual triggering; exact spec remains Draft.
