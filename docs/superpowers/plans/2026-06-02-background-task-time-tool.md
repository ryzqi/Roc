# Background Task Time Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workflow-local `resolve_background_task_time` tool so background-task creation resolves and validates time before `propose_background_task`.

**Architecture:** Keep the renderer contract unchanged: task workbench still submits raw user input plus `workflowHint: 'propose_background_task'`. Add a focused main-process time parser/tool, register it in deep-agent sessions, extend the workflow prompt with a one-shot, and update forge guardrails so the create-background-task workflow enforces time resolution before propose/schedule while allowing a dedicated clarification terminal branch.

**Tech Stack:** TypeScript, Electron main process services, LangChain `DynamicStructuredTool`, Zod, Vitest, existing Roc forge guardrails.

---

## File Structure

- Create `src/main/services/deep-agent/background-task-time-tool.ts`
  - Owns the Zod schema, parser, timezone/reference-time handling, and `createResolveBackgroundTaskTimeTool`.
  - Depends only on existing `BackgroundTaskTrigger`, `RocDomainError`, and `computeNextCronRunAt`.
- Modify `src/main/services/deep-agent/session.ts`
  - Imports and registers `resolve_background_task_time` before background task propose/schedule tools.
- Modify `src/main/services/deep-agent/prompt.ts`
  - Replaces the short create-background-task workflow overview with one-shot guidance.
- Modify `src/main/services/forge-guardrails/state-schema.ts`
  - Adds `backgroundTaskTimeResolution` to `ForgeStepTrackerState`.
- Modify `src/main/services/forge-guardrails/middleware/step-enforcement.ts`
  - Records `resolve_background_task_time` output status.
  - Allows `confirm_with_user` only for the clarification branch or after all required steps.
- Modify `src/main/services/forge-guardrails/prerequisites-config.ts`
  - Adds `resolve_background_task_time` to `requiredSteps`.
  - Adds prerequisite from `propose_background_task` to `resolve_background_task_time`.
- Modify `src/main/services/agent-service.ts`
  - Adds a built-in capability card for the new tool.
- Create `tests/main/background-task-time-tool.test.ts`
  - Covers parser/tool behavior.
- Modify `tests/main/deep-agent-prompt.test.ts`
  - Covers one-shot prompt.
- Modify `tests/main/services/forge-guardrails/prerequisites-config.test.ts`
  - Covers workflow/prerequisite config.
- Modify `tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts`
  - Covers clarification branch.
- Modify `tests/main/app-services.provider.test.ts`
  - Covers capability card order/metadata.
- Modify `tests/main/deep-agent-runtime-service.test.ts`
  - Covers runtime tool registration descriptors.

---

### Task 1: Time Parser And Tool

**Files:**
- Create: `src/main/services/deep-agent/background-task-time-tool.ts`
- Test: `tests/main/background-task-time-tool.test.ts`

- [ ] **Step 1: Write failing parser/tool tests**

