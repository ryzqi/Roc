# Research performance baselines

These are historical measurements, not current-run acceptance. Each durable JSON records the measured source identity, protocol, samples and limitations; documentation maintenance does not rerun benchmarks. `.artifacts/research-optimization/` contains optional local raw outputs. General validation boundaries are in [verification](verification.md).

## Reproduction

Run from the repository root. These commands exercise the current implementation and create new reports; they do not reproduce the historical source revision automatically.

| Scope | Entry point | Durable historical evidence |
| --- | --- | --- |
| SQLite FTS / exact vector retrieval | `pnpm research:retrieval-bench <report.json>` | [Original](research-retrieval-baseline.json), [narrow ranking](research-retrieval-narrow.json), [protocol](research-performance-protocol.json) |
| PDF parser / page-proxy reuse | `node scripts/benchmark-pdf-document-parser.mjs <report.json>` | [PDF](research-pdf-performance.json) |
| Indexed graph neighborhoods | `pnpm research:graph-bench` | [Graph](research-graph-performance.json) |
| Native process admission | `pnpm research:admission-bench` | [Admission](research-admission-performance.json) |
| Injected provider requests / cache | `pnpm research:network-bench` | [Network](research-network-performance.json) |
| Managed storage inventory | `pnpm research:storage-bench` | [Storage](research-storage-performance.json) |

Use a new output path and preserve historical reports. Benchmarks use isolated generated fixtures or injected requests, not a user database or live providers. Full report paths and hashes are recorded in the durable JSON.

## Frozen retrieval protocol and results

The protocol freezes 10,000 / 100,000 / 1,000,000 chunks, 384 dimensions, seed 19790527, four projects, 100 chunks per document, 20 samples per group, top 20 results, a 64 MiB SQLite connection cache and WAL / NORMAL pragmas. Eight groups per scale combine English / mixed queries, all projects / project-0 and fresh / repeated connections. P95 goals are FTS 2,500 ms, vector 2,500 ms and total 5,000 ms.

The 2026-11-06 original run starts at `892a9cba`; narrow ranking starts at `c0cd1437` with the implementation change identified by source hashes. The recorded machine is MacBookPro18,3, 10 logical CPUs, 32 GiB RAM, macOS arm64, Node v26.13.0 and pnpm 12.5.1. Each run completed 24 groups / 480 timed searches and checked production schema, chunk/vector counts, integrity, ordered unique top-20 results and project isolation.

| Chunks | Original FTS / vector / total P95 maxima | Narrow FTS / vector / total P95 maxima | Database | Original / narrow peak RSS |
| --- | --- | --- | ---: | --- |
| 10,000 | 12.9 / 11.8 / 24.9 ms | 10.2 / 11.7 / 21.9 ms | 37.3 MiB | 276.2 / 262.0 MiB |
| 100,000 | 242.8 / 124.8 / 359.6 ms | 93.9 / 126.9 / 211.0 ms | 359.5 MiB | 660.9 / 657.7 MiB |
| 1,000,000 | 2508.8 / 1351.5 / 3717.6 ms | 1108.4 / 1361.7 / 2312.6 ms | 3585.2 MiB | 3742.4 / 3728.9 MiB |

The original million-chunk mixed / all-projects / repeated FTS group missed its target by 8.8 ms. Narrow ranking met every frozen target: maximum million-chunk FTS P95 fell 55.8%, total P95 37.8%. It sorts and limits candidate identity/rank rows before loading selected text and metadata. The recorded comparison retains the same protocol, corpus, candidate ranges, database bytes and pragmas.

Every generated chunk contains common query terms, so this stresses broad candidate sets. Eligible-match counts precede top-20; fusion counts are returned-ID unions. Fresh connections reset SQLite page cache, not OS cache; repeated connections warm one query. Generated vectors measure exact scan throughput, not semantic relevance. RSS covers worker imports/generation/search; disk bytes exclude transient WAL. These timing results do not establish retrieval quality or authorize a database migration.

## PDF contract and fixed long-document fixture

The parser and stored-content reader accept output contract 4; derivation generation 3 is a separate text/index identity. The 2026-11-06 benchmark uses a 400-page / 625,447-byte, text-only fixture and three isolated samples per eight routes. Production native full parse and page-201 parse publish real outputs. Abort at page-5 layout leaves no later pages or output files. The PDF.js/canvas probe reuses page proxies on one document and cleans them; it does not establish a bitmap cache.

| Native scenario | P95 elapsed | First native extraction P95 |
| --- | ---: | ---: |
| Full 400 pages | 290.6 ms | 51.6 ms |
| Page 201 only | 66.6 ms | 57.2 ms |
| Cancel at page 5 | 72.3 ms | 56.0 ms |

Full-parse peak worker RSS P95 is 252.8 MiB; abort-to-rejection/cleanup P95 is 2.6 ms. First extraction is an intermediate event, distinct from published parse output. The linked report retains event-loop delay, page acquisition/paint timings, hardware and source/raw-report hashes.

Historical Electron reader first-paint samples for the same bytes were 1665.7 / 1673.4 / 1671.9 ms, including activation, sealed preview, protocol fetch and worker startup. Navigation 201/400/1 checked real pixels, one visible canvas, at most four million pixels, one worker and release on close. Native extraction and browser first paint are separate measurements. Three samples and uncontrolled OS cache support descriptive figures only; scanned/mixed fixtures stopped at missing-model validation, so representative OCR throughput remains unrun.

