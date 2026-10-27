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

## Decisions

- Keep native-text page PNG and both JSON artifact paths while their consumer contracts require them; optimize only after a compatible consumer migration and measured benefit.
- Do not claim scanned/mixed OCR inference gains from the no-model baseline. Use a real user-installed model pack for any later OCR performance claim; until available, restrict phase 4 to changes whose evidence does not require inference.
- Treat project list plus command-palette search as the phase 5 cache candidate because both call the same unfiltered `listProjects` IPC resource; first prove simultaneous consumers and invalidate the shared key after successful writes.
- Keep each phase's evidence and adopt/no-go decision in this file so every requested phase has a reviewable, committed outcome.

## Later phases

- Phase 1: Committed.
- Phase 2: Committed.
- Phase 3: Fuzzysort evaluation is a no-go for production adoption because its quality gain comes with material latency and memory regressions against the observed baseline; final review passed.
- Phase 4: Pending.
- Phase 5: Pending.
- Phase 6: Pending.
- Phase 7: Pending.
- Phase 8: Pending.