Create `tests/main/background-task-time-tool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createResolveBackgroundTaskTimeTool,
  resolveBackgroundTaskTime
} from '../../src/main/services/deep-agent/background-task-time-tool';

function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

const referenceDate = new Date(2026, 5, 2, 10, 30, 0, 0);

describe('background task time resolver', () => {
  it('resolves relative minutes into a once trigger', () => {
    const result = resolveBackgroundTaskTime({
      text: '15 分钟后检查测试失败情况',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toEqual({
      status: 'resolved',
      trigger: {
        type: 'once',
        description: '15 分钟后',
        nextRunAt: localIso(2026, 6, 2, 10, 45)
      },
      reference: {
        nowUtc: referenceDate.toISOString(),
        nowLocal: '2026-06-02 10:30',
        timeZone: 'Asia/Shanghai'
      },
      confidence: 'high',
      notes: ['按本机时区解析相对时间。']
    });
  });

  it('resolves tomorrow HH:mm into a once trigger', () => {
    const result = resolveBackgroundTaskTime({
      text: '明天 09:15 生成报告',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toMatchObject({
      status: 'resolved',
      trigger: {
        type: 'once',
        description: '明天 09:15',
        nextRunAt: localIso(2026, 6, 3, 9, 15)
      },
      confidence: 'high'
    });
  });

  it('resolves daily HH:mm into a cron trigger with the next future run', () => {
    const result = resolveBackgroundTaskTime({
      text: '每天 09:00 检查测试失败情况',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toMatchObject({
      status: 'resolved',
      trigger: {
        type: 'cron',
        description: '每天 09:00',
        cronExpression: '0 9 * * *',
        nextRunAt: localIso(2026, 6, 3, 9, 0)
      },
      confidence: 'high'
    });
  });

  it('resolves weekly Chinese weekday into a cron trigger', () => {
    const result = resolveBackgroundTaskTime({
      text: '每周一 08:30 汇总待办',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toMatchObject({
      status: 'resolved',
      trigger: {
        type: 'cron',
        description: '每周一 08:30',
        cronExpression: '30 8 * * 1',
        nextRunAt: localIso(2026, 6, 8, 8, 30)
      }
    });
  });

  it('resolves monthly day into a cron trigger', () => {
    const result = resolveBackgroundTaskTime({
      text: '每月 3 日 14:05 检查账单',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toMatchObject({
      status: 'resolved',
      trigger: {
        type: 'cron',
        description: '每月 3 日 14:05',
        cronExpression: '5 14 3 * *',
        nextRunAt: localIso(2026, 6, 3, 14, 5)
      }
    });
  });

  it('returns manual when there is no time intent', () => {
    const result = resolveBackgroundTaskTime({
      text: '手动检查当前仓库',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toMatchObject({
      status: 'resolved',
      trigger: {
        type: 'manual',
        description: '手动触发'
      },
      confidence: 'medium',
      notes: ['未检测到明确时间表达，按手动触发处理。']
    });
  });

  it('asks for clarification when explicit once time is already in the past', () => {
    const result = resolveBackgroundTaskTime({
      text: '今天 09:00 检查测试失败情况',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toEqual({
      status: 'needs_clarification',
      reference: {
        nowUtc: referenceDate.toISOString(),
        nowLocal: '2026-06-02 10:30',
        timeZone: 'Asia/Shanghai'
      },
      clarificationQuestion: '你给出的触发时间已经过去。请提供一个未来时间。',
      notes: ['一次性触发时间必须晚于当前时间。']
    });
  });

  it('asks for clarification when the time expression is explicit but unsupported', () => {
    const result = resolveBackgroundTaskTime({
      text: '每个工作日早上检查状态',
      now: referenceDate,
      timeZone: 'Asia/Shanghai'
    });

    expect(result).toMatchObject({
      status: 'needs_clarification',
      clarificationQuestion: '我无法稳定解析这个触发时间。请改写为明确格式，例如“每天 09:00”或“每周一 09:00”。'
    });
  });

  it('tool returns formatted JSON with runtime time reference', async () => {
    const tool = createResolveBackgroundTaskTimeTool({
      now: () => referenceDate,
      timeZone: () => 'Asia/Shanghai'
    });

    const raw = await tool.invoke({ text: '15 分钟后检查测试失败情况' });

    expect(JSON.parse(raw)).toMatchObject({
      status: 'resolved',
      trigger: {
        type: 'once',
        nextRunAt: localIso(2026, 6, 2, 10, 45)
      },
      reference: {
        timeZone: 'Asia/Shanghai'
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
pnpm vitest run tests/main/background-task-time-tool.test.ts
```

Expected: FAIL with module not found for `background-task-time-tool`.

- [ ] **Step 3: Implement parser and tool**

Create `src/main/services/deep-agent/background-task-time-tool.ts`:

```ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { BackgroundTaskTrigger } from '../../../shared/types';
import { RocDomainError } from '../errors';
import { computeNextCronRunAt } from '../task/cron-parser';

export const RESOLVE_BACKGROUND_TASK_TIME_TOOL_NAME = 'resolve_background_task_time';

const timeToolInputSchema = z.strictObject({
  text: z.string().trim().min(1).describe('用户关于后台任务触发时间的自然语言描述。')
});

type TimeToolDependencies = {
  now?: () => Date;
  timeZone?: () => string;
};

type TimeReference = {
  nowUtc: string;
  nowLocal: string;
  timeZone: string;
};

export type ResolveBackgroundTaskTimeResult =
  | {
      status: 'resolved';
      trigger: BackgroundTaskTrigger;
      reference: TimeReference;
      confidence: 'high' | 'medium';
      notes: string[];
    }
  | {
      status: 'needs_clarification';
      reference: TimeReference;
      clarificationQuestion: string;
      notes: string[];
    };

type ResolveBackgroundTaskTimeInput = {
  now?: Date;
  text: string;
  timeZone?: string;
};

type ClockParts = {
  hour: number;
  minute: number;
  raw: string;
};

const chineseWeekdays: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6
};

export function createResolveBackgroundTaskTimeTool(input: TimeToolDependencies = {}): DynamicStructuredTool<any, any, any, string> {
  return new DynamicStructuredTool<typeof timeToolInputSchema, z.infer<typeof timeToolInputSchema>, z.infer<typeof timeToolInputSchema>, string>({
    name: RESOLVE_BACKGROUND_TASK_TIME_TOOL_NAME,
    description: [
      '解析后台任务的自然语言触发时间。',
      '先调用本工具，再用返回的 trigger 调用 propose_background_task。',
      '本工具不创建任务，只返回 manual / once / cron trigger 候选或澄清问题。'
    ].join('\n'),
    schema: timeToolInputSchema,
    func: async (rawInput) => {
      const parsed = timeToolInputSchema.parse(rawInput);
      return JSON.stringify(
        resolveBackgroundTaskTime({
          text: parsed.text,
          now: readNow(input.now),
          timeZone: readTimeZone(input.timeZone)
        }),
        null,
        2
      );
    }
  });
}

export function resolveBackgroundTaskTime(input: ResolveBackgroundTaskTimeInput): ResolveBackgroundTaskTimeResult {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? readTimeZone();
  const reference = createReference(now, timeZone);
  const text = input.text.trim();

  const relative = resolveRelative(text, now, reference);
  if (relative !== null) {
    return relative;
  }

  const absoluteDate = resolveAbsoluteDate(text, now, reference);
  if (absoluteDate !== null) {
    return absoluteDate;
  }

  const dayRelative = resolveDayRelative(text, now, reference);
  if (dayRelative !== null) {
    return dayRelative;
  }

  const daily = resolveDaily(text, now, reference);
  if (daily !== null) {
    return daily;
  }

  const weekly = resolveWeekly(text, now, reference);
  if (weekly !== null) {
    return weekly;
  }

  const monthly = resolveMonthly(text, now, reference);
  if (monthly !== null) {
    return monthly;
  }

  if (hasExplicitUnsupportedTimeIntent(text)) {
    return clarification(reference, '我无法稳定解析这个触发时间。请改写为明确格式，例如“每天 09:00”或“每周一 09:00”。', [
      '检测到时间意图，但表达不在当前支持范围内。'
    ]);
  }

  return {
    status: 'resolved',
    trigger: {
      type: 'manual',
      description: '手动触发'
    },
    reference,
    confidence: 'medium',
    notes: ['未检测到明确时间表达，按手动触发处理。']
  };
}

function resolveRelative(text: string, now: Date, reference: TimeReference): ResolveBackgroundTaskTimeResult | null {
  const match = /(\d+)\s*(分钟|小时)后/u.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    return clarification(reference, '请提供大于 0 的相对时间。', ['相对时间必须为正整数。']);
  }
  const next = new Date(now.getTime());
  if (match[2] === '分钟') {
    next.setMinutes(next.getMinutes() + amount);
  } else {
    next.setHours(next.getHours() + amount);
  }
  return resolvedOnce(`${amount} ${match[2]}后`, next, reference, ['按本机时区解析相对时间。']);
}

function resolveAbsoluteDate(text: string, now: Date, reference: TimeReference): ResolveBackgroundTaskTimeResult | null {
  const match = /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/u.exec(text);
  if (match === null) {
    return null;
  }
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute] = match;
  if (
    rawYear === undefined ||
    rawMonth === undefined ||
    rawDay === undefined ||
    rawHour === undefined ||
    rawMinute === undefined
  ) {
    return clarification(reference, '请使用有效的 YYYY-MM-DD HH:mm 时间。', ['绝对时间必须包含日期和时间。']);
  }
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const clock = readClock(`${rawHour}:${rawMinute}`);
  if (clock === null) {
    return clarification(reference, '请使用有效的 HH:mm 时间。', ['小时必须为 0-23，分钟必须为 0-59。']);
  }
  const candidate = new Date(year, month - 1, day, clock.hour, clock.minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    return pastOnce(reference);
  }
  return resolvedOnce(`${year}-${pad2(month)}-${pad2(day)} ${clock.raw}`, candidate, reference, ['按本机时区解析绝对日期时间。']);
}

function resolveDayRelative(text: string, now: Date, reference: TimeReference): ResolveBackgroundTaskTimeResult | null {
  const match = /(今天|明天)\s*(\d{1,2}:\d{2})/u.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const clock = readClock(match[2]);
  if (clock === null) {
    return clarification(reference, '请使用有效的 HH:mm 时间。', ['小时必须为 0-23，分钟必须为 0-59。']);
  }
  const candidate = new Date(now.getTime());
  candidate.setSeconds(0, 0);
  candidate.setHours(clock.hour, clock.minute, 0, 0);
  if (match[1] === '明天') {
    candidate.setDate(candidate.getDate() + 1);
  }
  if (candidate.getTime() <= now.getTime()) {
    return pastOnce(reference);
  }
  return resolvedOnce(`${match[1]} ${clock.raw}`, candidate, reference, ['按本机时区解析相对日期时间。']);
}

function resolveDaily(text: string, now: Date, reference: TimeReference): ResolveBackgroundTaskTimeResult | null {
  const match = /每天\s*(\d{1,2}:\d{2})/u.exec(text);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const clock = readClock(match[1]);
  if (clock === null) {
    return clarification(reference, '请使用有效的 HH:mm 时间。', ['小时必须为 0-23，分钟必须为 0-59。']);
  }
  return resolvedCron(`每天 ${clock.raw}`, `${clock.minute} ${clock.hour} * * *`, now, reference);
}

function resolveWeekly(text: string, now: Date, reference: TimeReference): ResolveBackgroundTaskTimeResult | null {
  const match = /每周([一二三四五六日天])\s*(\d{1,2}:\d{2})/u.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const weekday = chineseWeekdays[match[1]];
  const clock = readClock(match[2]);
  if (weekday === undefined || clock === null) {
    return clarification(reference, '请使用有效的每周触发时间，例如“每周一 09:00”。', ['星期和时间必须明确。']);
  }
  return resolvedCron(`每周${match[1]} ${clock.raw}`, `${clock.minute} ${clock.hour} * * ${weekday}`, now, reference);
}

function resolveMonthly(text: string, now: Date, reference: TimeReference): ResolveBackgroundTaskTimeResult | null {
  const match = /每月\s*(\d{1,2})\s*日\s*(\d{1,2}:\d{2})/u.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const day = Number.parseInt(match[1], 10);
  const clock = readClock(match[2]);
  if (!Number.isInteger(day) || day < 1 || day > 31 || clock === null) {
    return clarification(reference, '请使用有效的每月触发时间，例如“每月 3 日 09:00”。', ['日期必须为 1-31，时间必须为 HH:mm。']);
  }
  return resolvedCron(`每月 ${day} 日 ${clock.raw}`, `${clock.minute} ${clock.hour} ${day} * *`, now, reference);
}

function resolvedOnce(description: string, nextRunAt: Date, reference: TimeReference, notes: string[]): ResolveBackgroundTaskTimeResult {
  return {
    status: 'resolved',
    trigger: {
      type: 'once',
      description,
      nextRunAt: nextRunAt.toISOString()
    },
    reference,
    confidence: 'high',
    notes
  };
}

function resolvedCron(description: string, cronExpression: string, now: Date, reference: TimeReference): ResolveBackgroundTaskTimeResult {
  return {
    status: 'resolved',
    trigger: {
      type: 'cron',
      description,
      cronExpression,
      nextRunAt: computeNextCronRunAt(cronExpression, now)
    },
    reference,
    confidence: 'high',
    notes: ['按本机时区解析周期触发时间。']
  };
}

function clarification(reference: TimeReference, clarificationQuestion: string, notes: string[]): ResolveBackgroundTaskTimeResult {
  return {
    status: 'needs_clarification',
    reference,
    clarificationQuestion,
    notes
  };
}

function pastOnce(reference: TimeReference): ResolveBackgroundTaskTimeResult {
  return clarification(reference, '你给出的触发时间已经过去。请提供一个未来时间。', ['一次性触发时间必须晚于当前时间。']);
}

function hasExplicitUnsupportedTimeIntent(text: string): boolean {
  return /每个|工作日|周末|早上|上午|中午|下午|晚上|凌晨|点|半|每隔/u.test(text);
}

function createReference(now: Date, timeZone: string): TimeReference {
  return {
    nowUtc: now.toISOString(),
    nowLocal: formatLocalMinute(now),
    timeZone
  };
}

function readClock(raw: string): ClockParts | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(raw.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return {
    hour,
    minute,
    raw: `${pad2(hour)}:${pad2(minute)}`
  };
}

function formatLocalMinute(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function readNow(now: (() => Date) | undefined): Date {
  return now === undefined ? new Date() : now();
}

function readTimeZone(timeZone?: () => string): string {
  const resolved = timeZone === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone();
  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new RocDomainError({
      code: 'background_task_time_zone_unavailable',
      message: '无法读取本机时区。',
      category: 'external',
      retryable: true,
      userAction: '请检查系统时间和时区设置。'
    });
  }
  return resolved;
}
```

