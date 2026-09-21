import { describe, expect, it } from 'vitest';
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
          workspacePath: '/Users/test/Code/Roc',
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
          selectedPath: '/Users/test/Code/Roc',
          label: '/Users/test/Code/Roc'
        }
      }
    });

    expect(buildTopMeta('memory', state)).toBe('/Users/test/Code/Roc');
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

    expect(buildTopMeta('memory', state)).toBe('全局记忆');
  });

  it('uses research project context as the default research top meta', () => {
    const state = createLoadedState({});
    expect(buildTopMeta('research', state)).toBe('研究项目上下文');
  });
});
