# Task: production-rag-retrieval

**Status:** Draft — agent-reviewed; exact spec not yet user-approved. Synthetic fixtures validate engineering behavior, not reviewed retrieval quality or a new holdout baseline.

Control-plane only; this spec, gold annotations and review records are never production component inputs. Repository-native adapter: `evaluation/adapters/rag/`; runtime: `evaluation/runtime/production-rag.ts`; independent source graders: `evaluation/graders/{rag,source-evidence}.mjs`. No Harbor packaging is provided.

## Purpose and evidence

Measure the real Roc research indexing and ranking component: `ResearchKnowledgeRepository`, `ResearchEmbeddingService`, chunk/source mapping, BM25, configured embeddings, RRF and semantic reranking. This is host-only retrieval, with no generation model, agent graph, applicationContract, runtimeVerification or application checkpoint. Component results do not establish E2E agent quality.

Normal runs have `evidence: "production-component"`; explicit fixture runs have `"fixture"`. BM25 without reranking makes no model calls. Hybrid embeddings or semantic reranking may call configured production providers through the trusted host and shared run budget. Fixture mode permits only BM25/no reranker. Local fabricated corpora remain engineering evidence even when processed by production code.

## Exact input and relevant conditions

Import a `schemaVersion: 1`, `modality: "text-native"` corpus through:

```sh
pnpm evaluate prepare rag-retrieval --corpus evaluation/local/reviewed-corpus.json
pnpm evaluate run --suite rag-retrieval --dataset /absolute/prepared-dataset --profile full --concurrency 2 --retrieval-options evaluation/local/retrieval-options.json
```

Use the directory actually returned by prepare. `--fixture` prepare/run is a separate engineering path. The frozen corpus includes document/project IDs, sourceId/version/URI/license/parserVersion, current-version flags, raw content and SHA-256, and ordered UTF-16 blocks. Tasks provide `visible: {question,documentIds}` and evaluator-only `expected: {answerability,answers,evidence,evidenceChains}` with source/hash/parser-bound evidence locators and relevance 1–3.

For each task, the host calls `research.knowledge.search` exactly once with:

```text
{query: task.visible.question, projectId: frozen project, limit: 20, embeddingConfigId: null}
```

The production wrapper applies the separately frozen retrievalConfig. Defaults: mode=bm25, rerank=none, candidateLimit=50, topK=20, contextMaxChars=6000. Allowed ranges are candidateLimit 50–200, topK 1–20 and contextMaxChars 200–8000; embeddingConfigId selects an existing configured identity when needed. Retrieval settings, provider identities, capability manifest and actual component schema hash are retained. There is no model-written answer or later human turn.

All corpus documents are indexed, including scope/version distractors; the request is project-scoped. Gold must resolve to visible current sources. Connected source IDs, old versions and sources joined by multi-paper tasks form one independent cluster. Related tasks cannot cross supplied development/holdout splits. Task families are single-paper, evidence-chain, unanswerable, cross-paper and conflict-stale.

## Environment, visibility and reset

Each repeat creates a private host ResearchKnowledgeRepository database and index. It uses production chunking/source mapping and permitted configured retrieval transport, with credentials confined to the trusted provider host. The index must match the frozen corpus and remain unchanged across the trial. Production databases, UI state, arbitrary external tools and agent filesystem execution are not used. Text-native inputs do not test PDF ingestion, vision or arbitrary parser correctness.

The runner freezes selection contentHash=`hash({visible,expected})`, source/worker identity, metricsHash/taskSchemaHash/scorerHash, retrievalProvider/config, permissions, environment, executionPolicy and budget. Default concurrency is two independent trials, configurable 1–8; each trial retains its own state and host-scoped accounting. Admission estimates are distinct from measured usage; embedding/rerank usage not exposed by production clients remains unknown.

