# Research performance baselines

§22.1 A1 measures the production SQLite FTS and sqlite-vec repository on isolated generated data. The harness does not contact providers or open a user database.

## Frozen retrieval protocol

[The protocol](research-performance-protocol.json) freezes 10,000 / 100,000 / 1,000,000 chunks, 384 dimensions, seed 19790527, four projects, 100 chunks per document, 20 samples per group, top 20 results, a 64 MiB SQLite connection cache, and WAL / NORMAL pragmas. Eight groups per scale combine English / mixed queries, all projects / project-0, and fresh / repeated connections. The P95 goals are FTS 2,500 ms, vector 2,500 ms, and total 5,000 ms.

Each chunk includes the common English and Chinese query terms. This stresses broad candidate sets; the generated corpus does not represent the relevance distribution of a real research library. Candidate counts describe eligible matches before the top 20 limit. Fusion counts describe the union of actual returned candidate IDs.

A fresh connection resets SQLite's page cache. It does not flush the OS or filesystem cache. Repeated connections run one unmeasured query first; this does not establish that the complete database fits in memory. Generated vectors measure exact cosine scan throughput and cannot establish semantic relevance.

## Reproduction and evidence

Run `pnpm research:retrieval-bench` (`node scripts/benchmark-research-retrieval.mjs`) from `/Users/Apple_501/Desktop/Roc/Roc`. The measurement baseline is `892a9cba`. The machine is a MacBookPro18,3 with 10 logical CPUs and 32 GiB RAM, macOS arm64, Node v26.13.0 and pnpm 12.5.1. The report records the SQLite version and actual pragmas.

Each scale runs in a separate child with a task-created temporary database, removed in `finally`. The harness uses the production schema, migrations, repository and sqlite-vec. It verifies chunk/vector counts, SQLite integrity and foreign keys, unique ordered top 20 results, and project isolation. Eligible FTS counts are computed outside timed searches. Existing repository stages are wrapped for measurement without adding a product API.

Full samples are in `.artifacts/research-optimization/retrieval-performance.json`; the log is `.artifacts/research-optimization/retrieval-full.log`. The compact durable report is [research-retrieval-baseline.json](research-retrieval-baseline.json). That report retains sample counts, percentile summaries, candidate counts, source hashes and the frozen protocol hash. RSS includes the worker's imports, generation and searches; the OS peak covers the complete worker lifetime. Disk bytes describe the checkpointed database, excluding transient WAL files.

The first 10k loader failed before measurement because a bundled native dependency attempted `require(fs)` from a data URL. The existing loader's native external / `.runtime` mode resolved the error. A second preflight passed, and the full run supersedes both preflight reports. No timing goals were changed.

## Acceptance limits

Independent human-reviewed Chinese, English and mixed query relevance is **Blocked, not run**. It requires reviewer provenance, frozen source hashes, judgments and an evaluation split. The existing provider-fusion evaluator is not evidence of local FTS or embedding quality.

SQLite remains the engine. A timing target miss requires investigation of candidate filtering and two-stage ranking before evaluating ANN or a different database. This benchmark does not authorize a database migration.

## Measured retrieval results

Status: **Verified passing** for benchmark execution and integrity; the FTS performance target remains unmet in one group. All 480 timed searches completed. Million-chunk mixed-query / all-projects / repeated-connection FTS P95 was 2508.8 ms, 8.8 ms above the frozen 2500 ms target. Other stage targets and all total-time targets passed. The A1B increment below resolves that miss without changing the query or ordering.

| Chunks | Maximum FTS P95 | Maximum vector P95 | Maximum total P95 | Database | Worker peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10000 | 12.9 ms | 11.8 ms | 24.9 ms | 37.3 MiB | 276.2 MiB |
| 100000 | 242.8 ms | 124.8 ms | 359.6 ms | 359.5 MiB | 660.9 MiB |
| 1000000 | 2508.8 ms | 1351.5 ms | 3717.6 ms | 3585.2 MiB | 3742.4 MiB |

Validation: `node --check scripts/benchmark-research-retrieval.mjs`, complete benchmark execution, report readback / protocol and sample consistency checks, and `git diff --check` all passed. No product code changed, so build and renderer checks are not repeated for this script/document increment.

## Narrow FTS ranking (A1B)

