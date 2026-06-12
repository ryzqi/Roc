import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
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
  vi.restoreAllMocks();
  await services.cleanup();
});

describe('OpenAI-compatible streaming normalization', () => {
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

function configureOpenAiCompatibleProvider(): void {
  services.secretService.setProviderSecret('openai-local', 'sk-openai-test');
  services.configService.saveProviders({
    schemaVersion: 1,
    defaultModelId: 'qwen-local',
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
            supportsToolCalls: true
          }
        ]
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
