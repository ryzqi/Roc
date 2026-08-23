import { describe, expect, it } from 'vitest';
import { buildControlNavItems } from '../../src/renderer/app/nav-items';
import { buildTopMeta } from '../../src/renderer/app/view-routing';
import { createLoadedState } from './view-test-helpers';

describe('renderer navigation meta', () => {
  it('uses active task surface counts for the task board meta', () => {
    const state = createLoadedState({
      taskSnapshot: {
        ...createLoadedState({}).taskSnapshot,
        counts: {
          total: 3,
          running: 3,
          failed: 0,
          pendingConfirmation: 0
        }
      },
      activeTasks: [
        {
          kind: 'background',
          taskId: 'task-running',
          threadId: 'thread-running',
          title: '同步金价',
          goal: '同步金价',
          status: 'running',
          trigger: null,
          nextRunAt: null,
          lastRunAt: null,
          riskLevel: 'low',
          workspacePath: 'F:\\Code\\Roc',
          createdAt: '2026-06-18T00:00:00.000Z',
          updatedAt: '2026-06-18T00:00:00.000Z'
        }
      ]
    });

    expect(buildTopMeta('tasks-board', state)).toBe('1 个任务 · 运行中 1');
  });

  it('uses the current memory label instead of the Phase 1 placeholder', () => {
    const state = createLoadedState({
      appStatus: {
        ...createLoadedState({}).appStatus,
        workspace: {
          selectedPath: 'F:\\Code\\Roc',
          label: 'F:\\Code\\Roc'
        }
      }
    });

    const memoryNav = buildControlNavItems(state).find((item) => item.id === 'memory');

    expect(memoryNav?.meta).toBe('F:\\Code\\Roc');
    expect(buildTopMeta('memory', state)).toBe('F:\\Code\\Roc');
  });

  it('uses global memory copy when no workspace is selected', () => {
    const state = createLoadedState({
      appStatus: {
        ...createLoadedState({}).appStatus,
        workspace: {
          selectedPath: null,
          label: '未选择工作区'
        }
      }
    });

    const memoryNav = buildControlNavItems(state).find((item) => item.id === 'memory');

    expect(memoryNav?.meta).toBe('全局记忆');
    expect(buildTopMeta('memory', state)).toBe('全局记忆');
  });
});
