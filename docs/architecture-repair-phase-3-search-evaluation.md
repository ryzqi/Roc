# Phase 3: Fuzzysort offline search evaluation

## Decision

Do not add Fuzzysort to the application. The candidate improved aggregate Top-5/Top-10 ranking on the manually labelled query set, but missed the observed performance and memory baseline at 10k and 20k paths. Keep the existing subsequence matcher and record this as a no-go for dependency adoption.

Phase 0 recorded baselines but did not define numerical regression limits. For this gate, the existing matcher is the comparison budget: the candidate should improve ranking without a material latency or memory regression. The measured candidate does not meet that bar.

## Method

- Production behavior was read from `src/main/services/file-service.ts`: `searchByName` trims and lowercases the query, checks the basename before the full path, and returns workspace-scoped results. `isSubsequenceMatch` and `compareFileNameSearchCandidates` provide the current matching and ordering. The repository LSP outline failed with `tree-sitter runtime failed to initialize`; source inspection used direct reads.
- The offline candidate used Fuzzysort 4.0.2 from an isolated `.runtime/fuzzysort-trial` package. No application dependency or production source was changed. It prepared separate `normalizedName` and `normalizedPath` snapshots, used threshold `0.25`, ranked basename hits before path-only hits, deduplicated by `relativePath`, then used the existing path-length and `localeCompare` tie break.
- The 50-path hand-labelled corpus covers abbreviations, duplicate basenames, long paths, Chinese, case, punctuation, accented and mixed Unicode, and word-separated queries. Each query records its relevant paths; the table below shows relevant result ranks through Top 10 (`—` means no relevant result in the Top 10). The full annotated Top-5/Top-10 output, including every ranked path’s relevance flag, is committed in `scripts/benchmarks/phase-3-file-name-search/quality-eval-results.json`. Each list contains all available matches up to its limit and is shorter when fewer results match.
- Quality metrics are macro averages over 15 queries. `P@k`, `Recall@k`, and `NDCG@k` use the manually labelled relevant-path set; the macro values were independently recomputed from all 15 query rows and match the aggregate table. Threshold `0.25` was selected for comparison because the package default `0.5` returned no `cfg` results and missed most `rpt` results; thresholds `0` and `0.25` returned the same set in this corpus.
- The 1k/10k/20k performance runs used identical `nested/file-000000.txt`-style trees for both matchers, `maxResults=20`, and 20 hot samples per query. The 20k measurements were repeated in three isolated worker runs; reported hot metrics are medians of each run’s p50/p95. Cold first-preparation figures are the three-run median at 20k. Environment: macOS `darwin-arm64`, Node `v26.12.1`.

## Ranking results

| Metric | Existing matcher | Fuzzysort | Change |
| --- | ---: | ---: | ---: |
| P@5 | 0.4267 | 0.4933 | +0.0666 |
| P@10 | 0.2267 | 0.2667 | +0.0400 |
| Recall@5 | 0.7844 | 0.9600 | +0.1756 |
| Recall@10 | 0.8111 | 1.0000 | +0.1889 |
| NDCG@5 | 0.7459 | 0.9306 | +0.1847 |
| NDCG@10 | 0.7615 | 0.9534 | +0.1919 |

