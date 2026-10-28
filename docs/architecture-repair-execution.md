# Roc Architecture Repair Execution Record

This record accompanies `docs/architecture-repair-plan.md`. Each phase is reviewed independently, review findings are fixed before its commit, and compatibility gates may conclude with a documented no-go.

## Phase 0 — Baseline and behavior contracts

**Status:** Complete. Candidate decisions remain for their assigned phases.

### Reproducibility

- Baseline commit: `f4d06e5eee35bb575cac7eb0fbb02d96d9512619` on `main`, parent/reference `32d7ece1947d59f57b13d29630beca9783293dcf`; initial checkout was one commit ahead of `origin/main`.
- Lockfile blob: `134cb0acc11120ba8e070ace2071e6b7d8c0e89d` (`pnpm-lock.yaml`).
- Machine/runtime: macOS 27.0.1, `darwin-arm64`, MacBookPro18,3 / Apple M1 Pro, Node `v26.12.1`, pnpm `12.5.1`, Electron `45.0.0`, electron-vite `6.0.0`.
- The supplied `docs/architecture-repair-plan.md` was untracked at the start and is preserved as user input; it is not included in implementation commits.

### File-name search

Command: `node scripts/benchmark-file-name-search-snapshot.mjs .artifacts/architecture-repair-phase-0-file-name-baseline-reviewed.json`

The runner creates each corpus in a separate Node process and measures the existing `FileService` implementation. It runs query `file-0`, `maxResults=20`, 10 cold rebuild/query samples and 10 hot query samples. `peakRssKb` is Node `process.resourceUsage().maxRSS` for that worker. Artifact: `.artifacts/architecture-repair-phase-0-file-name-baseline-reviewed.json`.

| Corpus | Indexed | Build p50/p95 (ms) | Cold query p50/p95 (ms) | Hot query p50/p95 (ms) | Peak RSS (KB) | Truncated |
| ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 1,000 | 1,000 | 3.564 / 5.859 | 3.685 / 6.022 | 0.077 / 0.120 | 175,072 | yes, 20-result cap |
| 10,000 | 10,000 | 32.744 / 34.217 | 33.688 / 35.561 | 0.555 / 1.236 | 231,744 | yes, 20-result cap |
| 20,000 | 20,000 | 64.356 / 65.493 | 66.031 / 67.810 | 1.353 / 1.517 | 237,856 | yes, 20-result cap |
| 50,000 | 20,000 | 84.537 / 86.907 | 86.909 / 88.719 | 1.165 / 1.214 | 241,408 | yes; actual snapshot cap reached |

The 50k case confirms that only 20,000 paths are indexed. The recorded truncation flag is true in every case because `file-0` has more than 20 matching results; the flag also needs to remain true when the path visit cap is reached. The benchmark is synthetic and is not evidence for performance on a user's real workspace.

### PDF parse and artifact contracts

Command: `node scripts/benchmark-pdf-document-parser.mjs .artifacts/architecture-repair-phase-0-pdf-baseline-reviewed.json`

The runner uses the corpus PDF `tests/smoke/lib/assets/p5-paper.pdf` (30,474 bytes, SHA-256 `ee02484891e45e98e89d5682f6dc90562302e1fe5ee5a15f9cad9f0b4d18ddd5`) for the native-text scenario and generated one-page scanned/mixed PDFs for routing. Each scenario runs in a separate Node process. Artifact: `.artifacts/architecture-repair-phase-0-pdf-baseline-reviewed.json`.

| Scenario | Result | Elapsed (ms) | Peak RSS (KB) | Stage times (ms) | Output bytes |
| :--- | :--- | ---: | ---: | :--- | ---: |
| Native-text, page 1 | `native-text` | 269.554 | 167,024 | text 27.485; render 166.946; PNG encode 30.001; page write 0.748; artifact write 0.774 | 72,729 |
| Scanned routing | Stops at model validation with `ENOENT` | 200.970 | 152,944 | text 2.175; render 156.291; PNG encode 0.402; page write 0.618; OCR raster 0.034; model validation 0.066 | 0 after cleanup |
| Mixed routing | Stops at model validation with `ENOENT` | 244.159 | 164,272 | text 8.702; visual inspection 3.246; render 158.011; PNG encode 29.423; page write 0.770; OCR raster 0.530; model validation 0.102 | 0 after cleanup |

