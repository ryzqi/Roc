import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput
} from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { AIMessageFields } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { createDeepAgent, StateBackend, type DeepAgentRunStream } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  adaptDeepAgents110V3Run,
  type DeepAgents110V3Message,
  type DeepAgents110V3Subagent,
  type DeepAgents110V3SubagentCause,
  type DeepAgents110V3ToolCall,
  type DeepAgents110V3ToolCallStatus,
  type DeepAgents110V3Usage
} from '../../../../src/main/services/deep-agent/deep-agents-1-10-stream-adapter';

type ScriptedModelState = {
  nextResponseIndex: number;
};

type InstalledMessageHandle = DeepAgentRunStream['messages'] extends AsyncIterable<infer TMessage>
  ? TMessage
  : never;

type InstalledSubagentHandle = {
  readonly name: string;
  readonly cause: unknown;
  readonly output: Promise<unknown>;
  readonly messages: AsyncIterable<InstalledMessageHandle>;
  readonly toolCalls: AsyncIterable<unknown>;
  readonly subagents: AsyncIterable<unknown>;
};

class StreamShapeModel extends BaseChatModel {
  private readonly responses: readonly AIMessage[];
  private readonly state: ScriptedModelState;

  constructor(responses: readonly AIMessage[], state?: ScriptedModelState) {
    super({});
    this.responses = responses;
    this.state = state === undefined ? { nextResponseIndex: 0 } : state;
  }

  override _llmType(): string {
    return 'roc-deep-agent-stream-shape';
  }

  override bindTools(
    _tools: BindToolsInput[],
    _kwargs?: Partial<BaseChatModelCallOptions>
  ): StreamShapeModel {
    return new StreamShapeModel(this.responses, this.state);
  }

  override async _generate(): Promise<ChatResult> {
    const response = this.responses[this.state.nextResponseIndex];
    if (response === undefined) {
      throw new Error('deep_agent_stream_shape_model_sequence_exhausted');
    }
    this.state.nextResponseIndex += 1;
    return {
      generations: [{
        message: response,
        text: typeof response.content === 'string' ? response.content : ''
      }],
      llmOutput: {}
    };
  }
}