| Query | Manually relevant paths | Existing Top-10 relevant ranks | Fuzzysort Top-10 relevant ranks | NDCG@5 | NDCG@10 |
| --- | --- | ---: | ---: | ---: | ---: |
| `rpt` | `analysis/report.md`; `docs/weekly-report.md`; `docs/annual-project-report.md`; `reports/quarterly-report.md`; `docs/research-plan-template.md` | 1, 3, 5, 6, 7 | 2, 4, 6, 7, 8 | 0.64 → 0.36 | 0.87 → 0.70 |
| `cfg` | `src/config/configuration.ts`; `settings/editor-config.json` | 2, 3 | 2, 3 | 0.69 → 0.69 | 0.69 → 0.69 |
| `api` | `src/main/ipc/file-api.ts`; `src/renderer/ipc/file-api-client.ts`; `docs/api-usage.md` | 1, 3, 4 | 1, 2, 3 | 0.91 → 1.00 | 0.91 → 1.00 |
| `cron` | `src/main/plugins/task/cron-parser.ts`; `docs/scheduler/cron-contract.md` | 3, 4 | 1, 2 | 0.57 → 1.00 | 0.57 → 1.00 |
| `readme` | `README.md`; `docs/ReadMe-Workspace.md` | 1, 2 | 1, 2 | 1.00 → 1.00 | 1.00 → 1.00 |
| `论文` | `papers/论文/方法比较.md`; `研究/论文引文管理.csv`; `docs/论文与数据.md` | 1, 2, 3 | 1, 2, 3 | 1.00 → 1.00 | 1.00 → 1.00 |
| `café` | `research/café/summary.txt`; `research/café/project-notes.md`; `research/cafe-notes.md` | 1, 2 | 1, 3, 4 | 0.77 → 0.91 | 0.77 → 0.91 |
| `résumé` | `papers/résumé/model.txt`; `docs/resume-style.md` | 1 | 1, 2 | 0.61 → 1.00 | 0.61 → 1.00 |
| `foo.bar` | `src/types/foo.bar.ts` | 1 | 1 | 1.00 → 1.00 | 1.00 → 1.00 |
| `index` | `src/main/index.ts`; `src/renderer/index.ts`; `src/renderer/workspace/index.ts`; `src/main/services/file-index.ts`; `src/renderer/workspace/file-index-panel.tsx` | 1, 2, 3, 4, 5 | 1, 2, 3, 4, 5 | 1.00 → 1.00 | 1.00 → 1.00 |
| `analysis` | `projects/2025/experiments/longitudinal/studies/cohort-a/analysis-results.md`; `src/main/research/analysis-summary.ts`; `analysis/report.md`; `analysis-notes.txt` | 1, 2, 3, 4 | 1, 2, 3, 4 | 1.00 → 1.00 | 1.00 → 1.00 |
| `watcher` | `src/main/files/watcher-service.ts`; `src/main/services/file-watcher.ts`; `src/main/workspace/file-watcher-state.ts` | 1, 2, 3 | 1, 2, 3 | 1.00 → 1.00 | 1.00 → 1.00 |
| `async action` | `src/renderer/shared/use-async-action.ts` | — | 1 | 0.00 → 1.00 | 0.00 → 1.00 |
| `file search` | `src/main/services/file-search.ts`; `docs/file-search-guide.md`; `workspaces/current-project/file-search-settings.json` | — | 1, 2, 3 | 0.00 → 1.00 | 0.00 → 1.00 |
| `研究计划` | `docs/重要研究计划.md` | 1 | 1 | 1.00 → 1.00 | 1.00 → 1.00 |

The gains come mostly from word-separated queries that the existing subsequence matcher cannot match. There are query-specific losses: for `rpt`, Fuzzysort ranks `src/shared/retry-policy.ts` first and reduces NDCG@5 from `0.64` to `0.36`; `cfg` is unchanged. Accent-insensitive normalization also broadens the `café` result set, including the unrelated `cache/cafe-green-graph.json` near the top. The Unicode evaluation covers CJK plus precomposed and unaccented Latin diacritics; the compatibility script also records a filesystem probe that attempts to create both NFC and NFD `café.md` names. On this macOS filesystem it produced one observed `café.md` entry, so the run does not establish behavior across all Unicode normalization forms. These are visible tradeoffs in the annotated set, not hidden by the aggregate score.

## 1k/10k/20k performance

Times are milliseconds except memory. Candidate cold name includes the FileService snapshot build, both Fuzzysort `snapshot()` constructor calls, and the first name `go()`. Cold path after basename includes the FileService snapshot build, Fuzzysort constructor calls, and the first path `go()`; it excludes the earlier name-query wall time, matching the baseline path column, which also excludes the initial name-query wall time. In Fuzzysort 4.0.2, `snapshot()` schedules preparation and the first `go()` calls `_finish()` synchronously, so its timer includes index construction. A separate path-first measurement below records a complete initial path request. For 20k, baseline/candidate hot numbers are medians over three runs, each with 20 hot samples; the 1k/10k numbers are single runs.

| Paths | Baseline cold name | Candidate cold name | Baseline cold path total | Candidate cold path total | Hot name p50/p95 baseline → candidate | Hot path p50/p95 baseline → candidate | Candidate extra heap | Peak RSS baseline → candidate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 14.506 | 10.661 | 7.429 | 9.483 | 0.059 / 0.071 → 0.116 / 0.134 | 0.092 / 0.149 → 0.115 / 0.146 | 2,159 KB | 61,680 → 68,832 KB |
| 10,000 | 47.371 | 48.527 | 40.658 | 51.772 | 0.563 / 0.762 → 0.836 / 0.913 | 0.992 / 1.037 → 0.844 / 0.892 | 19,327 KB | 80,112 → 119,568 KB |
| 20,000 | 78.038 | 86.293 | 70.264 | 93.782 | 1.501 / 1.726 → 1.646 / 1.873 | 2.396 / 2.472 → 2.204 / 2.577 | 38,395 KB | 151,616 → 176,672 KB |