The native-text output contains `pages/page-1.png` (67,180 bytes), `artifacts/middle.json` (2,570 bytes), `artifacts/structured.json` (2,570 bytes), and `artifacts/document.md` (409 bytes). The two JSON files are byte-identical at this baseline. The page PNG remains required by `tests/unit/architecture-repair-corpus.test.mjs`, even when OCR raster allocation/inference is skipped. The parser exposes contract version 3, page locations, blocks, assets, `middleJson`, and `structuredContent`; errors clean the output directory. Scanned and mixed inference timing is not measured because model weights are intentionally absent from the source tree and are installed only by user action. The measured failures establish only the pre-inference path and cleanup behavior.

### Cron behavior contract

`src/main/plugins/task/cron-parser.ts` exports `parseCronExpression(expression: string): ParsedCronExpression` and `computeNextCronRunAt(expression: string, after: Date = new Date()): string`. It accepts exactly five numeric fields with comma lists, increasing ranges and positive steps; Sunday `7` maps to `0`. Day-of-month and day-of-week are both required to match (AND). Calendar calculations use the system local timezone and return an ISO timestamp. The next-run search is bounded by `366 * 24 * 60` effective minutes plus a four-day offset margin; timezone offset increases are sampled every six hours. Invalid input and no match use `background_task_cron_invalid` (`Cron 表达式无效。`). No Cron parser-specific tests exist at baseline. Preserve this contract, including the bounded search, when comparing Croner.

### Checkpointer recovery and lifecycle contract

`RocSqliteCheckpointer` is used by runtime/session recovery, session repository, interrupt projection, retention, and task-history deletion. Its additional recovery methods are `hasCheckpoint(threadId: string): boolean`, `readPendingInterrupts(threadId: string): RocCheckpointInterrupt[] | null`, and `validateCheckpointIntegrity(threadId: string): { valid: boolean; issues: string[] }`.

- Recovery fails closed when a checkpoint is missing, corrupt, unreadable, or cannot be validated; pending approval interrupts are preserved and wait for the user.
- `pendingWrites` read order is `(task_path, task_id, idx)`, not insertion order; path comparison follows SQLite BINARY/codepoint ordering. Missing task paths restore as the root path.
- Integrity is scoped to `(thread_id, checkpoint_ns, checkpoint_id)`; orphan writes and cross-namespace parent links are rejected.
- Backup restore tolerates the empty legacy schema, fills the legacy `task_path` column, skips duplicate keys, rejects malformed/view schemas, and propagates invalid-row failures without partial insertion.
- Retention deletes excess checkpoint rows only after protecting active/recent threads and threads with pending interrupts. Recovery compatibility must account for its bounded checkpoint retention.

Relevant contracts are covered by `tests/unit/checkpoint-write-order.test.mjs` and `tests/unit/operation-recovery.test.mjs`. `src/main/plugins/agent/interrupt-projection.ts` reads pending interrupts through the checkpointer interface; no replacement should make that consumer depend on another implementation's private schema.

### Renderer resource inventory

`useAsyncResource<T>(key: string | null, load: () => Promise<IpcLikeResult<T>>, { label }: AsyncResourceOptions): AsyncResource<T>` owns state per hook instance, drops data immediately on key changes, ignores stale responses, and offers explicit `reload()`. There is no global cache or cross-component request dedupe; SWR is absent.

- Project portal calls `listProjects()` using key `projects` in `src/renderer/project/use-projects.ts`.
- Command palette calls the same `research.listProjects()` IPC resource using a changing key `search-projects:${searchToken}` in `src/renderer/shell/use-search-groups.ts`.
- Project create/update/delete actions are exposed by `useProjects`; callers currently control when `refresh()` reloads the portal list. A project list/search shared-cache pilot is plausible, but phase 5 must prove mount overlap and write invalidation before adopting SWR.
- Model status is also read from settings (`settings:models`) and PaperReader (`research-models`). Settings polls during downloads and refreshes after select/download/import/remove/cancel; this is shared data but not the ordinary project/literature list required by the plan.
- Existing project-scoped resources must never display a prior project's data after switching. `useAsyncAction` uses a boolean `pending`; evaluate concurrency at its call sites before changing it independently of SWR.

### Baseline verification

| Command | Result |
| :--- | :--- |
| `node --test tests/unit/file-name-search-snapshot.test.mjs tests/unit/architecture-repair-corpus.test.mjs tests/unit/checkpoint-write-order.test.mjs tests/unit/operation-recovery.test.mjs` | Pass: 41 tests, 0 failures, 1.756 s |
| `pnpm check:ipc` | Pass: generated IPC files are current |
| `pnpm check:renderer-chunks` | Pass: eager JS 1,076,870 bytes across 6 files |
| `pnpm smoke:performance` | Pass: Electron verified workspace `better-sqlite3` |
| File search benchmark | Pass; results above |
| PDF parse baseline | Pass; native-text succeeds, scanned/mixed stop at expected absent-model validation boundary |

