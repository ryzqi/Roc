# Settings Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the settings modal so non-model settings are easier to understand, remove unused settings from UI and config contracts, and expose existing task scheduler settings.

**Architecture:** Keep the current settings modal, save/reset flow, and provider/default-model sections. Clean the shared `AppSettings` contract first, then update renderer navigation and sections, then add the new task settings section through the existing `useSettingsDraft -> buildSettingsSaveRequest -> settings.save -> applySettingsSnapshot` flow.

**Tech Stack:** TypeScript ESM, React 19, Vitest, Electron main config services, PowerShell commands on Windows.

## Global Constraints

- Keep the current settings modal entry, shell, close behavior, and save/reset flow.
- Keep `模型提供商` and `默认模型` behavior unchanged.
- No new IPC channel.
- No new MCP, Skill, Exa, Jina, browser, notification, release, or packaging behavior.
- No navigation redesign outside the settings modal.
- No compatibility alias for removed UI sections.
- Delete `notifications.lowDistraction` from UI, shared types, config schema, defaults, migration, impact model, tests, and smoke assertions.
- Reading old settings documents that contain `notifications.lowDistraction` must succeed.
- `任务与调度` edits `tasks.longRunningThresholds.runningSeconds`, `tasks.longRunningThresholds.toolCallCount`, `tasks.longRunningThresholds.subagentCount`, `tasks.scheduler.catchUpOnStartup`, and `tasks.scheduler.maxRegisteredTasks`.
- Numeric task settings must not be silently saved when invalid.
- User-facing UI text remains Simplified Chinese.

---

## File Structure

- `src/shared/types/settings.ts`
  - Owns `AppSettings`. Remove `notifications`.
- `src/main/services/config/defaults.ts`
  - Owns default settings. Remove `notifications`.
- `src/main/services/config/schema.ts`
  - Owns current settings validation. Remove `notifications`.
- `src/main/services/config/migration.ts`
  - Owns legacy normalization. Accept legacy `notifications` by ignoring it.
- `src/renderer/settings/impact-model.ts`
  - Owns dirty/impact rows. Remove notification row, add task rows.
- `src/renderer/settings/use-settings-draft.ts`
  - Owns section reset. Add `tasks` section reset behavior.
- `src/renderer/settings-model.ts`
  - Owns settings section ids and labels. Replace browser/capabilities with tasks.
- `src/renderer/settings/index.tsx`
  - Owns settings modal section routing. Remove browser/capabilities branches, add task section branch.
- `src/renderer/settings/sections/app-basics-section.tsx`
  - Redesign app basics and remove low-distraction notification control.
- `src/renderer/settings/sections/task-settings-section.tsx`
  - New focused section for task thresholds and scheduler settings.
- `src/renderer/settings/sections/auth-security-section.tsx`
  - Remove release-surface info row; keep approval mode and grants.
- `src/renderer/settings/sections/memory-section.tsx`
  - Reorganize memory controls into primary retention plus collapsed advanced groups.
- `src/renderer/settings/sections/browser-section.tsx`
  - Delete after SettingsView no longer references it.
- `src/renderer/settings/sections/capabilities-section.tsx`
  - Delete after SettingsView no longer references it.
- `src/renderer/styles/settings.css`
  - Add section group, toggle, advanced block, and validation styles scoped to settings.
- Tests:
  - `tests/main/config-service-settings.test.ts`
  - `tests/main/config-service.test.ts`
  - `tests/main/config-service-providers.test.ts`
  - `tests/main/config-service-helpers.test.ts`
  - `tests/renderer/settings-model.test.ts`
  - `tests/renderer/settings-model-save.test.ts`
  - `tests/renderer/app-basics-section.test.tsx`
  - `tests/renderer/auth-security-section.test.tsx`
  - `tests/renderer/settings-floating-surfaces.test.ts`
  - `tests/renderer/task-settings-section.test.tsx`
  - `tests/renderer/view-test-helpers.ts`
  - `tests/smoke/lib/electron-smoke-settings.mjs`

---

### Task 1: Remove Notification Setting From Shared Config Contract

**Files:**
- Modify: `src/shared/types/settings.ts`
- Modify: `src/main/services/config/defaults.ts`
- Modify: `src/main/services/config/schema.ts`
- Modify: `src/main/services/config/migration.ts`
- Modify: `tests/main/config-service-settings.test.ts`
- Modify: `tests/main/config-service.test.ts`
- Modify: `tests/main/config-service-providers.test.ts`
- Modify: `tests/main/config-service-helpers.test.ts`
- Modify: `tests/renderer/view-test-helpers.ts`
- Modify: `tests/renderer/settings-model-save.test.ts`
- Modify: `tests/renderer/settings-model-openrouter-llama.test.ts`
- Modify: `tests/renderer/settings-model-openai.test.ts`
- Modify: `tests/renderer/settings-model-nvidia.test.ts`
- Modify: `tests/renderer/settings-model-anthropic.test.ts`

**Interfaces:**
- Consumes: existing `AppSettings`.
- Produces: `AppSettings` without `notifications`, `SettingsSchema` that accepts current settings without `notifications`, migration that ignores legacy `notifications.lowDistraction`.

- [ ] **Step 1: Write failing main config tests for removed notification contract**

In `tests/main/config-service-settings.test.ts`, update settings fixtures so current expected settings omit `notifications`, and add a legacy assertion inside the migration coverage that proves old notification input is ignored:

```ts
expect(readSettingsDocument().settings).not.toHaveProperty('notifications');
```

When a legacy raw settings object still includes:

```ts
notifications: { lowDistraction: false },
```

the expected migrated settings block must not include `notifications`.

- [ ] **Step 2: Run main config test to verify it fails**

Run:

```powershell
pnpm test -- tests/main/config-service-settings.test.ts
```

Expected: FAIL because `AppSettings`, `SettingsSchema`, and defaults still require `notifications.lowDistraction`.

- [ ] **Step 3: Remove `notifications` from shared type**

In `src/shared/types/settings.ts`, replace the `AppSettings` top-level shape by deleting the `notifications` field:

```ts
export type AppSettings = {
  schemaVersion: 2;
  defaultWorkspace: string | null;
  startup: {
    openAtLogin: boolean;
    minimizeToTray: boolean;
  };
  globalHotkey: string | null;
  memory: {
    charLimits: MemoryCharLimits;
    sessionRetentionDays: number;
    securityScan: MemorySecurityScanSettings;
  };
  tasks: {
    longRunningThresholds: {
      runningSeconds: number;
      toolCallCount: number;
      subagentCount: number;
    };
    scheduler: {
      catchUpOnStartup: boolean;
      maxRegisteredTasks: number;
    };
  };
};
```

- [ ] **Step 4: Remove notification default and schema**

In `src/main/services/config/defaults.ts`, make the top of `defaultSettings`:

```ts
export const defaultSettings: AppSettings = {
  schemaVersion: 2,
  defaultWorkspace: null,
  startup: {
    openAtLogin: false,
    minimizeToTray: true
  },
  globalHotkey: null,
  memory: {
    charLimits: { user: 1375, agents: 800, memory: 2200 },
    sessionRetentionDays: 90,
    securityScan: {
      promptInjection: true,
      credential: true,
      sshBackdoor: true,
      invisibleUnicode: true
    }
  },
  tasks: {
    longRunningThresholds: {
      runningSeconds: 90,
      toolCallCount: 8,
      subagentCount: 1
    },
    scheduler: {
      catchUpOnStartup: true,
      maxRegisteredTasks: 256
    }
  }
};
```

In `src/main/services/config/schema.ts`, remove this block from `SettingsSchema`:

```ts
notifications: z.object({
  lowDistraction: z.boolean()
}),
```

- [ ] **Step 5: Update migration to ignore legacy notification input**

In `src/main/services/config/migration.ts`, remove:

```ts
const notifications = (value.notifications ?? {}) as Record<string, unknown>;
```

and remove this output block from `upgradeLegacySettings`:

```ts
notifications: {
  lowDistraction: typeof notifications.lowDistraction === 'boolean' ? notifications.lowDistraction : true
},
```

The returned object still passes through `SettingsSchema.parse`.

- [ ] **Step 6: Update test fixtures without changing unrelated values**

In all listed test files, delete only this object from `AppSettings` fixtures:

```ts
notifications: { lowDistraction: true },
```

or:

```ts
notifications: { lowDistraction: false },
```

Keep all `startup`, `globalHotkey`, `memory`, and `tasks` values unchanged.

- [ ] **Step 7: Run focused config/model tests**

Run:

```powershell
pnpm test -- tests/main/config-service-settings.test.ts
pnpm test -- tests/renderer/settings-model-save.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add -- src/shared/types/settings.ts src/main/services/config/defaults.ts src/main/services/config/schema.ts src/main/services/config/migration.ts tests/main/config-service-settings.test.ts tests/main/config-service.test.ts tests/main/config-service-providers.test.ts tests/main/config-service-helpers.test.ts tests/renderer/view-test-helpers.ts tests/renderer/settings-model-save.test.ts tests/renderer/settings-model-openrouter-llama.test.ts tests/renderer/settings-model-openai.test.ts tests/renderer/settings-model-nvidia.test.ts tests/renderer/settings-model-anthropic.test.ts
git commit -m "refactor: remove unused notification setting"
```

---

### Task 2: Replace Settings Navigation Sections

**Files:**
- Modify: `src/renderer/settings-model.ts`
- Modify: `src/renderer/settings/index.tsx`
- Modify: `src/renderer/settings/use-settings-draft.ts`
- Delete: `src/renderer/settings/sections/browser-section.tsx`
- Delete: `src/renderer/settings/sections/capabilities-section.tsx`
- Delete: `tests/renderer/browser-section.test.ts`
- Modify: `tests/renderer/settings-model.test.ts`
- Modify: `tests/renderer/settings-floating-surfaces.test.ts`
- Modify: `tests/smoke/lib/electron-smoke-settings.mjs`

**Interfaces:**
- Consumes: `SettingsSectionId`.
- Produces: new section id `'tasks'`, six-section sidebar, no browser/capabilities settings routes.

- [ ] **Step 1: Write failing section model test**

In `tests/renderer/settings-model.test.ts`, update the first test expectation:

```ts
expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
  '模型提供商',
  '默认模型',
  '应用基础',
  '任务与调度',
  '授权与安全',
  '记忆策略'
]);
expect(selectSettingsSection('providers', 'tasks')).toBe('tasks');
expect(selectSettingsSection('providers', 'browser')).toBe('providers');
expect(selectSettingsSection('providers', 'capabilities')).toBe('providers');
expect(selectSettingsSection('providers', 'unknown')).toBe('providers');
```

