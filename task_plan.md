# Task Workbench Refactor Execution Plan

## Goal

Implement `任务工作台重构计划.md` in phases, preserving scope:

- Task workbench, task service, scheduler, AI background task tools, long-running promotion, and related diagnostics.
- Exclude memory, MCP, Skills, settings page, and unrelated Doctor flows except planned scheduler checks.

## Acceptance

- Each phase has direct tests or smoke evidence.
- Each completed milestone is committed before the next phase starts.
- Unclear external API usage is checked against current official docs before implementation.

## Phases

| Phase | Status | Verification |
| --- | --- | --- |
| Phase 0: Read plan and current code | complete | Findings recorded in `findings.md` |
| Phase 1: Data model and migration | complete | `pnpm test tests/main/database-indexes.test.ts ...` passed; `pnpm typecheck` passed |
| Phase 2: Scheduler core | complete | Scheduler and cron tests passed; app service regression passed; `pnpm typecheck` passed |
| Phase 3: AI tools | complete | `pnpm test tests/main/background-task-tools.test.ts ...` passed; `pnpm typecheck` passed |
| Phase 4: Workbench UI | pending | Renderer view-model tests and typecheck |
| Phase 5: Long-running promotion and Doctor | pending | Promotion tests, Doctor checks, smoke path |

## Current Boundaries

- No third-party cron library.
- No second-level cron.
- No distributed scheduling.
- No unrelated renderer restyle.
- No extra compatibility paths unless current code requires one for migration.

## Errors Encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