- [ ] **Step 4: Run parser/tool tests**

Run:

```powershell
pnpm vitest run tests/main/background-task-time-tool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/main/services/deep-agent/background-task-time-tool.ts tests/main/background-task-time-tool.test.ts
git commit -m "feat: add background task time resolver"
```

Expected: commit created.

---

### Task 2: Tool Registration And Capability Card

**Files:**
- Modify: `src/main/services/deep-agent/session.ts`
- Modify: `src/main/services/agent-service.ts`
- Test: `tests/main/app-services.provider.test.ts`
- Test: `tests/main/deep-agent-runtime-service.test.ts`

- [ ] **Step 1: Write failing capability preview test**

In `tests/main/app-services.provider.test.ts`, update the tool order assertion in the capability preview test:

```ts
expect(preview.toolCards.slice(0, 10).map((card) => card.name)).toEqual([
  'execute',
  'web_read',
  'delete_file',
  'resolve_background_task_time',
  'propose_background_task',
  'schedule_background_task',
  'confirm_with_user',
  'read_background_task',
  'update_background_task',
  'cancel_background_task'
]);
```

Add this assertion near the existing `propose_background_task` card assertion:

```ts
expect(preview.toolCards).toContainEqual(
  expect.objectContaining({
    id: 'builtin:resolve_background_task_time',
    name: 'resolve_background_task_time',
    description: '解析后台任务触发时间，不创建任务。',
    sideEffects: ['background_task_time_resolution'],
    requiresApproval: false
  })
);
```