Shutdown closes the host component, saves the detached `runtime.transportReceipts` snapshot to `reranker-transport-receipts.json` so late cancellation replies are retained, and preserves cleanup and immutable index evidence before independent verification. Safe resume accepts only unsealed runs under the same frozen plan/journal/budget/owner contract; dispatched work requires complete independently verifiable evidence and is never blindly reissued. See [manual lifecycle](../../README.md#安全续跑).

## Independent verification and grading

The component `ragContract` is version 1 with these hash-bound descriptors:

```text
runtime: roc-research-repository-embedding-service
sourceMapping: source-version-sha256-parser-utf16-v1
toolBoundary: host-component-request-bound-to-capability-receipt-v1
verification: sqlite-source-ranking-context-transport-v1
```

`verifyRagComponent` independently reads raw SQLite source/chunk/version state, frozen component request and schema, capability receipts and hash-bound ranking artifacts. It checks project scope, current-source boundaries, source/parser/UTF-16 mapping, candidate/hit consistency, immutable index and host cleanup. It does not claim checkpoint or ToolMessage verification. The trial retains `component-schema.json`, `component-result.json`, `component-cleanup.json`, index snapshots, `rag-artifacts/`, `rag-receipts.json`, `reranker-transport-receipts.json` and `rag-verification.json`; verified trials bind `{status:"verified",contractHash,evidenceHash}` to the byte SHA-256 of the verification file.

The transport contract independently reconstructs query/documents hashes and binds the original provider receipt/correlation to `events.jsonl` budget dispatch, settlement and retrieval-model completion. It checks content-addressed `rag-artifacts/<responseHash>.json` scores/receipt/correlation against the source candidates and final ranking. Successful reranking must descend by provider score, with RRF score breaking ties; selected hits and outputRank are independently reconstructed from candidates and persisted paper diversity metadata. Each grade retains its measured request sample in retrievalLatenciesMs for retrieval P50/P95; missing or empty measurements cannot pass the latency gate. No reranker requires an empty transport receipt array. Receipt status/elapsedMs does not fill missing token/cost usage. The old `sqlite-source-ranking-context-v1` descriptor fails current quality comparison even with a recomputed valid hash; historical artifacts remain unchanged.

| Metric | Independent scoring boundary |
|---|---|
| recall20 | Fraction of gold evidence spans completely covered by the first 20 returned hits; union of compatible source/version/hash/parser spans may cover one locator |
| ndcg10 | First ten ranks; each newly fully covered evidence gains credit once, using the maximum newly covered relevance at that rank; normalized against sorted gold relevance |
| evidenceChainRecall20 | Fraction of declared chains for which every evidence locator is covered in the first 20 hits |
| wrongSourceRate | Actual returned hits whose non-global project differs from the non-null requested project, divided by observed hits |
| staleHitRate | Actual returned hits missing a matching candidate or whose candidate indexedVersion differs from current chunk indexedVersion, divided by observed hits |

No hits produces measured wrongSourceRate/staleHitRate=0; it does not grant recall credit. Unanswerable tasks have no gold: recall20, ndcg10 and evidenceChainRecall20 are null with explicit `metricApplicability[metric]="not_applicable"`. Missing chain annotations also supply no chain-recall value. Unknown or unmarked null metrics are invalid. Means report applicable n and notApplicable counts rather than assigning NA scores of 0 or 1.

Missing/corrupt index, receipts, schema, mapping, evidence or cleanup is verifier/environment/harness invalid and makes the run incomplete. Quality comparisons additionally require every trial's wrongSourceRate and staleHitRate to be measured zero. Continuous retrieval scores and diagnostic success flags are descriptive; an empty-gold task can have success=null and does not invent a successful-task cost denominator.

## Review, comparison and acceptance

Quality evidence requires `datasetProvenance.kind="human_reviewed"`, review.draft=0 and a frozen `datasetReview` with schemaVersion=1/status=reviewed/producer. Every selected task attests `hash({visible,expected})` through at least two distinct reviewers independent of the producer; different judgmentHashes require a third independent arbiter bound to the same contentHash. Agent-reviewed specs, synthetic assertions and copied reviewer names are not human review evidence.

Each metric needs at least five applicable independent source clusters and three repeats; NA clusters do not meet this threshold. Applicability is frozen within a task, across repeats and across both arms. Complete production component evidence with verified provenance is necessary; controlled/synthetic/insufficient runs are unadoptable, including synthetic ten-question × three-repeat fixtures.

Ordinary comparison freezes tools/schema, retrieval config/provider, data/selection, grader/metric/task contracts, permissions and runtime evidence. Exact retrieval or capability differences require a protocol preregistered before two fresh arms, using `spec.kind="ablation"` and `spec.ablation`; the seed is not a scored arm. Paired cluster bootstrap uses 2000 samples, margin at most 0.05 and conservative multiplicity handling. Superiority requires preregistered primary metrics and a strictly positive benefit CI lower bound; noninferior is not a release decision. Frozen absolute floors/ceilings, resource degradation/budget gates and known-cost requirements still apply. See [EXPERIMENTS](../../EXPERIMENTS.md).

## Open decisions and limits

Reviewed production retrieval data and business-calibrated floors/resource ceilings must be supplied and audited separately. No new human-reviewed corpus, quality baseline or uncontaminated holdout is established by this spec. Provide enough applicable evidence chains for chain-recall comparisons; larger total task counts cannot compensate for fewer applicable clusters. Public text may already be in model training, and component results do not validate answer generation, abstention or citation behavior.