## Phase 0 review and resolution

The independent reviewer found two measurement reliability issues, both fixed before commit:

- The PDF runner previously returned success after catching any parser error. It now asserts that native-text parsing succeeds with the expected route and artifacts, while scanned/mixed inputs reach model validation, fail with `ENOENT`, skip inference, and clean output. Any deviation exits unsuccessfully.
- The file-search runner previously inferred cap exhaustion from `corpusFiles > indexedEntries`. It now records the snapshot's actual `truncated` field, which is set by the bounded traversal.

After these fixes, both benchmarks were rerun with the reviewed artifact paths listed above. The focused 41-test contract command, IPC check, renderer chunk check, and performance smoke had already passed; the changed scripts also passed LSP diagnostics.

## Phase 1 — Path snapshot invalidation

**Status:** Complete. Phase 1 implementation, validation, review resolutions, and execution record are committed.

### Changes

- Known `change` events no longer invalidate the name snapshot when their filename is already present in the current snapshot; they still publish the debounced workspace content event. An unindexed filename reported as `change` invalidates with `watcher.unindexed-content-path`, so new files do not wait for the 60-second reconcile. `rename`, empty/unknown filenames, unknown event types, and watcher startup/runtime errors invalidate with a recorded reason. The 60-second reconciliation remains unchanged.
- `FileService` records build attempts, duration, indexed count, truncation, build reason, whether a stale generation was committed, and invalidation reason. A single shared build promise retries when the generation changes, so concurrent invalidations during a traversal collapse into one follow-up scan for the latest generation. Workspace identity is checked before each scan and before results are returned.
- Path-changing Roc operations now invalidate explicitly: creating/deleting files through `FileService`, Git discard/branch checkout, Agent atomic writes, and Research workspace/template atomic saves. Research writes invalidate after temporary-file cleanup on success, rollback, and aborted publication. The workspace plugin receives research/agent notifications through `workspace.path-structure-changed`. Plain `FileService` overwrite of an existing path does not invalidate because it does not rename or change the indexed path set.
- Inventory confirmed `.roc-research` is traversed by file-name search, so Research template and workspace writers need notifications. Document/library storage, experiment run data, and other job/export staging use their configured feature roots rather than the selected workspace. Arbitrary shell/terminal commands remain observed by the filesystem watcher and 60-second reconciliation because their path effects are not available as typed application operations.
- No runtime dependency was added. The only additional lint repair was documenting the existing Node/Web `ReadableStream` cast with its runtime invariant.

### Evidence

| Check | Result |
| :--- | :--- |
| `node --test tests/unit/agent-filesystem-path-invalidation.test.mjs tests/unit/file-name-search-snapshot.test.mjs tests/unit/research-workspace-files.test.mjs tests/unit/research-template-path-invalidation.test.mjs` | Pass: 23 tests, 0 failures |
| `pnpm typecheck` | Pass: `tsc --noEmit -p tsconfig.json` |
| `git diff --check` | Pass |
| `node scripts/benchmark-file-name-search-watcher.mjs 100` before changes | 100 ordinary content events caused 101 builds and 100 invalidations; 12.313 ms |
| `node scripts/benchmark-file-name-search-watcher.mjs 100` after changes | 100 ordinary content events caused 1 build and 0 invalidations; 13.947 ms |
| LSP diagnostics | A broad scan confirmed 12/13 files, with `src/main/plugins/research/index.ts` timing out without a finding; final targeted diagnostics on `src/main/services/workspace-change-watcher-service.ts`, `src/main/services/file-service.ts`, and `src/main/plugins/workspace/index.ts` are clean. Full TypeScript check passed. |

The first independent review found that a new path reported as `change` would otherwise be treated as content-only until TTL expiry. `FileService` now checks exact snapshot membership, invalidates unindexed paths, and a regression test covers the new-file `change` case. A follow-up subagent review found no additional issues.

## Phase 2 — Croner adapter

**Status:** Complete. The independent subagent review found no issues; this execution record is included in the Phase 2 commit.

### Changes

- Added `croner@10.0.1` as the calculation engine while leaving Roc's task repository, occurrence deduplication, restart recovery, missed-run policy, approvals, and run lifecycle unchanged. `ParsedCronExpression` had no external callers and is now module-private; `parseCronExpression` remains the strict grammar gate.
- The adapter selects five-field mode, sets `domAndDow: true`, leaves Croner paused, and omits `timezone` so calculations follow the host's current local timezone without creating a timer. Invalid expressions keep `background_task_cron_invalid` and `Cron 表达式无效。`.
- The old parser treats a numeric `start/step` segment as a singleton, while Croner expands it. The adapter normalizes only after strict Roc validation. Croner's DST-gap result is accepted only when `job.match(next)` confirms the requested local time; otherwise the search continues. The 366-day effective-minute boundary and six-hour offset sampling remain in place.
- Added a 64-entry LRU of paused Cron jobs. Cache keys use the exact validated expression, so an invalid expression that normalizes to a valid pattern cannot bypass validation. Evicted jobs are stopped; measured retained heap for 64 jobs was 5.13 MiB.

