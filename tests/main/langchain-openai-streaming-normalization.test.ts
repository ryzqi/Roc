import { AIMessage, AIMessageChunk, ChatMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { ChatOpenAICompletions } from '@langchain/openai';
import { createAgent } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-openai-streaming-');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await services.cleanup();
});

describe('OpenAI-compatible streaming normalization', () => {
  it('uses the configured provider timeout for stream idle recovery', async () => {
    vi.useFakeTimers();
    configureOpenAiCompatibleProvider({ timeoutMs: 5 });

    const configuredModel = await createConfiguredModel();
    const completionModel = configuredModel as unknown as {
      completions: {
        _streamResponseChunks: () => AsyncGenerator<ChatGenerationChunk>;
      };
    };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    completionModel.completions._streamResponseChunks = async function* () {
      await gate;
    };

    const stream = (configuredModel as unknown as {
      _streamResponseChunks: (messages: HumanMessage[], options: Record<string, never>) => AsyncGenerator<ChatGenerationChunk>;
    })._streamResponseChunks([new HumanMessage('wait for the provider')], {});
    const consume = (async () => {
      for await (const _chunk of stream) {
        // The source intentionally never yields before the idle timeout.
      }
    })();
    const result = Promise.race([
      consume.then(
        () => ({ kind: 'completed' as const }),
        (error: unknown) => ({ kind: 'error' as const, error })
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 10);
      })
    ]);

    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({
      kind: 'error',
      error: { name: 'ProviderStreamIdleError' }
    });
    release?.();
    await consume.catch(() => undefined);
  });

  it('normalizes a provider raw stream termination into a structured error', async () => {
    configureOpenAiCompatibleProvider();
    const configuredModel = await createConfiguredModel();
    const completionModel = configuredModel as unknown as {
      completions: {
        _streamResponseChunks: () => AsyncGenerator<ChatGenerationChunk>;
      };
    };
    completionModel.completions._streamResponseChunks = async function* () {
      throw new Error('terminated');
    };

    const stream = (configuredModel as unknown as {
      _streamResponseChunks: (messages: HumanMessage[], options: Record<string, never>) => AsyncGenerator<ChatGenerationChunk>;
    })._streamResponseChunks([new HumanMessage('terminate')], {});

    await expect(
      (async () => {
        for await (const _chunk of stream) {
          // The provider terminates before yielding a chunk.
        }
      })()
    ).rejects.toMatchObject({
      name: 'ProviderStreamTerminatedError',
      code: 'provider_stream_terminated'
    });
  });

  it('preserves provider reasoning and tool calls in streamV2 events', async () => {
    configureOpenAiCompatibleProvider();

    const configuredModel = await createConfiguredModel();
    stubSingleToolCallStream(configuredModel);

    const stream = configuredModel.streamV2('Create hello.txt.');
    const reasoningDeltas: string[] = [];
    for await (const delta of stream.reasoning) {
      reasoningDeltas.push(delta);
    }
    const toolCalls: unknown[] = [];
    for await (const call of stream.toolCalls) {
      toolCalls.push(call);
    }
    const output = await stream;

    const expectedToolCall = {
      type: 'tool_call',
      id: 'call-write',
      name: 'write_file',
      args: {
        file_path: '/workspace/hello.txt'
      }
    };
    expect(reasoningDeltas).toEqual(['Thinking']);
    expect(toolCalls).toEqual([expectedToolCall]);
    expect(output.tool_calls).toEqual([expectedToolCall]);
    expect(output.contentBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          reasoning: 'Thinking'
        }),
        expect.objectContaining(expectedToolCall)
      ])
    );
  });

  it('preserves split tool calls without indexes in the model stream used by agents', async () => {
    configureOpenAiCompatibleProvider();

    const configuredModel = await createConfiguredModel();
    stubSplitToolCallStream(configuredModel);

    let aggregated: AIMessageChunk | null = null;
    for await (const chunk of await configuredModel.stream('Search Agnes tool call errors.')) {
      aggregated = aggregated === null ? chunk : aggregated.concat(chunk);
    }

    expect(aggregated?.tool_calls).toEqual([
      {
        type: 'tool_call',
        id: 'call-search',
        name: 'web_search',
        args: {
          query: 'agnes'
        }
      }
    ]);
    expect(aggregated?.invalid_tool_calls).toEqual([]);
  });

  it('strips raw reasoning blocks from chat input before the next OpenAI-compatible call', async () => {
    configureOpenAiCompatibleProvider();

    const configuredModel = await createConfiguredModel();
    const receivedMessages = stubOkStream(configuredModel);

    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await configuredModel.stream([
      new AIMessage({
        content: [
          {
            type: 'reasoning',
            reasoning: 'Thinking'
          },
          {
            type: 'text',
            text: 'Done.'
          }
        ]
      })
    ])) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.content).join('')).toBe('OK');
    expect(readFirstMessageContent(receivedMessages)).toEqual([
      {
        type: 'text',
        text: 'Done.'
      }
    ]);
  });

  it('strips raw reasoning blocks from generic chat messages used by DeepAgents state', async () => {
    configureOpenAiCompatibleProvider();

    const configuredModel = await createConfiguredModel();
    const receivedMessages = stubOkStream(configuredModel);

    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await configuredModel.stream([
      new ChatMessage(
        {
          content: [
            {
              type: 'reasoning',
              reasoning: 'Thinking'
            },
            {
              type: 'text',
              text: 'Done.'
            }
          ],
          role: 'assistant'
        }
      )
    ])) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.content).join('')).toBe('OK');
    expect(readFirstMessageContent(receivedMessages)).toEqual([
      {
        type: 'text',
        text: 'Done.'
      }
    ]);
  });

  it('strips provider-specific reasoning block variants from chat input', async () => {
    configureOpenAiCompatibleProvider();

    const configuredModel = await createConfiguredModel();
    const receivedMessages = stubOkStream(configuredModel);

    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await configuredModel.stream([
      new AIMessage({
        content: [
          {
            type: 'reasoning_content',
            reasoning_content: 'Hidden reasoning content'
          },
          {
            type: 'thinking',
            thinking: 'Hidden thinking'
          },
          {
            type: 'text',
            text: 'Done.'
          }
        ]
      })
    ])) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.content).join('')).toBe('OK');
    expect(readFirstMessageContent(receivedMessages)).toEqual([
      {
        type: 'text',
        text: 'Done.'
      }
    ]);
  });

  it('uses a protocol-safe placeholder when a tool message only contains reasoning blocks', async () => {
    configureOpenAiCompatibleProvider();

    const configuredModel = await createConfiguredModel();
    const receivedMessages = stubOkStream(configuredModel);

    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await configuredModel.stream([
      new ToolMessage({
        content: [
          {
            type: 'reasoning',
            reasoning: 'Hidden tool reasoning'
          }
        ],
        tool_call_id: 'functions.task:17'
      })
    ])) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.content).join('')).toBe('OK');
    expect(readFirstMessageContent(receivedMessages)).toBe('Task completed');
  });

  it('preserves message chunk fields while stripping raw reasoning input', async () => {
    configureOpenAiCompatibleProvider();

    const configuredModel = await createConfiguredModel();
    const receivedMessages = stubOkStream(configuredModel);

    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await configuredModel.stream([
      new AIMessageChunk({
        content: [
          {
            type: 'reasoning',
            reasoning: 'Hidden chunk reasoning'
          },
          {
            type: 'text',
            text: 'Done.'
          }
        ],
        tool_call_chunks: [
          {
            id: 'call-search',
            name: 'web_search',
            args: '{"query":"roc"}',
            type: 'tool_call_chunk'
          }
        ]
      })
    ])) {
      chunks.push(chunk);
    }

    const firstMessage = receivedMessages[0];
    expect(chunks.map((chunk) => chunk.content).join('')).toBe('OK');
    expect(AIMessageChunk.isInstance(firstMessage)).toBe(true);
    if (!AIMessageChunk.isInstance(firstMessage)) {
      throw new Error('Expected first message to remain an AIMessageChunk.');
    }
    expect(firstMessage.content).toEqual([
      {
        type: 'text',
        text: 'Done.'
      }
    ]);
    expect(firstMessage.tool_call_chunks).toEqual([
      {
        id: 'call-search',
        name: 'web_search',
        args: '{"query":"roc"}',
        type: 'tool_call_chunk'
      }
    ]);
  });

  it('lets an agent execute a tool emitted as split chunks without indexes', async () => {
    configureOpenAiCompatibleProvider();
    const model = await createConfiguredModel();
    stubAgentModelSequence();
    const webSearchSchema = z.object({
      query: z.string()
    });
    const agent = createAgent({
      model,
      tools: [
        tool(async ({ query }: z.infer<typeof webSearchSchema>) => `result:${query}`, {
          name: 'web_search',
          description: 'Search the web.',
          schema: webSearchSchema
        })
      ],
      systemPrompt: 'Use tools when needed.'
    });

    const run = await agent.streamEvents(
      {
        messages: [{ role: 'user', content: 'Search Agnes tool call errors.' }]
      },
      { version: 'v3' }
    );
    const toolCalls: Array<{ input: unknown; name: string; output: unknown }> = [];
    for await (const call of run.toolCalls) {
      const output = await call.output;
      toolCalls.push({
        input: await Promise.resolve(call.input),
        name: call.name,
        output: readToolOutputContent(output)
      });
    }
    const output = await run.output;

    expect(toolCalls).toEqual([
      {
        input: {
          query: 'agnes'
        },
        name: 'web_search',
        output: 'result:agnes'
      }
    ]);
    expect(output.messages.some((message) => ToolMessage.isInstance(message) && message.content === 'result:agnes')).toBe(true);
  });
});