The production keyword search now materializes candidate IDs, document IDs, chunk indices and ranks, sorts and limits those rows, then loads text, titles, sources and locators for the selected hits. This removes large chunk payloads from broad candidate materialization. Body-first ordering, BM25, title deduplication, tie ordering and both chunk/document project boundaries remain intact. There is one current implementation.

Run `pnpm research:retrieval-bench .artifacts/research-optimization/retrieval-narrow-performance.json`. The starting commit is `c0cd1437` with the repository change recorded by the source hashes in [research-retrieval-narrow.json](research-retrieval-narrow.json). The original report remains unchanged. Full samples and logs are `.artifacts/research-optimization/retrieval-narrow-performance.json` and `retrieval-narrow-full.log`.

| Chunks | Maximum FTS P95 | Maximum vector P95 | Maximum total P95 | Worker peak RSS |
| --- | ---: | ---: | ---: | ---: |
| 10000 | 10.2 ms | 11.7 ms | 21.9 ms | 262.0 MiB |
| 100000 | 93.9 ms | 126.9 ms | 211.0 ms | 657.7 MiB |
| 1000000 | 1108.4 ms | 1361.7 ms | 2312.6 ms | 3728.9 MiB |

All 24 groups / 480 searches meet the frozen FTS, vector and total P95 goals. The million-chunk maximum FTS P95 falls 55.8%, and maximum total P95 falls 37.8%. Hardware, protocol hash, corpus hashes, candidate ranges, database bytes and pragmas match the original baseline; only the repository implementation hash changes. This is a repeat on generated broad-match data, with the cache and semantic-quality limitations stated above.

Verification from `/Users/Apple_501/Desktop/Roc/Roc`: `node --test tests/unit/knowledge-vector-search.test.mjs` passed 2/2, including production-schema keyword ordering/scoping/metadata and exact sqlite-vec ranking. Full benchmark and before/after report consistency checks passed. `pnpm build` (including typecheck), `node scripts/smoke-electron.mjs` (13/13, zero renderer errors), `pnpm check:ipc`, `pnpm check:renderer-chunks` and `git diff --check` passed. Logs use the `retrieval-narrow-` prefix in the same artifact directory. Status: **Verified passing** for this engineering performance change; independent retrieval quality remains unrun.

## Current PDF contract and long-document measurements (A2)

The parser and stored-content reader accept output contract 4 only. The benchmark's obsolete contract 3 route and environment switches are removed. Derivation generation 3 is still the current text/index identity and is independent from the output format.

`node scripts/benchmark-pdf-document-parser.mjs .artifacts/research-optimization/pdf-current-final-performance.json` runs three isolated worker samples for each of eight routes. The shared long fixture is 400 pages / 625,447 bytes, 612×792, Helvetica, 10 lines per page with 100 evidence words plus 10 page labels, and no images. Native full parse and page-201 local parse use production parser/outputs. A real AbortController cancels at page-5 layout; no later pages or output files remain. The production PDF.js/canvas probe paints pages 1/1/201/1 on one document, verifies cached page-proxy identity and cleans each page. It does not retain or claim a bitmap cache.

| Long native scenario | P95 elapsed | First native extraction P95 | Peak worker RSS P95 |
| --- | ---: | ---: | ---: |
| Full 400-page parse | 290.6 ms | 51.6 ms | 252.8 MiB |
| Page 201 local parse | 66.6 ms | 57.2 ms | See report |
| Cancel at page 5 | 72.3 ms | 56.0 ms | See report |

Cancellation response P95 is 2.6 ms from abort to parser rejection/cleanup. First extraction is an intermediate event; readable parse means completed and published parser output. Event-loop delay and page acquisition/paint timings are retained in [research-pdf-performance.json](research-pdf-performance.json), together with hardware, source/implementation hashes, sample measurements and the full raw-report hash. Three samples are a descriptive baseline; no percentile reliability or production OCR throughput claim is made. Scanned/mixed fixtures stop at real missing-model validation, clean output and never run inference.

