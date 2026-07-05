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