- [ ] **Step 2: Write failing runtime descriptor test**

In `tests/main/deep-agent-runtime-service.test.ts`, update the broader runtime tool order assertion in the test that includes `web_search`:

```ts
expect(toolNames).toEqual([
  'web_read',
  'delete_file',
  'read_background_task',
  'confirm_with_user',
  'resolve_background_task_time',
  'propose_background_task',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task',
  'session_search',
  'web_search'
]);
```

Find the test named `registers stable background task tool descriptors for task runs`. Update the fixed tool order:

```ts
expect(toolNames).toEqual([
  'web_read',
  'delete_file',
  'read_background_task',
  'confirm_with_user',
  'resolve_background_task_time',
  'propose_background_task',
  'schedule_background_task',
  'update_background_task',
  'cancel_background_task',
  'session_search'
]);
```

In the same test, add a descriptor assertion:

```ts
const timeTool = call.tools?.find((tool) => tool.name === 'resolve_background_task_time');

expect(readToolSchemaKeys(timeTool)).toEqual(['text']);
expect(timeTool?.description ?? '').toContain('解析后台任务');
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
pnpm vitest run tests/main/app-services.provider.test.ts tests/main/deep-agent-runtime-service.test.ts
```

Expected: FAIL because the new tool is not registered or exposed yet.

- [ ] **Step 4: Register the tool in deep-agent sessions**

Modify `src/main/services/deep-agent/session.ts` imports:

```ts
import { createResolveBackgroundTaskTimeTool } from './background-task-time-tool';
```

Inside `createRunTools`, add the tool before `backgroundTaskTools`:

```ts
const resolveBackgroundTaskTimeTool = createResolveBackgroundTaskTimeTool();
```

Update `runTools`:

```ts
const runTools: ClientTool[] = [
  webReadTool,
  deleteFileTool,
  readBackgroundTaskTool,
  confirmWithUserTool,
  resolveBackgroundTaskTimeTool,
  ...backgroundTaskTools,
  sessionSearchTool
];
```

- [ ] **Step 5: Add capability card**

Modify `src/main/services/agent-service.ts`. In `toolCards`, insert the new card before `propose_background_task`:

```ts
this.createBackgroundTaskCard('resolve_background_task_time', '解析后台任务触发时间，不创建任务。', false, [
  'background_task_time_resolution'
]),
```

- [ ] **Step 6: Run registration tests**

Run:

```powershell
pnpm vitest run tests/main/app-services.provider.test.ts tests/main/deep-agent-runtime-service.test.ts
```

