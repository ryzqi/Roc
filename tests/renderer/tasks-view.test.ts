import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActiveTaskItem } from '../../src/shared/types';
import { TasksView } from '../../src/renderer/views/tasks/TasksView';
import { createLoadedState } from './view-test-helpers';

describe('TasksView', () => {
  it('renders a kanban-only task board without the old rail, table, or drawer surface', () => {
    const html = renderTasksView([
      createActiveTask({ taskId: 'pending-1', threadId: 'thread-pending-1', goal: '等待审批', status: 'pending_confirmation' }),
      createActiveTask({ taskId: 'running-1', threadId: 'thread-running-1', goal: '执行中', status: 'running' }),
      createActiveTask({ taskId: 'paused-1', threadId: 'thread-paused-1', goal: '暂停中', status: 'paused' }),
      createActiveTask({ taskId: 'done-1', threadId: 'thread-done-1', goal: '已完成', status: 'completed' })
    ]);

    expect(html).toContain('class="canvas-stage stage-grid task-board-page"');
    expect(html).toContain('data-testid="tasks-board-view"');
    expect(html).toContain('data-testid="task-board-column-待处理"');
    expect(html).toContain('data-testid="task-board-column-进行中"');
    expect(html).toContain('data-testid="task-board-column-已暂停"');
    expect(html).toContain('data-testid="task-board-column-已结束"');
    expect(html).toContain('data-testid="task-board-card-pending-1"');
    expect(html).toContain('data-testid="task-board-card-running-1"');
    expect(html).toContain('data-testid="task-board-card-paused-1"');
    expect(html).toContain('data-testid="task-board-card-done-1"');
    expect(html).toContain('class="task-board-column-count status-pill info"');
    expect(html).toContain('class="task-board-card-status status-pill info"');
    expect(html).toContain('class="task-board-card-workspace"');
    expect(html).toContain('F:\\Code\\Roc');
  });

  it('renders empty lane states without removing the four task columns', () => {
    const html = renderTasksView([
      createActiveTask({ taskId: 'running-1', threadId: 'thread-running-1', goal: '执行中', status: 'running' })
    ]);

    expect(html).toContain('data-testid="task-board-column-待处理"');
    expect(html).toContain('data-testid="task-board-column-进行中"');
    expect(html).toContain('data-testid="task-board-column-已暂停"');
    expect(html).toContain('data-testid="task-board-column-已结束"');
    expect(html).toContain('class="task-board-column-empty"');
    expect(html).toContain('此列暂无任务');
  });

  it('renders the task workbench empty state inside the board page', () => {
    const html = renderTasksView([]);

    expect(html).toContain('data-testid="tasks-board-view"');
    expect(html).toContain('data-testid="tasks-empty-state"');
    expect(html).toContain('class="task-empty-shell"');
    expect(html).toContain('点击右上角“新建任务”开始创建后台任务。');
    expect(html).toContain('新建任务');
    expect(html).not.toContain('data-testid="task-create-dialog-panel"');
    expect(html).not.toContain('data-testid="task-create-dialog-backdrop"');
  });
});

function renderTasksView(activeTasks: ActiveTaskItem[]): string {
  return renderToStaticMarkup(
    React.createElement(TasksView, {
      state: createLoadedState({ activeTasks }),
      updateLoadedState: () => {},
      liveTaskRun: null,
      onOpenTaskDetail: () => {},
      onSelectedTaskIdChange: () => {},
      onSubmitTaskPrompt: async () => ({ ok: true as const }),
      boardUiState: { railId: 'all', scrollTop: 0 },
      onBoardUiStateChange: () => {}
    })
  );
}

function createActiveTask(input: Pick<ActiveTaskItem, 'taskId' | 'threadId' | 'goal' | 'status'>): ActiveTaskItem {
  return {
    kind: 'background',
    taskId: input.taskId,
    threadId: input.threadId,
    title: input.goal,
    goal: input.goal,
    status: input.status,
    trigger: null,
    nextRunAt: null,
    lastRunAt: null,
    riskLevel: 'low',
    workspacePath: 'F:\\Code\\Roc',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z'
  };
}