The actual Electron reader uses the exact same long-PDF bytes and production parser/preview registry. Three repeated reader activations first paint at 1665.7 / 1673.4 / 1671.9 ms, including keyboard activation, sealed preview, protocol fetch and the native worker. Navigation to 201/400/1 checks nonempty source pixels, one visible canvas, at most 4 million pixels, one worker and full release on close. Browser first paint is separate from native extraction and parse completion. Raw evidence is `.artifacts/research-optimization/pr07-reader-selection/long-pdf-performance.json`; the compact report includes its hash and samples. OS cache is uncontrolled.

From `/Users/Apple_501/Desktop/Roc/Roc`, syntax check, 24 parser/cache samples, report/hash readback, `node --test tests/unit/architecture-repair-corpus.test.mjs` (14/14), `pnpm build` (including typecheck), and `node --test tests/renderer/paper-reader.test.mjs` (31/31) passed. Reader coverage also checks historical identity, source corruption, cancellation, keyboard interaction, light/dark layouts and clipping. `node scripts/smoke-electron.mjs` (13/13, zero renderer errors), `pnpm check:ipc`, `pnpm check:renderer-chunks` and `git diff --check` passed. Logs use the `pdf-current-` prefix. Status: **Verified passing** for current-contract parsing, this fixed native fixture and covered reader behavior; representative scanned OCR throughput remains unrun.

## Indexed graph neighborhoods and bounded lists (A3)

The renderer now projects actual `cites` and `sourced-from` relations into linear adjacency indexes. It expands shared-evidence claims only for the selected node; it does not materialize the shared-claim clique. Only loaded evidence establishes these relationships. Node and neighborhood lists paginate independently at 50 items, filter changes reset the node page, changing selection resets the neighborhood page, and reduced data clamps both pages. Narrow windows stack the detail region below the list. Neighbor buttons support keyboard selection and the existing assistant callback. The relation count describes recorded citations and sources.

Run `pnpm research:graph-bench` from `/Users/Apple_501/Desktop/Roc/Roc`. It uses production `deriveGraph` and neighbor functions on 100 / 300 / 1,000 / 10,000 / 50,000 claims sharing one loaded evidence, five samples each. Before execution, the harness fixes P95 goals of 2,500 ms derivation, 100 ms expanded-page lookup and 10 ms paging cached selected IDs. All pass. Five samples use nearest rank, so P95 is the maximum; these are descriptive measurements. RSS covers the same-process imports and prior scales, not an isolated per-scale peak.

| Claims | Recorded links | Derive P95 | Expand first page P95 | Page selected IDs P95 | Process peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 | 0.38 ms | 0.08 ms | 0.011 ms | 18.1 MiB |
| 300 | 300 | 0.56 ms | 0.04 ms | 0.002 ms | 21.0 MiB |
| 1000 | 1000 | 1.19 ms | 0.27 ms | 0.005 ms | 26.3 MiB |
| 10000 | 10000 | 14.56 ms | 0.95 ms | 0.005 ms | 108.4 MiB |
| 50000 | 50000 | 79.12 ms | 3.86 ms | 0.007 ms | 239.4 MiB |

The original 1,000-claim fixture generated 500,500 links and took up to about 651 ms. The original 100/300/1,000 samples remain in [research-graph-performance.json](research-graph-performance.json), together with current source/corpus hashes, hardware and raw-report hashes. The recipe and machine match. Raw files are `.artifacts/research-optimization/graph-baseline.json`, `graph-current.json` and their logs.

Real Electron tests mount the production view with the same 50,000-claim recipe three times and record two real animation frames after mount, 50 node buttons, 50 neighbor buttons and selected detail text. First-frame samples are in `graph-ui/first-frame.json`; they include derivation and DOM work, not database/network latency. Light/dark 1,250/1,099/650 px, static/hover/expanded/focus states retain visible controls, no horizontal overflow and clip-audit `cut=0`. Screenshots and audit receipts are under `graph-ui/`. This is bounded rendering of the current store projection; it does not establish database pagination or a force-layout benchmark.

Verification: `node --test tests/unit/renderer-derive.test.mjs` 11/11; `pnpm typecheck`; `pnpm build`; `node --test tests/renderer/knowledge-graph.test.mjs` 6/6. `node scripts/smoke-electron.mjs` 13/13 with zero renderer errors; `pnpm check:ipc`; `pnpm check:renderer-chunks` 1,134,468 eager bytes / six files; syntax and diff checks passed. Status: **Verified passing** for the graph projection, benchmark and tested renderer behavior.
