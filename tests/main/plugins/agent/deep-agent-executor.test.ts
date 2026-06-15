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
    await buildExecutorOnce(createCapabilities(capabilityCalls), {
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });
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
      workflowHint: 'propose_background_task',
      taskSource: 'workbench'
    });

    const buildInput = readBuildInput();
    expect(buildInput.systemPrompt).toContain('本轮工作流：创建后台任务。');
    expect(buildInput.systemPrompt).toContain(
      '可用工具：resolve_background_task_time / propose_background_task / schedule_background_task。'
    );
    expect(buildInput.systemPrompt).toContain('schedule_background_task({ previewId })');
  });

  it('adds background task change interrupts inside workbench background task workflows', async () => {
    await buildExecutorOnce(createCapabilities([], { capabilityPreview: true }), {
      workflowHint: 'background_task_change',
      taskSource: 'workbench'
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

  it('does not expose background task tools in ordinary chat runs', async () => {
    await buildExecutorOnce(createCapabilities([]), {
      mode: 'chat',
      workflowHint: null,
      taskSource: null
    });

    expect(readBuiltTools().map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        'resolve_background_task_time',
        'propose_background_task',
        'schedule_background_task',
        'read_background_task',
        'update_background_task',
        'cancel_background_task'
      ])
    );
  });

  it('rejects background task workflow hints without workbench source', async () => {
    await expect(
      buildExecutorOnce(createCapabilities([]), {
        workflowHint: 'propose_background_task',
        taskSource: null
      })
    ).rejects.toThrow('background_task_workbench_source_required');
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

  it('yields streamed assistant text before reasoning and final output finish', async () => {
    const reasoning = createControlledAsyncStream<string>();
    const text = createControlledAsyncStream<string>();
    const output = createDeferred<unknown>();
    const execution = await startExecutorExecution({
      capabilities: createCapabilities([]),
      messages: createAsyncIterable([
        {
          reasoning: reasoning.iterable,
          text: text.iterable
        }
      ]),
      output: output.promise
    });
    const iterator = execution[Symbol.asyncIterator]();
    const firstRead = iterator.next();

    try {
      await reasoning.waitForRead();
      text.push('实时回答第一段');

      const event = await readIteratorValue(firstRead, 'streamed_text_before_final_output');

      expect(event).toEqual({
        type: 'assistant_block',
        runId: 'run-1',
        block: {
          kind: 'text',
          blockId: 'text-run-1',
          phase: 'delta',
          text: '实时回答第一段'
        }
      });
    } finally {
      text.close();
      reasoning.close();
      output.resolve({ messages: [] });
      await firstRead.catch(() => undefined);
      await waitForPromise(drainIterator(iterator), 'executor_drain');
    }
  });

  it('drains buffered assistant events without array shift reindexing', async () => {
    const chunks = Array.from({ length: 128 }, (_, index) => `实时片段${index}`);
    const originalShift = Array.prototype.shift;
    Object.defineProperty(Array.prototype, 'shift', {
      configurable: true,
      value: function <T>(this: T[]): T | undefined {
        if (isChatRunEventBuffer(this)) {
          throw new Error('chat_run_event_queue_shift_used');
        }
        return Reflect.apply(originalShift, this, []) as T | undefined;
      }
    });

    try {
      const events = await collectExecutorEvents({
        capabilities: createCapabilities([]),
        messages: createAsyncIterable([
          {
            text: createAsyncIterable(chunks)
          }
        ]),
        output: {
          messages: []
        }
      });

      expect(
        events.map((event) => (event.type === 'assistant_block' && event.block.kind === 'text' ? event.block.text : null))
      ).toEqual(chunks);
    } finally {
      Object.defineProperty(Array.prototype, 'shift', {
        configurable: true,
        value: originalShift
      });
    }
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

interface ExecutorEventsInput {
  capabilities: RocCapabilityRegistry;
  messages?: AsyncIterable<unknown>;
  output?: unknown;
  requestOverride?: Partial<ChatStartRunRequest>;
  subagents?: AsyncIterable<unknown>;
  toolCalls?: AsyncIterable<unknown>;
}

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

async function collectExecutorEvents(input: ExecutorEventsInput): Promise<ChatRunEvent[]> {
  return await collectEvents(await startExecutorExecution(input));
}

async function startExecutorExecution(input: ExecutorEventsInput): Promise<AsyncIterable<ChatRunEvent>> {
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
  return execution;
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
          interruptOn: {}
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

type ControlledAsyncStream<T> = {
  close: () => void;
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  waitForRead: () => Promise<void>;
};

function createControlledAsyncStream<T>(): ControlledAsyncStream<T> {
  const values: T[] = [];
  const pendingReads: Array<(result: IteratorResult<T>) => void> = [];
  const readWaiters: Array<() => void> = [];
  let closed = false;
  let readCount = 0;
  let observedReadCount = 0;

  const notifyRead = () => {
    readCount += 1;
    const waiters = readWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  };

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      const reads = pendingReads.splice(0);
      reads.forEach((resolve) => resolve({ done: true, value: undefined }));
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          notifyRead();
          if (values.length > 0) {
            return Promise.resolve({ done: false, value: values.shift() as T });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            pendingReads.push(resolve);
          });
        }
      })
    },
    push: (value) => {
      if (closed) {
        throw new Error('controlled_stream_closed');
      }
      const read = pendingReads.shift();
      if (read === undefined) {
        values.push(value);
        return;
      }
      read({ done: false, value });
    },
    waitForRead: async () => {
      if (readCount > observedReadCount) {
        observedReadCount = readCount;
        return;
      }
      await new Promise<void>((resolve) => {
        readWaiters.push(() => {
          observedReadCount = readCount;
          resolve();
        });
      });
    }
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (resolve === null) {
    throw new Error('deferred_resolve_missing');
  }
  return {
    promise,
    resolve
  };
}

async function collectEvents(events: AsyncIterable<ChatRunEvent>): Promise<ChatRunEvent[]> {
  const result: ChatRunEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

async function readIteratorValue<T>(read: Promise<IteratorResult<T>>, label: string): Promise<T> {
  const result = await waitForPromise(read, label);
  if (result.done === true) {
    throw new Error(`expected_iterator_value:${label}`);
  }
  return result.value;
}

async function waitForPromise<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed_out:${label}`)), 100);
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function drainIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  while (true) {
    const result = await iterator.next();
    if (result.done === true) {
      return;
    }
  }
}

function isChatRunEventBuffer(value: readonly unknown[]): boolean {
  if (value.length === 0) {
    return false;
  }
  const first = value[0];
  if (typeof first !== 'object' || first === null || !('type' in first)) {
    return false;
  }
  return first.type === 'assistant_block';
}
