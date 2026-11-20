# Task: scientific-retrieval baseline

**Status:** Draft — agent-reviewed. This full scientific retrieval contract is not a registered `pnpm evaluate` suite. Public QASPER text and SciEGQA PDF region/block components have separate scopes in the [Scientific RAG guide](../../../docs/scientific-rag/README.md). The [corpus guide](../../corpora/scientific-rag/README.md#独立观测与评分入口) routes to full-PDF source resolution, new context observations and explicit query/request binding. A qualified result requires complete gold, independently resolved sources and actual runtime/context receipts; component summaries alone cannot establish it.

## Outcome and inputs

Measure current production retrieval against at least 200 human evidence queries in the six [corpus categories](../../corpora/scientific-rag/queries/README.md). Freeze real PDF sources, independent gold, parsed artifacts, production chunks/indexedVersion, embedding/reranker configuration revisions and provider identities.

Reuse [production-rag-retrieval](../rag-retrieval/Task.md), repository-native runner/isolation/budget/seals, source-evidence verifier and source-connected clusters. Its text-native corpus and scorer do not establish PDF/table/figure/equation baselines; scientific adapters must retain real ingestion and original PDF mapping rather than relabeling a text fixture.

Each trial uses a private production ResearchKnowledgeRepository and current ingestion/chunking/embedding paths. Scope the actual `research.knowledge.search` request to frozen target project/sources, request top 20 and preserve complete ranking receipts and actual context reads. Related papers and multi-paper tasks must remain in the same development/holdout source component.

## Independent metrics

| Metric | Definition and evidence |
| --- | --- |
| Recall@5/10/20 | Fraction of unique gold evidence spans fully covered by each prefix; only compatible sourceHash/parse identity and verified original-source mapping may combine coverage. |
| MRR@10 | Reciprocal of the first prefix-completion rank at or before 10 that fully covers a gold evidence span; 0 when no valid positive is covered. Compatible child intervals may combine within a prefix. |
| nDCG@10 | Relevance 1–3, `2^relevance-1` gain/log2(rank+1); each gold span gains credit once, maximum newly covered relevance per rank, ideal ranking fixed from gold. |
| Span Recall | Gold coverage in the actual assembled/read context, independently of ranked-hit recall. |
| Locator Accuracy | Fraction of observed returned/context source locators that independently resolve to the exact captured PDF/parse/block/span/page region. |
| Unanswerable behavior | Report unsupported positive retrieval/answer evidence separately; no positive gold means Recall/MRR/nDCG are NA, not 1 or 0. |

Query object targets must resolve to the actual source object/block and corresponding evidence. Gold IDs are independent annotation IDs; the adapter must persist the gold-to-production mapping, including missing objects. Incorrect/missing evidence does not receive credit from semantic similarity alone.

Preserve wrong-project and stale-hit checks from existing verification. Missing rankings/source mappings/receipts/cleanup are invalid trials; a model-written answer is not a retrieval-verification artifact.

The calculator contract in [scientific-evidence-scoring.mjs](../../lib/scientific-evidence-scoring.mjs) accepts original gold identities plus independently resolved required production ranges, and separate ranking/context locator observations. It does not resolve those ranges, validate human review or create runtime receipts. Confirmed absent production mappings remain zero-credit gold; unresolved mappings and failed/unavailable channels make the relevant metric NA. No single metric or macro mean qualifies a full cohort. Gold-to-parse alignment, source/quote/geometry checks and actual context capture are responsibilities of the adapters described below; full baseline qualification additionally requires reviewed gold and complete execution evidence.

The exact-block resolver preserves original gold IDs and offsets, requiring equal full text/page/kind/normalized geometry and unique correspondence; captured gold additionally requires exact parse and block identity. OCR changes, ambiguous or split/merged objects stay unresolved. Verified parse failures or exact objects missing full indexed text remain absent. Its host adapter verifies actual saved SciEGQA executions, reconstructs sources and SQL intervals, and fails closed on incomplete corpus qualification before gold-mode run reads. It does not bind new gold queries to historical search requests or capture context reads. Source observations alone provide no span scores or scientific baseline.

The separate context host captures new calls to current production `readContext` on the saved readonly DB: first 3 saved hits, 2000 chars/read, neighbors=true, ≤6000 chars/query. It preserves actual timestamp/result/hash/failure receipts and independently verifies source identity, raw-SQL neighboring parents and exact surrogate-safe UTF-16 budget windows. Rankings and separately read contexts use the calculator observation schema with original published query IDs. Failed reads, historical missing context and successful empty results remain distinct; duplicate returned neighbor occurrences are retained. This is no historical or agent-assembled-context observation, new gold query binding, unsupported-answer judgment or qualified span score.

The [explicit saved-query binding host](../../adapters/scientific-retrieval.mjs) checks full corpus qualification before accessing runs/bindings/context. Explicit published IDs and receipt digests, original gold query/resolver digests, exact boundary-trimmed request text and matching singleton target scope are required. Missing and cross-paper requests remain in the full cohort with unavailable channels/NA metrics. Optional new context reports are reconstructed from saved receipts, source ranges and SQL, with current compiler inputs/hash and complete counts checked; omitted context stays unavailable. Source-only readback and engineering binding regressions do not establish a qualified-gold host run or full scientific suite.

## Output and performance

`retrieval.json` stores per-query/per-category/applicable counts, input/config identities and verified production artifacts. Use actual request latency samples for P50/P95 and actual provider usage for cost; unknown usage stays null. Complete trials and all category quotas are required before publishing a qualified baseline.

Model-free frozen-vector or BM25 fixtures are engineering regressions. They do not provide actual scientific OCR/provider quality or total ingestion cost. The calculator always reports `calculated-unqualified` and `scientificBaselineReady:false`; its fabricated regression outputs are not baseline measurements. Published region/block metrics remain separate from full-span metrics.
