import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { RocDomainError } from '../../../../../src/main/services/errors';
import {
  defaultErrorTracker,
  defaultStepTracker,
  FORGE_EXHAUSTED_CODES,
  readForgeMessageTag,
  ROC_PREREQUISITES
} from '../../../../../src/main/services/forge-guardrails';
import { createStepEnforcementMiddleware } from '../../../../../src/main/services/forge-guardrails/middleware/step-enforcement';
import { tagForgeMessage } from '../../../../../src/main/services/forge-guardrails/message-tags';

function getStepEnforcementMiddleware(input?: { workflowHint?: 'propose_background_task' | 'background_task_change' | null }) {
  const workflowHint = input?.workflowHint === undefined ? 'propose_background_task' : input.workflowHint;
  return createStepEnforcementMiddleware({
    resolveWorkflowFromContext: () => workflowHint,
    prerequisitesConfig: ROC_PREREQUISITES
  });
}

function getAfterModelHook() {
  const middleware = getStepEnforcementMiddleware();
  const afterModel = middleware.afterModel;
  if (typeof afterModel !== 'object' || afterModel === null || typeof afterModel.hook !== 'function') {
    throw new Error('Expected step enforcement middleware to expose object-form afterModel hook.');
  }
  return afterModel;
}

function baseState(input?: {
  messages?: unknown[];
  stepTracker?: ReturnType<typeof defaultStepTracker>;
  errorTracker?: ReturnType<typeof defaultErrorTracker>;
}) {
  return {
    messages: input?.messages === undefined ? [] : input.messages,
    forge_step_tracker: input?.stepTracker === undefined ? defaultStepTracker() : input.stepTracker,
    forge_error_tracker: input?.errorTracker === undefined ? defaultErrorTracker() : input.errorTracker
  };
}

function aiWithToolCall(toolCall: { name: string; args?: Record<string, unknown>; id?: string }) {
  return new AIMessage({
    id: `ai-${toolCall.name}`,
    content: '',
    tool_calls: [
      {
        name: toolCall.name,
        args: toolCall.args === undefined ? {} : toolCall.args,
        id: toolCall.id === undefined ? `call-${toolCall.name}` : toolCall.id,
        type: 'tool_call'
      }
    ]
  });
}

async function runAfterModel(input: Parameters<typeof baseState>[0]) {
  const update = await getAfterModelHook().hook(baseState(input) as never, {} as never);
  return update as
    | {
        messages?: unknown[];
        forge_step_tracker?: ReturnType<typeof defaultStepTracker>;
        jumpTo?: 'model' | 'tools' | 'end';
      }
    | undefined;
}