Expected: PASS for updated descriptor/card assertions.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/main/services/deep-agent/session.ts src/main/services/agent-service.ts tests/main/app-services.provider.test.ts tests/main/deep-agent-runtime-service.test.ts
git commit -m "feat: expose background task time resolver"
```

Expected: commit created.

---

### Task 3: Prompt One-Shot And Workflow Config

**Files:**
- Modify: `src/main/services/deep-agent/prompt.ts`
- Modify: `src/main/services/forge-guardrails/prerequisites-config.ts`
- Test: `tests/main/deep-agent-prompt.test.ts`
- Test: `tests/main/services/forge-guardrails/prerequisites-config.test.ts`

- [ ] **Step 1: Update failing prompt test**

Replace the current `adds a propose-background-task workflow overview without hard step ordering` test in `tests/main/deep-agent-prompt.test.ts` with:

```ts
it('adds a propose-background-task workflow overview with time resolution one-shot', () => {
  const prompt = buildSystemPrompt({
    enabledCapabilities: { mcpServers: [], skills: [] },
    workspacePath: 'F:\\Code\\Roc',
    frozenSnapshot: disabledSnapshot(),
    workflowHint: 'propose_background_task'
  });

  expect(prompt).toContain('本轮工作流：创建后台任务。');
  expect(prompt).toContain(
    '可用工具：resolve_background_task_time / propose_background_task / schedule_background_task / confirm_with_user。'
  );
  expect(prompt).toContain('先调用 resolve_background_task_time 解析触发时间。');
  expect(prompt).toContain('resolve_background_task_time({ text: "每天 9:00 检查测试失败情况" })');
  expect(prompt).toContain('propose_background_task({ goal, trigger: resolved.trigger, workspacePath })');
  expect(prompt).toContain('schedule_background_task({ previewId })');
  expect(prompt).toContain('confirm_with_user({ summary })');
  expect(prompt).not.toContain('buildTaskProposalPrompt');
});
```

- [ ] **Step 2: Update failing workflow config test**

In `tests/main/services/forge-guardrails/prerequisites-config.test.ts`, update expectations:

```ts
expect(ROC_WORKFLOWS.propose_background_task).toEqual({
  name: 'propose_background_task',
  requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
  terminalTools: ['confirm_with_user']
});
```

Update prerequisite expectations:

```ts
expect(ROC_PREREQUISITES.prerequisites).toEqual({
  edit_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path' }],
  delete_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path', currentArg: 'relativePath' }],
  write_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path' }],
  propose_background_task: [{ kind: 'nameOnly', tool: 'resolve_background_task_time' }],
  schedule_background_task: [{ kind: 'nameOnly', tool: 'propose_background_task' }],
  update_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }],
  cancel_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }]
});
expect(Object.values(ROC_PREREQUISITES.prerequisites).flat()).toHaveLength(7);
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
pnpm vitest run tests/main/deep-agent-prompt.test.ts tests/main/services/forge-guardrails/prerequisites-config.test.ts
```

Expected: FAIL because prompt/config still use the old tool set.

- [ ] **Step 4: Update prompt overview**

Modify `src/main/services/deep-agent/prompt.ts` in `createWorkflowOverview` for `workflowHint === 'propose_background_task'`:

```ts
return [
  '',
  '本轮工作流：创建后台任务。',
  '可用工具：resolve_background_task_time / propose_background_task / schedule_background_task / confirm_with_user。',
  '先调用 resolve_background_task_time 解析触发时间；用返回的 trigger 组装 propose_background_task。',
  'propose 仅生成草稿；schedule 才实际落地；confirm 通知用户工作完成或请求用户补充缺失时间。',
  'One-shot：用户说“每天 9:00 检查测试失败情况”时，依次调用：',
  '1. resolve_background_task_time({ text: "每天 9:00 检查测试失败情况" })',
  '2. propose_background_task({ goal, trigger: resolved.trigger, workspacePath })',
  '3. schedule_background_task({ previewId })',
  '4. confirm_with_user({ summary })'
];
```

- [ ] **Step 5: Update workflow config**

Modify `src/main/services/forge-guardrails/prerequisites-config.ts`:

```ts
export const ROC_PREREQUISITES: PrerequisitesConfig = {
  prerequisites: {
    edit_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path' }],
    delete_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path', currentArg: 'relativePath' }],
    write_file: [{ kind: 'argMatched', tool: 'read_file', matchArg: 'file_path' }],
    propose_background_task: [{ kind: 'nameOnly', tool: 'resolve_background_task_time' }],
    schedule_background_task: [{ kind: 'nameOnly', tool: 'propose_background_task' }],
    update_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }],
    cancel_background_task: [{ kind: 'argMatched', tool: 'read_background_task', matchArg: 'taskId' }]
  }
};
```

Update `ROC_WORKFLOWS.propose_background_task`:

```ts
propose_background_task: {
  name: 'propose_background_task',
  requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
  terminalTools: ['confirm_with_user']
},
```

- [ ] **Step 6: Run prompt/config tests**

Run:

```powershell
pnpm vitest run tests/main/deep-agent-prompt.test.ts tests/main/services/forge-guardrails/prerequisites-config.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/main/services/deep-agent/prompt.ts src/main/services/forge-guardrails/prerequisites-config.ts tests/main/deep-agent-prompt.test.ts tests/main/services/forge-guardrails/prerequisites-config.test.ts
git commit -m "feat: require time resolution in background task workflow"
```

Expected: commit created.

---

### Task 4: Step Enforcement Clarification Branch

**Files:**
- Modify: `src/main/services/forge-guardrails/state-schema.ts`
- Modify: `src/main/services/forge-guardrails/middleware/step-enforcement.ts`
- Test: `tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts`

- [ ] **Step 1: Write failing clarification branch tests**

In `tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts`, update existing workflow initialization expectations so `requiredSteps` includes `resolve_background_task_time`:

```ts
requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
```

Update the terminal nudge test setup to use the same required steps:

```ts
requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
```

Update the first-turn initialization assertion to include the new state field:

```ts
expect(update).toEqual({
  forge_step_tracker: {
    executedTools: {},
    requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
    terminalTools: ['confirm_with_user'],
    iterationIndex: 0,
    prematureAttempts: 0,
    prereqViolations: 0,
    backgroundTaskTimeResolution: null
  }
});
```

Add these tests before `allows terminal tools after all required steps have succeeded`:

```ts
it('records needs_clarification from the background time resolver tool result', async () => {
  const middleware = getStepEnforcementMiddleware();
  if (typeof middleware.wrapToolCall !== 'function') {
    throw new Error('Expected step enforcement middleware to expose wrapToolCall.');
  }
  const toolMessage = new ToolMessage({
    tool_call_id: 'call-time',
    name: 'resolve_background_task_time',
    content: JSON.stringify({
      status: 'needs_clarification',
      clarificationQuestion: '请提供未来时间。'
    }),
    status: 'success'
  });

  const result = await middleware.wrapToolCall(
    {
      toolCall: {
        name: 'resolve_background_task_time',
        args: { text: '今天 09:00 检查测试' },
        id: 'call-time'
      },
      state: baseState()
    } as never,
    (async () => toolMessage) as never
  );

  expect(result).toBeInstanceOf(Command);
  expect((result as Command).update).toMatchObject({
    messages: [toolMessage],
    forge_step_tracker: {
      backgroundTaskTimeResolution: 'needs_clarification',
      executedTools: {
        resolve_background_task_time: [{ text: '今天 09:00 检查测试' }]
      }
    }
  });
});