## Graph neighborhoods

The production projection indexes recorded `cites` / `sourced-from` relations and expands shared-evidence claims only for the selected node. It does not materialize a shared-claim clique. Loaded nodes and neighborhoods page independently at 50 items; this is bounded renderer projection, not database pagination or a force-layout benchmark.

Five samples per scale freeze P95 goals of 2,500 ms derivation, 100 ms first-page expansion and 10 ms cached-ID paging. All recorded groups pass.

| Claims / recorded links | Derive P95 | Expand first page P95 | Page selected IDs P95 | Process peak RSS |
| --- | ---: | ---: | ---: | ---: |
| 100 / 100 | 0.38 ms | 0.08 ms | 0.011 ms | 18.1 MiB |
| 300 / 300 | 0.56 ms | 0.04 ms | 0.002 ms | 21.0 MiB |
| 1,000 / 1,000 | 1.19 ms | 0.27 ms | 0.005 ms | 26.3 MiB |
| 10,000 / 10,000 | 14.56 ms | 0.95 ms | 0.005 ms | 108.4 MiB |
| 50,000 / 50,000 | 79.12 ms | 3.86 ms | 0.007 ms | 239.4 MiB |

The original 1,000-claim fixture generated 500,500 links and took up to about 651 ms; its samples remain in the report. Historical Electron checks mounted the same 50,000-claim recipe three times, inspected bounded lists, real frames, keyboard/focus and light/dark layouts. Five nearest-rank samples make P95 the maximum; RSS includes imports and prior scales.

## Admission, network and storage

| Baseline | Fixture and recorded result | Limit |
| --- | --- | --- |
| Native admission | Three samples × 12 finite probes / six projects; global 2, project 1, parser 1 and GPU 1 verified; bounded 10-second wait goal passed | Fixed 140 ms native holds measure admission/startup/cleanup, not engine throughput or a universal starvation deadline |
| Injected network | Five samples, scripted 25 ms fetch; request P95 <1,000 ms and cancellation <250 ms; cold cache ≈28 ms, warm <1 ms, two-failure recovery ≈839 ms | No sockets/live providers; policy clock is virtual, fetch/retry/cache/cancellation elapsed time is real |
| Storage | Five scans each of 1,000 / 10,000 generated 256-byte files; P95 16.53 / 154.08 ms against 5,000 ms goal; exact totals and zero database writes checked | Warm filesystem observations, not user-library or OCR/model throughput |

Admission receipts preserve wait/hold, resources and stdout/stderr. An initial native startup failure remains unexplained; subsequent regression runs passed without a claimed scheduler fix. Network fixtures cover cache scope/quotas, retries, payload validation, circuit recovery, cancellation and shutdown; invalid responses are not cached.

`research.getStorageUsage({projectId})` inventories configured managed roots without opening the user workspace or deleting files. Ownership and retention groups, missing roots and errors remain explicit; symlinks/invalid roots/I/O errors refuse partial success. Apparent bytes, per-group inode-deduplicated allocated blocks, logical vector/chunk payload and database allocation are distinct. Shared references and APFS allocation are not exclusive physical usage; unclassified bytes grant no deletion permission.

## Frozen retrieval engineering regression

Run the current adapter from the repository root:

```sh
pnpm evaluation:frozen-retrieval:check tests/fixtures/local-retrieval-quality-context-role-v2.json evaluation/local/frozen-retrieval/regression.json
```

Both paths are required. [The adapter](../evaluation/adapters/frozen-retrieval/index.mjs) evaluates the production repository/schema, FTS, exact sqlite-vec search and RRF in an isolated in-memory database with captured vectors. Reports declare `frozen-embedding` / `engineering-regression`; they measure supplied-vector ranking, not embedding generation, ingestion or index-build quality. Recall@20, graded nDCG@10, evidence-chain coverage, no-answer nonempty retrieval, returned IDs, language aggregates and hashes retain distinct meanings; chain coverage is not reasoning correctness and nonempty retrieval is not answer refusal.

[Contract-2 input](../tests/fixtures/local-retrieval-quality-context-role-v2.json) requires source/chunk and actual contextual embedding-input hashes, vector provenance, producer/reviewers/split and complete grades 0–3 for every in-scope chunk under the same two or more named strategies. Invalid IDs, provenance, judgments, scope, vectors or changed production inputs fail before scoring. Human-reviewed input requires a reviewer distinct from its producer; identities are declarations, not verified credentials.

The current engineering fixture binds 32 production document-input hashes, including scientific `Role:` context, while preserving original content/judgments and three-dimensional synthetic axis vectors. No model was called or vector regenerated. [The original input](../tests/fixtures/local-retrieval-quality.json) is byte-preserved and rejected by current inputs with `document_embedding_input_changed`; [its historical report](research-local-quality-fixture.json) records designed evaluator outcomes only. Input drift requires a new versioned fixture and provenance; real model vectors require re-embedding changed inputs.

Historical benchmark, integrity and focused runtime/renderer checks are recorded with each report. Independent human-reviewed local retrieval quality, representative scanned OCR, live-provider latency and user-library workload measurements remain unrun; none is established by these engineering baselines.
