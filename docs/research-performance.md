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

Status: **Verified passing** for benchmark execution and integrity; the FTS performance target remains unmet in one group. All 480 timed searches completed. Million-chunk mixed-query / all-projects / repeated-connection FTS P95 was 2508.8 ms, 8.8 ms above the frozen 2500 ms target. Other stage targets and all total-time targets passed. The next increment ranks narrow candidate rows before hydrating selected text, preserving the existing query and ordering.

| Chunks | Maximum FTS P95 | Maximum vector P95 | Maximum total P95 | Database | Worker peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10000 | 12.9 ms | 11.8 ms | 24.9 ms | 37.3 MiB | 276.2 MiB |
| 100000 | 242.8 ms | 124.8 ms | 359.6 ms | 359.5 MiB | 660.9 MiB |
| 1000000 | 2508.8 ms | 1351.5 ms | 3717.6 ms | 3585.2 MiB | 3742.4 MiB |

Validation: `node --check scripts/benchmark-research-retrieval.mjs`, complete benchmark execution, report readback / protocol and sample consistency checks, and `git diff --check` all passed. No product code changed, so build and renderer checks are not repeated for this script/document increment.
