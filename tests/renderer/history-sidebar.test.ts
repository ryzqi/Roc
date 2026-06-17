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
      createThread('current-thread', '当前主会话'),
      createThread('memory-thread', '记忆整理裁决'),
      createThread('task-thread', '任务工作台记录'),
      createThread('background-completed', '后台已完成任务', {
        kind: 'background',
        status: 'completed'
      }),
      createThread('background-running', '后台运行任务', {
        kind: 'background',
        status: 'running'
      })
    ], []);

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

  it('excludes non-chat threads even when they look like old long-running history', () => {
    const longRunningThread = {
      id: 'long-running-active',
      kind: 'long_running',
      title: '残留长任务',
      goal: '残留长任务',
      status: 'running',
      createdAt: '2026-05-08T15:00:00.000Z',
      updatedAt: '2026-05-08T15:30:45.000Z'
    } as unknown as TaskThread;
    const items = buildHistoryItems([
      longRunningThread,
      createThread('background-active', '后台', {
        kind: 'background',
        status: 'running'
      })
    ], []);

    expect(items).toEqual([]);
  });
});
