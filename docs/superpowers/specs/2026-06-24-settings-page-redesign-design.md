# Settings Page Redesign Design

Date: 2026-06-24

## Goal

Redesign the settings modal so non-model settings are easier to understand, only real configuration remains in the settings surface, and unused settings are removed from both UI and configuration contracts.

## Scope

In scope:

- Keep the current settings modal entry, shell, close behavior, and save/reset flow.
- Keep `模型提供商` and `默认模型` behavior unchanged.
- Redesign all other settings sections.
- Add a `任务与调度` settings section for existing task-related configuration.
- Remove settings pages that are only status summaries or navigation shortcuts.
- Remove the unused `notifications.lowDistraction` setting from UI, shared types, config schema, defaults, migration, impact model, tests, and smoke assertions.

Out of scope:

- No provider/default-model redesign.
- No new IPC channel.
- No new MCP, Skill, Exa, Jina, browser, notification, release, or packaging behavior.
- No navigation redesign outside the settings modal.
- No compatibility alias for removed UI sections.

## Current Facts

Current settings sections are:

- `模型提供商`
- `默认模型`
- `应用基础`
- `授权与安全`
- `记忆策略`
- `网页与浏览器`
- `能力入口`

Runtime-backed settings:

- `defaultWorkspace` is used by workspace and kernel bootstrap flows.
- `startup.openAtLogin` and `startup.minimizeToTray` are used by the Windows host integration.
- `globalHotkey` is used by global shortcut registration.
- Memory retention and security scan settings are used by native memory backends.
- `tasks.longRunningThresholds` and `tasks.scheduler` exist in defaults, schema, and migration but are not currently exposed in settings UI.

Cleanup candidate:

- `notifications.lowDistraction` has no verified runtime consumer beyond settings UI, impact copy, defaults, schema, migration, and tests.

## Information Architecture

The settings modal keeps the current sidebar-and-panel layout. The section list becomes:

1. `模型提供商`
2. `默认模型`
3. `应用基础`
4. `任务与调度`
5. `授权与安全`
6. `记忆策略`

Removed sections:

- `网页与浏览器`
- `能力入口`

Rationale:

- Settings should contain configurable behavior, not feature directory shortcuts.
- MCP and Skill management already have dedicated management surfaces.
- Exa/Jina capability status belongs with feature-specific management or runtime views, not global settings.

## Section Designs

### 应用基础

Purpose: configure host-level app behavior.

Groups:

- `工作区`
  - `默认工作区`
  - Full-width input.
  - Keeps current note that running tasks do not move automatically.
- `窗口行为`
  - `开机启动`
  - `最小化到托盘`
  - Both use toggle-style controls.
  - `开机启动` keeps the host sync status.
- `全局入口`
  - `全局快捷键`
  - Keeps registration status and error text.

Removed:

- `低打扰通知`

### 任务与调度

Purpose: expose existing task runtime thresholds and scheduler settings.

Groups:

- `长任务识别`
  - `运行秒数`: writes `tasks.longRunningThresholds.runningSeconds`.
  - `工具调用数`: writes `tasks.longRunningThresholds.toolCallCount`.
  - `子代理数`: writes `tasks.longRunningThresholds.subagentCount`.
- `后台调度`
  - `启动时补跑`: writes `tasks.scheduler.catchUpOnStartup`.
  - `最大注册任务数`: writes `tasks.scheduler.maxRegisteredTasks`.

Validation:

- Numeric values must be integers.
- Threshold values can be zero or positive where the existing schema allows zero.
- `maxRegisteredTasks` must be positive.
- Invalid values show row-level errors and must not be silently saved.

### 授权与安全

Purpose: configure approval behavior and inspect long-lived grants.

Groups:

- `delete_file 审批模式`
  - Options: `全自动`, `默认审批`.
  - Keeps current permission save path.
- `长期授权`
  - Shows existing grants.
  - Empty state: only states that no long-lived grants exist.

Removed:

- `发布级系统能力` info row.