- [ ] **Step 2: Run section model test to verify it fails**

Run:

```powershell
pnpm test -- tests/renderer/settings-model.test.ts
```

Expected: FAIL because `SETTINGS_SECTIONS` still contains `网页与浏览器` and `能力入口`.

- [ ] **Step 3: Update section ids**

In `src/renderer/settings-model.ts`, set the section type and array to:

```ts
export type SettingsSectionId =
  | 'providers'
  | 'default-model'
  | 'app-basics'
  | 'tasks'
  | 'auth-security'
  | 'memory';

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'providers', label: '模型提供商' },
  { id: 'default-model', label: '默认模型' },
  { id: 'app-basics', label: '应用基础' },
  { id: 'tasks', label: '任务与调度' },
  { id: 'auth-security', label: '授权与安全' },
  { id: 'memory', label: '记忆策略' }
];
```

- [ ] **Step 4: Remove browser/capabilities routing**

In `src/renderer/settings/index.tsx`, remove imports:

```ts
import { BrowserSection } from './sections/browser-section';
import { CapabilitiesSection } from './sections/capabilities-section';
```

Remove `exaTestLabel`, `exaServer`, `testExa`, and the effect that resets `exaTestLabel`.

Remove render branches:

```tsx
{activeSection === 'browser' ? (
  <BrowserSection exaServer={exaServer} onTestExa={testExa} testStatusLabel={exaTestLabel} />
) : null}
{activeSection === 'capabilities' ? (
  <CapabilitiesSection
    mcpServers={state.mcpServers}
    onNavigate={onNavigate}
    skills={state.skills}
  />
) : null}
```

Keep the `onNavigate` prop for now because `SettingsFeature` and `AppSettingsLayer` still pass it; remove it only if TypeScript proves no longer needed in this task.

- [ ] **Step 5: Add tasks reset behavior**

In `src/renderer/settings/use-settings-draft.ts`, update `resetSection`:

```ts
if (sectionId === 'app-basics' || sectionId === 'memory' || sectionId === 'tasks') {
  setDraftSettings(baseSettings);
}
```

- [ ] **Step 6: Delete unused browser/capabilities section files**

Delete:

```powershell
Remove-Item -LiteralPath 'src\renderer\settings\sections\browser-section.tsx'
Remove-Item -LiteralPath 'src\renderer\settings\sections\capabilities-section.tsx'
Remove-Item -LiteralPath 'tests\renderer\browser-section.test.ts'
```

Before running these commands, verify the paths are exactly under `F:\Code\Roc`.

- [ ] **Step 7: Update floating surfaces and smoke tests**

In `tests/renderer/settings-floating-surfaces.test.ts`, remove imports and render calls for `BrowserSection` and `CapabilitiesSection`. Keep assertions for app basics, auth/security, default model, memory, and providers.

In `tests/smoke/lib/electron-smoke-settings.mjs`, replace the navigation list:

```js
for (const sectionId of [
  'providers',
  'default-model',
  'app-basics',
  'tasks',
  'auth-security',
  'memory'
]) {
  await clickSmokeControl(page, `[data-testid="settings-section-${sectionId}"]`);
  await page.waitForSelector(`[data-testid="settings-panel-${sectionId}"], [data-testid="provider-settings"], [data-testid="default-model-settings"]`, {
    timeout: 5000
  });
}
```

Task 3 will create `settings-panel-tasks`.

- [ ] **Step 8: Run navigation tests**

Run:

```powershell
pnpm test -- tests/renderer/settings-model.test.ts
pnpm test -- tests/renderer/settings-floating-surfaces.test.ts
```

Expected: `settings-model.test.ts` PASS. `settings-floating-surfaces.test.ts` may fail until Task 3 creates the tasks section; if it fails only for missing `TaskSettingsSection`, continue to Task 3 without committing this task.

- [ ] **Step 9: Commit if both tests pass**

```powershell
git add -- src/renderer/settings-model.ts src/renderer/settings/index.tsx src/renderer/settings/use-settings-draft.ts src/renderer/settings/sections/browser-section.tsx src/renderer/settings/sections/capabilities-section.tsx tests/renderer/browser-section.test.ts tests/renderer/settings-model.test.ts tests/renderer/settings-floating-surfaces.test.ts tests/smoke/lib/electron-smoke-settings.mjs
git commit -m "refactor: simplify settings navigation"
```

If `settings-floating-surfaces.test.ts` fails because Task 3 is required, defer this commit and include Task 2 changes in Task 3's commit.

---

### Task 3: Add Task And Scheduler Settings Section

**Files:**
- Create: `src/renderer/settings/sections/task-settings-section.tsx`
- Create: `tests/renderer/task-settings-section.test.tsx`
- Modify: `src/renderer/settings/index.tsx`
- Modify: `src/renderer/settings/impact-model.ts`
- Modify: `tests/renderer/settings-model-save.test.ts`
- Modify: `tests/renderer/settings-floating-surfaces.test.ts`
- Modify: `src/renderer/styles/settings.css`

**Interfaces:**
- Consumes: `AppSettings`.
- Produces: `TaskSettingsSection({ draft, onChange }: { draft: AppSettings; onChange: (next: AppSettings) => void })`.
- Produces impact rows for task fields with section id `'tasks'`.

