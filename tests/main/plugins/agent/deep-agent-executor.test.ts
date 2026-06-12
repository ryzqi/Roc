import { ToolMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatRunEvent,
  ChatStartRunRequest,
  TaskDetail,
  TaskRun,
  Workspace
} from '../../../../src/shared/types';
import type { CapabilityDescriptor, RocCapabilityRegistry } from '../../../../src/main/kernel/types';
import { createAgentDeepAgentExecutor } from '../../../../src/main/plugins/agent/deep-agent-executor';
import type { DeepAgentBuildInput } from '../../../../src/main/services/deep-agent/agent-builder';
import { tagForgeMessage } from '../../../../src/main/services/forge-guardrails';
import { RocPaths } from '../../../../src/main/services/paths';

const mocked = vi.hoisted(() => ({
  buildDeepAgent: vi.fn()
}));

vi.mock('../../../../src/main/services/deep-agent/agent-builder', () => ({
  buildDeepAgent: mocked.buildDeepAgent
}));

describe('createAgentDeepAgentExecutor', () => {
  it('wires the production background task tools to task capabilities', async () => {
    const capabilityCalls: Array<{ name: string; input: unknown }> = [];
    await buildExecutorOnce(createCapabilities(capabilityCalls));
    const tools = readBuiltTools();

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'resolve_background_task_time',
        'propose_background_task',
        'schedule_background_task',
        'read_background_task',
        'update_background_task',
        'cancel_background_task'
      ])
    );

    const proposeResult = readJson(
      await invokeTool(findTool(tools, 'propose_background_task'), {
        goal: '每天检查测试',
        trigger: {
          type: 'manual',
          description: '手动'
        },
        workspacePath: 'F:\\Code\\Roc'
      })
    ) as { previewId: string; preview: BackgroundTaskPreview };
    expect(proposeResult.preview.requiresConfirmation).toBe(false);

    expect(
      readJson(
        await invokeTool(findTool(tools, 'schedule_background_task'), {
          previewId: proposeResult.previewId
        })
      )
    ).toMatchObject({
      ok: true,
      taskId: 'background-1',
      threadId: 'thread-background-1'
    });

    await invokeTool(findTool(tools, 'read_background_task'), {
      taskId: 'background-1'
    });
    await invokeTool(findTool(tools, 'update_background_task'), {
      taskId: 'background-1',
      patch: {
        goal: '每天检查失败测试'
      },
      reason: '调整目标'
    });
    await invokeTool(findTool(tools, 'cancel_background_task'), {
      taskId: 'background-1',
      reason: '不再需要'
    });

    expect(capabilityCalls.map((call) => call.name)).toEqual([
      'workspace.getCurrent',
      'task.background.preview',
      'task.background.create',
      'task.detail.get',
      'task.background.update',
      'task.background.cancel'
    ]);
  });

  it('uses the shared workflow system prompt in production executor runs', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      workflowHint: 'propose_background_task'
    });

    const buildInput = readBuildInput();
    expect(buildInput.systemPrompt).toContain('本轮工作流：创建后台任务。');
    expect(buildInput.systemPrompt).toContain(
      '可用工具：resolve_background_task_time / propose_background_task / schedule_background_task。'
    );
    expect(buildInput.systemPrompt).toContain('schedule_background_task({ previewId })');
  });

  it('keeps approval interrupts for background task changes during creation workflow runs', async () => {
    await buildExecutorOnce(createCapabilities([], { capabilityPreview: true }), {
      workflowHint: 'propose_background_task'
    });

    expect(readBuildInput().interruptOn).toEqual({
      update_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      cancel_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      }
    });
  });

  it('emits streamed assistant message chunks', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['实时回答'])
        }
      ]),
      output: {
        messages: []
      }
    });

    expect(events).toContainEqual({
      type: 'assistant_block',
      runId: 'run-1',
      block: {
        kind: 'text',
        blockId: 'text-run-1',
        phase: 'delta',
        text: '实时回答'
      }
    });
  });

  it('emits final assistant output when the provider does not stream message text', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          {
            content: '最终回答',
            type: 'ai'
          }
        ]
      }
    });

    expect(events).toEqual([
      {
        type: 'assistant_block',
        runId: 'run-1',
        block: {
          kind: 'text',
          blockId: 'text-run-1',
          phase: 'delta',
          text: '最终回答'
        }
      }
    ]);
  });

  it('does not synthesize earlier assistant output when the final message is not assistant text', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          {
            content: '历史回答',
            type: 'ai'
          },
          {
            content: '新的用户输入',
            type: 'human'
          }
        ]
      }
    });

    expect(events).toEqual([]);
  });

  it('uses final ToolMessage content for tool block output when present', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          new ToolMessage({
            content: 'Successfully wrote to /workspace/hello.docx',
            name: 'write_file',
            tool_call_id: 'call-write'
          })
        ]
      }
    });

    expect(events).toEqual([
      {
        type: 'assistant_block',
        runId: 'run-1',
        block: {
          kind: 'tool_call',
          blockId: 'tool-call-write',
          callId: 'call-write',
          name: 'write_file',
          phase: 'end',
          output: 'Successfully wrote to /workspace/hello.docx'
        }
      }
    ]);
  });

  it('does not emit final tool blocks for Forge tagged ToolMessage output', async () => {
    const events = await collectExecutorEvents({
      capabilities: createCapabilities([]),
      output: {
        messages: [
          tagForgeMessage(
            new ToolMessage({
              content: '[ToolResolutionError] Missing prerequisite.',
              name: 'web_search',
              tool_call_id: 'call-search'
            }),
            'forge:tool_resolution'
          )
        ]
      }
    });

    expect(events).toEqual([]);
  });
});