async function createConfiguredModel(): Promise<ChatOpenAI> {
  const factory = new LangChainModelFactory(services.configService, services.secretService);
  const result = await factory.createDefaultChatModel({ streaming: true });
  return (result.model as ChatOpenAI).withConfig({
    stop: ['\n']
  }) as unknown as ChatOpenAI;
}

function configureOpenAiCompatibleProvider(input: { timeoutMs?: number } = {}): void {
  services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
  services.configService.saveProviders({
    schemaVersion: 2,
    defaultModelId: 'openai-local:qwen-local',
    providers: [
      {
        id: 'openai-local',
        name: 'OpenAI Local',
        type: 'openai_compatible',
        endpoint: 'http://127.0.0.1:8081/v1',
        credentialRef: 'secret:openai-local',
        enabled: true,
        models: [
          {
            id: 'qwen-local',
            displayName: 'Qwen Local',
            enabled: true,
            supportsStreaming: true,
            supportsToolCalls: true,
            supportsImages: false
          }
        ],
        ...(input.timeoutMs === undefined ? {} : { options: { timeoutMs: input.timeoutMs } })
      }
    ]
  });
}

function stubSingleToolCallStream(model: ChatOpenAI): void {
  const completionModel = model as unknown as {
    completions: {
      _streamResponseChunks: () => AsyncGenerator<ChatGenerationChunk>;
    };
  };

  completionModel.completions._streamResponseChunks = async function* () {
    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: '',
        additional_kwargs: {
          reasoning_content: 'Thinking'
        },
        tool_call_chunks: [
          {
            id: 'call-write',
            name: 'write_file',
            args: '{"file_path":"/workspace/hello.txt"}',
            index: 0,
            type: 'tool_call_chunk'
          }
        ]
      }),
      text: '',
      generationInfo: {}
    });
  };
}

