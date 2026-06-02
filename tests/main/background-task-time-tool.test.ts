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