### Evidence

| Check | Result |
| :--- | :--- |
| `node --test tests/unit/cron-parser-compatibility.test.mjs` | Pass: 6 tests, including grammar/error mapping, minute/date/day boundaries, leap years, cache-validation collision, dynamic local-timezone changes, Singapore, and New York DST |
| Old/new differential | Pass: 800 generated cases across UTC, Asia/Singapore, America/New_York, Europe/Berlin, and Australia/Lord_Howe; 0 mismatches |
| `pnpm typecheck` | Pass: `tsc --noEmit -p tsconfig.json` |
| `git diff --check` | Pass |
| Warm repeated computation | Daily: 3.50→1.83 µs; every 15 minutes: 4.17→1.68 µs; every minute: 5.21→2.56 µs; Feb 29: 108.90→68.08 µs |
| 30-day missed-run recovery | 43,200 one-minute occurrences: 224.28 ms legacy vs 142.13 ms adapter; both ended at `2026-01-31T00:00:00.000Z` |

The bounded cache matters because `resolveScheduledOccurrenceSchedule` advances missed occurrences inside `claimInCurrentTransaction`, which runs within SQLite transactions. Raw per-call Croner construction was 9–12× slower on common schedules; the warm bounded-cache path is faster than the old parser and uses no scheduled timer.

## Phase 3 — Fuzzy search comparison

**Status:** Final Standards and Spec reviews passed with no findings. The offline result is a no-go for production Fuzzysort adoption; Phase 3 made no source or root dependency changes.

The annotated 15-query comparison improved macro NDCG@5 from `0.7459` to `0.9306` and NDCG@10 from `0.7615` to `0.9534` at threshold `0.25`, but `rpt` fell from `0.64` to `0.36` at NDCG@5. The detailed query labels, relevant ranks, and full baseline/candidate Top-5/Top-10 ranked paths with relevance flags are in `docs/architecture-repair-phase-3-search-evaluation.md` and `scripts/benchmarks/phase-3-file-name-search/quality-eval-results.json`.

On the same nested 20k corpus, the candidate added a median `38,395KB` heap and `25,056KB` peak RSS. Cold name was `86.293ms` versus `78.038ms`; hot basename p50/p95 was `1.646/1.873ms` versus `1.501/1.726ms`. The complete path-first request measured `100.691ms` versus `70.219ms` baseline, about `43%` slower. Cold totals include Fuzzysort snapshot construction; the first `go()` synchronously finishes its index preparation. Phase 0 has no explicit numeric budgets; using the measured baseline as a no-regression reference, this candidate does not pass the plan's latency/memory gate. The real-filesystem compatibility check verified actual `FileService` snapshots preserve workspace isolation, ignored `.git` and `node_modules` directories, symlink exclusion, basename-before-path ordering, unique paths, equal-score basename ties matching the existing comparator, empty-query traversal order, and result-limit truncation. Unicode coverage is limited to the labelled CJK and Latin-diacritic cases and does not establish equivalence across all normalization forms. A 50,000-file run confirmed that the real snapshot builder caps at 20,000 entries and sets `truncated=true`; baseline and candidate both returned 20 results and retained `truncated=true` for basename and path queries. The candidate retained about `38,400KB` extra heap at the cap and its fresh path-first request took `119.927ms` versus `90.560ms` baseline (about `32%` slower). Reproducible offline scripts and full annotated Top-5/Top-10 relevance output are committed under `scripts/benchmarks/phase-3-file-name-search/`; Fuzzysort itself remains an isolated, non-root dependency.

## Phase 4 — PDF work reduction

**Status:** Phase 4 implementation and validation are complete: 468 unit tests, 26 renderer tests, build/chunk checks, and fresh ten-run same-hash baselines pass. The original three Spec findings and both follow-up Spec/Standards findings are fixed; final Standards and Spec reviews returned no findings. Phase 4 is committed as `65c87c7`.

### Consumer and compatibility audit