function stubSplitToolCallStream(model: ChatOpenAI): void {
  const completionModel = model as unknown as {
    completions: {
      _streamResponseChunks: () => AsyncGenerator<ChatGenerationChunk>;
    };
  };

  completionModel.completions._streamResponseChunks = async function* () {
    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: '',
        additional_kwargs: {
          reasoning_content: 'Thinking'
        },
        tool_call_chunks: [
          {
            id: 'call-search',
            name: 'web_search',
            args: '{"query"',
            type: 'tool_call_chunk'
          }
        ]
      }),
      text: '',
      generationInfo: {}
    });
    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            args: ':"agnes"}',
            type: 'tool_call_chunk'
          }
        ]
      }),
      text: '',
      generationInfo: {}
    });
  };
}

function stubAgentModelSequence(): void {
  let callCount = 0;
  vi.spyOn(ChatOpenAICompletions.prototype, '_streamResponseChunks').mockImplementation(async function* () {
    callCount += 1;
    if (callCount === 1) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          additional_kwargs: {
            reasoning_content: 'Thinking'
          },
          tool_call_chunks: [
            {
              id: 'call-search',
              name: 'web_search',
              args: '{"query"',
              type: 'tool_call_chunk'
            }
          ]
        }),
        text: '',
        generationInfo: {}
      });
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              args: ':"agnes"}',
              type: 'tool_call_chunk'
            }
          ]
        }),
        text: '',
        generationInfo: {}
      });
      return;
    }

    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: 'Done.'
      }),
      text: 'Done.',
      generationInfo: {}
    });
  });
}

function readToolOutputContent(value: unknown): unknown {
  if (ToolMessage.isInstance(value)) {
    return value.content;
  }
  if (!isRecord(value)) {
    return value;
  }
  const kwargs = value.kwargs;
  if (!isRecord(kwargs)) {
    return value;
  }
  return kwargs.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stubOkStream(model: ChatOpenAI): unknown[] {
  const receivedMessages: unknown[] = [];
  const completionModel = model as unknown as {
    completions: {
      _streamResponseChunks: (messages: unknown[]) => AsyncGenerator<ChatGenerationChunk>;
    };
  };
  completionModel.completions._streamResponseChunks = async function* (messages) {
    receivedMessages.splice(0, receivedMessages.length, ...messages);
    yield new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: 'OK'
      }),
      text: 'OK',
      generationInfo: {}
    });
  };
  return receivedMessages;
}

function readFirstMessageContent(messages: unknown[]): unknown {
  const message = messages[0];
  if (!isRecord(message)) {
    throw new Error('Expected first message to be a record.');
  }
  return message.content;
}
