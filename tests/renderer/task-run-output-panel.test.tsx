import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskRunOutputPanel } from '../../src/renderer/views/tasks/TaskRunOutputPanel';
import type { TaskRunOutput } from '../../src/renderer/views/tasks/task-run-output';

describe('TaskRunOutputPanel', () => {
  it('renders guardrail nudges as low-emphasis audit rows', () => {
    const output: TaskRunOutput = {
      runId: 'run-1',
      status: 'completed',
      userInput: '创建后台任务',
      assistantMessage: '已完成',
      reasoning: '',
      tools: [],
      subagents: [],
      guardrails: [
        {
          nudgeKind: 'step',
          tier: 2,
          content: '必须调用 schedule_background_task 后再结束。',
          toolName: 'confirm_with_user',
          toolCallId: 'call-confirm'
        }
      ],
      error: null
    };

    const html = renderToStaticMarkup(React.createElement(TaskRunOutputPanel, { output }));

    expect(html).toContain('run-event--guardrail');
    expect(html).toContain('[护栏: step]');
    expect(html).toContain('必须调用 schedule_background_task 后再结束。');
    expect(html).toContain('confirm_with_user');
  });
});