async function buildExecutorOnce(
  capabilities: RocCapabilityRegistry,
  requestOverride: Partial<ChatStartRunRequest> = {}
): Promise<void> {
  await collectExecutorEvents({
    capabilities,
    requestOverride,
    output: {
      messages: [
        {
          role: 'assistant',
          content: 'ok'
        }
      ]
    }
  });
}

async function collectExecutorEvents(input: {
  capabilities: RocCapabilityRegistry;
  messages?: AsyncIterable<unknown>;
  output?: unknown;
  requestOverride?: Partial<ChatStartRunRequest>;
  subagents?: AsyncIterable<unknown>;
  toolCalls?: AsyncIterable<unknown>;
}): Promise<ChatRunEvent[]> {
  mocked.buildDeepAgent.mockReset();
  mocked.buildDeepAgent.mockReturnValue({
    streamEvents: vi.fn(async () => ({
      toolCalls: input.toolCalls ?? emptyAsyncIterable(),
      messages: input.messages ?? emptyAsyncIterable(),
      subagents: input.subagents ?? emptyAsyncIterable(),
      output: input.output ?? { messages: [] }
    }))
  });
  const executor = createAgentDeepAgentExecutor({
    capabilities: input.capabilities,
    paths: new RocPaths('F:\\Code\\Roc\\.roc-test')
  });
  const execution = await executor.execute({
    abortSignal: new AbortController().signal,
    modelHandle: {
      providerId: 'test-provider',
      modelId: 'test-model',
      langChainHandle: {
        model: {} as never,
        modelId: 'test-model',
        provider: {
          id: 'test-provider',
          name: 'Test Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test',
          credentialRef: null,
          enabled: true,
          models: []
        },
        runtime: {
          providerType: 'openai_compatible',
          baseUrl: null,
          streaming: true,
          modelKwargs: {},
          contextBudgetTokens: 4096
        }
      }
    },
    request: {
      input: '每天检查测试',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      },
      ...input.requestOverride
    },
    run: createRun()
  });
  return await collectEvents(execution);
}

function createCapabilities(
  calls: Array<{ name: string; input: unknown }>,
  options: { capabilityPreview?: boolean } = {}
): RocCapabilityRegistry {
  const capabilityPreviewDescriptor: CapabilityDescriptor = {
    name: 'agent.capability.preview',
    version: '1.0.0',
    inputSchema: z.unknown(),
    outputSchema: z.unknown()
  };
  return {
    declare: () => {},
    register: () => {},
    list: () => (options.capabilityPreview === true ? [capabilityPreviewDescriptor] : []),
    invoke: async <TInput, TOutput>(name: string, input: TInput): Promise<TOutput> => {
      calls.push({ name, input });
      if (name === 'agent.capability.preview') {
        return {
          interruptOn: {
            update_background_task: {
              allowedDecisions: ['approve', 'edit', 'reject']
            },
            cancel_background_task: {
              allowedDecisions: ['approve', 'edit', 'reject']
            }
          }
        } as TOutput;
      }
      if (name === 'workspace.getCurrent') {
        const workspace = {
          id: 'workspace-1',
          path: 'F:\\Code\\Roc',
          displayName: 'Roc',
          lastOpenedAt: '2026-06-04T00:00:00.000Z',
          trustState: 'trusted'
        } satisfies Workspace;
        return workspace as TOutput;
      }
      if (name === 'task.background.preview') {
        return createPreview(input as BackgroundTaskPreviewRequest) as TOutput;
      }
      if (name === 'task.background.create') {
        return createTask(input as BackgroundTaskPreview, 'running') as TOutput;
      }
      if (name === 'task.detail.get') {
        return createTaskDetail() as TOutput;
      }
      if (name === 'task.background.update') {
        return createTask(createPreview((input as { patch: Partial<BackgroundTaskPreviewRequest> }).patch), 'running') as TOutput;
      }
      if (name === 'task.background.cancel') {
        return createTask(createPreview({ goal: '已取消任务' }), 'cancelled') as TOutput;
      }
      throw new Error(`unexpected_capability:${name}`);
    }
  } satisfies RocCapabilityRegistry;
}

