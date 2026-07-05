# Findings & Decisions

## Requirements
- Audit the whole Roc codebase, not a narrow subsystem.
- Check production readiness, redundancy, first-principles simplicity, optimization opportunities, performance, animation, and interaction quality.
- Use file tracking for the whole process.
- After each completed part: review, fix issues, verify, and commit.
- Stop only when the whole codebase analysis is complete and evidence supports the requested end state.

## Constraints
- Windows 11 and PowerShell are the operating environment.
- Follow local `AGENTS.md` and project boundaries.
- Do not alter generated/dependency output such as `dist/`, `release/`, or `node_modules/`.
- Do not delete code without evidence.
- Do not claim fixed, complete, or passing without fresh verification.

## Research Findings
- Root planning files were absent at session recovery; this audit starts by creating `task_plan.md`, `findings.md`, and `progress.md`.
- Memory indicates Roc full cleanup work should use strict unused scan plus typecheck, IPC check, build/test, and `git diff --check` before final completion.
- Local command sources confirm `package.json` exposes: `pnpm typecheck`, `pnpm test`, `pnpm generate:ipc`, `pnpm check:ipc`, `pnpm build`, `pnpm package:dir`, `pnpm smoke:electron`, `pnpm smoke:performance`, `pnpm verify:native-packaging`, and `pnpm verify:paths`.
- `AGENTS.md` confirms generated/dependency directories are out of scope for manual edits: `dist/`, `release/`, and `node_modules/`.
- Current git baseline after planning files: branch `main`; only `task_plan.md`, `findings.md`, and `progress.md` are untracked; `git diff --check` produced no output.
- Repo file count by audit area: `src/main` 183, `src/preload` 1, `src/renderer` 179, `src/shared` 28, `src/rtk-integration` 4, `tests/main` 181, `tests/renderer` 79, `tests/shared` 3, `tests/smoke` 29, `tests/manual` 2, `scripts` 15, `docs` 3.
- `tsconfig.json` includes `src`, `tests`, `electron.vite.config.ts`, and `vitest.config.ts`; strict TypeScript baseline should cover source and tests.
- `vitest.config.ts` runs `tests/**/*.test.ts` and `tests/**/*.test.tsx` in Node with 20s test and hook timeout.
- `electron.vite.config.ts` currently has explicit renderer manual chunks for xterm, diff, and markdown packages.
- Strict unused/dead-code scan completed with exit 0: `pnpm exec tsc --noEmit -p tsconfig.json --noUnusedLocals --noUnusedParameters`.
- TypeScript baseline completed with exit 0: `pnpm typecheck`.
- IPC drift baseline completed with exit 0: `pnpm check:ipc`; output says generated files are current.
- `src/main` production source had explicit `any` type keywords in IPC handler and LangChain dynamic tool boundary types. A new AST-based quality test reproduced the issue before the fix.
- Empty catch handler scan has direct coverage in `tests/main/code-quality-empty-catch.test.ts`; current focused run passes.
- Post-fix text search for `\bany\b` in `src/main` only reports `AbortSignal.any` API property references in `src/main/services/langchain-nvidia-probe.ts`, not explicit `any` type keywords.
- `prepareChatImageAttachments()` was on the `AgentRuntime.startRun()` path and used `statSync/readFileSync` for image files. It now uses `fs/promises` and `startRun()` awaits the same prepared attachment contract.
- `toLogError()` had duplicate implementations in IPC and Windows host code while `electron-runtime-adapters.ts` already exposed the same behavior. The single source is now `src/main/services/errors.ts`.
- `TerminalSessionService` wrote every PTY output chunk with `appendFileSync`. It now uses a per-session `WriteStream`, closes the stream on exit/close/shutdown, and keeps late output ignored after session deletion.
- `FileService.streamPdfPreviewResource()` used to read the entire PDF with `readFileSync` before returning a `Response`. It now returns a `createReadStream()` Web stream while keeping the same PDF path checks, media type, and cache headers.
- `InfrastructureLogger` is live kernel infrastructure for plugin and event-bus logs. It used `appendFileSync` per plugin log entry; it now writes through a `WriteStream` and is closed by `KernelRuntime` on start failure and shutdown.
- `TaskScheduler` capped long timers with `maxTimeoutDelayMs` but did not re-check `nextRunAt` when an intermediate timer slice elapsed. Long-horizon tasks could start early; the fire path now reschedules until the task is actually due.
- `src/main/services/langchain-nvidia-probe.ts` had a local `anySignal()` fallback and double assertion around `AbortSignal.any`. Current runtime check reports Node `v25.7.0` with native `AbortSignal.any` and `AbortSignal.timeout`; `package.json` pins `@types/node` `26.1.0`, Electron `42.4.1`, and TypeScript `6.0.3`.
- NVIDIA probe cancellation now uses native `AbortSignal.any` directly. Behavior coverage proves first SSE delta returns and cancels the reader, internal hard timeout maps to `provider_request_timeout`, and caller abort remains an `AbortError` instead of being misclassified as provider timeout.
- DeepAgents reference check for this runtime/recovery pass: continuity-sensitive paths should preserve a stable `thread_id`, use the framework checkpointer/backend semantics instead of ad hoc state, and keep tool/backend routing boundaries explicit.
- `executeWithProviderRequestRetry()` checked abort before each attempt and while waiting for an abort event during backoff, but `delayWithAbort()` did not handle a signal already aborted before the listener was attached. If an operation aborted the signal while throwing a retryable provider failure, cancellation could wait for the full retry backoff before surfacing.
- `src/main/plugins/agent/deep-agent-executor.ts` kept a `closers` cleanup registry that had no registration path (`closers.push` had no production match) and only performed an empty `Promise.allSettled` traversal after `consumeRun`. Removing it does not remove a real cleanup hook; `eventQueue.fail(error)` remains the error path.
- `src/main/services/deep-agent/prompt-builder.ts` was only a compatibility re-export for prompt block helpers. Production code imports the real `context/prompt-blocks` and `context/prompt-serialization` modules directly; the old path was referenced only by tests.
- Not deleted: `src/main/services/deep-agent/harness-profiles.ts`, `plan-filesystem-defaults.ts`, and Forge cleanup middleware remain in the real `buildDeepAgent()` middleware path or exported middleware path with focused behavior tests.
- Not deleted: `subagent-projection.ts` still keeps a `taskId` fallback for async subagent identity. Current evidence does not prove DeepAgents runtime will never emit that field, so it remains a reported candidate rather than deleted code.
- `src/main/infrastructure/schema-registry.ts` had no production import-graph inbound edge and full-text search found only the source file plus its dedicated test. Current plugin schemas are applied through active plugin/bootstrap paths instead, so the registry was unused infrastructure code.
- Phase 4 IPC/preload/RTK scan found no generated IPC drift, no raw preload wildcard/capability exposure, and RTK integration behavior was already covered by dedicated `tests/rtk-integration` tests.
- `ProviderOptions.anthropicCacheControl` was a retired prompt-cache constructor option with no runtime/UI reader; references existed only in the shared type and config Zod schema. Keeping it allowed stale provider settings to persist unused config.
- Phase 5 renderer style entry is `src/renderer/styles/index.css`; `src/renderer/styles.css` does not exist.
- `ChatComposer` tool, skill, and model popovers were hover-only: the trigger buttons lacked click/focus opening paths and `aria-expanded`. The triggers now open on click/focus, keep focus inside the anchor, close after focus leaves, and still refresh tool/skill options when a different capability popover opens.
- Renderer hover-only scan now only reports the fixed `ChatComposer` hover compatibility handlers; no other `onMouseEnter`/`onMouseLeave` popover or action triggers were found in `src/renderer`.
- Production renderer stale task UI scan found no matches for `queuedTaskPrompt`, `openInChat`, `TaskDetailDrawer`, old task table/rail CSS, `json-view`, `reasoning-view`, or `reasoning-parser`.
- Workbench resize splitters were focusable `role="separator"` controls without keyboard resizing. The right workbench panel, files tree pane, and Git change pane now handle horizontal arrow keys plus `Home`/`End` and expose `aria-orientation`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`.
- `prefersReducedTransparency` was applied to the root dataset by `system-appearance.ts`, but `task-create-dialog.css` did not consume `data-reduced-transparency`; the task creation backdrop blur now disables under `:root[data-reduced-transparency='true']`.
- Renderer import graph found `src/renderer/shared/async-state.ts` as the only no-inbound non-entry candidate. Full-text search showed only its dedicated test imported it, so the helper and test were unused residue and have been removed.
- Phase 6 startup state: branch `main`; `git status --short --branch` shows only `task_plan.md` modified for the Phase 6 transition; `git diff --stat` shows 4 changed lines in that file.
- Phase 6 initial file-map command included nonexistent `.github`, so it returned exit 1 even though the real target paths were listed. This is a scan-input error, not a source failure.
- This checkout has no root `README.md`; command/doc scans that include `README.md` return `os error 2`. Current authoritative command sources remain `AGENTS.md`, `CLAUDE.md`, `package.json`, and local config files.
- Phase 6 weak-assertion scan found many `not.toBeNull()` DOM guards that need case-by-case triage rather than broad replacement. The concrete `toBeDefined()` candidates in forge guardrails tests were weak existence guards and have been replaced with unique digest and content assertions.
- A new AST quality guard in `tests/main/code-quality-empty-catch.test.ts` now rejects `expect(...).toBeDefined()` in automated tests. RED found the two forge guardrails weak assertions; GREEN passed after replacement, and a full source/test search found no remaining `.toBeDefined()` calls.
- Phase 6 test-control scan found no `.only()`, `.skip()`, `test.todo`, `describe.todo`, or `it.todo` in `tests`.
- Phase 6 weak-null scan found many `.not.toBeNull()` checks, mostly DOM query guards in renderer tests and concrete null-return assertions in main/shared behavior tests. Current evidence does not justify a broad rewrite; handle only future cases with a direct weak-assertion replacement target.
- Phase 6 stale/legacy text scan in `tests`, `scripts`, `docs`, and `resources` only found historical design/plan text under `docs/superpowers`; no executable stale test or script candidate was proven by that scan.
- Phase 6 tracked file count by `git ls-files`: `tests` 304, `scripts` 15, `docs` 4, `resources` 5. `rg --files docs` undercounts docs because `.gitignore` ignores `docs/*` while `docs/rtk-integration.md` remains tracked.
- Phase 6 command drift candidates: ignored `CLAUDE.md` and tracked `docs/rtk-integration.md` contained older RTK test command examples. The tracked RTK doc now uses `pnpm test -- tests\rtk-integration` and `pnpm test -- --coverage tests\rtk-integration`; ignored `CLAUDE.md` is recorded but left unchanged because it is not a commit target.
- Phase 6 RTK version drift: bundled Windows binary reports `rtk 0.42.4`, and `tests/rtk-integration/integration.test.ts` asserts the same version. Tracked `docs/rtk-integration.md` still said v0.42.0; it now records v0.42.4, release date 2026-06-12, and the v0.42.4 release URL. Ignored `CLAUDE.md` still says v0.42.0 and is recorded as local stale guidance outside the commit target.
- `scripts/verify-paths.mjs` expects `.npmrc`, `.runtime`, `.artifacts`, `src`, and `tests`; all five paths exist in this checkout and `pnpm verify:paths` passes.
- `resources` currently contains only `icon.ico` and four platform RTK binaries. No redundant tracked resource file was proven by Phase 6 scanning.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Start with baseline scans before manual deletion | Automated unused/type checks produce safer evidence for cleanup candidates. |
| Audit by repo area | Full-repo all-at-once review is too broad for reliable evidence and commit boundaries. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|

## Resources
- `AGENTS.md`
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `electron.vite.config.ts`
- `task_plan.md`
- `progress.md`

## Audit Log
| Area | Status | Evidence | Follow-up |
|------|--------|----------|-----------|
| Recovery/planning | complete | Planning files created because none existed; rules and command sources read | Commit baseline tracking |
| Automated baseline scans | complete | Strict unused scan, typecheck, and IPC check exited 0 | Start `src/main` audit |
| `src/main` explicit any audit | complete | RED quality test found 19 explicit `any` type keywords; GREEN test now passes | Continue `src/main` production audit |
| `src/main` chat image attachment I/O | complete | Focused chat image/runtime tests, typecheck, strict unused pass; no `readFileSync/statSync` remains in attachment reader | Continue `src/main` production audit |
| `src/main` error normalization duplication | complete | RED errors test failed before export; GREEN focused tests/typecheck/strict unused pass; only one `toLogError` implementation remains | Continue `src/main` production audit |
| `src/main` terminal output logging | complete | RED quality test found `appendFileSync`; GREEN focused tests/typecheck/strict unused pass; no `appendFileSync` remains in production terminal service | Continue `src/main` production audit |
| `src/main` PDF preview resource I/O | complete | RED quality test found `readFileSync` in `streamPdfPreviewResource`; GREEN focused tests/typecheck/strict unused pass; behavior test consumes streamed PDF `Response` | Continue `src/main` production audit |
| `src/main` infrastructure plugin logging | complete | RED quality test found `appendFileSync` in `InfrastructureLogger.append`; GREEN focused tests/typecheck/strict unused pass; kernel runtime closes logger on shutdown | Continue `src/main` production audit |
| `src/main` task scheduler long-delay timers | complete | RED scheduler test proved a future task fired after the first max-timeout slice; GREEN focused tests/typecheck/strict unused pass | Continue `src/main` production audit |
| `src/main` NVIDIA probe abort composition | complete | RED quality test found local `function anySignal`; GREEN direct probe tests, retry-layer test, typecheck, strict unused, source search, and diff check pass | Continue `src/main` production audit |
| `src/main` provider retry abort backoff | complete | RED test showed an already-aborted signal stayed pending before retry backoff; GREEN provider retry tests, typecheck, strict unused, source search, and diff check pass | Continue `src/main` production audit |
| `src/main` DeepAgent executor cleanup registry | complete | RED quality test found inert `closers`; GREEN focused executor tests/typecheck/strict unused pass; production source search has no `closers` registry matches | Continue `src/main` production audit |
| `src/main` DeepAgent prompt-builder compatibility export | complete | RED quality test found the old re-export file; GREEN focused prompt tests/typecheck/strict unused pass; `rg prompt-builder` has no source/test/docs references | Continue `src/main` production audit |
| `src/main` infrastructure schema registry | complete | RED quality test found unused registry file; GREEN focused infrastructure tests/typecheck/strict unused pass; AST import graph has no orphan candidates after deletion | Continue `src/main` production audit |
| `src/main` area closeout | complete | `pnpm test -- tests/main` passed 178 files and 986 tests on the current worktree; exit 0 with known Windows `node-pty AttachConsole failed` teardown noise | Start shared/preload/RTK audit |
| shared/preload/RTK boundary audit | complete | `pnpm check:ipc` passed; focused shared/RTK/preload/config tests passed; no raw preload wildcard IPC or RTK contract drift found | Start renderer audit |
| retired Anthropic cache-control option | complete | RED config test proved `anthropicCacheControl` was preserved; GREEN test proves validation now strips it while preserving supported Anthropic options | Start renderer audit |
| `src/renderer` ChatComposer popover interaction | complete | RED click/focus/focus-leave tests reproduced hover-only and sticky-focus behavior; GREEN focused chat tests, full renderer suite, typecheck, strict unused, and diff check pass | Continue renderer audit |
| `src/renderer` workbench resize separator keyboard controls | complete | RED separator tests reproduced missing keyboard resize; GREEN focused workbench tests, full renderer suite, typecheck, strict unused, and diff check pass | Continue renderer audit |
| `src/renderer` reduced transparency backdrop | complete | RED CSS contract reproduced unused `data-reduced-transparency`; GREEN animation config tests, full renderer suite, typecheck, strict unused, and diff check pass | Continue renderer audit |
| `src/renderer` async-state cleanup | complete | Import graph and full-text search proved no production inbound references; RED cleanup guard, GREEN renderer tests/typecheck/strict unused/diff check pass | Continue renderer audit |
| `src/renderer` area closeout | complete | `pnpm test -- tests/renderer`, `pnpm typecheck`, strict unused scan, and `git diff --check` pass on current HEAD | Start tests/scripts/resources/docs audit |
| tests/scripts/resources/docs audit startup | in progress | Recovery confirmed Phase 6 is the active phase; initial scans produced concrete weak-assertion, command-doc, and path-verification candidates | Audit candidates before editing |
| test weak-assertion cleanup | complete | RED quality guard found two `toBeDefined()` assertions; GREEN quality and forge guardrails tests passed; source search has no remaining `.toBeDefined()` calls | Continue docs/scripts/resources audit |
| scripts/docs/resources audit | complete | `verify:paths`, RTK command tests, RTK coverage command, binary version check, script reference tests, typecheck, strict unused, and diff check passed | Commit Phase 6 slice |
| Phase 7 completion audit startup | in progress | Phase 6 committed as `9d3fca9`; post-commit status was clean before switching `task_plan.md` to Phase 7 | Run whole-repo verification set |
| Phase 7 completion audit | complete | Strict unused scan, `pnpm typecheck`, `pnpm check:ipc`, `pnpm build`, full `pnpm test`, and `git diff --check` exited 0 on the current tree | Commit final planning closeout |
