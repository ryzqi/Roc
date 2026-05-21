import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskCreateDialog } from '../../src/renderer/views/tasks/TaskCreateDialog';
import { createLoadedState } from './view-test-helpers';

describe('TaskCreateDialog', () => {
  it('renders the manual task creation form fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskCreateDialog, {
        open: true,
        onClose: () => {},
        onCreated: async () => {},
        state: createLoadedState({
          workspace: {
            id: 'workspace-1',
            path: 'F:\\Code\\Roc',
            displayName: 'Roc',
            trustState: 'trusted',
            lastOpenedAt: '2026-05-21T00:00:00.000Z'
          }
        })
      })
    );

    expect(html).toContain('data-testid="task-create-dialog"');
    expect(html).toContain('data-testid="task-create-goal"');
    expect(html).toContain('data-testid="task-create-trigger-type"');
    expect(html).toContain('data-testid="task-create-workspace-path"');
    expect(html).toContain('data-testid="task-create-allowed-actions"');
    expect(html).toContain('创建任务');
  });
});