- [ ] **Step 1: Write failing component test**

Create `tests/renderer/task-settings-section.test.tsx`:

```tsx
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../src/shared/types';
import { TaskSettingsSection } from '../../src/renderer/settings/sections/task-settings-section';

function createSettings(): AppSettings {
  return {
    schemaVersion: 2,
    defaultWorkspace: null,
    startup: { openAtLogin: false, minimizeToTray: true },
    globalHotkey: null,
    memory: {
      charLimits: { user: 1375, agents: 800, memory: 2200 },
      sessionRetentionDays: 90,
      securityScan: {
        promptInjection: true,
        credential: true,
        sshBackdoor: true,
        invisibleUnicode: true
      }
    },
    tasks: {
      longRunningThresholds: {
        runningSeconds: 90,
        toolCallCount: 8,
        subagentCount: 1
      },
      scheduler: {
        catchUpOnStartup: true,
        maxRegisteredTasks: 256
      }
    }
  };
}

describe('TaskSettingsSection', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('edits task thresholds and scheduler settings', async () => {
    const onChange = vi.fn();
    const settings = createSettings();

    await act(async () => {
      root.render(<TaskSettingsSection draft={settings} onChange={onChange} />);
    });

    setInputValue('settings-task-running-seconds', '120');
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      tasks: {
        ...settings.tasks,
        longRunningThresholds: {
          ...settings.tasks.longRunningThresholds,
          runningSeconds: 120
        }
      }
    });

    await act(async () => {
      query<HTMLInputElement>('settings-task-catch-up-on-startup').click();
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      tasks: {
        ...settings.tasks,
        scheduler: {
          ...settings.tasks.scheduler,
          catchUpOnStartup: false
        }
      }
    });
  });

  it('shows row-level validation and does not emit invalid numeric settings', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<TaskSettingsSection draft={createSettings()} onChange={onChange} />);
    });

    setInputValue('settings-task-max-registered-tasks', '0');

    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('必须是大于 0 的整数');
  });

  function query<T extends HTMLElement>(testId: string): T {
    const element = container.querySelector<T>(`[data-testid="${testId}"]`);
    expect(element).not.toBeNull();
    return element as T;
  }

  function setInputValue(testId: string, value: string): void {
    const input = query<HTMLInputElement>(testId);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    expect(setter).not.toBeUndefined();
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
```

- [ ] **Step 2: Run component test to verify it fails**

Run:

```powershell
pnpm test -- tests/renderer/task-settings-section.test.tsx
```

Expected: FAIL because `TaskSettingsSection` does not exist.

- [ ] **Step 3: Implement task settings section**

Create `src/renderer/settings/sections/task-settings-section.tsx`:

```tsx
import type React from 'react';
import { useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { FieldRow } from '../atoms';

type NumberFieldName =
  | 'runningSeconds'
  | 'toolCallCount'
  | 'subagentCount'
  | 'maxRegisteredTasks';

type NumberFieldRule = {
  field: NumberFieldName;
  label: string;
  hint: string;
  min: number;
  testId: string;
  value: number;
};

export function TaskSettingsSection({
  draft,
  onChange
}: {
  draft: AppSettings;
  onChange: (next: AppSettings) => void;
}): React.JSX.Element {
  const [errors, setErrors] = useState<Partial<Record<NumberFieldName, string>>>({});

  const thresholdRules: NumberFieldRule[] = [
    {
      field: 'runningSeconds',
      label: '运行秒数',
      hint: '任务运行达到该秒数后，会被视为长任务候选。',
      min: 0,
      testId: 'settings-task-running-seconds',
      value: draft.tasks.longRunningThresholds.runningSeconds
    },
    {
      field: 'toolCallCount',
      label: '工具调用数',
      hint: '工具调用达到该次数后，会提高长任务识别权重。',
      min: 0,
      testId: 'settings-task-tool-call-count',
      value: draft.tasks.longRunningThresholds.toolCallCount
    },
    {
      field: 'subagentCount',
      label: '子代理数',
      hint: '子代理数量达到该值后，会被视为复杂任务候选。',
      min: 0,
      testId: 'settings-task-subagent-count',
      value: draft.tasks.longRunningThresholds.subagentCount
    }
  ];

  const schedulerRule: NumberFieldRule = {
    field: 'maxRegisteredTasks',
    label: '最大注册任务数',
    hint: '限制后台调度器可登记的任务总数。',
    min: 1,
    testId: 'settings-task-max-registered-tasks',
    value: draft.tasks.scheduler.maxRegisteredTasks
  };

  function parseInteger(raw: string, min: number): number | string {
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      return min === 0 ? '必须是大于或等于 0 的整数' : '必须是大于 0 的整数';
    }
    if (value < min) {
      return min === 0 ? '必须是大于或等于 0 的整数' : '必须是大于 0 的整数';
    }
    return value;
  }

  function setNumberField(rule: NumberFieldRule, raw: string): void {
    const parsed = parseInteger(raw, rule.min);
    if (typeof parsed === 'string') {
      setErrors((current) => ({ ...current, [rule.field]: parsed }));
      return;
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[rule.field];
      return next;
    });
    if (rule.field === 'maxRegisteredTasks') {
      onChange({
        ...draft,
        tasks: {
          ...draft.tasks,
          scheduler: {
            ...draft.tasks.scheduler,
            maxRegisteredTasks: parsed
          }
        }
      });
      return;
    }
    onChange({
      ...draft,
      tasks: {
        ...draft.tasks,
        longRunningThresholds: {
          ...draft.tasks.longRunningThresholds,
          [rule.field]: parsed
        }
      }
    });
  }

  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-tasks">
      <div className="section-head">
        <h2 className="section-title">任务与调度</h2>
      </div>
      <div className="settings-section-group">
        <h3 className="settings-group-title">长任务识别</h3>
        <div className="form-grid">
          {thresholdRules.map((rule) => (
            <FieldRow hint={rule.hint} key={rule.field} label={rule.label}>
              <input
                data-testid={rule.testId}
                inputMode="numeric"
                min={rule.min}
                onChange={(event) => setNumberField(rule, event.currentTarget.value)}
                type="number"
                value={rule.value}
              />
              {errors[rule.field] === undefined ? null : (
                <small className="field-error">{errors[rule.field]}</small>
              )}
            </FieldRow>
          ))}
        </div>
      </div>
      <div className="settings-section-group">
        <h3 className="settings-group-title">后台调度</h3>
        <div className="form-grid">
          <label className="field checkbox-field settings-toggle-row">
            <span>启动时补跑</span>
            <input
              checked={draft.tasks.scheduler.catchUpOnStartup}
              data-testid="settings-task-catch-up-on-startup"
              onChange={(event) =>
                onChange({
                  ...draft,
                  tasks: {
                    ...draft.tasks,
                    scheduler: {
                      ...draft.tasks.scheduler,
                      catchUpOnStartup: event.currentTarget.checked
                    }
                  }
                })
              }
              type="checkbox"
            />
            <small className="field-hint">应用启动时补跑错过触发时间的后台任务。</small>
          </label>
          <FieldRow hint={schedulerRule.hint} label={schedulerRule.label}>
            <input
              data-testid={schedulerRule.testId}
              inputMode="numeric"
              min={schedulerRule.min}
              onChange={(event) => setNumberField(schedulerRule, event.currentTarget.value)}
              type="number"
              value={schedulerRule.value}
            />
            {errors.maxRegisteredTasks === undefined ? null : (
              <small className="field-error">{errors.maxRegisteredTasks}</small>
            )}
          </FieldRow>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Wire section into SettingsView**

In `src/renderer/settings/index.tsx`, add:

```ts
import { TaskSettingsSection } from './sections/task-settings-section';
```

Add render branch after app basics:

```tsx
{activeSection === 'tasks' ? (
  <TaskSettingsSection
    draft={draft.settings}
    onChange={draft.setSettings}
  />
) : null}
```

- [ ] **Step 5: Add task impact rows**

In `src/renderer/settings/impact-model.ts`, add helper copy:

```ts
const taskFieldImpactCopy: Record<string, string> = {
  'longRunningThresholds.runningSeconds': '会影响任务运行多久后被识别为长任务候选。',
  'longRunningThresholds.toolCallCount': '会影响工具调用多少次后被识别为长任务候选。',
  'longRunningThresholds.subagentCount': '会影响子代理数量达到多少后被识别为复杂任务候选。',
  'scheduler.catchUpOnStartup': '会影响应用启动时是否补跑错过触发时间的后台任务。',
  'scheduler.maxRegisteredTasks': '会影响后台调度器最多登记多少个任务。'
};
```

Inside `buildImpactRows`, after app basics rows and before memory rows, add `pushIfChanged` calls with section id `'tasks'`:

```ts
pushIfChanged(
  rows,
  'tasks',
  'tasks.longRunningThresholds.runningSeconds',
  base.settings.tasks.longRunningThresholds.runningSeconds,
  draft.settings.tasks.longRunningThresholds.runningSeconds,
  taskFieldImpactCopy['longRunningThresholds.runningSeconds'],
  'info',
  (value) => `${value} 秒`
);
pushIfChanged(
  rows,
  'tasks',
  'tasks.longRunningThresholds.toolCallCount',
  base.settings.tasks.longRunningThresholds.toolCallCount,
  draft.settings.tasks.longRunningThresholds.toolCallCount,
  taskFieldImpactCopy['longRunningThresholds.toolCallCount'],
  'info',
  (value) => `${value} 次`
);
pushIfChanged(
  rows,
  'tasks',
  'tasks.longRunningThresholds.subagentCount',
  base.settings.tasks.longRunningThresholds.subagentCount,
  draft.settings.tasks.longRunningThresholds.subagentCount,
  taskFieldImpactCopy['longRunningThresholds.subagentCount'],
  'info',
  (value) => `${value} 个`
);
pushIfChanged(
  rows,
  'tasks',
  'tasks.scheduler.catchUpOnStartup',
  base.settings.tasks.scheduler.catchUpOnStartup,
  draft.settings.tasks.scheduler.catchUpOnStartup,
  taskFieldImpactCopy['scheduler.catchUpOnStartup'],
  'info',
  (value) => (value ? '启动时补跑' : '启动时不补跑')
);
pushIfChanged(
  rows,
  'tasks',
  'tasks.scheduler.maxRegisteredTasks',
  base.settings.tasks.scheduler.maxRegisteredTasks,
  draft.settings.tasks.scheduler.maxRegisteredTasks,
  taskFieldImpactCopy['scheduler.maxRegisteredTasks'],
  'info',
  (value) => `${value} 个`
);
```

Remove the notification impact row if still present.

- [ ] **Step 6: Update impact model test**

In `tests/renderer/settings-model-save.test.ts`, update `reports impact rows` so `draftSettings` changes one task field:

```ts
tasks: {
  ...baseSettings.tasks,
  scheduler: {
    ...baseSettings.tasks.scheduler,
    maxRegisteredTasks: 128
  }
}
```

Expected fields include:

```ts
'tasks.scheduler.maxRegisteredTasks'
```

and do not include:

```ts
'notifications.lowDistraction'
```

Assert:

```ts
expect(rows.find((row) => row.field === 'tasks.scheduler.maxRegisteredTasks')?.sectionId).toBe('tasks');
expect(rows.find((row) => row.field === 'tasks.scheduler.maxRegisteredTasks')?.after).toBe('128 个');
```

- [ ] **Step 7: Add settings styles**

In `src/renderer/styles/settings.css`, add scoped styles:

```css
.settings-section-group {
  display: grid;
  gap: 12px;
}