- `research.document.asset` serves stored page-image assets through `src/main/pdf-preview-protocol.ts`; `ResearchDocumentService.asset` validates the parse, asset ID, hash, and stored file. This is a real consumer contract. Keep PNGs for pages with visual content, OCR, low-quality text, or inconclusive visual inspection.
- `PaperReader` renders parsed text blocks. The renderer does not currently fetch page assets. Research exports preview the original PDF. The existing `files.preview*` protocol is unchanged.
- `artifacts/middle.json` and `artifacts/structured.json` contain identical JSON, but both paths are externally recognizable through the returned contract; v4 continues to write them separately. There is no in-repo reader that needs the second payload, but Phase4 preserves the established filename contract. Existing v3 records retain both paths and remain readable.
- `researchParseContractVersion` advances to 4 while `researchParserVersion` remains `roc-research-parser/2`; `researchDerivationGenerationVersion` stays at 3 because text, locations, blocks, and citation IDs are unchanged. `ResearchToolchain.identity()` uses the v2 parser and generation-3 identity payload, preserving the prior parser key so artifact-only output changes do not requeue existing documents. Existing v3 parses remain active.

### Changes and measurements

`measureResearchPdfPage` computes the same clamped page dimensions without canvas rendering. The parser omits the page PNG only when native text is high quality and visual inspection succeeds with no visible content. `researchPdfPageHasVisualContent` returns visual content on unknown/non-text operators or if PDF.js inspection throws; this conservatively retains the page image and continues OCR when models are available. Visual pages, OCR pages, low-quality text, and inconclusive pages retain the normal render and asset path. Text, page count, coordinates, and citation identifiers are unchanged.

For contract v4, the `assets` list is authoritative for whether a page image exists; consumers must not infer a PNG from page count. Text, page geometry, locations, and citation identifiers are still emitted for every page. Contract v3 retains its original schema and artifact paths; the existing `files.preview*` protocol remains unchanged.

The benchmark ran 10 fresh Node processes per scenario at the Phase3 commit (`328916c9c9cd2707c1495164cf807019e3502267`) and on the candidate. Both use Node `v26.12.1`, `darwin-arm64`, and matching fixture hashes. The script reports p50/p95 elapsed time, peak RSS, output bytes, per-stage time, and p50/p95 of each run's maximum event-loop delay using `monitorEventLoopDelay`; this measures the parser host process, not Electron startup. Raw ignored artifacts: `.runtime/phase4-pdf-before-review.json` and `.runtime/phase4-pdf-after-review.json`.

| Scenario | Legacy contract 3 | Contract 4 | Result |
| :--- | :--- | :--- | :--- |
| Clean native text, SHA-256 `8489dd1fd21d46abeb783e07670263ea2f13220d1cbe1285e10e429454d72fd5` | Elapsed p50/p95 `245.027/253.148ms`; event-loop max p50/p95 `213.123/221.819ms`; RSS p50/p95 `162,528/166,582KB`; `70,644` bytes | Elapsed `57.651/58.664ms`; event-loop max `53.428/54.452ms`; RSS p50/p95 `127,576/134,042KB`; `10,099` bytes | p50 elapsed 76.5% lower, p95 76.8% lower, output 85.7% smaller. Render/encode/write p50 `163.402/28.213/0.797ms` become visual-inspection/layout `2.447/0.113ms`. |
| Visual `p5-paper.pdf`, SHA-256 `ee02484891e45e98e89d5682f6dc90562302e1fe5ee5a15f9cad9f0b4d18ddd5` | Elapsed p50/p95 `268.631/279.032ms`; `72,729` bytes | Elapsed `275.334/291.732ms`; `72,729` bytes; page PNG retained | Output and stages remain on the legacy render path. A separate candidate batch measured `268.175/278.739ms` versus baseline `269.260/277.269ms`; timing varies between runs, with no artifact-size change. |
| Scanned and mixed routing | Stops at absent model `ENOENT`; output cleaned | Same `ENOENT`; output cleaned | No OCR inference result claimed; model packs are absent. |

No model pack is available to measure model initialization or inference, so this phase makes no OCR-worker claim. The measured gain is isolated to confirmed clean-text pages; the visual fixture remains on the compatibility path.

### Validation

