import { describe, expect, it } from 'vitest';
import type { TaskThread } from '../../src/shared/types';
import * as historySidebar from '../../src/renderer/history-sidebar';
import { buildHistoryItems } from '../../src/renderer/history-sidebar';

function createThread(id: string, title: string, input: Partial<TaskThread> = {}): TaskThread {
  return {
    id,
    kind: 'chat',
    title,
    goal: title,
    status: 'completed',
    createdAt: '2026-05-08T15:00:00.000Z',
    updatedAt: '2026-05-08T15:30:45.000Z',
    ...input
  };
}

describe('history sidebar helpers', () => {
  it('keeps only user conversation threads in the history list', () => {
    const items = buildHistoryItems([
      createThread('user-thread', '用户真实任务'),
      createThread('quick-thread', '快捷入口创建任务'),
      createThread('current-thread', '当前主会话'),
      createThread('tray-thread', '托盘接管记录'),
      createThread('memory-thread', '记忆整理裁决'),
      createThread('task-thread', '任务工作台记录'),
      createThread('background-thread', '后台定时任务')
    ], ['background-thread']);

    expect(items).toEqual([
      {
        id: 'user-thread',
        label: '用户真实任务',
        meta: '2026-05-08 23:30',
        icon: 'history'
      }
    ]);
  });

  it('filters history items by title and meta with case-insensitive matching', () => {
    const filterHistoryItems = (
      historySidebar as {
        filterHistoryItems?: (
          items: Array<{ id: string; label: string; meta: string; icon: 'history' }>,
          query: string
        ) => Array<{ id: string; label: string; meta: string; icon: 'history' }>;
      }
    ).filterHistoryItems;

    expect(typeof filterHistoryItems).toBe('function');
    if (filterHistoryItems === undefined) {
      throw new Error('filterHistoryItems is not implemented.');
    }

    const items = [
      {
        id: 'thread-plan',
        label: 'Refactor planner',
        meta: '2026-05-08 15:30',
        icon: 'history' as const
      },
      {
        id: 'thread-report',
        label: 'Weekly report',
        meta: '2026-05-09 09:12',
        icon: 'history' as const
      }
    ];

    expect(filterHistoryItems(items, 'planner')).toEqual([items[0]]);
    expect(filterHistoryItems(items, '2026-05-09')).toEqual([items[1]]);
    expect(filterHistoryItems(items, 'REPORT')).toEqual([items[1]]);
    expect(filterHistoryItems(items, 'missing')).toEqual([]);
    expect(filterHistoryItems(items, '   ')).toEqual(items);
  });

  it('hides active promoted threads but returns completed promoted threads to history', () => {
    const items = buildHistoryItems([
      createThread('long-running-active', '活跃长任务', {
        kind: 'long_running',
        status: 'running'
      }),
      createThread('background-active', '活跃后台任务', {
        kind: 'background',
        status: 'paused'
      }),
      createThread('long-running-completed', '已完成长任务', {
        kind: 'long_running',
        status: 'completed'
      })
    ], []);

    expect(items).toEqual([
      {
        id: 'long-running-completed',
        label: '已完成长任务',
        meta: '2026-05-08 23:30',
        icon: 'history'
      }
    ]);
  });
});
