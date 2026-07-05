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