- `node --test tests/unit/architecture-repair-corpus.test.mjs`: 13 passed, including v3 stored-content compatibility, parser-identity stability, separate JSON paths/equal payloads, text coordinates, visual-page PNG retention, failed-inspection fallback, clean-text PNG omission, and output cleanup.
- `node --test tests/unit/research-archive-libraries.test.mjs tests/unit/ripgrep-search.test.mjs`: 31 passed.
- `pnpm test:unit`: 468 passed, 0 failed after the Spec fixes and test-runner stability adjustments.
- `pnpm test:renderer`: one initial run alongside typecheck/LSP had 25/26 pass and timed out once in the transcript-anchor wait; the exact test passed isolated, and the serial full suite passed 26/26. No renderer files changed.
- `pnpm typecheck`, `pnpm check:ipc`, and `git diff --check`: passed after final code/test changes.
- `pnpm build`: passed (`pnpm typecheck && electron-vite build`).
- `pnpm check:renderer-chunks`: passed; renderer eager JS is `1,076,909` bytes across 6 files.
- Targeted LSP diagnostics: 4 of 5 changed TS files confirmed clean; `src/main/plugins/research/index.ts` timed out once; full TypeScript check passed.

**Review:** The initial Spec findings (distinct JSON path compatibility, unknown operator handling, and repeated/main-thread-blocking measurements) were fixed. Follow-up Spec review found that PDF.js inspection failures could still escape; the visual helper now conservatively retains the image. Follow-up Standards review found artifact version bumps could rotate the index parser key; `researchParserIdentityPayload` keeps the existing v2/generation-3 key stable. Both fixes have regression coverage. Final Standards and Spec reviews returned no findings.

## Phase 5 — Renderer resource cache pilot

**Status:** Phase 5 implementation and validation are complete. The initial Spec review found no issues; Standards found one P2: cached project results were hidden while SWR revalidated. The hook now keeps `ready` when cached data exists, and renderer regression coverage verifies results remain visible during refresh and after a failed refresh. The focused Standards follow-up review returned no findings; Phase 5 is committed as `03ed314`.

### Evidence and decisions

- `AppShell` mounts `useSearchGroups`, and `ProjectPortalView` mounts when no project is selected. Both read the same unfiltered `research.listProjects()` resource on startup using independent local hooks. The renderer lifecycle test mounts both consumers under one provider and verifies one IPC request.
- Project-list search and portal filters are local; the SWR key is `['research', 'projects', 'list', { scope: 'all', query: null }]`. A per-renderer-window provider in `App.tsx` scopes the cache. Focus, reconnect, and periodic refresh are disabled; 2-second dedupe is retained; only structured IPC errors marked `retryable` retry.
- `IpcResourceError` preserves code, category, retryability, user action, and audit event ID. The portal, command palette, project create/update/delete actions, and workspace binding share the list; successful writes invalidate its key. Command-palette-open revalidation remains to catch main-process idea promotions, which have no renderer list-change event.
- `useAsyncAction` now counts all in-flight requests and lets only the latest invocation publish its error. Project-row writes and confirmation actions disable while a project mutation is pending; workspace directory selection is single-flight.

### Validation

- `pnpm typecheck`, `pnpm test:unit` (468/468), and `pnpm test:renderer` (29/29) pass.
- `pnpm build` passes. After the build, `pnpm check:renderer-chunks` reports `1,117,304` eager JS bytes across 6 files, `40,395` above the Phase4 `1,076,909`-byte baseline and below the `1,700,000`-byte project limit.
- Changed-file LSP diagnostics reported 0 findings across 12 paths; post-fix checks for `use-project-list.ts` and the renderer lifecycle test also reported 0 findings. `git diff --check` is clean.
- Initial review: Spec returned no findings; Standards found one P2 about cached results disappearing during list revalidation. The status mapping and a refresh-success/failure regression fixed it; targeted validation passed again.

**Review:** Initial Spec review returned no findings. Initial Standards review found P2 at `src/renderer/project/use-project-list.ts:38`; fixed by preferring cached data for `ready` status and adding regression assertions for in-flight and failed revalidation. Focused Standards follow-up review returned no findings; commit `03ed314`.

## Phase 6 — Tokenizer comparison

**Status:** No-go for production adoption: independent review found exact-count incompatibilities. The existing `js-tiktoken` implementation and dependency are retained; the final follow-up review found no issues.

The exploratory comparison preserved Roc's `js-tiktoken/lite` model-to-encoding mapping and substituted a hand-built candidate loader. It tested six encodings with special-token strings, malformed UTF-16, multilingual text, tool JSON, published Chinese and English abstracts, and a synthetic long tool result. The sampled inputs agreed, but that corpus omitted important Unicode whitespace. The benchmark assembled the candidate from the baseline source and a replacement loader rather than measuring the final production source, so the performance measurements below are exploratory rather than evidence of real production-path gains.