### 记忆策略

Purpose: configure native memory retention, protection, and capacity without overwhelming the main view.

Groups:

- `会话回忆`
  - `会话回忆保留`
  - Primary visible setting.
- `安全扫描`
  - Shows overall scan status in the main view.
  - Detailed scan toggles move into `高级保护`.
- `高级保护`
  - `Prompt injection 扫描`
  - `凭据扫描`
  - `SSH 后门扫描`
  - `不可见字符扫描`
  - Collapsed by default.
- `高级容量`
  - `USER 容量`
  - `AGENTS 容量`
  - `MEMORY 容量`
  - Collapsed by default.

## Data Flow

The existing settings data flow remains authoritative:

`useSettingsDraft -> buildSettingsSaveRequest -> settings.save -> applySettingsSnapshot`

Changes:

- Add task settings editing through `draft.settings.tasks`.
- Extend dirty/impact tracking for task fields.
- Remove notification dirty/impact tracking.
- Remove browser/capabilities section routing from settings.
- Keep provider/default model save paths unchanged.

No new IPC is introduced.

## Cleanup Contract

Delete `notifications.lowDistraction` from:

- `src/shared/types/settings.ts`
- config defaults
- config schema
- config migration
- renderer app basics UI
- settings impact model
- renderer tests
- main config tests
- smoke assertions

Migration behavior:

- Reading old settings documents that contain `notifications.lowDistraction` must succeed.
- The migrated/current settings shape must omit `notifications`.

Stop condition:

- If implementation finds a real runtime consumer for `notifications.lowDistraction`, do not remove the field. Report the consumer and revise the plan.

Delete browser/capabilities setting sections from:

- `SettingsSectionId`
- `SETTINGS_SECTIONS`
- `SettingsView` render branches
- section imports
- setting-specific tests that only validate those sections

Do not delete:

- MCP management view
- Skill management view
- Exa preset logic
- Jina reader logic

## Error Handling

- Keep save errors in the existing `settings-save-error` surface.
- Provider/default-model errors remain unchanged.
- New task numeric validation errors should appear beside the affected field before save.
- Removed settings should not produce fallback pages or aliases. Invalid section ids should continue to fall back through existing section selection behavior.

## Testing

Targeted tests:

- Renderer tests for section navigation and removed sections.
- Renderer tests for `应用基础` without `低打扰通知`.
- Renderer tests for new `任务与调度` controls, validation, dirty marker, and save request.
- Renderer tests for `授权与安全` without release-surface copy.
- Renderer tests for `记忆策略` folded advanced protection/capacity layout.
- Settings impact model tests for added task rows and removed notification row.
- Main config tests for removed `notifications` schema field and legacy migration.
- Smoke settings assertions updated to avoid deleted notification field.

Verification commands:

```powershell
pnpm test -- tests/renderer/settings-model-save.test.ts
pnpm test -- tests/renderer/app-basics-section.test.tsx
pnpm test -- tests/renderer/auth-security-section.test.tsx
pnpm test -- tests/renderer/settings-floating-surfaces.test.ts
pnpm test -- tests/main/config-service-settings.test.ts
pnpm typecheck
git diff --check
```

Run broader tests if implementation touches shared IPC, app bootstrap, or unrelated config persistence.

## Acceptance Criteria

- Settings modal opens and closes through the existing entry.
- `模型提供商` and `默认模型` remain behaviorally unchanged.
- Settings sidebar contains exactly the six approved sections.
- `网页与浏览器` and `能力入口` are absent from the settings modal.
- `应用基础` contains workspace, startup/tray behavior, and global hotkey settings only.
- `任务与调度` edits existing task threshold and scheduler settings.
- `授权与安全` contains approval mode and grants only.
- `记忆策略` keeps real memory settings while moving detailed scan and capacity controls into collapsed advanced groups.
- `notifications.lowDistraction` has no remaining tracked source references after implementation.
- Legacy settings with the old notification field still load.
- Direct verification passes before claiming implementation complete.
