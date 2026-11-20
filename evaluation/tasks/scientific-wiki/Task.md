# Task: scientific-wiki baseline

**Status:** Draft — agent-reviewed. This full scientific Wiki contract is not a registered `pnpm evaluate` suite. The public source-copy component has a production runtime and independent SQLite scorer, described below and in the [Scientific RAG guide](../../../docs/scientific-rag/README.md). Full qualification additionally requires human facts, original-PDF citation resolution, model generation and isolated source-update scenarios.

## Outcome and inputs

Measure current Paper Card/Wiki compilation, citations and stale propagation. Use actual paper sources, human reference facts and supporting gold evidence, production chunk/source mappings and original Evidence locators. Query answers alone are not a complete Wiki fact-coverage annotation set.

Freeze source/parse/index versions, Paper Card prompt/model/config, Wiki section/revision/Basis Digest, human reference facts and scorer contract. Reuse repository-native eval runner/isolation/budget/seals and the actual Paper Card/Wiki outboxes. Hide reference facts from the production model's generation input.

## Runtime and independent checks

Create a disposable private project/database/index per trial. Run actual `ResearchPaperCards` generation and Wiki compile, retaining outbox transitions, citations and immutable revisions. Provider failures, missing chunks and source/version mismatch remain explicit; they do not produce a success-shaped baseline.

| Metric | Evidence and denominator |
| --- | --- |
| Fact Coverage | Fraction of independently human-labelled supported facts represented accurately with all required experimental conditions; source correctness alone does not prove scientific agreement. Freeze human adjudication/scorer rules before running. |
| Citation Validity | Valid generated citations divided by all observed citations; resolve exact source/project/hash/parse/block/span and require the cited original evidence to support the associated fact. No citations is NA. |
| Stale Propagation | Fraction of predeclared affected dependencies/assistant sections marked stale or replaced by correctly sourced new revisions after an isolated source update. |

Update scenarios must declare affected and unaffected sections in advance. Use actual asynchronous reparse, source supersession and compile/resynthesize paths. Check original Evidence bytes, old immutable revisions and human-owned content remain exact; unaffected sections must not be needlessly changed. Never mutate a real user's project to score this spec.

## Implemented public component boundary

[Runtime](../../runtime/public-scientific-wiki.ts) exercises production Knowledge,
Evidence and Wiki repositories in disposable SQLite databases using locked QASPER text
sources. It captures the first 50 chunks per paper, compiles source/topic pages, retains a
declared assistant source-copy probe and explicitly invalidates one Evidence per paper.
[Host scorer](../../adapters/scientific-public/wiki.mjs) independently checks original
UTF-16 text intervals, source/parse identities, persisted excerpts, queued/ready jobs,
unchanged sections and immutable revisions. No Paper Card or model generation occurs.

The component report retains page/citation counts, source-copy validity, byte-exact copy rates and explicitly affected stale sections. Source-copy validity permits the production section boundary's whitespace trim and budget-limited source prefix; exact-copy rate preserves those differences. These metrics do not establish scientific support for a fact, original-PDF locator correctness or asynchronous reparse/supersession behavior. Fact Coverage and generated Citation Validity remain null unless independently measured under their full contracts; source-copy outputs keep `scientificBaselineReady:false`. Readable raw databases, sources and revisions are required to reverify any retained report.

## Results and shared performance

`wiki.json` contains per-fact/citation/update outcomes, source/model/prompt identities, captured revisions and human/scorer evidence. Preserve applicable counts and explicit null reasons for unmeasured judgments. `performance.json` across all four tasks retains actual P50/P95 samples, process peak RSS, full ingestion/index elapsed time and measured embedding/provider usage plus trusted pricing; estimates cannot replace measured cost.

Deterministic source checks and stale scenarios must repeat identically. LLM output, timing and resource samples are measurements under frozen conditions, not promised byte-identical results. Production unit fixtures prove contracts and recovery, not scientific fact coverage. Existing public component reports retain their measured scope; this Draft spec creates no full scientific quality claim.