describe('Deep Agents 1.10.8 stream v3 shape conformance', () => {
  it('pins the installed run, message, usage, and tool-call handles', async () => {
    const agent = createRootShapeAgent();

    const run = await agent.streamEvents(
      { messages: [new HumanMessage('Inspect the fixture.')] },
      { version: 'v3' }
    );
    const messageTask = observeMessages(run.messages);
    const toolTask = observeToolCalls(run.toolCalls);
    const subagentTask = collect(run.subagents);
    const [messages, toolCalls, subagents, output] = await Promise.all([
      messageTask,
      toolTask,
      subagentTask,
      run.output
    ]);

    expect(presentFields(run, ['messages', 'toolCalls', 'subagents', 'output', 'interrupted', 'interrupts']))
      .toEqual(['messages', 'toolCalls', 'subagents', 'output', 'interrupted', 'interrupts']);
    expect(messages).toEqual([
      {
        fields: ['namespace', 'node', 'text', 'toolCalls', 'reasoning', 'usage', 'output'],
        namespace: ['model_request:<uuid>'],
        node: 'model_request',
        text: [],
        toolCalls: [],
        reasoning: [],
        usage: [{
          input_tokens: 11,
          output_tokens: 3,
          total_tokens: 14,
          input_token_details: {
            cache_read: 4,
            cache_creation: 2
          }
        }],
        output: {
          id: 'ai-stream-shape-tool',
          content: [],
          toolCallIds: []
        }
      },
      {
        fields: ['namespace', 'node', 'text', 'toolCalls', 'reasoning', 'usage', 'output'],
        namespace: ['model_request:<uuid>'],
        node: 'model_request',
        text: ['fixture complete'],
        toolCalls: [],
        reasoning: [],
        usage: [{
          input_tokens: 7,
          output_tokens: 5,
          total_tokens: 12
        }],
        output: {
          id: 'ai-stream-shape-final',
          content: [{ type: 'text', text: 'fixture complete' }],
          toolCallIds: []
        }
      }
    ]);
    expect(toolCalls).toEqual([{
      fields: ['name', 'callId', 'input', 'output', 'status', 'error'],
      name: 'inspect_payload',
      callId: 'call-stream-shape',
      input: { value: 'fixture' },
      output: 'observed:fixture',
      status: 'finished',
      error: undefined
    }]);
    expect(subagents).toEqual([]);
    expect(run.interrupted).toBe(false);
    expect(run.interrupts).toEqual([]);
    expect(readLastAssistantText(output)).toBe('fixture complete');
  });

  it('pins the installed named-subagent handle and lifecycle cause', async () => {
    const agent = createNamedSubagentShapeAgent();

    const run = await agent.streamEvents(
      { messages: [new HumanMessage('Delegate the fixture.')] },
      { version: 'v3' }
    );
    const rootMessagesTask = observeMessages(run.messages);
    const rootToolsTask = observeToolCalls(run.toolCalls);
    const subagentsTask = observeSubagents(run.subagents);
    const [rootMessages, rootTools, subagents, output] = await Promise.all([
      rootMessagesTask,
      rootToolsTask,
      subagentsTask,
      run.output
    ]);

    expect(rootMessages.at(-1)?.output.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(rootTools).toContainEqual(expect.objectContaining({
      name: 'task',
      callId: 'call-stream-subagent',
      status: 'finished'
    }));
    expect(subagents).toEqual([{
      fields: ['name', 'cause', 'output', 'messages', 'toolCalls', 'subagents'],
      name: 'research',
      cause: { type: 'toolCall', tool_call_id: 'call-stream-subagent' },
      messages: [{
        fields: ['namespace', 'node', 'text', 'toolCalls', 'reasoning', 'usage', 'output'],
        namespace: ['tools:<uuid>', 'model_request:<uuid>'],
        node: 'model_request',
        text: ['subagent complete'],
        toolCalls: [],
        reasoning: [],
        usage: [{
          input_tokens: 13,
          output_tokens: 2,
          total_tokens: 15
        }],
        output: {
          id: 'ai-stream-subagent-final',
          content: [{ type: 'text', text: 'subagent complete' }],
          toolCallIds: []
        }
      }],
      toolCalls: [],
      subagents: [],
      output: 'subagent complete'
    }]);
    expect(readLastAssistantText(output)).toBe('done');
  });
});

describe('Deep Agents 1.10.x stream v3 adapter contract', () => {
  it('maps the installed run into stable message, usage, tool, and output DTOs', async () => {
    const rawRun = await createRootShapeAgent().streamEvents(
      { messages: [new HumanMessage('Inspect the fixture.')] },
      { version: 'v3' }
    );

    const run = adaptDeepAgents110V3Run(rawRun);
    const [messages, toolCalls, subagents, output] = await Promise.all([
      observeAdaptedMessages(run.messages),
      observeAdaptedToolCalls(run.toolCalls),
      collect(run.subagents),
      run.output
    ]);

    expect(messages).toEqual([
      {
        usageKey: 'run/messages/0',
        namespace: ['model_request:<uuid>'],
        node: 'model_request',
        text: [],
        reasoning: [],
        trailingReasoning: null,
        usage: [{
          inputTokens: 11,
          outputTokens: 3,
          totalTokens: 14,
          cacheReadTokens: 4,
          cacheCreationTokens: 2
        }]
      },
      {
        usageKey: 'run/messages/1',
        namespace: ['model_request:<uuid>'],
        node: 'model_request',
        text: ['fixture complete'],
        reasoning: [],
        trailingReasoning: null,
        usage: [{
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
          cacheReadTokens: null,
          cacheCreationTokens: null
        }]
      }
    ]);
    expect(toolCalls).toEqual([{
      name: 'inspect_payload',
      callId: 'call-stream-shape',
      input: { value: 'fixture' },
      output: 'observed:fixture',
      status: 'finished',
      error: undefined
    }]);
    expect(subagents).toEqual([]);
    expect(run.interrupted).toBe(false);
    expect(run.interrupts).toEqual([]);
    expect(output).toEqual({ finalAssistantText: 'fixture complete' });
  });

  it('reads interrupt terminal state after the live run stream is consumed', async () => {
    let interrupted = false;
    let interrupts: unknown[] = [];
    const rawRun = createRawRun({
      messages: (async function* () {
        interrupted = true;
        interrupts = [{
          interruptId: 'interrupt-question',
          payload: { kind: 'question', question: 'Which workspace?' }
        }];
      })(),
      output: new Promise<never>(() => {})
    });
    Object.defineProperties(rawRun, {
      interrupted: {
        enumerable: true,
        get: () => interrupted
      },
      interrupts: {
        enumerable: true,
        get: () => interrupts
      }
    });

    const run = adaptDeepAgents110V3Run(rawRun);

    expect(run.interrupted).toBe(false);
    expect(run.interrupts).toEqual([]);
    await collect(run.messages);
    expect(run.interrupted).toBe(true);
    expect(run.interrupts).toEqual([{
      interruptId: 'interrupt-question',
      payload: { kind: 'question', question: 'Which workspace?' }
    }]);
  });

  it('maps the installed named subagent and converts its lifecycle cause', async () => {
    const rawRun = await createNamedSubagentShapeAgent().streamEvents(
      { messages: [new HumanMessage('Delegate the fixture.')] },
      { version: 'v3' }
    );

    const run = adaptDeepAgents110V3Run(rawRun);
    const [subagents] = await Promise.all([
      observeAdaptedSubagents(run.subagents),
      observeAdaptedMessages(run.messages),
      observeAdaptedToolCalls(run.toolCalls),
      run.output
    ]);

    expect(subagents).toEqual([{
      name: 'research',
      cause: { type: 'toolCall', toolCallId: 'call-stream-subagent' },
      messages: [{
        usageKey: 'run/subagents/0/messages/0',
        namespace: ['tools:<uuid>', 'model_request:<uuid>'],
        node: 'model_request',
        text: ['subagent complete'],
        reasoning: [],
        trailingReasoning: null,
        usage: [{
          inputTokens: 13,
          outputTokens: 2,
          totalTokens: 15,
          cacheReadTokens: null,
          cacheCreationTokens: null
        }]
      }],
      toolCalls: [],
      subagents: [],
      output: 'subagent complete'
    }]);
  });

  it('maps nested named subagents recursively with stable usage paths', async () => {
    const nestedSubagent = createRawSubagent({
      name: 'nested-research',
      cause: { type: 'toolCall', tool_call_id: 'call-nested' },
      messages: asyncValues([createRawMessage({
        text: asyncValues(['nested response'])
      })]),
      output: Promise.resolve({
        messages: [new AIMessage({ content: 'nested response' })]
      })
    });
    const parentSubagent = createRawSubagent({
      name: 'research',
      cause: { type: 'toolCall', tool_call_id: 'call-parent' },
      messages: asyncValues([createRawMessage({
        text: asyncValues(['parent response'])
      })]),
      subagents: asyncValues([nestedSubagent]),
      output: Promise.resolve({
        messages: [new AIMessage({ content: 'parent response' })]
      })
    });
    const run = adaptDeepAgents110V3Run(createRawRun({
      subagents: asyncValues([parentSubagent])
    }));

    const subagents = await observeAdaptedSubagents(run.subagents);

    expect(subagents[0]?.cause).toEqual({ type: 'toolCall', toolCallId: 'call-parent' });
    expect(subagents[0]?.messages[0]?.usageKey).toBe('run/subagents/0/messages/0');
    expect(subagents[0]?.subagents[0]?.cause).toEqual({
      type: 'toolCall',
      toolCallId: 'call-nested'
    });
    expect(subagents[0]?.subagents[0]?.messages[0]?.usageKey).toBe(
      'run/subagents/0/subagents/0/messages/0'
    );
  });

  it('normalizes the package-declared missing subagent cause to null', async () => {
    const run = adaptDeepAgents110V3Run(createRawRun({
      subagents: asyncValues([createRawSubagent({ cause: undefined })])
    }));

    const subagents = await collect(run.subagents);

    expect(subagents[0]?.cause).toBeNull();
  });

  it('normalizes partial usage observations without inventing missing values', async () => {
    const run = adaptDeepAgents110V3Run(createRawRun({
      messages: asyncValues([createRawMessage({
        usage: asyncValues([
          {
            input_tokens: 80,
            input_token_details: { cache_read: 30 }
          },
          {
            output_tokens: 15,
            total_tokens: 95
          }
        ])
      })])
    }));
    const messages = await collect(run.messages);
    const first = messages[0];
    if (first === undefined) {
      throw new Error('adapter_usage_message_missing');
    }

    await expect(collect(first.usage)).resolves.toEqual([
      {
        inputTokens: 80,
        outputTokens: null,
        totalTokens: null,
        cacheReadTokens: 30,
        cacheCreationTokens: null
      },
      {
        inputTokens: null,
        outputTokens: 15,
        totalTokens: 95,
        cacheReadTokens: null,
        cacheCreationTokens: null
      }
    ]);
  });

  it('maps message output reasoning into the adapter DTO', async () => {
    const run = adaptDeepAgents110V3Run(createRawRun({
      messages: asyncValues([createRawMessage({
        output: Promise.resolve({
          additional_kwargs: {
            reasoning_content: 'adapter fallback reasoning'
          }
        })
      })])
    }));
    const messages = await collect(run.messages);
    const message = messages[0];
    if (message === undefined) {
      throw new Error('adapter_reasoning_message_missing');
    }

    expect(Object.keys(message).sort()).toEqual([
      'namespace',
      'node',
      'reasoning',
      'text',
      'trailingReasoning',
      'usage',
      'usageKey'
    ]);
    await expect(message.trailingReasoning).resolves.toBe('adapter fallback reasoning');
  });

  it('fails explicitly when a tool handle omits required fields or Promise boundaries', async () => {
    const missingCallId = adaptDeepAgents110V3Run(createRawRun({
      toolCalls: asyncValues([createRawToolCall({ callId: undefined })])
    }));
    await expect(collect(missingCallId.toolCalls)).rejects.toThrow(
      'deep_agents_1_10_v3_tool_call_id_missing'
    );

    const nonPromiseOutput = adaptDeepAgents110V3Run(createRawRun({
      toolCalls: asyncValues([createRawToolCall({ output: 'not-a-promise' })])
    }));
    await expect(collect(nonPromiseOutput.toolCalls)).rejects.toThrow(
      'deep_agents_1_10_v3_tool_call_output_promise_missing'
    );

    const nonPromiseStatus = adaptDeepAgents110V3Run(createRawRun({
      toolCalls: asyncValues([createRawToolCall({ status: 'finished' })])
    }));
    await expect(collect(nonPromiseStatus.toolCalls)).rejects.toThrow(
      'deep_agents_1_10_v3_tool_call_status_promise_missing'
    );

    const nonPromiseError = adaptDeepAgents110V3Run(createRawRun({
      toolCalls: asyncValues([createRawToolCall({ error: undefined })])
    }));
    await expect(collect(nonPromiseError.toolCalls)).rejects.toThrow(
      'deep_agents_1_10_v3_tool_call_error_promise_missing'
    );
  });

  it('observes rejected tool output when a sibling Promise boundary is invalid', async () => {
    await expectNoUnhandledRejections(async () => {
      const output = Promise.reject(new Error('tool output failed during contract drift'));
      const run = adaptDeepAgents110V3Run(createRawRun({
        toolCalls: asyncValues([createRawToolCall({
          output,
          status: 'not-a-promise'
        })])
      }));

      await expect(collect(run.toolCalls)).rejects.toThrow(
        'deep_agents_1_10_v3_tool_call_status_promise_missing'
      );
    });
  });

  it('normalizes terminal tool errors without waiting for output', async () => {
    const run = adaptDeepAgents110V3Run(createRawRun({
      toolCalls: asyncValues([createRawToolCall({
        output: new Promise<never>(() => {}),
        status: Promise.resolve('error'),
        error: Promise.resolve('Bearer terminal-error')
      })])
    }));
    const calls = await collect(run.toolCalls);

    await expect(calls[0]?.outcome).resolves.toEqual({
      status: 'error',
      error: 'Bearer terminal-error'
    });
  });

  it.each([
    {
      label: 'missing terminal error',
      status: 'error',
      error: undefined,
      expected: 'deep_agents_1_10_v3_tool_call_terminal_error_missing'
    },
    {
      label: 'non-terminal status',
      status: 'running',
      error: undefined,
      expected: 'deep_agents_1_10_v3_tool_call_status_not_terminal'
    },
    {
      label: 'unexpected terminal error',
      status: 'finished',
      error: 'unexpected error',
      expected: 'deep_agents_1_10_v3_tool_call_terminal_error_unexpected'
    }
  ])('fails explicitly for $label', async ({ status, error, expected }) => {
    const run = adaptDeepAgents110V3Run(createRawRun({
      toolCalls: asyncValues([createRawToolCall({
        status: Promise.resolve(status),
        error: Promise.resolve(error)
      })])
    }));
    const calls = await collect(run.toolCalls);

    await expect(calls[0]?.outcome).rejects.toThrow(expected);
  });

  it('observes rejected run output when later synchronous validation fails', async () => {
    await expectNoUnhandledRejections(() => {
      const output = Promise.reject(new Error('run output failed during contract drift'));
      expect(() => adaptDeepAgents110V3Run(createRawRun({
        output,
        interrupted: 'false'
      }))).toThrow('deep_agents_1_10_v3_run_interrupted_boolean_missing');
    });
  });

  it('observes rejected message output when a sibling field is invalid', async () => {
    await expectNoUnhandledRejections(async () => {
      const run = adaptDeepAgents110V3Run(createRawRun({
        messages: asyncValues([createRawMessage({
          output: Promise.reject(new Error('message output failed during contract drift')),
          text: 'not-an-async-iterable'
        })])
      }));

      await expect(collect(run.messages)).rejects.toThrow(
        'deep_agents_1_10_v3_message_text_async_iterable_missing'
      );
    });
  });

  it('observes rejected subagent output when a sibling field is invalid', async () => {
    await expectNoUnhandledRejections(async () => {
      const run = adaptDeepAgents110V3Run(createRawRun({
        subagents: asyncValues([createRawSubagent({
          output: Promise.reject(new Error('subagent output failed during contract drift')),
          cause: { type: 'unsupported' }
        })])
      }));

      await expect(collect(run.subagents)).rejects.toThrow(
        'deep_agents_1_10_v3_subagent_cause_type_invalid'
      );
    });
  });

  it('fails explicitly when run, message, or subagent contracts drift', async () => {
    expect(() => adaptDeepAgents110V3Run({})).toThrow(
      'deep_agents_1_10_v3_run_messages_async_iterable_missing'
    );

    const invalidMessage = adaptDeepAgents110V3Run(createRawRun({
      messages: asyncValues([createRawMessage({ text: 'not-an-async-iterable' })])
    }));
    await expect(collect(invalidMessage.messages)).rejects.toThrow(
      'deep_agents_1_10_v3_message_text_async_iterable_missing'
    );

    const invalidMessageOutput = adaptDeepAgents110V3Run(createRawRun({
      messages: asyncValues([createRawMessage({ output: { content: [] } })])
    }));
    await expect(collect(invalidMessageOutput.messages)).rejects.toThrow(
      'deep_agents_1_10_v3_message_output_promise_missing'
    );

    const invalidSubagent = adaptDeepAgents110V3Run(createRawRun({
      subagents: asyncValues([{
        name: 'research',
        cause: { type: 'toolCall' },
        output: Promise.resolve({ messages: [] }),
        messages: asyncValues([]),
        toolCalls: asyncValues([]),
        subagents: asyncValues([])
      }])
    }));
    await expect(collect(invalidSubagent.subagents)).rejects.toThrow(
      'deep_agents_1_10_v3_subagent_cause_tool_call_id_missing'
    );

    expect(() => adaptDeepAgents110V3Run(createRawRun({
      output: { messages: [] }
    }))).toThrow('deep_agents_1_10_v3_run_output_promise_missing');
    const invalidFinalMessage = adaptDeepAgents110V3Run(createRawRun({
      output: Promise.resolve({ messages: [42] })
    }));
    await expect(invalidFinalMessage.output).rejects.toThrow(
      'deep_agents_1_10_v3_run_output_message_invalid'
    );
    expect(() => adaptDeepAgents110V3Run(createRawRun({
      interrupted: 'false'
    }))).toThrow('deep_agents_1_10_v3_run_interrupted_boolean_missing');
    expect(() => adaptDeepAgents110V3Run(createRawRun({
      interrupts: [{ payload: { kind: 'question', question: 'Missing id?' } }]
    }))).toThrow('deep_agents_1_10_v3_run_interrupt_id_missing');
  });
});

function createRootShapeAgent() {
  const inspectTool = tool(async ({ value }: { value: string }) => `observed:${value}`, {
    name: 'inspect_payload',
    description: 'Inspect a deterministic payload.',
    schema: z.object({ value: z.string() })
  });
  return createDeepAgent({
    backend: new StateBackend(),
    model: new StreamShapeModel([
      message({
        id: 'ai-stream-shape-tool',
        content: '',
        tool_calls: [{
          name: 'inspect_payload',
          id: 'call-stream-shape',
          args: { value: 'fixture' },
          type: 'tool_call'
        }],
        usage_metadata: {
          input_tokens: 11,
          output_tokens: 3,
          total_tokens: 14,
          input_token_details: {
            cache_read: 4,
            cache_creation: 2
          }
        }
      }),
      message({
        id: 'ai-stream-shape-final',
        content: 'fixture complete',
        usage_metadata: {
          input_tokens: 7,
          output_tokens: 5,
          total_tokens: 12
        }
      })
    ]),
    tools: [inspectTool]
  });
}

function createNamedSubagentShapeAgent() {
  return createDeepAgent({
    backend: new StateBackend(),
    model: structuredToolModel('task', 'call-stream-subagent', {
      description: 'Return the subagent fixture.',
      subagent_type: 'research'
    }),
    subagents: [{
      name: 'research',
      description: 'Produce a deterministic subagent response.',
      systemPrompt: 'Return the fixture response.',
      model: new StreamShapeModel([message({
        id: 'ai-stream-subagent-final',
        content: 'subagent complete',
        usage_metadata: {
          input_tokens: 13,
          output_tokens: 2,
          total_tokens: 15
        }
      })]),
      tools: []
    }]
  });
}

function message(fields: AIMessageFields): AIMessage {
  return new AIMessage(fields);
}

function structuredToolModel(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>
): StreamShapeModel {
  return new StreamShapeModel([
    message({
      id: `ai-${toolCallId}`,
      content: '',
      tool_calls: [{ name: toolName, id: toolCallId, args, type: 'tool_call' }]
    }),
    message({ id: `ai-${toolCallId}-terminal`, content: 'done' })
  ]);
}

async function observeMessages(messages: AsyncIterable<InstalledMessageHandle>) {
  const observed = [];
  for await (const handle of messages) {
    const [text, toolCalls, reasoning, usage, output] = await Promise.all([
      collect(handle.text),
      collect(handle.toolCalls),
      collect(handle.reasoning),
      collect(handle.usage),
      Promise.resolve(handle.output)
    ]);
    const outputToolCalls = output.tool_calls;
    observed.push({
      fields: presentFields(handle, ['namespace', 'node', 'text', 'toolCalls', 'reasoning', 'usage', 'output']),
      namespace: normalizeNamespace(handle.namespace),
      node: handle.node,
      text,
      toolCalls,
      reasoning,
      usage,
      output: {
        id: output.id,
        content: output.content,
        toolCallIds: outputToolCalls === undefined ? [] : outputToolCalls.map((call) => call.id)
      }
    });
  }
  return observed;
}

async function observeToolCalls(calls: AsyncIterable<{
  readonly name: string;
  readonly callId: string;
  readonly input: unknown;
  readonly output: Promise<unknown>;
  readonly status: Promise<'running' | 'finished' | 'error'>;
  readonly error: Promise<string | undefined>;
}>) {
  const observed = [];
  for await (const call of calls) {
    observed.push({
      fields: presentFields(call, ['name', 'callId', 'input', 'output', 'status', 'error']),
      name: call.name,
      callId: call.callId,
      input: call.input,
      output: await call.output,
      status: await call.status,
      error: await call.error
    });
  }
  return observed;
}

async function observeSubagents<TSubagent extends InstalledSubagentHandle>(subagents: AsyncIterable<TSubagent>) {
  const observed = [];
  for await (const subagent of subagents) {
    const [messages, toolCalls, nestedSubagents, output] = await Promise.all([
      observeMessages(subagent.messages),
      collect(subagent.toolCalls),
      collect(subagent.subagents),
      subagent.output
    ]);
    observed.push({
      fields: presentFields(subagent, ['name', 'cause', 'output', 'messages', 'toolCalls', 'subagents']),
      name: subagent.name,
      cause: subagent.cause,
      messages,
      toolCalls,
      subagents: nestedSubagents,
      output: readLastAssistantText(output)
    });
  }
  return observed;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

function presentFields(value: object, fields: readonly string[]): string[] {
  return fields.filter((field) => field in value);
}

function normalizeNamespace(namespace: readonly string[]): string[] {
  return namespace.map((segment) => segment.replace(
    /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    ':<uuid>'
  ));
}

function readLastAssistantText(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) {
    return null;
  }
  const messages = Reflect.get(output, 'messages');
  if (!Array.isArray(messages)) {
    return null;
  }
  const last = messages.at(-1);
  if (!AIMessage.isInstance(last) || typeof last.content !== 'string') {
    if (!AIMessage.isInstance(last) || !Array.isArray(last.content)) {
      return null;
    }
    const text = last.content
      .filter((block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        Reflect.get(block, 'type') === 'text' &&
        typeof Reflect.get(block, 'text') === 'string'
      )
      .map((block) => block.text)
      .join('');
    return text.length === 0 ? null : text;
  }
  return last.content;
}

type AdaptedMessageObservation = {
  usageKey: string;
  namespace: string[];
  node: string;
  text: string[];
  reasoning: string[];
  trailingReasoning: string | null;
  usage: DeepAgents110V3Usage[];
};

type AdaptedToolCallObservation = {
  name: string;
  callId: string;
  input: unknown;
  output: unknown;
  status: DeepAgents110V3ToolCallStatus;
  error: string | undefined;
};

type AdaptedSubagentObservation = {
  name: string;
  cause: DeepAgents110V3SubagentCause | null;
  messages: AdaptedMessageObservation[];
  toolCalls: AdaptedToolCallObservation[];
  subagents: AdaptedSubagentObservation[];
  output: string | null;
};

async function observeAdaptedMessages(
  messages: AsyncIterable<DeepAgents110V3Message>
): Promise<AdaptedMessageObservation[]> {
  const observed: AdaptedMessageObservation[] = [];
  for await (const handle of messages) {
    const [text, reasoning, trailingReasoning, usage] = await Promise.all([
      collect(handle.text),
      collect(handle.reasoning),
      handle.trailingReasoning,
      collect(handle.usage)
    ]);
    observed.push({
      usageKey: handle.usageKey,
      namespace: normalizeNamespace(handle.namespace),
      node: handle.node,
      text,
      reasoning,
      trailingReasoning,
      usage
    });
  }
  return observed;
}

async function observeAdaptedToolCalls(
  calls: AsyncIterable<DeepAgents110V3ToolCall>
): Promise<AdaptedToolCallObservation[]> {
  const observed: AdaptedToolCallObservation[] = [];
  for await (const call of calls) {
    const outcome = await call.outcome;
    observed.push({
      name: call.name,
      callId: call.callId,
      input: call.input,
      output: outcome.status === 'finished' ? outcome.output : null,
      status: outcome.status,
      error: outcome.status === 'error' ? outcome.error : undefined
    });
  }
  return observed;
}

async function observeAdaptedSubagents(
  subagents: AsyncIterable<DeepAgents110V3Subagent>
): Promise<AdaptedSubagentObservation[]> {
  const observed: AdaptedSubagentObservation[] = [];
  for await (const subagent of subagents) {
    const [messages, toolCalls, nestedSubagents, output] = await Promise.all([
      observeAdaptedMessages(subagent.messages),
      observeAdaptedToolCalls(subagent.toolCalls),
      observeAdaptedSubagents(subagent.subagents),
      subagent.output
    ]);
    observed.push({
      name: subagent.name,
      cause: subagent.cause,
      messages,
      toolCalls,
      subagents: nestedSubagents,
      output: output.finalAssistantText
    });
  }
  return observed;
}

function createRawRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: asyncValues([]),
    toolCalls: asyncValues([]),
    subagents: asyncValues([]),
    output: Promise.resolve({ messages: [] }),
    interrupted: false,
    interrupts: [],
    ...overrides
  };
}

function createRawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: ['model_request:fixture'],
    node: 'model_request',
    text: asyncValues([]),
    toolCalls: asyncValues([]),
    reasoning: asyncValues([]),
    usage: asyncValues([]),
    output: Promise.resolve(new AIMessage({ content: '' })),
    ...overrides
  };
}

function createRawToolCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'inspect_payload',
    callId: 'call-fixture',
    input: { value: 'fixture' },
    output: Promise.resolve('observed:fixture'),
    status: Promise.resolve('finished'),
    error: Promise.resolve(undefined),
    ...overrides
  };
}

function createRawSubagent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'research',
    cause: { type: 'toolCall', tool_call_id: 'call-subagent' },
    output: Promise.resolve({ messages: [] }),
    messages: asyncValues([]),
    toolCalls: asyncValues([]),
    subagents: asyncValues([]),
    ...overrides
  };
}

async function* asyncValues<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}

async function expectNoUnhandledRejections(operation: () => void | Promise<void>): Promise<void> {
  const unhandledReasons: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledReasons.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await operation();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(unhandledReasons).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
}