Independent review found that `gpt-tokenizer@4.1.0` differs from `js-tiktoken@1.0.21` for U+FEFF: for both `cl100k_base` and `o200k_base`, `" \uFEFFa"` counts as 3 tokens with the current implementation and 2 with the candidate; repeating it 1,000 times yields 3,000 versus 2,000. Conversely, `" \t\uFEFF"` produces 2 versus 3. These differences can change compaction decisions while being reported as exact. `scripts/benchmarks/phase-6-tokenizer/incompatibility.mjs` reproduces the discrepancies in Electron, and the retained production counter now has a regression test for these inputs. The candidate is removed from production dependencies. The temporary candidate's global merge cache was disabled during the comparison because it retains input fragments across independent counters.

The candidate has no additional runtime dependencies and occupies 30,544 KiB installed on this machine; `js-tiktoken` occupies 22,008 KiB. These are installed-package sizes, not measurements of the packaged application.

### Measurements and validation

The comparison ran on Apple M1 Pro, macOS arm64, Electron 45.0.0 (Node v24.22.0), with ten fresh processes per implementation and model and twelve warm iterations per process. Its fixed source baseline is `5f80ed9cc81fc11c26bc536e5ec0a33289e49308`; corpus SHA-256 is `487744bd6e00c710efc258a41cc401e2f268053b1c9342a3b45d8546bfe74fce`. All six encodings agreed on the listed inputs, 256 generated Unicode/special-token cases per encoding, message totals and budget profiles. This is bounded evidence, not a proof of equivalence for all strings.

| Exploratory candidate cache: disabled | Baseline p50/p95 | Candidate p50/p95 |
| :--- | :--- | :--- |
| GPT-3.5 cold first text | 110.589 / 110.965 ms | 36.205 / 36.703 ms |
| GPT-3.5 first message set | 563.808 / 576.364 ms | 87.856 / 89.659 ms |
| GPT-3.5 peak RSS | 242,864 / 244,208 KiB | 211,504 / 213,168 KiB |
| GPT-4o cold first text | 222.954 / 227.568 ms | 64.509 / 65.866 ms |
| GPT-4o first message set | 624.453 / 642.901 ms | 106.320 / 107.337 ms |
| GPT-4o peak RSS | 282,880 / 283,456 KiB | 225,600 / 226,656 KiB |

The first message set includes a generated, repetitive 613,293-byte tool result; it is deliberately above Roc's 131,072-byte cache limit and is not representative of the actual compaction path, which can externalize large tool results. The GPT-4o first-message timer-delay p50/p95 was 624.542/642.987 ms baseline versus 106.395/107.413 ms candidate. The cached short-message p50 was 0.028 ms versus 0.027 ms. With the candidate's default global merge cache enabled, GPT-4o first-message p50 was 30.443 ms, but that cache retains input fragments globally. Both modes and raw process samples are recorded in `scripts/benchmarks/phase-6-tokenizer/results-*.json`; the recorded source and lockfile hashes refer to the baseline, and the historical results lack a benchmark-script hash and installed dependency graph. They are therefore not fully reproducible evidence and cannot justify adoption. The updated comparison includes the counterexamples, exits nonzero on mismatch, and produces a machine-readable rejection; a separate probe verifies the two common encodings.

Before the incompatibility was discovered, the experimental implementation passed `pnpm test:unit` (470/470), `pnpm test:renderer` (29/29), `pnpm check:ipc`, `pnpm build`, `pnpm check:renderer-chunks` (1,117,304 eager bytes), `pnpm smoke:performance`, `pnpm smoke:electron` (62/62 assertions), `pnpm package:dir`, and `pnpm verify:native-packaging`. The experimental arm64 app's packaged Electron loaded all six candidate encodings; these successful checks did not establish semantic equivalence. Final validation of the retained implementation passed `pnpm test:unit` (469/469), `pnpm typecheck`, `pnpm build`, and `pnpm check:renderer-chunks` (1,117,304 eager bytes). The independent Electron reproducer confirmed all six listed mismatch assertions.

**Review:** Independent review found Unicode counting and initialization-retry incompatibilities. A second reviewer identified missing counterexamples and incomplete historical benchmark provenance before its process ended with SIGTERM; the counterexamples and machine-readable rejection were added and historical provenance limits disclosed. A separate follow-up review of the final no-go state found no issues.

## Phase 7 — SQLite Checkpointer compatibility prototype

**Status:** No-go for adopting `@langchain/langgraph-checkpoint-sqlite@1.1.0`. The reproducible isolated comparison passes core Saver behavior but fails the migration and Electron packaging gates.

### Evidence