.settings-group-title {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.settings-toggle-row {
  min-height: 74px;
}

.field-error {
  color: var(--st-bad);
  font-size: 12px;
  line-height: 1.4;
}

.settings-advanced {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: rgba(245, 248, 252, 0.5);
  padding: 12px 14px;
}

.settings-advanced > summary {
  cursor: pointer;
  color: var(--ink);
  font-size: var(--font-meta-size);
  font-weight: 600;
}
```

- [ ] **Step 8: Run task and settings tests**

Run:

```powershell
pnpm test -- tests/renderer/task-settings-section.test.tsx
pnpm test -- tests/renderer/settings-model-save.test.ts
pnpm test -- tests/renderer/settings-floating-surfaces.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add -- src/renderer/settings/sections/task-settings-section.tsx tests/renderer/task-settings-section.test.tsx src/renderer/settings/index.tsx src/renderer/settings/impact-model.ts tests/renderer/settings-model-save.test.ts tests/renderer/settings-floating-surfaces.test.ts src/renderer/styles/settings.css
git commit -m "feat: add task scheduler settings"
```

If Task 2 commit was deferred, include Task 2 files in this commit with the same message.

---

### Task 4: Redesign App Basics, Auth Security, And Memory Sections

**Files:**
- Modify: `src/renderer/settings/sections/app-basics-section.tsx`
- Modify: `src/renderer/settings/sections/auth-security-section.tsx`
- Modify: `src/renderer/settings/sections/memory-section.tsx`
- Modify: `tests/renderer/app-basics-section.test.tsx`
- Modify: `tests/renderer/auth-security-section.test.tsx`
- Modify: `tests/renderer/settings-floating-surfaces.test.ts`
- Modify: `src/renderer/styles/settings.css`

**Interfaces:**
- Consumes: `AppBasicsSection`, `AuthSecuritySection`, `MemorySection` existing props.
- Produces: same component signatures, updated markup and copy.

- [ ] **Step 1: Update app basics test first**

In `tests/renderer/app-basics-section.test.tsx`, replace the old low-distraction test with:

```tsx
it('renders workspace, window behavior, and global entry settings without notification controls', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppBasicsSection, {
      draft: createSettings(),
      hostIntegration: createHostIntegration(),
      onChange: vi.fn()
    })
  );

  expect(html).toContain('工作区');
  expect(html).toContain('窗口行为');
  expect(html).toContain('全局入口');
  expect(html).toContain('data-testid="settings-default-workspace"');
  expect(html).toContain('data-testid="settings-startup-open-at-login"');
  expect(html).toContain('data-testid="settings-startup-minimize-to-tray"');
  expect(html).toContain('data-testid="settings-global-hotkey"');
  expect(html).not.toContain('低打扰通知');
  expect(html).not.toContain('settings-notifications-low-distraction');
});
```

Also remove `notifications` from `createSettings()`.

- [ ] **Step 2: Update auth/security test first**

In `tests/renderer/auth-security-section.test.tsx`, keep assertions for approval modes and grants. Replace release copy assertion with:

```ts
expect(html).not.toContain('发布级系统能力');
expect(html).not.toContain('release surface');
expect(html).not.toContain('未启用系统 URL 协议');
```

- [ ] **Step 3: Update memory layout assertions**

In `tests/renderer/settings-floating-surfaces.test.ts`, for `MemorySection`, assert:

```ts
expect(sectionHtml).toContain('高级保护');
expect(sectionHtml).toContain('高级容量');
expect(sectionHtml).toContain('Prompt injection 扫描');
expect(sectionHtml).toContain('USER 容量');
```

- [ ] **Step 4: Run tests to verify failures**

Run:

```powershell
pnpm test -- tests/renderer/app-basics-section.test.tsx
pnpm test -- tests/renderer/auth-security-section.test.tsx
pnpm test -- tests/renderer/settings-floating-surfaces.test.ts
```

Expected: FAIL until components are redesigned.

- [ ] **Step 5: Redesign AppBasicsSection**

In `src/renderer/settings/sections/app-basics-section.tsx`, keep `formatOpenAtLoginHint` and `formatGlobalHotkeyHint`. Replace the JSX inside the `<section>` with grouped layout:

```tsx
<div className="settings-section-group">
  <h3 className="settings-group-title">工作区</h3>
  <FieldRow hint="工作区切换不会自动转移已运行任务，新任务才会绑定新的工作区。" label="默认工作区">
    <input
      data-testid="settings-default-workspace"
      onChange={(event) =>
        onChange({
          ...draft,
          defaultWorkspace:
            event.currentTarget.value.trim().length === 0 ? null : event.currentTarget.value
        })
      }
      placeholder="例如 F:\\Code\\Roc"
      value={draft.defaultWorkspace === null ? '' : draft.defaultWorkspace}
    />
  </FieldRow>
