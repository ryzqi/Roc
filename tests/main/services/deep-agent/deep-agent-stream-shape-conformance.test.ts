import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput
} from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { AIMessageFields } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  adaptDeepAgentRun,
  type DeepAgentDomainEvent
} from '../../../../src/main/services/deep-agent/deep-agents-1-10-stream-adapter';

type ScriptedModelState = {
  nextResponseIndex: number;
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

describe('Deep Agents 1.10.8 stream v3 conformance', () => {
  it('translates the installed message, usage, tool, and output handles into domain events', async () => {
    const rawRun = await createRootShapeAgent().streamEvents(
      { messages: [new HumanMessage('Inspect the fixture.')] },
      { version: 'v3' }
    );
    const run = adaptDeepAgentRun(rawRun, {
      projectToolOutput: ({ output }) => output
    });
    const [events, output] = await Promise.all([collect(run.events), run.output]);

    expect(events).toEqual(expect.arrayContaining<DeepAgentDomainEvent>([
      expect.objectContaining({
        type: 'usage',
        usage: expect.objectContaining({ inputTokens: 11, outputTokens: 3, totalTokens: 14 })
      }),
      expect.objectContaining({
        type: 'tool_call_started',
        scope: null,
        callId: 'call-stream-shape',
        name: 'inspect_payload',
        input: { value: 'fixture' }
      }),
      expect.objectContaining({
        type: 'tool_call_completed',
        scope: null,
        callId: 'call-stream-shape',
        output: 'observed:fixture'
      }),
      expect.objectContaining({
        type: 'assistant_delta',
        scope: null,
        kind: 'text',
        text: 'fixture complete'
      })
    ]));
    expect(output).toBe('fixture complete');
    expect(events.some((event) => event.type === 'run_interrupted')).toBe(false);
  });

  it('translates nested subagent streams into scoped lifecycle events', async () => {
    const run = adaptDeepAgentRun(createRawRun({
      subagents: asyncValues([createRawSubagent({
        messages: asyncValues([createRawMessage({
          text: asyncValues(['child answer']),
          reasoning: asyncValues(['private reasoning'])
        })]),
        subagents: asyncValues([createRawSubagent({ name: 'reader' })])
      })])
    }), {
      projectToolOutput: ({ output }) => output
    });

    const events = await collect(run.events);

    expect(events).toEqual(expect.arrayContaining<DeepAgentDomainEvent>([
      {
        type: 'subagent_started',
        scope: { name: 'research', ordinalPath: [0], path: ['research#0'] }
      },
      {
        type: 'assistant_delta',
        scope: { name: 'research', ordinalPath: [0], path: ['research#0'] },
        kind: 'text',
        text: 'child answer'
      },
      {
        type: 'subagent_started',
        scope: {
          name: 'reader',
          ordinalPath: [0, 0],
          path: ['research#0', 'reader#0']
        }
      },
      {
        type: 'subagent_completed',
        scope: { name: 'research', ordinalPath: [0], path: ['research#0'] }
      }
    ]));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'assistant_delta',
      scope: expect.objectContaining({ name: 'research' }),
      kind: 'reasoning'
    }));
  });

  it('keeps terminal tool errors independent from an unresolved output promise', async () => {
    const run = adaptDeepAgentRun(createRawRun({
      toolCalls: asyncValues([createRawToolCall({
        output: new Promise<never>(() => {}),
        status: Promise.resolve('error'),
        error: Promise.resolve('Bearer secret-token')
      })])
    }), {
      projectToolOutput: ({ output }) => output
    });

    const events = await collect(run.events);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_call_failed',
      error: '[REDACTED]'
    }));
  });

  it('fails explicitly when required vendor stream boundaries drift', async () => {
    expect(() => adaptDeepAgentRun({}, {
      projectToolOutput: ({ output }) => output
    })).toThrow('deep_agents_1_10_v3_run_messages_async_iterable_missing');

    const invalidStatus = adaptDeepAgentRun(createRawRun({
      toolCalls: asyncValues([createRawToolCall({ status: Promise.resolve('finished-v2') })])
    }), {
      projectToolOutput: ({ output }) => output
    });
    await expect(collect(invalidStatus.events)).rejects.toThrow(
      'deep_agents_1_10_v3_tool_call_status_invalid'
    );

    const invalidUsage = adaptDeepAgentRun(createRawRun({
      messages: asyncValues([createRawMessage({ usage: asyncValues([{}]) })])
    }), {
      projectToolOutput: ({ output }) => output
    });
    await expect(collect(invalidUsage.events)).rejects.toThrow(
      'deep_agents_1_10_v3_usage_empty'
    );
  });

  it('observes vendor promises before a sibling contract assertion fails', async () => {
    await expectNoUnhandledRejections(async () => {
      const output = Promise.reject(new Error('run output rejected'));
      expect(() => adaptDeepAgentRun(createRawRun({
        messages: null,
        output
      }), {
        projectToolOutput: ({ output: value }) => value
      })).toThrow('deep_agents_1_10_v3_run_messages_async_iterable_missing');
    });
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
          input_token_details: { cache_read: 4, cache_creation: 2 }
        }
      }),
      message({
        id: 'ai-stream-shape-final',
        content: 'fixture complete',
        usage_metadata: { input_tokens: 7, output_tokens: 5, total_tokens: 12 }
      })
    ]),
    tools: [inspectTool]
  });
}

function message(fields: AIMessageFields): AIMessage {
  return new AIMessage(fields);
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

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

async function* asyncValues<T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values;
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