At 20k, the first name `go()` took a median `18.410ms` and the first path-first `go()` took `32.995ms`; each includes synchronous Fuzzysort index preparation. Constructing both Fuzzysort snapshots took a median `0.120ms` and is included in the cold totals above. The two prepared snapshots retained about `38.4MB` additional JS heap and increased median peak RSS by `25,056KB`. Hot basename p50/p95 regressed by about `10%`/`9%`; hot path p50 was about `8%` faster while p95 was about `4%` slower.

Across three fresh-worker path-first runs, the median candidate initial path request was `100.691ms` versus `70.219ms` baseline, about `43%` slower. The candidate total includes a `67.577ms` median FileService snapshot build, `0.120ms` Fuzzysort snapshot construction, and a `32.995ms` first path `go()` that prepares and searches the index. The baseline total includes snapshot build and the first path search.

Both matchers returned 20 results and marked `truncated=true` for the `file-0` and `nested` 20k queries. The offline candidate checks also passed empty-query order, result-limit truncation, deterministic ordering, unique-path checks, and baseline tie-order compatibility for equal-score `a/report.md` and `b/report.md`. Passing `snapshot.truncated=true` with no matches kept the candidate `truncated=true`.

An additional run created 50,000 real files and exercised the actual `FileService` snapshot builder. It produced exactly 20,000 indexed entries with `snapshot.truncated=true`; both baseline and candidate returned 20 and set `truncated=true` for name and path queries. The candidate added `38,395KB` heap at the cap. In the fresh path-first worker, the candidate took `119.927ms` end to end versus `90.560ms` for the baseline path search including snapshot construction.

The real-filesystem compatibility check used actual `FileService` snapshots in two workspaces. It verified ignored `.git`/`node_modules` directories and symlinks stay excluded, basename hits precede path-only hits, paths are unique, equal-score basename ties match the existing comparator, the empty-query traversal order is retained, max-result truncation matches, and workspace A results do not leak into workspace B. The same script records that this macOS filesystem exposes one directory entry after both precomposed and decomposed `café.md` names are written.

## Reproduction

The isolated trial package is Fuzzysort 4.0.2 under `.runtime/fuzzysort-trial/package`; no root dependency is needed. From the repository root, recreate it with `mkdir -p .runtime/fuzzysort-trial/package`, `npm pack fuzzysort@4.0.2 --pack-destination .runtime/fuzzysort-trial`, then `tar -xzf .runtime/fuzzysort-trial/fuzzysort-4.0.2.tgz -C .runtime/fuzzysort-trial/package --strip-components=1`. The committed scripts under `scripts/benchmarks/phase-3-file-name-search/` load `FUZZYSORT_MODULE` when set, otherwise they resolve `.runtime/fuzzysort-trial/package/fuzzysort.js` from the repository root. The query labels are embedded in `quality-eval.mjs`; `quality-eval-results.json` is the captured threshold-0.25 output with complete baseline/candidate Top-5/Top-10 paths and relevance labels (up to the number of available matches). Other transient run logs are generated under `.runtime/fuzzysort-trial/` and are not checked in.

Commands used from the repository root:

- `FUZZY_THRESHOLD=0.25 node scripts/benchmarks/phase-3-file-name-search/quality-eval.mjs > .runtime/fuzzysort-trial/quality-results-0.25-final.json`
- `FUZZY_THRESHOLD=0.5 node scripts/benchmarks/phase-3-file-name-search/quality-eval.mjs > .runtime/fuzzysort-trial/quality-results-0.5-final.json`
- `CORPUS_SIZE=1000 node scripts/benchmarks/phase-3-file-name-search/performance.mjs > .runtime/fuzzysort-trial/benchmark-1000-corrected.json`
- `CORPUS_SIZE=10000 node scripts/benchmarks/phase-3-file-name-search/performance.mjs > .runtime/fuzzysort-trial/benchmark-10000-corrected.json`
- `CORPUS_SIZE=20000 node scripts/benchmarks/phase-3-file-name-search/performance.mjs > .runtime/fuzzysort-trial/benchmark-20k-corrected-r1.json` (repeat for `r2` and `r3`)
- `CORPUS_SIZE=50000 node scripts/benchmarks/phase-3-file-name-search/performance.mjs > .runtime/fuzzysort-trial/benchmark-50k-cap-corrected.json`
- `node scripts/benchmarks/phase-3-file-name-search/snapshot-compatibility.mjs > .runtime/fuzzysort-trial/snapshot-compatibility-results.json`

## Gate outcome

Ranking quality improved on the 15-query set, but the 10k/20k preparation and memory cost and the 20k hot-name regression exceed the observed baseline. Do not add Fuzzysort or change production matching. The experiment was isolated under `.runtime/fuzzysort-trial`; no root dependency, lockfile change, or production code change was made for Phase 3.