it('allows confirm_with_user as terminal when time resolution needs clarification', async () => {
  const update = await runAfterModel({
    messages: [aiWithToolCall({ name: 'confirm_with_user', args: { summary: '请提供未来时间。' } })],
    stepTracker: {
      ...defaultStepTracker(),
      requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
      terminalTools: ['confirm_with_user'],
      backgroundTaskTimeResolution: 'needs_clarification',
      executedTools: {
        resolve_background_task_time: [{ text: '今天 09:00 检查测试' }]
      }
    }
  });

  expect(update).toBeUndefined();
});

it('still nudges early confirm_with_user when time resolution is resolved', async () => {
  const update = await runAfterModel({
    messages: [aiWithToolCall({ name: 'confirm_with_user', args: { summary: 'done' }, id: 'call-confirm' })],
    stepTracker: {
      ...defaultStepTracker(),
      requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
      terminalTools: ['confirm_with_user'],
      backgroundTaskTimeResolution: 'resolved',
      executedTools: {
        resolve_background_task_time: [{ text: '每天 09:00 检查测试' }]
      }
    }
  });

  expect(update?.jumpTo).toBe('model');
  expect(update?.forge_step_tracker?.prematureAttempts).toBe(1);
  const nudge = update?.messages?.[0] as ToolMessage;
  expect(String(nudge.content)).toContain('propose_background_task');
  expect(String(nudge.content)).toContain('schedule_background_task');
});
```

Update `allows terminal tools after all required steps have succeeded`:

```ts
requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
terminalTools: ['confirm_with_user'],
backgroundTaskTimeResolution: 'resolved',
executedTools: {
  resolve_background_task_time: [{ text: '每天 09:00 检查测试' }],
  propose_background_task: [{ goal: 'X' }],
  schedule_background_task: [{ previewId: 'preview-1' }]
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
pnpm vitest run tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts
```

Expected: FAIL because `backgroundTaskTimeResolution` is not in state and terminal logic has no clarification branch.

- [ ] **Step 3: Extend step tracker state**

Modify `src/main/services/forge-guardrails/state-schema.ts`:

```ts
const stepTrackerSchema = z.object({
  executedTools: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default(() => ({})),
  requiredSteps: z.array(z.string()).default(() => []),
  terminalTools: z.array(z.string()).default(() => []),
  iterationIndex: z.number().int().nonnegative().default(0),
  prematureAttempts: z.number().int().nonnegative().default(0),
  prereqViolations: z.number().int().nonnegative().default(0),
  backgroundTaskTimeResolution: z.enum(['resolved', 'needs_clarification']).nullable().default(null)
});
```

No other reducer change is needed; `mergeStepTracker` already spreads scalar fields from updates.

Modify `src/main/services/forge-guardrails/middleware/step-enforcement.ts` in the `beforeAgent` initializer:

```ts
return {
  forge_step_tracker: {
    executedTools,
    requiredSteps: workflow === null ? [] : workflow.requiredSteps,
    terminalTools: workflow === null ? [] : workflow.terminalTools,
    iterationIndex: 0,
    prematureAttempts: 0,
    prereqViolations: 0,
    backgroundTaskTimeResolution: existing?.backgroundTaskTimeResolution ?? null
  }
};
```

- [ ] **Step 4: Record time resolver status in wrapToolCall**

Modify `src/main/services/forge-guardrails/middleware/step-enforcement.ts`. Add constants/functions near helper functions:

```ts
const BACKGROUND_TASK_TIME_TOOL_NAME = 'resolve_background_task_time';

function readBackgroundTaskTimeResolution(result: ToolMessage, toolName: string): 'resolved' | 'needs_clarification' | null {
  if (toolName !== BACKGROUND_TASK_TIME_TOOL_NAME || typeof result.content !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(result.content) as { status?: unknown };
    return parsed.status === 'resolved' || parsed.status === 'needs_clarification' ? parsed.status : null;
  } catch {
    return null;
  }
}

function allowsClarificationTerminalBranch(tracker: ForgeStepTrackerState): boolean {
  return (
    tracker.backgroundTaskTimeResolution === 'needs_clarification' &&
    (tracker.executedTools[BACKGROUND_TASK_TIME_TOOL_NAME] ?? []).length > 0
  );
}
```

Update the terminal check:

```ts
const terminalCalls = toolCalls.filter((toolCall) => tracker.terminalTools.includes(toolCall.name));
if (terminalCalls.length > 0 && !areRequiredStepsSatisfied(tracker) && !allowsClarificationTerminalBranch(tracker)) {
```

Update `wrapToolCall` after `recordToolExecution`:

```ts
const timeResolution = readBackgroundTaskTimeResolution(result, request.toolCall.name);
const updatedTracker =
  timeResolution === null
    ? recordToolExecution(tracker, request.toolCall.name, readToolArgs(request.toolCall.args))
    : {
        ...recordToolExecution(tracker, request.toolCall.name, readToolArgs(request.toolCall.args)),
        backgroundTaskTimeResolution: timeResolution
      };
```

- [ ] **Step 5: Run step-enforcement tests**

Run:

```powershell
pnpm vitest run tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/main/services/forge-guardrails/state-schema.ts src/main/services/forge-guardrails/middleware/step-enforcement.ts tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts
git commit -m "feat: allow background task time clarification branch"
```

Expected: commit created.

---

### Task 5: Full Targeted Verification And Cleanup

**Files:**
- Verify only unless a previous task left a failing assertion.

- [ ] **Step 1: Run focused test set from the spec**

Run:

```powershell
pnpm vitest run tests/main/background-task-time-tool.test.ts tests/main/deep-agent-prompt.test.ts tests/main/services/forge-guardrails/prerequisites-config.test.ts tests/main/services/forge-guardrails/middleware/step-enforcement.test.ts tests/main/app-services.provider.test.ts tests/main/deep-agent-runtime-service.test.ts tests/main/background-task-tools.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run packaged build**

Run:

```powershell
pnpm package:dir
```

Expected: PASS and `out\Roc-win32-x64\Roc.exe` exists.

- [ ] **Step 4: Decide smoke scope**

If `tests/smoke/lib/fixtures.mjs` or packaged fixture expectations fail because tool order changed, update the smoke fixture to include `resolve_background_task_time` in the propose-background-task path, then run:

```powershell
$env:ROC_SMOKE_TARGET = "packaged"
pnpm smoke:electron
```

Expected: PASS. If no smoke fixture was touched and targeted/runtime tests prove the workflow/tool registration, record that packaged smoke was not required for this plan.

- [ ] **Step 5: Commit any verification-driven fix**

If Step 1-4 required changes, commit them:

```powershell
git add tests/smoke/lib/fixtures.mjs tests/smoke/electron-smoke.mjs tests/smoke/lib/ipc.mjs
git commit -m "test: align background task time workflow verification"
```

Expected: commit created only if files changed. If no files changed, skip this commit.

---

## Self-Review

- Spec coverage:
  - Raw renderer input plus `workflowHint` remains unchanged: Task 2/3 do not touch renderer.
  - Time parser/tool: Task 1.
  - One-shot prompt: Task 3.
  - Required steps and prerequisites: Task 3.
  - Clarification branch: Task 4.
  - Capability and runtime descriptors: Task 2.
  - Verification: Task 5.
- Placeholder scan:
  - No placeholder markers or deferred-work phrases remain.
  - Every changed-file task has test, implementation, verification, and commit steps.
- Type consistency:
  - Tool name is consistently `resolve_background_task_time`.
  - Time status values are consistently `'resolved' | 'needs_clarification'`.
  - Step tracker field is consistently `backgroundTaskTimeResolution`.
