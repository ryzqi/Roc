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
