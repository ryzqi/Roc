# Task Workbench Refactor Findings

## Source Of Truth

- Primary implementation plan: `任务工作台重构计划.md`.
- Current repository code on disk overrides stale retrieval output.

## Initial Facts

- `任务工作台重构计划.md` defines five implementation phases and explicit non-goals.
- Existing dirty worktree only shows the untracked plan file at start.
- `package.json` exposes `typecheck`, `test`, `build`, `smoke:electron`, `package:dir`, and performance smoke scripts.
- Memory notes indicate Roc renderer/workbench changes should use targeted tests and `pnpm smoke:electron` when UI contracts change.

## Code Reading Notes

- Existing task schema was effectively version 1. `DatabaseService.migrate()` always wrote `schema_version = 1`.
- `task_threads` previously had no `kind`; background task creation inserted plain thread rows.
- `background_tasks` previously had no `cron_expression`, `last_run_at`, `last_run_status`, or `run_count`.
- Current trigger contract was `manual | schedule`; Phase 1 changes it to `manual | once | cron`.
- Existing task IPC and renderer still consume `backgroundTask` / `backgroundTasks`; Phase 1 keeps those fields until Phase 4 replaces them.

## Phase 1 Decisions

- Use `TaskKind = 'chat' | 'background' | 'long_running'` on all `TaskThread` values.
- New chat runs insert `kind = 'chat'`; new background tasks insert `kind = 'background'`.
- No legacy `schedule` trigger alias is retained. Tests and smoke seed data now use `cron`.
- `manual` triggers no longer carry `nextRunAt`; scheduled triggers are `once` or `cron`.
- Schema v2 is additive via `CREATE TABLE IF NOT EXISTS` plus `ensureColumn()` for upgraded databases.

## Phase 2 Decisions

- `TaskSchedulerService` owns timers, catch-up, suspend/resume, and firing guards.
- Scheduler SQL writes are routed through `TaskService` methods to keep database ownership local.
- `LifecycleService.pauseBackgroundExecution()` suspends timers without changing task database status.
- `LifecycleService.resumeBackgroundExecution()` recomputes future cron runs from the current time; Electron `powerMonitor` resume still performs missed-run catch-up.
- Once tasks are marked `completed` after being fired once. The real agent run lifecycle remains owned by `DeepAgentRuntimeService`.
- Official Electron docs confirm `powerMonitor` has a `resume` event; main process now forwards it to scheduler catch-up.
