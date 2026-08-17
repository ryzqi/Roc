import Database from 'better-sqlite3';

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool, type ClientTool } from '@langchain/core/tools';
import { InMemoryStore, messagesStateReducer } from '@langchain/langgraph';
import { createPatchToolCallsMiddleware, StateBackend } from 'deepagents';
import { toolRetryMiddleware } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import {
  buildDeepAgent,
  type DeepAgentBuildInput
} from '../../../../src/main/services/deep-agent/agent-builder';
import type { RocCompositeBackend } from '../../../../src/main/services/deep-agent/backend';
import { createBackgroundTaskTools } from '../../../../src/main/services/deep-agent/background-task-tools';
import { RocSqliteCheckpointer } from '../../../../src/main/services/deep-agent/sqlite-checkpointer';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';
import { RocDomainError } from '../../../../src/main/services/errors';
import {
  defaultErrorTracker,
  PreviewStore,
  readForgeMessageTag,
  RocToolResolutionError
} from '../../../../src/main/services/forge-guardrails';
import type {
  RunCapabilityEffectClassV1,
  RunCapabilityManifestToolV1,
  RunCapabilityManifestV1,
  RunCapabilityReconcileStrategyV1
} from '../../../../src/shared/types';

type ScriptedModelState = {
  nextResponseIndex: number;
};

type StreamToolCall = {
  readonly callId: string;
  readonly error: Promise<string | undefined>;
  readonly input: unknown | Promise<unknown>;
  readonly name: string;
  readonly output: Promise<unknown>;
  readonly status: Promise<'error' | 'finished' | 'running'>;
};

class ScriptedToolModel extends BaseChatModel {
  private readonly responses: readonly AIMessage[];
  private readonly state: ScriptedModelState;

  constructor(responses: readonly AIMessage[], state?: ScriptedModelState) {
    super({});
    this.responses = responses;
    this.state = state === undefined ? { nextResponseIndex: 0 } : state;
  }

  override _llmType(): string {
    return 'roc-middleware-overlap-scripted';
  }

  get responseIndex(): number {
    return this.state.nextResponseIndex;
  }

  override bindTools(
    _tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>
  ): ScriptedToolModel {
    return new ScriptedToolModel(this.responses, this.state);
  }

  override async _generate(): Promise<ChatResult> {
    const response = this.responses[this.state.nextResponseIndex];
    if (response === undefined) {
      throw new Error('middleware_overlap_model_sequence_exhausted');
    }
    this.state.nextResponseIndex += 1;
    return {
      generations: [
        {
          message: response,
          text: typeof response.content === 'string' ? response.content : ''
        }
      ],
      llmOutput: {}
    };
  }
}

