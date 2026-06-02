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

export function createResolveBackgroundTaskTimeTool(
  input: TimeToolDependencies = {}
): DynamicStructuredTool<any, any, any, string> {
  return new DynamicStructuredTool<
    typeof timeToolInputSchema,
    z.infer<typeof timeToolInputSchema>,
    z.infer<typeof timeToolInputSchema>,
    string
  >({
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
