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
          nudgeKind: 'retry',
          tier: 2,
          content: '请重新给出有效工具调用。',
          toolName: 'write_file',
          toolCallId: 'call-write'
        }
      ],
      error: null
    };

    const html = renderToStaticMarkup(React.createElement(TaskRunOutputPanel, { output }));

    expect(html).toContain('run-event--guardrail');
    expect(html).toContain('[护栏: retry]');
    expect(html).toContain('请重新给出有效工具调用。');
    expect(html).toContain('write_file');
  });
});