</div>
<div className="settings-section-group">
  <h3 className="settings-group-title">窗口行为</h3>
  <div className="form-grid">
    <label className="field checkbox-field settings-toggle-row">
      <span>开机启动</span>
      <input
        checked={draft.startup.openAtLogin}
        data-testid="settings-startup-open-at-login"
        onChange={(event) =>
          onChange({
            ...draft,
            startup: {
              ...draft.startup,
              openAtLogin: event.currentTarget.checked
            }
          })
        }
        type="checkbox"
      />
      <small className="field-hint">{formatOpenAtLoginHint(hostIntegration)}</small>
    </label>
    <label className="field checkbox-field settings-toggle-row">
      <span>最小化到托盘</span>
      <input
        checked={draft.startup.minimizeToTray}
        data-testid="settings-startup-minimize-to-tray"
        onChange={(event) =>
          onChange({
            ...draft,
            startup: {
              ...draft.startup,
              minimizeToTray: event.currentTarget.checked
            }
          })
        }
        type="checkbox"
      />
      <small className="field-hint">关闭主窗口后保持后台驻留。</small>
    </label>
  </div>
</div>
<div className="settings-section-group">
  <h3 className="settings-group-title">全局入口</h3>
  <FieldRow hint={formatGlobalHotkeyHint(hostIntegration)} label="全局快捷键">
    <input
      data-testid="settings-global-hotkey"
      onChange={(event) => {
        const value = event.currentTarget.value.trim();
        onChange({
          ...draft,
          globalHotkey: value.length === 0 ? null : value
        });
      }}
      placeholder="例如 Ctrl+Shift+Space"
      value={draft.globalHotkey === null ? '' : draft.globalHotkey}
    />
  </FieldRow>
</div>
```

Remove the `低打扰通知` checkbox entirely.

- [ ] **Step 6: Trim AuthSecuritySection**

In `src/renderer/settings/sections/auth-security-section.tsx`, delete the final `settings-subsection` whose heading is `发布级系统能力` and whose `InfoRow` title is `release surface`.

Keep approval mode and long-term grant markup unchanged except copy adjustments needed by tests.

- [ ] **Step 7: Reorganize MemorySection**

In `src/renderer/settings/sections/memory-section.tsx`, keep the helper functions. Replace the flat form grid with:

```tsx
<div className="settings-section-group">
  <h3 className="settings-group-title">会话回忆</h3>
  <FieldRow hint="会话回忆超过保留期会被自动清理；策展记忆不受影响。" label="会话回忆保留">
    <input
      data-testid="settings-memory-session-retention-days"
      onChange={(event) => {
        const value = parsePositiveInteger(event.currentTarget.value);
        if (value !== null) {
          patchMemory({ sessionRetentionDays: value });
        }
      }}
      min={1}
      type="number"
      value={draft.memory.sessionRetentionDays}
    />
  </FieldRow>
</div>
<div className="settings-section-group">
  <h3 className="settings-group-title">安全扫描</h3>
  <p className="card-hint">当前写入记忆前会检查 prompt injection、凭据、SSH 后门和不可见字符。</p>
  <details className="settings-advanced">
    <summary>高级保护</summary>
    <div className="form-grid">
      <label className="field checkbox-field">
        <span>Prompt injection 扫描</span>
        <input
          checked={draft.memory.securityScan.promptInjection}
          data-testid="settings-memory-security-prompt-injection"
          onChange={(event) => patchSecurityScan('promptInjection', event.currentTarget.checked)}
          type="checkbox"
        />
      </label>
      <label className="field checkbox-field">
        <span>凭据扫描</span>
        <input
          checked={draft.memory.securityScan.credential}
          data-testid="settings-memory-security-credential"
          onChange={(event) => patchSecurityScan('credential', event.currentTarget.checked)}
          type="checkbox"
        />
      </label>
      <label className="field checkbox-field">
        <span>SSH 后门扫描</span>
        <input
          checked={draft.memory.securityScan.sshBackdoor}
          data-testid="settings-memory-security-ssh-backdoor"
          onChange={(event) => patchSecurityScan('sshBackdoor', event.currentTarget.checked)}
          type="checkbox"
        />
      </label>
      <label className="field checkbox-field">
        <span>不可见字符扫描</span>
        <input
          checked={draft.memory.securityScan.invisibleUnicode}
          data-testid="settings-memory-security-invisible-unicode"
          onChange={(event) => patchSecurityScan('invisibleUnicode', event.currentTarget.checked)}
          type="checkbox"
        />
      </label>
    </div>
  </details>