function createRun(): TaskRun {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    runNumber: 1,
    userInput: '每天检查测试',
    status: 'running',
    startedAt: '2026-06-04T00:00:00.000Z',
    endedAt: null,
    modelId: 'test-model',
    enabledCapabilities: {
      mcpServers: [],
      skills: []
    }
  };
}

function createPreview(input: Partial<BackgroundTaskPreviewRequest>): BackgroundTaskPreview {
  const trigger = input.trigger ?? {
    type: 'manual',
    description: '手动'
  };
  return {
    goal: input.goal ?? '每天检查测试',
    trigger,
    workspacePath: input.workspacePath ?? 'F:\\Code\\Roc',
    allowedActions: input.allowedActions ?? [],
    forbiddenActions: input.forbiddenActions ?? [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: input.enabledCapabilities === undefined ? null : input.enabledCapabilities,
    scheduled: trigger.type !== 'manual',
    nextRunAt: trigger.type === 'cron' || trigger.type === 'once' ? trigger.nextRunAt : null,
    cronExpression: trigger.type === 'cron' ? trigger.cronExpression : null,
    riskLevel: 'low',
    requiresConfirmation: false
  };
}

function createTask(preview: BackgroundTaskPreview, status: BackgroundTask['status']): BackgroundTask {
  return {
    id: 'background-1',
    threadId: 'thread-background-1',
    runId: 'run-background-1',
    goal: preview.goal,
    status,
    scheduled: preview.scheduled,
    triggerType: preview.trigger.type,
    triggerDescription: preview.trigger.description,
    nextRunAt: preview.nextRunAt,
    cronExpression: preview.cronExpression,
    workspacePath: preview.workspacePath,
    allowedActions: preview.allowedActions,
    forbiddenActions: preview.forbiddenActions,
    failurePolicy: preview.failurePolicy,
    notificationPolicy: preview.notificationPolicy,
    riskLevel: preview.riskLevel,
    requiresConfirmation: preview.requiresConfirmation,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    enabledCapabilities: preview.enabledCapabilities
  };
}

function createTaskDetail(): TaskDetail {
  return {
    threadId: 'thread-background-1',
    taskId: 'background-1',
    thread: {
      id: 'thread-background-1',
      kind: 'background',
      title: '每天检查测试',
      goal: '每天检查测试',
      status: 'running',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z'
    },
    backgroundTask: createTask(createPreview({}), 'running'),
    lastRunId: null,
    runHistory: [],
    recentEvents: [],
    schedulerRegistered: true
  };
}

function readBuiltTools(): ClientTool[] {
  return readBuildInput().tools;
}

function readBuildInput(): DeepAgentBuildInput {
  const input = mocked.buildDeepAgent.mock.calls[0]?.[0] as DeepAgentBuildInput | undefined;
  if (input === undefined) {
    throw new Error('expected_build_deep_agent_call');
  }
  return input;
}

function findTool(tools: ClientTool[], name: string): ClientTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`expected_tool:${name}`);
  }
  return tool;
}

async function invokeTool(tool: ClientTool, input: Record<string, unknown>): Promise<unknown> {
  const invoke = Reflect.get(tool, 'invoke');
  if (typeof invoke !== 'function') {
    throw new Error(`tool_not_invokable:${tool.name}`);
  }
  return await invoke.call(tool, input);
}

function readJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error('expected_json_string_tool_output');
  }
  return JSON.parse(value) as unknown;
}

async function* emptyAsyncIterable(): AsyncIterable<unknown> {}

async function* createAsyncIterable(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

async function collectEvents(events: AsyncIterable<ChatRunEvent>): Promise<ChatRunEvent[]> {
  const result: ChatRunEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}