describe('ForgeStepEnforcementMiddleware', () => {
  it('uses object-form afterModel with canJumpTo model', () => {
    expect(getAfterModelHook().canJumpTo).toEqual(['model']);
  });

  it('initializes the step tracker from workflowHint on the first agent turn', () => {
    const middleware = getStepEnforcementMiddleware();
    if (typeof middleware.beforeAgent !== 'function') {
      throw new Error('Expected step enforcement middleware to expose beforeAgent.');
    }

    const update = middleware.beforeAgent({ messages: [] } as never, {} as never);

    expect(update).toEqual({
      forge_step_tracker: {
        executedTools: {},
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        iterationIndex: 0,
        prematureAttempts: 0,
        prereqViolations: 0,
        backgroundTaskTimeResolution: null
      }
    });
  });

  it('keeps checkpointed step tracker state on resume instead of overwriting from a null workflowHint', () => {
    const middleware = getStepEnforcementMiddleware({ workflowHint: null });
    if (typeof middleware.beforeAgent !== 'function') {
      throw new Error('Expected step enforcement middleware to expose beforeAgent.');
    }

    const update = middleware.beforeAgent(
      baseState({
        stepTracker: {
          ...defaultStepTracker(),
          executedTools: {
            propose_background_task: [{ goal: 'X' }]
          },
          requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
          terminalTools: ['confirm_with_user'],
          iterationIndex: 3
        }
      }) as never,
      {} as never
    );

    expect(update).toBeUndefined();
  });

  it('increments iterationIndex before model calls and marks the previous AI message', () => {
    const middleware = getStepEnforcementMiddleware();
    if (typeof middleware.beforeModel !== 'function') {
      throw new Error('Expected step enforcement middleware to expose beforeModel.');
    }
    const previousAi = new AIMessage({
      id: 'ai-prev',
      content: '',
      tool_calls: [
        {
          name: 'propose_background_task',
          args: { goal: 'X' },
          id: 'call-propose',
          type: 'tool_call'
        }
      ]
    });

    const update = middleware.beforeModel(
      baseState({
        messages: [previousAi],
        stepTracker: {
          ...defaultStepTracker(),
          iterationIndex: 2
        }
      }) as never,
      {} as never
    );

    expect(update).toMatchObject({
      forge_step_tracker: {
        iterationIndex: 3
      }
    });
    expect(previousAi.additional_kwargs.forge_iteration_index).toBe(3);
  });

  it('nudges when a terminal tool is called before required steps are complete', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'confirm_with_user', args: { summary: 'done' }, id: 'call-confirm' })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user']
      }
    });

    expect(update?.jumpTo).toBe('model');
    expect(update?.forge_step_tracker?.prematureAttempts).toBe(1);
    const nudge = update?.messages?.[0] as ToolMessage;
    expect(nudge).toBeInstanceOf(ToolMessage);
    expect(nudge.tool_call_id).toBe('call-confirm');
    expect(nudge.name).toBe('confirm_with_user');
    expect(nudge.status).toBe('error');
    expect(String(nudge.content)).toContain('[StepEnforcementError]');
    expect(String(nudge.content)).toContain('必须先完成这些步骤');
    expect(readForgeMessageTag(nudge)).toBe('forge:step_nudge');
  });

  it('escalates repeated premature terminal calls across tier two and tier three nudges', async () => {
    const tierTwo = await runAfterModel({
      messages: [aiWithToolCall({ name: 'confirm_with_user' })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        prematureAttempts: 1
      }
    });
    const tierThree = await runAfterModel({
      messages: [aiWithToolCall({ name: 'confirm_with_user' })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        prematureAttempts: 2
      }
    });

    expect(tierTwo?.forge_step_tracker?.prematureAttempts).toBe(2);
    expect(String((tierTwo?.messages?.[0] as ToolMessage).content)).toContain('必须立刻调用');
    expect(tierThree?.forge_step_tracker?.prematureAttempts).toBe(3);
    expect(String((tierThree?.messages?.[0] as ToolMessage).content)).toContain('停止');
  });

  it('throws after premature terminal calls exceed the configured budget', async () => {
    await expect(
      runAfterModel({
        messages: [aiWithToolCall({ name: 'confirm_with_user' })],
        stepTracker: {
          ...defaultStepTracker(),
          requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
          terminalTools: ['confirm_with_user'],
          prematureAttempts: 3
        },
        errorTracker: {
          ...defaultErrorTracker(),
          maxPrematureAttempts: 3
        }
      })
    ).rejects.toThrow(RocDomainError);

    await expect(
      runAfterModel({
        messages: [aiWithToolCall({ name: 'confirm_with_user' })],
        stepTracker: {
          ...defaultStepTracker(),
          requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
          terminalTools: ['confirm_with_user'],
          prematureAttempts: 3
        },
        errorTracker: {
          ...defaultErrorTracker(),
          maxPrematureAttempts: 3
        }
      })
    ).rejects.toMatchObject({
      code: FORGE_EXHAUSTED_CODES.stepEnforcement
    });
  });

  it('nudges when edit_file is called before read_file for the same path', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'edit_file', args: { file_path: '/workspace/a.md' }, id: 'call-edit' })]
    });

    expect(update?.jumpTo).toBe('model');
    expect(update?.forge_step_tracker?.prereqViolations).toBe(1);
    const nudge = update?.messages?.[0] as ToolMessage;
    expect(nudge).toBeInstanceOf(ToolMessage);
    expect(nudge.tool_call_id).toBe('call-edit');
    expect(nudge.name).toBe('edit_file');
    expect(nudge.status).toBe('error');
    expect(String(nudge.content)).toContain('[PrerequisiteError]');
    expect(String(nudge.content)).toContain('read_file(file_path="/workspace/a.md")');
    expect(readForgeMessageTag(nudge)).toBe('forge:prerequisite_nudge');
  });

  it('allows edit_file after read_file has succeeded for the same path', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'edit_file', args: { file_path: '/workspace/a.md' } })],
      stepTracker: {
        ...defaultStepTracker(),
        executedTools: {
          read_file: [{ file_path: '/workspace/a.md' }]
        }
      }
    });

    expect(update).toBeUndefined();
  });

  it('allows write_file after read_file for the same DeepAgents file_path', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'write_file', args: { file_path: '/workspace/quicksort_example.py' } })],
      stepTracker: {
        ...defaultStepTracker(),
        executedTools: {
          read_file: [{ file_path: '/workspace/quicksort_example.py' }]
        }
      }
    });

    expect(update).toBeUndefined();
  });

  it('nudges when edit_file targets a different path than the prior read_file call', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'edit_file', args: { file_path: '/workspace/b.md' } })],
      stepTracker: {
        ...defaultStepTracker(),
        executedTools: {
          read_file: [{ file_path: '/workspace/a.md' }]
        }
      }
    });

    const nudge = update?.messages?.[0] as ToolMessage;
    expect(update?.jumpTo).toBe('model');
    expect(String(nudge.content)).toContain('read_file(file_path="/workspace/b.md")');
  });

  it('records needs_clarification from the background time resolver tool result', async () => {
    const middleware = getStepEnforcementMiddleware();
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected step enforcement middleware to expose wrapToolCall.');
    }
    const toolMessage = new ToolMessage({
      tool_call_id: 'call-time',
      name: 'resolve_background_task_time',
      content: JSON.stringify({
        status: 'needs_clarification',
        clarificationQuestion: '请提供未来时间。'
      }),
      status: 'success'
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: 'resolve_background_task_time',
          args: { text: '今天 09:00 检查测试' },
          id: 'call-time'
        },
        state: baseState()
      } as never,
      (async () => toolMessage) as never
    );

    expect(result).toBeInstanceOf(Command);
    expect((result as Command).update).toMatchObject({
      messages: [toolMessage],
      forge_step_tracker: {
        backgroundTaskTimeResolution: 'needs_clarification',
        executedTools: {
          resolve_background_task_time: [{ text: '今天 09:00 检查测试' }]
        }
      }
    });
  });

  it('allows confirm_with_user as terminal when time resolution needs clarification', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'confirm_with_user', args: { summary: '请提供未来时间。' } })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        backgroundTaskTimeResolution: 'needs_clarification',
        executedTools: {
          resolve_background_task_time: [{ text: '今天 09:00 检查测试' }]
        }
      }
    });

    expect(update).toBeUndefined();
  });

  it('nudges propose_background_task when time resolution needs clarification', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'propose_background_task', args: { goal: 'X' }, id: 'call-propose' })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        backgroundTaskTimeResolution: 'needs_clarification',
        executedTools: {
          resolve_background_task_time: [{ text: '今天 09:00 检查测试' }]
        }
      }
    });

    expect(update?.jumpTo).toBe('model');
    expect(update?.forge_step_tracker?.prereqViolations).toBe(1);
    const nudge = update?.messages?.[0] as ToolMessage;
    expect(nudge).toBeInstanceOf(ToolMessage);
    expect(nudge.tool_call_id).toBe('call-propose');
    expect(nudge.name).toBe('propose_background_task');
    expect(nudge.status).toBe('error');
    expect(String(nudge.content)).toContain('[PrerequisiteError]');
    expect(String(nudge.content)).toContain('resolve_background_task_time(status="resolved")');
    expect(readForgeMessageTag(nudge)).toBe('forge:prerequisite_nudge');
  });

  it('nudges schedule_background_task when time resolution needs clarification', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'schedule_background_task', args: { previewId: 'preview-1' }, id: 'call-schedule' })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        backgroundTaskTimeResolution: 'needs_clarification',
        executedTools: {
          resolve_background_task_time: [{ text: '今天 09:00 检查测试' }],
          propose_background_task: [{ goal: 'X' }]
        }
      }
    });

    expect(update?.jumpTo).toBe('model');
    expect(update?.forge_step_tracker?.prereqViolations).toBe(1);
    const nudge = update?.messages?.[0] as ToolMessage;
    expect(nudge).toBeInstanceOf(ToolMessage);
    expect(nudge.tool_call_id).toBe('call-schedule');
    expect(nudge.name).toBe('schedule_background_task');
    expect(nudge.status).toBe('error');
    expect(String(nudge.content)).toContain('[PrerequisiteError]');
    expect(String(nudge.content)).toContain('resolve_background_task_time(status="resolved")');
    expect(readForgeMessageTag(nudge)).toBe('forge:prerequisite_nudge');
  });

  it('allows propose_background_task when time resolution is resolved', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'propose_background_task', args: { goal: 'X' } })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        backgroundTaskTimeResolution: 'resolved',
        executedTools: {
          resolve_background_task_time: [{ text: '每天 09:00 检查测试' }]
        }
      }
    });

    expect(update).toBeUndefined();
  });

  it('still nudges early confirm_with_user when time resolution is resolved', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'confirm_with_user', args: { summary: 'done' }, id: 'call-confirm' })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        backgroundTaskTimeResolution: 'resolved',
        executedTools: {
          resolve_background_task_time: [{ text: '每天 09:00 检查测试' }]
        }
      }
    });

    expect(update?.jumpTo).toBe('model');
    expect(update?.forge_step_tracker?.prematureAttempts).toBe(1);
    const nudge = update?.messages?.[0] as ToolMessage;
    expect(String(nudge.content)).toContain('propose_background_task');
    expect(String(nudge.content)).toContain('schedule_background_task');
  });

  it('allows terminal tools after all required steps have succeeded', async () => {
    const update = await runAfterModel({
      messages: [aiWithToolCall({ name: 'confirm_with_user' })],
      stepTracker: {
        ...defaultStepTracker(),
        requiredSteps: ['resolve_background_task_time', 'propose_background_task', 'schedule_background_task'],
        terminalTools: ['confirm_with_user'],
        backgroundTaskTimeResolution: 'resolved',
        executedTools: {
          resolve_background_task_time: [{ text: '每天 09:00 检查测试' }],
          propose_background_task: [{ goal: 'X' }],
          schedule_background_task: [{ previewId: 'preview-1' }]
        }
      }
    });

    expect(update).toBeUndefined();
  });

  it('throws after prerequisite violations exceed the configured budget', async () => {
    await expect(
      runAfterModel({
        messages: [aiWithToolCall({ name: 'edit_file', args: { file_path: '/workspace/a.md' } })],
        stepTracker: {
          ...defaultStepTracker(),
          prereqViolations: 2
        },
        errorTracker: {
          ...defaultErrorTracker(),
          maxPrereqViolations: 2
        }
      })
    ).rejects.toMatchObject({
      code: FORGE_EXHAUSTED_CODES.prerequisite
    });
  });

  it('returns Command updates when successful tool calls should be recorded', async () => {
    const middleware = getStepEnforcementMiddleware();
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected step enforcement middleware to expose wrapToolCall.');
    }
    const toolMessage = new ToolMessage({
      tool_call_id: 'call-propose',
      name: 'propose_background_task',
      content: 'ok',
      status: 'success'
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: 'propose_background_task',
          args: { goal: 'X' },
          id: 'call-propose'
        },
        state: baseState()
      } as never,
      (async () => toolMessage) as never
    );

    expect(result).toBeInstanceOf(Command);
    expect((result as Command).update).toMatchObject({
      messages: [toolMessage],
      forge_step_tracker: {
        executedTools: {
          propose_background_task: [{ goal: 'X' }]
        }
      }
    });
  });

  it('does not record failed tool messages as completed steps', async () => {
    const middleware = getStepEnforcementMiddleware();
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected step enforcement middleware to expose wrapToolCall.');
    }
    const toolMessage = new ToolMessage({
      tool_call_id: 'call-propose',
      name: 'propose_background_task',
      content: 'failed',
      status: 'error'
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: 'propose_background_task',
          args: { goal: 'X' },
          id: 'call-propose'
        },
        state: baseState()
      } as never,
      (async () => toolMessage) as never
    );

    expect(result).toBe(toolMessage);
  });

  it('does not record tool-resolution soft errors as completed steps', async () => {
    const middleware = getStepEnforcementMiddleware();
    if (typeof middleware.wrapToolCall !== 'function') {
      throw new Error('Expected step enforcement middleware to expose wrapToolCall.');
    }
    const toolMessage = tagForgeMessage(
      new ToolMessage({
        tool_call_id: 'call-read-task',
        name: 'read_background_task',
        content: '[ToolResolutionError] Background task not found.',
        status: 'success'
      }),
      'forge:tool_resolution'
    );

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: 'read_background_task',
          args: { taskId: 'missing-task' },
          id: 'call-read-task'
        },
        state: baseState()
      } as never,
      (async () => toolMessage) as never
    );

    expect(result).toBe(toolMessage);
  });
});
