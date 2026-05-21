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
| Phase 4: Workbench UI | complete | Renderer/task service IPC tests passed; `pnpm typecheck` passed |
| Phase 5: Long-running promotion and Doctor | complete | Promotion/Doctor renderer tests passed; smoke scripts syntax checked |

## Hook-Compatible Phase Status

### Phase 0: Read plan and current code

**Status:** complete

**Verification:** `findings.md` records the source of truth, code reading notes, and implementation boundaries.

### Phase 1: Data model and migration

**Status:** complete

**Verification:** `9084579 feat(tasks): add task workbench schema v2`; targeted database/task tests and `pnpm typecheck` passed.

### Phase 2: Scheduler core

**Status:** complete

**Verification:** `d694af2 feat(tasks): add background task scheduler`; scheduler, cron, app-service tests and `pnpm typecheck` passed.

### Phase 3: AI tools

**Status:** complete

**Verification:** `ec01a7b feat(tasks): add background task agent tools`; background-task tool/runtime tests and `pnpm typecheck` passed.

### Phase 4: Workbench UI

**Status:** complete

**Verification:** `4431440 feat(tasks): complete task workbench refactor`; active task workbench renderer/IPC tests passed.

### Phase 5: Long-running promotion and Doctor

**Status:** complete

**Verification:** `4431440 feat(tasks): complete task workbench refactor`; promotion/Doctor tests, `pnpm build`, `pnpm package:dir`, and packaged Electron smoke passed.

## Current Boundaries

- No third-party cron library.
- No second-level cron.
- No distributed scheduling.
- No unrelated renderer restyle.
- No extra compatibility paths unless current code requires one for migration.

## Errors Encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| planning hook reported `0/0 phases done` | Stop hook checked `task_plan.md` after implementation | Added hook-compatible `### Phase` headings with `**Status:** complete` markers while preserving the original phase table. |