describe('Deep Agents 1.10.8 middleware overlap conformance', () => {
  it('uses the installed PatchToolCallsMiddleware only for message parity repair', async () => {
    const history = [
      new HumanMessage({ id: 'human-parity', content: 'continue' }),
      new AIMessage({
        id: 'ai-parity',
        content: '',
        tool_calls: [
          { name: 'matched_tool', args: {}, id: 'call-matched', type: 'tool_call' },
          { name: 'dangling_tool', args: {}, id: 'call-dangling', type: 'tool_call' }
        ]
      }),
      new ToolMessage({
        id: 'tool-matched',
        tool_call_id: 'call-matched',
        name: 'matched_tool',
        content: 'matched'
      }),
      new ToolMessage({
        id: 'tool-orphan',
        tool_call_id: 'call-orphan',
        name: 'orphan_tool',
        content: 'orphan'
      })
    ];
    const middleware = createPatchToolCallsMiddleware();
    const beforeAgent = requireFunctionHook(middleware.beforeAgent, 'beforeAgent');

    const update = await beforeAgent({ messages: history } as never, {} as never);
    const updateMessages = readUpdateMessages(update);
    expect(updateMessages[0]).toBeInstanceOf(RemoveMessage);
    const patched = messagesStateReducer(history, updateMessages);
    expect(readParityFixture(patched)).toEqual([
      { kind: 'human', id: 'human-parity' },
      { kind: 'assistant', id: 'ai-parity', toolCallIds: ['call-matched', 'call-dangling'] },
      {
        kind: 'tool',
        name: 'dangling_tool',
        toolCallId: 'call-dangling',
        status: undefined,
        content: 'Tool call dangling_tool with id call-dangling was cancelled - another message came in before it could be completed.'
      },
      {
        kind: 'tool',
        name: 'matched_tool',
        toolCallId: 'call-matched',
        status: undefined,
        content: 'matched'
      }
    ]);

    const wrapModelCall = requireFunctionHook(middleware.wrapModelCall, 'wrapModelCall');
    const handler = vi.fn(async (_request: unknown) => new AIMessage('terminal'));
    await wrapModelCall({ messages: history } as never, handler as never);
    const modelRequest = handler.mock.calls[0]?.[0] as { messages?: BaseMessage[] } | undefined;
    if (modelRequest?.messages === undefined) {
      throw new Error('middleware_overlap_patched_model_request_missing');
    }
    expect(readParityFixture(modelRequest.messages)).toEqual(readParityFixture(patched));
  });

  it('pins the installed Deep Agents tool event shape before Roc projection', async () => {
    const db = createAgentDatabase();
    const inspectTool = tool(async ({ value }: { value: string }) => `observed:${value}`, {
      name: 'inspect_payload',
      description: 'Inspect a deterministic payload.',
      schema: z.object({ value: z.string() })
    });

    try {
      const agent = createTestAgent({
        db,
        model: structuredToolModel('inspect_payload', 'call-event-shape', { value: 'fixture' }),
        runId: 'run-event-shape',
        threadId: 'thread-event-shape',
        tools: [inspectTool],
        manifestTools: [manifestTool('inspect_payload', 'none', 'none')]
      });
      const run = await agent.streamEvents(
        initialState('observe the tool event'),
        { configurable: { thread_id: 'thread-event-shape' }, version: 'v3' }
      );
      const observedCalls: Array<{
        keys: string[];
        callId: string;
        name: string;
        input: unknown;
        output: unknown;
        status: string;
        error: string | undefined;
      }> = [];
      const toolCallsTask = (async () => {
        for await (const call of run.toolCalls as AsyncIterable<StreamToolCall>) {
          observedCalls.push({
            keys: Object.keys(call).sort(),
            callId: call.callId,
            name: call.name,
            input: await Promise.resolve(call.input),
            output: await call.output,
            status: await call.status,
            error: await call.error
          });
        }
      })();
      const messagesTask = drain(run.messages as AsyncIterable<unknown>);
      const subagentsTask = drain(run.subagents as AsyncIterable<unknown>);
      const [, , , output] = await Promise.all([toolCallsTask, messagesTask, subagentsTask, run.output]);

      expect(observedCalls).toHaveLength(1);
      expect(observedCalls[0]).toMatchObject({
        keys: ['callId', 'error', 'input', 'name', 'output', 'status'],
        callId: 'call-event-shape',
        name: 'inspect_payload',
        input: { value: 'fixture' },
        status: 'finished',
        error: undefined
      });
      expect(observedCalls[0]?.output).toBe('observed:fixture');
      expect(readTrajectory(output.messages)).toEqual([
        { kind: 'assistant_tool_call', name: 'inspect_payload', id: 'call-event-shape' },
        { kind: 'tool_result', name: 'inspect_payload', id: 'call-event-shape', status: 'success' }
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects an unknown tool at the protocol boundary in a real agent trajectory', async () => {
    const db = createAgentDatabase();
    try {
      const model = structuredToolModel('missing_tool', 'call-unknown-tool', { value: 'fixture' });
      const agent = createTestAgent({
        db,
        model,
        runId: 'run-unknown-tool',
        threadId: 'thread-unknown-tool',
        tools: [],
        manifestTools: []
      });

      await expect(
        agent.invoke(
          initialState('call the unknown tool'),
          { configurable: { thread_id: 'thread-unknown-tool' } }
        )
      ).rejects.toThrow(
        'agent_capability_manifest_tool_not_authorized:missing_tool'
      );
      expect(model.responseIndex).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps rescue parsing and Roc protocol normalization as distinct pre-execution owners', async () => {
    const db = createAgentDatabase();
    const handler = vi.fn(async ({ trigger }: { trigger: { type: string; description: string } }) =>
      `accepted:${trigger.type}:${trigger.description}`
    );
    const backgroundTool = tool(handler, {
      name: 'propose_background_task',
      description: 'Accept a deterministic background task request.',
      schema: z.object({
        trigger: z.object({
          type: z.literal('manual'),
          description: z.string()
        })
      })
    });
    const model = new ScriptedToolModel([
      new AIMessage({
        id: 'ai-rescue-protocol',
        content: '[TOOL_CALLS]propose_background_task{"trigger":"{\\"type\\":\\"manual\\",\\"description\\":\\"fixture\\"}"}'
      }),
      new AIMessage({ id: 'ai-rescue-terminal', content: 'done' })
    ]);

    try {
      const agent = createTestAgent({
        db,
        model,
        runId: 'run-rescue-protocol',
        threadId: 'thread-rescue-protocol',
        tools: [backgroundTool],
        manifestTools: [manifestTool('propose_background_task', 'none', 'none')]
      });
      const result = await agent.invoke(
        initialState('rescue and normalize the tool call'),
        { configurable: { thread_id: 'thread-rescue-protocol' } }
      );

      expect(handler).toHaveBeenCalledWith(
        {
          trigger: {
            type: 'manual',
            description: 'fixture'
          }
        },
        expect.anything()
      );
      const rescued = result.messages.find((message: BaseMessage) =>
        AIMessage.isInstance(message) && message.id === 'ai-rescue-protocol'
      );
      if (!AIMessage.isInstance(rescued)) {
        throw new Error('middleware_overlap_rescued_message_missing');
      }
      expect(rescued.additional_kwargs.forge_rescue).toEqual({ strategy: 'mistral_bracket' });
      expect(readTrajectory(result.messages)).toEqual([
        {
          kind: 'assistant_tool_call',
          name: 'propose_background_task',
          id: 'call_rescued_ai-rescue-protocol_0'
        },
        {
          kind: 'tool_result',
          name: 'propose_background_task',
          id: 'call_rescued_ai-rescue-protocol_0',
          status: 'success'
        }
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps Roc tool resolution soft instead of letting generic runtime mapping consume it', async () => {
    const db = createAgentDatabase();
    const readTaskTool = tool(async () => {
      throw new RocToolResolutionError('Background task does not exist.');
    }, {
      name: 'read_background_task',
      description: 'Read a deterministic task fixture.',
      schema: z.object({ taskId: z.string() })
    });

    try {
      const agent = createTestAgent({
        db,
        model: structuredToolModel('read_background_task', 'call-resolution', { taskId: 'missing' }),
        runId: 'run-resolution',
        threadId: 'thread-resolution',
        tools: [readTaskTool],
        manifestTools: [manifestTool('read_background_task', 'none', 'none')]
      });
      const result = await agent.invoke(
        initialState('read the missing task'),
        { configurable: { thread_id: 'thread-resolution' } }
      );
      const message = requireToolMessage(result.messages, 'call-resolution');

      expect(message.status).toBe('success');
      expect(readForgeMessageTag(message)).toBe('forge:tool_resolution');
      expect(message.content).toBe('[ToolResolutionError] Background task does not exist.');
    } finally {
      db.close();
    }
  });

  it('records an effectful pre-execution resolution failure as final before returning a soft result', async () => {
    const db = createAgentDatabase();
    const createBackgroundTask = vi.fn(async () => ({
      id: 'unexpected-task',
      threadId: 'unexpected-thread',
      nextRunAt: null
    }));
    const registerTask = vi.fn();
    const scheduleTool = createBackgroundTaskTools({
      previewStore: new PreviewStore(),
      runtimeWorkspacePath: 'F:\\Code\\Roc',
      taskAdapter: {
        createBackgroundTaskPreview: async () => {
          throw new Error('unexpected_preview');
        },
        createBackgroundTask,
        readBackgroundTask: async () => {
          throw new Error('unexpected_read');
        },
        updateBackgroundTask: async () => ({
          id: 'unexpected-task',
          threadId: 'unexpected-thread',
          nextRunAt: null
        }),
        cancelBackgroundTask: async () => ({
          id: 'unexpected-task',
          threadId: 'unexpected-thread',
          status: 'cancelled'
        })
      },
      schedulerAdapter: {
        refreshTask: () => {},
        registerTask,
        unregisterTask: () => {}
      }
    }).find((candidate) => candidate.name === 'schedule_background_task');
    if (scheduleTool === undefined) {
      throw new Error('middleware_overlap_schedule_tool_missing');
    }

    try {
      const agent = createTestAgent({
        db,
        effectStore: new AgentToolEffectStore(db),
        model: structuredToolModel('schedule_background_task', 'call-resolution-effect', {
          previewId: 'missing-preview'
        }),
        runId: 'run-resolution-effect',
        threadId: 'thread-resolution-effect',
        tools: [scheduleTool],
        manifestTools: [manifestTool('schedule_background_task', 'external_call', 'manual_confirmation', ['main'])]
      });
      const result = await agent.invoke(
        initialState('schedule the missing preview'),
        { configurable: { thread_id: 'thread-resolution-effect' } }
      );
      const message = requireToolMessage(result.messages, 'call-resolution-effect');

      expect(message.status).toBe('success');
      expect(readForgeMessageTag(message)).toBe('forge:tool_resolution');
      expect(message.content).toBe(
        '[ToolResolutionError] Unknown previewId missing-preview. 请先调用 propose_background_task 生成新的 preview。'
      );
      expect(
        db.prepare(
          `SELECT status
           FROM agent_tool_effects
           WHERE run_id = ? AND tool_call_id = ?`
        ).get('run-resolution-effect', 'call-resolution-effect')
      ).toEqual({ status: 'failed_final' });
      expect(createBackgroundTask).not.toHaveBeenCalled();
      expect(registerTask).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('derives subagent effect identity from a real task trajectory and checkpoint', async () => {
    const db = createAgentDatabase();
    const mutate = vi.fn(async ({ value }: { value: number }) => `mutated:${value}`);
    const mutateTool = tool(mutate, {
      name: 'server__mutate',
      description: 'Apply a deterministic external effect.',
      schema: z.object({ value: z.number() })
    });
    const subagentModel = structuredToolModel('server__mutate', 'call-subagent-effect', { value: 1 });

    try {
      const agent = createTestAgent({
        db,
        effectStore: new AgentToolEffectStore(db),
        model: structuredToolModel('task', 'call-subagent-task', {
          description: 'Apply the deterministic effect.',
          subagent_type: 'effect-worker'
        }),
        runId: 'run-subagent-effect',
        threadId: 'thread-subagent-effect',
        tools: [mutateTool],
        subagents: [
          {
            name: 'effect-worker',
            description: 'Effect identity fixture.',
            systemPrompt: 'Apply the effect once and finish.',
            model: subagentModel,
            tools: [mutateTool]
          }
        ],
        manifestTools: [
          manifestTool('task', 'none', 'none', ['main']),
          manifestTool('server__mutate', 'external_call', 'manual_confirmation')
        ]
      });
      const result = await agent.invoke(
        initialState('delegate the effect'),
        {
          configurable: { thread_id: 'thread-subagent-effect' },
          recursionLimit: 60
        }
      );
      const effectRow = db.prepare(
        `SELECT tool_call_id AS toolCallId, execution_path AS executionPath,
                checkpoint_id AS checkpointId, status
         FROM agent_tool_effects
         WHERE run_id = ?`
      ).get('run-subagent-effect') as {
        toolCallId: string;
        executionPath: string;
        checkpointId: string;
        status: string;
      } | undefined;
      if (effectRow === undefined || !effectRow.executionPath.startsWith('subagent/')) {
        throw new Error('middleware_overlap_subagent_effect_row_missing');
      }
      const checkpointNamespace = effectRow.executionPath.slice('subagent/'.length);
      const checkpointRow = db.prepare(
        `SELECT checkpoint_ns AS checkpointNamespace, checkpoint_id AS checkpointId
         FROM langgraph_checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      ).get('thread-subagent-effect', checkpointNamespace, effectRow.checkpointId);

      expect(requireToolMessage(result.messages, 'call-subagent-task').status).toBeUndefined();
      expect(readTrajectory(result.messages)).toContainEqual({
        kind: 'tool_result',
        name: 'task',
        id: 'call-subagent-task',
        status: 'success'
      });
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(effectRow.toolCallId).toBe('call-subagent-effect');
      expect(effectRow.executionPath).toMatch(
        /^subagent\/tools:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      );
      expect(effectRow.checkpointId).not.toBe('');
      expect(effectRow.status).toBe('succeeded');
      expect(checkpointRow).toEqual({
        checkpointNamespace,
        checkpointId: effectRow.checkpointId
      });
    } finally {
      db.close();
    }
  }, 10_000);

  it('records a manual-confirmation effect as unknown before product error mapping', async () => {
    const db = createAgentDatabase();
    const shellTool = tool(async () => {
      throw new Error('shell result unavailable');
    }, {
      name: 'run_shell_command',
      description: 'Run a deterministic shell fixture.',
      schema: z.object({ command: z.string() })
    });

    try {
      const agent = createTestAgent({
        db,
        effectStore: new AgentToolEffectStore(db),
        model: structuredToolModel('run_shell_command', 'call-effect-unknown', { command: 'git status' }),
        runId: 'run-effect-unknown',
        threadId: 'thread-effect-unknown',
        tools: [shellTool],
        manifestTools: [manifestTool('run_shell_command', 'host_execution', 'manual_confirmation')]
      });
      const result = await agent.invoke(
        initialState('run the shell fixture'),
        { configurable: { thread_id: 'thread-effect-unknown' } }
      );
      const message = requireToolMessage(result.messages, 'call-effect-unknown');
      const effectRows = db
        .prepare(
          `SELECT tool_call_id AS toolCallId, execution_path AS executionPath, status
           FROM agent_tool_effects
           WHERE run_id = ?`
        )
        .all('run-effect-unknown');

      expect(message.status).toBe('error');
      expect(message.content).toBe('[ToolRuntimeError] Error: shell result unavailable');
      expect(effectRows).toEqual([
        {
          toolCallId: 'call-effect-unknown',
          executionPath: 'main',
          status: 'unknown'
        }
      ]);
    } finally {
      db.close();
    }
  });

  it('pins native retry exhaustion as an error ToolMessage', async () => {
    const retryMiddleware = toolRetryMiddleware({
      maxRetries: 2,
      tools: ['web_read'],
      backoffFactor: 1.5,
      initialDelayMs: 0,
      jitter: false
    });
    const wrapToolCall = requireFunctionHook(retryMiddleware.wrapToolCall, 'native_retry_wrap_tool_call');
    const handler = vi.fn(async () => {
      throw new Error('network reset');
    });

    const result = await wrapToolCall(
      {
        toolCall: {
          args: { url: 'https://example.com' },
          id: 'call-network-exhausted',
          name: 'web_read'
        }
      },
      handler
    );

    expect(handler).toHaveBeenCalledTimes(3);
    expect(ToolMessage.isInstance(result)).toBe(true);
    if (!ToolMessage.isInstance(result)) {
      throw new Error('middleware_overlap_native_retry_result_invalid');
    }
    expect(result.status).toBe('error');
    expect(result.tool_call_id).toBe('call-network-exhausted');
    expect(result.content).toBe("Tool 'web_read' failed after 3 attempts with Error");
  });

  it('returns retry exhaustion to the agent while preserving recoverable effect state', async () => {
    const db = createAgentDatabase();
    const handler = vi.fn(async () => {
      throw new Error('web_read 请求失败：network reset');
    });
    const webReadTool = tool(handler, {
      name: 'web_read',
      description: 'Read a deterministic failing network fixture.',
      schema: z.object({ url: z.string() })
    });

    try {
      const agent = createTestAgent({
        db,
        effectStore: new AgentToolEffectStore(db),
        model: structuredToolModel('web_read', 'call-network-exhausted', { url: 'https://example.com' }),
        runId: 'run-network-exhausted',
        threadId: 'thread-network-exhausted',
        tools: [webReadTool],
        manifestTools: [manifestTool('web_read', 'network_read', 'retry_safe')]
      });
      const result = await agent.invoke(
        initialState('read the failing network fixture'),
        { configurable: { thread_id: 'thread-network-exhausted' } }
      );
      const message = requireToolMessage(result.messages, 'call-network-exhausted');

      expect(handler).toHaveBeenCalledTimes(3);
      expect(message.status).toBe('error');
      expect(message.content).toBe('web_read 请求失败：network reset');
      expect(
        db.prepare(
          `SELECT status
           FROM agent_tool_effects
           WHERE run_id = ? AND tool_call_id = ?`
        ).get('run-network-exhausted', 'call-network-exhausted')
      ).toEqual({ status: 'failed_retryable' });
    } finally {
      db.close();
    }
  }, 15_000);

  it('lets native network retry and Roc effect recovery share the same stable tool call', async () => {
    const db = createAgentDatabase();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('web_read 请求失败：network reset'))
      .mockResolvedValueOnce('network ok');
    const webReadTool = tool(handler, {
      name: 'web_read',
      description: 'Read a deterministic network fixture.',
      schema: z.object({ url: z.string() })
    });

    try {
      const agent = createTestAgent({
        db,
        effectStore: new AgentToolEffectStore(db),
        model: structuredToolModel('web_read', 'call-network-retry', { url: 'https://example.com' }),
        runId: 'run-network-retry',
        threadId: 'thread-network-retry',
        tools: [webReadTool],
        manifestTools: [manifestTool('web_read', 'network_read', 'retry_safe')]
      });
      const result = await agent.invoke(
        initialState('read the network fixture'),
        { configurable: { thread_id: 'thread-network-retry' } }
      );
      const message = requireToolMessage(result.messages, 'call-network-retry');
      const effectRows = db
        .prepare(
          `SELECT tool_call_id AS toolCallId, execution_path AS executionPath, status
           FROM agent_tool_effects
           WHERE run_id = ?`
        )
        .all('run-network-retry');

      expect(handler).toHaveBeenCalledTimes(2);
      expect(message.content).toBe('network ok');
      expect(effectRows).toEqual([
        {
          toolCallId: 'call-network-retry',
          executionPath: 'main',
          status: 'succeeded'
        }
      ]);
    } finally {
      db.close();
    }
  }, 10_000);

  it('maps non-effect Roc runtime failures into product ToolMessages', async () => {
    const db = createAgentDatabase();
    const deleteTool = tool(async () => {
      throw new RocDomainError({
        code: 'delete_file_target_not_empty',
        message: '只能删除空目录。',
        category: 'validation',
        retryable: false,
        userAction: '请先清空目录内容。'
      });
    }, {
      name: 'delete_file',
      description: 'Delete a deterministic file fixture.',
      schema: z.object({ file_path: z.string() })
    });

    try {
      const agent = createTestAgent({
        db,
        model: structuredToolModel('delete_file', 'call-runtime-error', { file_path: '/workspace/docs' }),
        runId: 'run-runtime-error',
        threadId: 'thread-runtime-error',
        tools: [deleteTool],
        manifestTools: [manifestTool('delete_file', 'none', 'none')]
      });
      const result = await agent.invoke(
        initialState('delete the fixture'),
        { configurable: { thread_id: 'thread-runtime-error' } }
      );
      const message = requireToolMessage(result.messages, 'call-runtime-error');

      expect(message.status).toBe('error');
      expect(message.content).toBe(
        '[RocToolError] delete_file_target_not_empty: 只能删除空目录。\n请先清空目录内容。'
      );
    } finally {
      db.close();
    }
  });
});

function createAgentDatabase(): Database.Database {
  const db = new Database(':memory:');
  applyAgentPluginSchema(db);
  return db;
}

function createTestAgent(input: {
  db: Database.Database;
  effectStore?: AgentToolEffectStore;
  manifestTools: RunCapabilityManifestToolV1[];
  model: BaseChatModel;
  runId: string;
  subagents?: DeepAgentBuildInput['subagents'];
  threadId: string;
  tools: ClientTool[];
}) {
  const backend = Object.assign(new StateBackend(), { routePrefixes: [] }) as RocCompositeBackend;
  const buildInput: DeepAgentBuildInput = {
    mode: 'run',
    model: input.model,
    systemPrompt: 'Use the requested tool once, then finish.',
    backend,
    store: new InMemoryStore(),
    memorySources: [],
    skillSources: [],
    subagents: input.subagents === undefined ? [] : input.subagents,
    tools: input.tools,
    capabilityManifest: manifestFor(input.manifestTools),
    filesystemPermissions: [],
    workspacePath: 'F:\\Code\\Roc',
    interruptOn: undefined,
    checkpointer: new RocSqliteCheckpointer(input.db),
    workflowHint: null,
    contextBudgetTokens: undefined,
    modelCallLimit: 6,
    modelThreadCallLimit: 6,
    toolCallLimit: 6,
    toolThreadCallLimit: 6
  };
  buildInput.toolEffectIdempotency = {
    runId: input.runId,
    threadId: input.threadId,
    store: input.effectStore === undefined ? new AgentToolEffectStore(input.db) : input.effectStore
  };
  return buildDeepAgent(buildInput);
}

function structuredToolModel(toolName: string, toolCallId: string, args: Record<string, unknown>): ScriptedToolModel {
  return new ScriptedToolModel([
    new AIMessage({
      id: `ai-${toolCallId}`,
      content: '',
      tool_calls: [
        {
          name: toolName,
          id: toolCallId,
          args,
          type: 'tool_call'
        }
      ]
    }),
    new AIMessage({ id: `ai-${toolCallId}-terminal`, content: 'done' })
  ]);
}

function initialState(prompt: string) {
  return {
    forge_error_tracker: defaultErrorTracker(),
    messages: [new HumanMessage(prompt)]
  };
}

function manifestFor(tools: RunCapabilityManifestToolV1[]): RunCapabilityManifestV1 {
  return {
    schemaVersion: 1,
    manifestHash: 'f'.repeat(64),
    requestedCapabilities: { mcpServers: [], skills: [] },
    resolvedCapabilities: { mcpServers: [], skills: [] },
    skippedCapabilities: [],
    tools,
    skills: [],
    untrustedContextPolicy: 'external_content_reference_only'
  };
}

function manifestTool(
  modelVisibleName: string,
  effectClass: RunCapabilityEffectClassV1,
  reconcileStrategy: RunCapabilityReconcileStrategyV1,
  executionScopes: RunCapabilityManifestToolV1['executionScopes'] = ['main', 'subagent']
): RunCapabilityManifestToolV1 {
  return {
    canonicalIdentity: `fixture:${modelVisibleName}`,
    modelVisibleName,
    provenance: { kind: 'mcp', serverId: 'middleware-overlap-fixture' },
    executionScopes,
    riskLevel: effectClass === 'none' ? 'low' : 'medium',
    effectClass,
    approvalPolicy: { kind: 'none' },
    idempotencyStrategy: effectClass === 'none' ? 'none' : 'tool_call',
    reconcileStrategy,
    resourceScope: 'external'
  };
}

function requireFunctionHook(hook: unknown, name: string): (...args: unknown[]) => unknown {
  let candidate: ((...args: unknown[]) => unknown) | null = null;
  if (typeof hook === 'function') {
    candidate = (...args: unknown[]) => Reflect.apply(hook, undefined, args);
  } else if (hook !== null && typeof hook === 'object') {
    const descriptorHook = Reflect.get(hook, 'hook');
    if (typeof descriptorHook === 'function') {
      candidate = (...args: unknown[]) => Reflect.apply(descriptorHook, undefined, args);
    }
  }
  if (candidate === null) {
    throw new Error(`middleware_overlap_${name}_missing`);
  }
  return candidate;
}

function readUpdateMessages(update: unknown): BaseMessage[] {
  if (update === null || typeof update !== 'object' || !('messages' in update)) {
    throw new Error('middleware_overlap_patch_update_missing');
  }
  const messages = Reflect.get(update, 'messages');
  if (!Array.isArray(messages)) {
    throw new Error('middleware_overlap_patch_messages_invalid');
  }
  return messages as BaseMessage[];
}

function readParityFixture(messages: readonly BaseMessage[]) {
  return messages.map((message) => {
    if (AIMessage.isInstance(message)) {
      return {
        kind: 'assistant' as const,
        id: message.id,
        toolCallIds: message.tool_calls?.map((toolCall) => toolCall.id)
      };
    }
    if (ToolMessage.isInstance(message)) {
      return {
        kind: 'tool' as const,
        name: message.name,
        toolCallId: message.tool_call_id,
        status: message.status,
        content: message.content
      };
    }
    return {
      kind: message.getType(),
      id: message.id
    };
  });
}

function readTrajectory(messages: readonly BaseMessage[]) {
  const trajectory: Array<
    | { kind: 'assistant_tool_call'; name: string; id: string | undefined }
    | { kind: 'tool_result'; name: string | undefined; id: string; status: 'success' | 'error' }
  > = [];
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const toolCall of message.tool_calls === undefined ? [] : message.tool_calls) {
        trajectory.push({
          kind: 'assistant_tool_call',
          name: toolCall.name,
          id: toolCall.id
        });
      }
    }
    if (ToolMessage.isInstance(message)) {
      trajectory.push({
        kind: 'tool_result',
        name: message.name,
        id: message.tool_call_id,
        status: message.status === 'error' ? 'error' : 'success'
      });
    }
  }
  return trajectory;
}

function requireToolMessage(messages: readonly BaseMessage[], toolCallId: string): ToolMessage {
  const message = messages.find(
    (candidate) => ToolMessage.isInstance(candidate) && candidate.tool_call_id === toolCallId
  );
  if (!ToolMessage.isInstance(message)) {
    throw new Error(`middleware_overlap_tool_message_missing:${toolCallId}`);
  }
  return message;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _value of stream) {
    // 消费安装包 stream，确保共享 run 完整结束。
  }
}