- `scripts/benchmarks/phase-7-checkpointer/package.json` pins the candidate 1.1.0 with LangGraph 1.5.2, Core 1.2.20, Checkpoint 1.2.1, and `better-sqlite3@12.10.0`. Roc uses driver 13.0.3. Candidate peer ranges match; its driver is a second native module.
- Candidate's schema also violates Roc's exact migration inventory: after `SqliteSaver` creates `checkpoints` / `writes`, the next `applyDatabaseMigrations()` fails with `database_schema_rebuild_required`. The official saver has no Roc data importer, `restoreFrom`, retention, or integrity validator.
- `electron-builder.yml` sets `npmRebuild: false` and unpacks only root `node_modules/better-sqlite3/**`. The isolated v12.10 driver loads under Node v26 but fails in Electron 45's Node v24 runtime: `was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 150.` A checked-in test reproduces this mismatch.
- The Roc/candidate comparison passed twelve isolated contracts: separate pinned drivers and Electron ABI reproduction; namespace, parallel pending writes/order, duplicate writes, metadata filtering/pagination and transaction rollback; exact migration schema rejection; retention truncation/integrity; SQLite backup/restore; interrupt → process exit → restart → resume; SIGKILL inside `putWrites` with rollback; RunControl drain/resume; AbortSignal cancellation; effect-store reuse; and a graph node replay through Roc's real tool-effect middleware after process restart under both savers. Command: `npm test --prefix scripts/benchmarks/phase-7-checkpointer` (12 passed, 0 failed).
- Roc retention may delete a parent checkpoint which `validateCheckpointIntegrity` later treats as corruption. The experiments do not define a pruning boundary marker that distinguishes intentional truncation from damage. The candidate has no equivalent API.

### Decision

**No-go.** Existing recovery data and backups are unreadable across the candidate schema; the candidate omits Roc-specific recovery APIs; pruning semantics remain unresolved; and the second native driver fails under the current Electron packaging configuration. Do not migrate or dual-write. Keep `RocSqliteCheckpointer` and revisit only with a defined retention-boundary policy, offline migration/rollback design, and packaged Electron validation. No production dependency, source, or database changes were made.

### Validation and review

- `npm test --prefix scripts/benchmarks/phase-7-checkpointer`: 12 passed, 0 failed. The prototype includes a checked-in expected-failure Electron ABI probe.
- Independent review initially found gaps in cancellation, side-effect replay, and Electron ABI reproducibility. Added AbortSignal cancellation under both savers, a process-restart graph test using Roc's real idempotency middleware, and the native ABI probe. A second review found one stale test count, which was corrected; the reviewer reran all twelve prototype tests successfully. Focused existing `checkpoint-write-order` and `operation-recovery` tests also pass (16/16); `git diff --check` is clean. Phase 7 is ready to commit.

## Decisions

- Use contract v4 for page-image policy and retain v3 schema reads; omit page PNG only after a successful no-visual-content inspection on high-quality native text. The visual detector fails closed: any unknown PDF.js operator retains the image.
- Keep both `artifacts/middle.json` and `artifacts/structured.json` as distinct files in v4. Both returned paths were part of the earlier contract, so preserve the visible path shape even though payloads are identical.
- Keep `researchDerivationGenerationVersion` at 3 and `researchParserVersion` at `roc-research-parser/2` while output contract advances to 4; `ResearchToolchain.identity()` hashes the same v2/generation-3 payload as before, preventing a corpus-wide reparse for artifact-only changes.
- Do not claim scanned/mixed OCR inference gains from the no-model baseline. Use a real user-installed model pack for any later OCR performance claim; until available, restrict phase 4 to changes whose evidence does not require inference.
- Adopt SWR for only the global project-list resource: two consumers issue identical initial IPC reads; query/filtering is local, so `scope: all, query: null` is the stable key and successful renderer writes invalidate it. The per-renderer provider, manual palette-open revalidation, retry policy, and eager chunk budget preserve required boundaries.
- Keep each phase's evidence and adopt/no-go decision in this file so every requested phase has a reviewable, committed outcome.

## Later phases

- Phase 1: Committed.
- Phase 2: Committed.
- Phase 3: Fuzzysort evaluation is a no-go for production adoption because its quality gain comes with material latency and memory regressions against the observed baseline; final review passed.
- Phase 4: Implementation and validation complete; all original and follow-up review findings are fixed; final Standards and Spec reviews returned no findings; committed as `65c87c7`.
- Phase 5: Implementation and validation complete; initial Spec review found no issues; the one Standards P2 about cached-list visibility is fixed and revalidated; focused Standards follow-up found no findings; committed as `03ed314`.
- Phase 6: Tokenizer candidate rejected due to Unicode counting incompatibility; review findings addressed and final follow-up found no issues.
- Phase 7: Official Checkpointer candidate rejected after isolated recovery/retention/backup/crash/cancellation/side-effect comparison and Electron ABI probe; independent review and commit are in progress.
- Phase 8: Pending.