</div>
<div className="settings-section-group">
  <details className="settings-advanced">
    <summary>高级容量</summary>
    <div className="form-grid">
      <FieldRow hint="USER.md 最大字符数。" label="USER 容量">
        <input
          data-testid="settings-memory-char-limit-user"
          onChange={(event) => {
            const value = parsePositiveInteger(event.currentTarget.value);
            if (value !== null) {
              patchCharLimit('user', value);
            }
          }}
          min={1}
          type="number"
          value={draft.memory.charLimits.user}
        />
      </FieldRow>
      <FieldRow hint="AGENTS.md 最大字符数。" label="AGENTS 容量">
        <input
          data-testid="settings-memory-char-limit-agents"
          onChange={(event) => {
            const value = parsePositiveInteger(event.currentTarget.value);
            if (value !== null) {
              patchCharLimit('agents', value);
            }
          }}
          min={1}
          type="number"
          value={draft.memory.charLimits.agents}
        />
      </FieldRow>
      <FieldRow hint="MEMORY.md 最大字符数。" label="MEMORY 容量">
        <input
          data-testid="settings-memory-char-limit-memory"
          onChange={(event) => {
            const value = parsePositiveInteger(event.currentTarget.value);
            if (value !== null) {
              patchCharLimit('memory', value);
            }
          }}
          min={1}
          type="number"
          value={draft.memory.charLimits.memory}
        />
      </FieldRow>
    </div>
  </details>
</div>
```

- [ ] **Step 8: Run section tests**

Run:

```powershell
pnpm test -- tests/renderer/app-basics-section.test.tsx
pnpm test -- tests/renderer/auth-security-section.test.tsx
pnpm test -- tests/renderer/settings-floating-surfaces.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add -- src/renderer/settings/sections/app-basics-section.tsx src/renderer/settings/sections/auth-security-section.tsx src/renderer/settings/sections/memory-section.tsx tests/renderer/app-basics-section.test.tsx tests/renderer/auth-security-section.test.tsx tests/renderer/settings-floating-surfaces.test.ts src/renderer/styles/settings.css
git commit -m "style: reorganize settings sections"
```

---

### Task 5: Final Cleanup And Verification

**Files:**
- Modify: `tests/smoke/lib/electron-smoke-settings.mjs`
- Inspect: all source and tests touched by Tasks 1-4

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: verified settings redesign with no notification setting residue.

- [ ] **Step 1: Search for deleted setting residue**

Run:

```powershell
rg -n "lowDistraction|notifications|settings-notifications-low-distraction|网页与浏览器|能力入口|settings-section-browser|settings-section-capabilities|settings-panel-browser|settings-panel-capabilities" src tests docs/superpowers/specs/2026-06-24-settings-page-redesign-design.md
```

Expected: only spec references to the removed concepts may remain. No `src` or `tests` matches for `lowDistraction`, `notifications`, or deleted settings test ids.

- [ ] **Step 2: Update smoke settings navigation and assertions**

In `tests/smoke/lib/electron-smoke-settings.mjs`, ensure the settings section loop uses exactly:

```js
for (const sectionId of [
  'providers',
  'default-model',
  'app-basics',
  'tasks',
  'auth-security',
  'memory'
]) {
  await clickSmokeControl(page, `[data-testid="settings-section-${sectionId}"]`);
  await page.waitForSelector(`[data-testid="settings-panel-${sectionId}"], [data-testid="provider-settings"], [data-testid="default-model-settings"]`, {
    timeout: 5000
  });
}
```

Add evidence after visiting tasks:

```js
providerSettingsEvidence.taskSettingsVisible =
  (await page.locator('[data-testid="settings-panel-tasks"]').count()) > 0 ||
  ((await page.textContent('[data-testid="settings-view"]')) ?? '').includes('任务与调度');
```

Keep existing provider/default-model/app-basics evidence.

- [ ] **Step 3: Run targeted verification**

Run:

```powershell
pnpm test -- tests/renderer/settings-model.test.ts
pnpm test -- tests/renderer/task-settings-section.test.tsx
pnpm test -- tests/renderer/settings-model-save.test.ts
pnpm test -- tests/renderer/app-basics-section.test.tsx
pnpm test -- tests/renderer/auth-security-section.test.tsx
pnpm test -- tests/renderer/settings-floating-surfaces.test.ts
pnpm test -- tests/main/config-service-settings.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run broader verification**

Run:

```powershell
pnpm typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Optional smoke verification if renderer tests and typecheck pass**

Run only if the local Electron smoke environment is healthy:

```powershell
node tests\smoke\lib\electron-smoke-settings.mjs
```

Expected: PASS or a known environment-only failure with logs that do not point to settings UI selectors.

- [ ] **Step 6: Commit final cleanup**

```powershell
git add -- tests/smoke/lib/electron-smoke-settings.mjs
git commit -m "test: update settings smoke coverage"
```

If no smoke file changes remain, skip this commit and record that Task 5 had verification-only changes.

---

## Self-Review Checklist

- Spec coverage:
  - Modal shell unchanged: Tasks 2-4 avoid `settings-modal.tsx`.
  - Provider/default model unchanged: Tasks do not edit provider/default-model components except shared `SettingsView` routing.
  - Browser/capabilities removed: Task 2.
  - Notification setting removed from contract: Task 1 and Task 5 residue search.
  - Task settings exposed: Task 3.
  - App basics/auth/memory redesigned: Task 4.
  - Verification commands included: Task 5.
- Completion scan:
  - No deferred requirement markers.
- Type consistency:
  - New section id is always `'tasks'`.
  - New component is always `TaskSettingsSection`.
  - New test file is always `tests/renderer/task-settings-section.test.tsx`.
