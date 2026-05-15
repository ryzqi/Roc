import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from '@langchain/langgraph';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { DeepAgentRuntimeService } from '../../src/main/services/deep-agent-runtime-service';
import { RocDomainError } from '../../src/main/services/errors';
import type { ChatRunEvent } from '../../src/shared/types';
import { z } from 'zod';

const mocked = vi.hoisted(() => ({
  streamEventsMock: vi.fn(),
  createDeepAgentMock: vi.fn(),
  exaSearchInvokeMock: vi.fn(),
  mcpGetToolsMock: vi.fn(),
  mcpClientCloseMock: vi.fn(),
  invokeMock: vi.fn()
}));

vi.mock('deepagents', async () => {
  const actual = await vi.importActual<typeof import('deepagents')>('deepagents');
  return {
    ...actual,
    createDeepAgent: mocked.createDeepAgentMock.mockImplementation(() => ({
      streamEvents: mocked.streamEventsMock,
      invoke: mocked.invokeMock
    }))
  };
});

vi.mock('@langchain/mcp-adapters', () => {
  class MultiServerMCPClientMock {
    getTools = mocked.mcpGetToolsMock;
    close = mocked.mcpClientCloseMock;
  }
  return {
    MultiServerMCPClient: MultiServerMCPClientMock
  };
});

function createAsyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) {
        yield value;
      }
    }
  };
}

  function createRuntime(): DeepAgentRuntimeService {
    return new DeepAgentRuntimeService(
      services.langChainModelFactory,
      services.taskService,
      services.memoryService,
      services.agentService,
      services.workspaceService,
      services.fileService,
      services.mcpService,
      services.webReadService,
      services.shellExecutionService,
      services.paths,
      {
        append: vi.fn()
      } as never
    );
  }

function waitForEvent(
  runtime: DeepAgentRuntimeService,
  predicate: (event: ChatRunEvent) => boolean
): Promise<ChatRunEvent> {
  return new Promise((resolve) => {
    let dispose = () => {};
    dispose = runtime.onRunEvent((event) => {
      if (!predicate(event)) {
        return;
      }
      dispose();
      resolve(event);
    });
  });
}

let root: string;
let userHome: string;
let previousUserProfile: string | undefined;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-deep-agent-runtime-'));
  userHome = mkdtempSync(join(tmpdir(), 'roc-user-home-'));
  previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = userHome;
  services = createAppServices(root);
  services.appService.initialize();
  services.secretService.setProviderSecret('nvidia', 'nvapi-test');
  services.configService.saveProviders({
    schemaVersion: 1,
    defaultModelId: 'moonshotai/kimi-k2.6',
    providers: [
      {
        id: 'nvidia',
        name: 'NVIDIA',
        type: 'nvidia',
        endpoint: 'https://integrate.api.nvidia.com/v1',
        credentialRef: 'secret:nvidia',
        enabled: true,
        models: [
          {
            id: 'moonshotai/kimi-k2.6',
            displayName: 'Kimi K2.6',
            enabled: true,
            supportsStreaming: true,
            supportsToolCalls: true
          }
        ],
        options: {
          thinking: true
        }
      }
    ]
  });
  vi.spyOn(services.langChainModelFactory, 'createDefaultChatModel').mockResolvedValue({
    provider: services.configService.getProviders().providers[0]!,
    modelId: 'moonshotai/kimi-k2.6',
    model: {} as never,
    runtime: {
      providerType: 'nvidia',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      streaming: true,
      modelKwargs: {
        chat_template_kwargs: {
          thinking: true
        }
      }
    }
  });
  mocked.streamEventsMock.mockReset();
  mocked.createDeepAgentMock.mockClear();
  mocked.exaSearchInvokeMock.mockReset();
  mocked.exaSearchInvokeMock.mockResolvedValue('Exa search results');
  mocked.mcpGetToolsMock.mockReset();
  mocked.mcpGetToolsMock.mockResolvedValue([
    {
      name: 'web_search_exa',
      description: 'Search the public web via Exa.',
      schema: z.object({
        query: z.string()
      }),
      invoke: mocked.exaSearchInvokeMock
    }
  ]);
  mocked.mcpClientCloseMock.mockReset();
  mocked.mcpClientCloseMock.mockResolvedValue(undefined);
  mocked.invokeMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
  vi.restoreAllMocks();
});

describe('DeepAgentRuntimeService', () => {
  it('emits message, reasoning, and completion events for a chat run', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Hello', ' world']),
          reasoning: createAsyncIterable(['thinking...'])
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    const started = await runtime.startRun({
      input: 'Reply with OK only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const finished = await completed;

    expect(started.runId).toBeTruthy();
    expect(events.map((event) => event.type)).toContain('run_started');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message_delta',
        delta: 'Hello'
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reasoning_delta',
        delta: 'thinking...'
      })
    );
    expect(finished).toMatchObject({
      type: 'run_completed',
      assistantMessage: 'Hello world',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6'
    });
  });

  it('emits reasoning deltas from reasoning_content when the standard reasoning stream is missing', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          reasoning_content: 'fallback thinking'
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with the fallback reasoning only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['fallback thinking']);
  });

  it('emits reasoning deltas from LangChain contentBlocks when the standard reasoning stream is missing', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          contentBlocks: [
            {
              type: 'text',
              text: 'should stay out of reasoning'
            },
            {
              type: 'reasoning',
              reasoning: 'content block thinking'
            }
          ]
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with the content block reasoning only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['content block thinking']);
    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'message_delta' }> => event.type === 'message_delta')
        .map((event) => event.delta)
    ).toEqual(['Final answer']);
  });

  it('emits reasoning deltas from OpenAI Responses reasoning summaries in additional kwargs', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          additional_kwargs: {
            reasoning: {
              summary: [
                {
                  type: 'summary_text',
                  text: 'summary thinking'
                }
              ]
            }
          }
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with the OpenAI reasoning summary only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['summary thinking']);
  });

  it('emits reasoning deltas from additional_kwargs reasoning_content on streamed messages', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          additional_kwargs: {
            reasoning_content: 'additional kwargs thinking'
          }
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with the provider reasoning content only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['additional kwargs thinking']);
  });

  it('emits reasoning deltas from the final message output additional_kwargs when the live reasoning stream is missing', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          output: Promise.resolve({
            additional_kwargs: {
              reasoning_content: 'trailing thinking'
            }
          })
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with trailing reasoning only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['trailing thinking']);
  });

  it('emits reasoning deltas from final message output OpenAI reasoning summaries', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          output: Promise.resolve({
            additional_kwargs: {
              reasoning: {
                summary: [
                  {
                    type: 'summary_text',
                    text: 'trailing summary thinking'
                  }
                ]
              }
            }
          })
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with trailing reasoning summary only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['trailing summary thinking']);
  });

  it('emits reasoning deltas from final message output contentBlocks', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          output: Promise.resolve({
            contentBlocks: [
              {
                type: 'text',
                text: 'plain answer block'
              },
              {
                type: 'reasoning',
                reasoning: 'trailing block thinking'
              }
            ]
          })
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with trailing content block reasoning only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['trailing block thinking']);
  });

  it('prefers the standard reasoning stream over reasoning_content fallback when both exist', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          reasoning: createAsyncIterable(['standard thinking']),
          reasoning_content: createAsyncIterable(['fallback thinking'])
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: 'Reply with the standard reasoning only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['standard thinking']);
  });

  it('extracts only explicit reasoning blocks from fallback content blocks', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Final answer']),
          content: [
            {
              type: 'text',
              text: 'should stay out of reasoning'
            },
            {
              type: 'reasoning',
              text: 'block thinking'
            }
          ]
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    const started = await runtime.startRun({
      input: 'Reply with the explicit reasoning block only.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const finished = await completed;

    expect(started.runId).toBeTruthy();
    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'reasoning_delta' }> => event.type === 'reasoning_delta')
        .map((event) => event.delta)
    ).toEqual(['block thinking']);
    expect(
      events
        .filter((event): event is Extract<ChatRunEvent, { type: 'message_delta' }> => event.type === 'message_delta')
        .map((event) => event.delta)
    ).toEqual(['Final answer']);
    expect(finished).toMatchObject({
      type: 'run_completed',
      assistantMessage: 'Final answer'
    });
  });

  it('passes skills to deepagents and keeps skill storage under the configured Roc data root', async () => {
    expect(services.paths.skillsDir).toBe(join(root, 'skills'));

    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([{ text: createAsyncIterable(['OK']) }]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');

    await runtime.startRun({
      input: 'Use the selected skill.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: ['project-review']
      }
    });
    await completed;

    const call = mocked.createDeepAgentMock.mock.calls.at(-1)?.[0] as
      | { skills?: string[]; backend?: { routePrefixes?: string[] } }
      | undefined;
    expect(call?.skills).toEqual(['/skills/project-review/']);
    expect(call?.backend?.routePrefixes).toEqual(['/skills/']);
  });

  it('sorts selected skills before passing them to deepagents', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([{ text: createAsyncIterable(['OK']) }]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');

    await runtime.startRun({
      input: 'Use the selected skills.',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: ['zeta-review', 'alpha-review']
      }
    });
    await completed;

    const call = mocked.createDeepAgentMock.mock.calls.at(-1)?.[0] as
      | { skills?: string[] }
      | undefined;
    expect(call?.skills).toEqual(['/skills/alpha-review/', '/skills/zeta-review/']);
  });

  it('stores selected MCP and Skill capabilities on task runs without claiming unloaded skills were executed', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Task complete'])
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });
    services.mcpService.upsertServer({
      id: 'docs-http',
      name: 'Docs HTTP MCP',
      transport: 'http',
      enabled: true,
      url: 'https://docs.example.test/mcp',
      preset: false,
      riskLevel: 'medium',
      allowedTools: ['search_docs']
    });
    mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
    writeFileSync(
      join(services.paths.skillsDir, 'project-review', 'SKILL.md'),
      ['---', 'name: project-review', 'description: Review a local project', '---', ''].join('\n'),
      'utf8'
    );

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');
    const started = await runtime.startRun({
      input: '用本轮能力做代码审查',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['docs-http', 'missing-mcp'],
        skills: ['project-review']
      }
    });
    await completed;

    const run = services.taskService.getRun(started.runId);
    const snapshot = services.taskService.getSnapshot();
    const manifestEvent = snapshot.recentEvents.find((event) => event.type === 'context_manifest');

    expect(run.enabledCapabilities).toEqual({
      mcpServers: ['docs-http', 'missing-mcp'],
      skills: ['project-review']
    });
    expect(snapshot.threads[0]?.status).toBe('completed');
    expect(manifestEvent?.payload).toMatchObject({
      requestedCapabilities: {
        mcpServers: ['docs-http', 'missing-mcp'],
        skills: ['project-review']
      },
      resolvedCapabilities: {
        mcpServers: ['docs-http'],
        skills: ['project-review']
      },
      skippedCapabilities: [expect.objectContaining({ id: 'missing-mcp', type: 'mcp_server', reason: 'not_found' })],
      untrustedContextPolicy: 'external_content_reference_only'
    });
    expect(snapshot.recentEvents.find((event) => event.type === 'skill_loaded')).toBeUndefined();
  });

  it('mounts real memory, web, and named subagent runtime capabilities for task runs when Exa is enabled', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Search complete'])
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);
    const candidate = services.memoryService.writeCandidate({
      type: 'knowledge_note',
      scope: 'project:roc',
      content: 'Deep Agents runtime should expose memory_search and memory_get.',
      confidence: 0.9,
      priority: 'high',
      source: 'test',
      sourceRef: 'tests/deep-agent-runtime-service'
    });
    const acceptedMemory = services.memoryService.acceptCandidate(candidate.id);
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-runtime-workspace-'));
    services.workspaceService.selectWorkspace(workspaceRoot);
    writeFileSync(join(workspaceRoot, 'runtime-note.txt'), 'runtime note\n', 'utf8');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Fetched via Jina Reader', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8'
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');
    await runtime.startRun({
      input: '搜索最新上下文并读取网页',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: []
      }
    });
    await completed;

    const createAgentCall = mocked.createDeepAgentMock.mock.calls.at(-1)?.[0] as
      | {
          backend?: {
            execute?: (command: string) => Promise<{ output: string; exitCode: number | null; truncated: boolean }>;
          };
          tools?: Array<{ name: string; invoke: (input: unknown) => Promise<unknown> }>;
          subagents?: Array<{ name: string; tools?: Array<{ name: string; invoke: (input: unknown) => Promise<unknown> }> }>;
        }
      | undefined;
    const toolNames = createAgentCall?.tools?.map((tool) => tool.name) ?? [];
    const subagentNames = createAgentCall?.subagents?.map((subagent) => subagent.name) ?? [];
    const codeReviewSubagent = createAgentCall?.subagents?.find((subagent) => subagent.name === 'code-review');
    const researchSubagent = createAgentCall?.subagents?.find((subagent) => subagent.name === 'research');
    const backend = createAgentCall?.backend as
      | {
          execute?: (command: string) => Promise<{ output: string; exitCode: number | null; truncated: boolean }>;
        }
      | undefined;
    const memorySearchTool = createAgentCall?.tools?.find((tool) => tool.name === 'memory_search');
    const memoryGetTool = createAgentCall?.tools?.find((tool) => tool.name === 'memory_get');
    const webSearchTool = createAgentCall?.tools?.find((tool) => tool.name === 'web_search');
    const webReadTool = createAgentCall?.tools?.find((tool) => tool.name === 'web_read');

    expect(toolNames).toEqual(['memory_get', 'memory_search', 'web_read', 'delete_file', 'web_search']);
    expect(toolNames).not.toContain('terminal_command');
    expect(subagentNames).toEqual(expect.arrayContaining(['code-review', 'research']));
    expect(codeReviewSubagent?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['memory_search', 'memory_get'])
    );
    expect(researchSubagent?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['web_read']));
    await expect(
      memorySearchTool?.invoke({
        query: 'Deep Agents runtime',
        source: 'curated',
        scope: 'project:roc'
      })
    ).resolves.toContain(acceptedMemory.id);
    await expect(memoryGetTool?.invoke({ id: acceptedMemory.id })).resolves.toContain(
      'Deep Agents runtime should expose memory_search and memory_get.'
    );
    await expect(webSearchTool?.invoke({ query: 'langchain mcp adapters' })).resolves.toBe('Exa search results');
    await expect(backend?.execute?.('dir')).resolves.toMatchObject({
      exitCode: 0,
      truncated: false,
      output: expect.stringContaining('runtime-note.txt')
    });
    await expect(
      webReadTool?.invoke({
        url: 'https://example.com',
        noCache: true,
        responseMode: 'markdown',
        timeoutSeconds: 8
      })
    ).resolves.toBe('Fetched via Jina Reader');
    expect(mocked.exaSearchInvokeMock).toHaveBeenCalledWith({ query: 'langchain mcp adapters' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://r.jina.ai/https://example.com/',
      expect.objectContaining({
        headers: expect.objectContaining({
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        })
      })
    );
    expect(mocked.mcpClientCloseMock).toHaveBeenCalled();
  });

  it('uses backend execute instead of mounting terminal_command for task runs', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['列出完成'])
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');
    await runtime.startRun({
      input: '列出工作区文件',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    const createAgentCall = mocked.createDeepAgentMock.mock.calls.at(-1)?.[0] as
      | {
          backend?: { execute?: (command: string) => Promise<unknown> };
          tools?: Array<{ name: string }>;
        }
      | undefined;
    const toolNames = createAgentCall?.tools?.map((tool) => tool.name) ?? [];

    expect(toolNames).not.toContain('terminal_command');
    expect(typeof createAgentCall?.backend?.execute).toBe('function');
  });

  it('records web_search and web_read tool lifecycle events in the task trace', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['已整理搜索与网页正文'])
        }
      ]),
      toolCalls: createAsyncIterable([
        {
          name: 'web_search',
          input: { query: 'roc exa mcp' },
          output: Promise.resolve('search output')
        },
        {
          name: 'web_read',
          input: { url: 'https://example.com' },
          output: Promise.resolve('page body')
        }
      ]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');
    const started = await runtime.startRun({
      input: '读取搜索结果网页',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    const snapshot = services.taskService.getSnapshot();
    const toolEvents = snapshot.recentEvents.filter(
      (event) => event.runId === started.runId && event.type === 'tool_call'
    );

    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'web_search',
            status: 'start',
            input: { query: 'roc exa mcp' }
          })
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'web_search',
            status: 'end',
            output: 'search output'
          })
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'web_read',
            status: 'start',
            input: { url: 'https://example.com' }
          })
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'web_read',
            status: 'end',
            output: 'page body'
          })
        })
      ])
    );
  });

  it('keeps MCP tool_result payloads out of assistant chat text while preserving tool audit events', async () => {
    const rawSearchPayload = '{"results":[{"title":"Exa raw result","text":"RAW_EXA_RESULT_BODY"}]}';
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable([rawSearchPayload]),
          contentBlocks: [
            {
              type: 'tool_result',
              name: 'web_search',
              content: rawSearchPayload
            }
          ]
        },
        {
          text: createAsyncIterable(['最终回答：已基于搜索结果整理。'])
        }
      ]),
      toolCalls: createAsyncIterable([
        {
          name: 'web_search',
          input: { query: 'roc exa mcp' },
          output: Promise.resolve(rawSearchPayload)
        }
      ]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });
    const started = await runtime.startRun({
      input: '搜索并总结',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const finished = await completed;

    const messageText = events
      .filter((event): event is Extract<ChatRunEvent, { type: 'message_delta' }> => event.type === 'message_delta')
      .map((event) => event.delta)
      .join('');
    const snapshot = services.taskService.getSnapshot();
    const assistantMessage = snapshot.recentEvents.find(
      (event) => event.runId === started.runId && event.type === 'message'
    );
    const toolEvent = snapshot.recentEvents.find(
      (event) =>
        event.runId === started.runId &&
        event.type === 'tool_call' &&
        (event.payload as { status?: string }).status === 'end'
    );

    expect(messageText).toBe('最终回答：已基于搜索结果整理。');
    expect(messageText).not.toContain('RAW_EXA_RESULT_BODY');
    expect(finished).toMatchObject({
      type: 'run_completed',
      assistantMessage: '最终回答：已基于搜索结果整理。'
    });
    expect(JSON.stringify(assistantMessage?.payload)).not.toContain('RAW_EXA_RESULT_BODY');
    expect(toolEvent?.payload).toMatchObject({
      name: 'web_search',
      status: 'end',
      output: rawSearchPayload
    });
  });

  it('keeps top-level server tool result messages out of assistant chat text while preserving the final answer', async () => {
    const rawSearchPayload = '{"results":[{"title":"Exa raw result","text":"RAW_EXA_RESULT_BODY"}]}';
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          type: 'server_tool_call_result',
          text: createAsyncIterable([rawSearchPayload])
        },
        {
          text: createAsyncIterable(['最终回答：已基于搜索结果整理。'])
        }
      ]),
      toolCalls: createAsyncIterable([
        {
          name: 'web_search',
          input: { query: 'roc exa mcp' },
          output: Promise.resolve(rawSearchPayload)
        }
      ]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: '搜索并总结',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const finished = await completed;

    const messageText = events
      .filter((event): event is Extract<ChatRunEvent, { type: 'message_delta' }> => event.type === 'message_delta')
      .map((event) => event.delta)
      .join('');

    expect(messageText).toBe('最终回答：已基于搜索结果整理。');
    expect(messageText).not.toContain('RAW_EXA_RESULT_BODY');
    expect(finished).toMatchObject({
      type: 'run_completed',
      assistantMessage: '最终回答：已基于搜索结果整理。'
    });
  });

  it('keeps hosted Exa text result blocks out of assistant chat text while preserving the final answer', async () => {
    const rawSearchPayload = [
      'Title: NVIDIA Corp (NVDA) | Currently at $235.74 (+4.39%) | May 14, 2026',
      'URL: https://finance.yahoo.com/quote/NVDA/',
      'Published: 2026-05-15T09:50:39.199Z',
      'Author: N/A',
      'Highlights:',
      '',
      'RAW_EXA_RESULT_BODY'
    ].join('\n');
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable([rawSearchPayload]),
          content: [
            {
              type: 'text',
              text: rawSearchPayload
            }
          ]
        },
        {
          text: createAsyncIterable(['最终回答：已基于搜索结果整理。'])
        }
      ]),
      toolCalls: createAsyncIterable([
        {
          name: 'web_search',
          input: { query: 'NVDA stock price' },
          output: Promise.resolve(rawSearchPayload)
        }
      ]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });

    await runtime.startRun({
      input: '搜索并总结 NVDA 当前股价',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: []
      }
    });
    const finished = await completed;

    const messageText = events
      .filter((event): event is Extract<ChatRunEvent, { type: 'message_delta' }> => event.type === 'message_delta')
      .map((event) => event.delta)
      .join('');

    expect(messageText).toBe('最终回答：已基于搜索结果整理。');
    expect(messageText).not.toContain('RAW_EXA_RESULT_BODY');
    expect(finished).toMatchObject({
      type: 'run_completed',
      assistantMessage: '最终回答：已基于搜索结果整理。'
    });
  });

  it('keeps Skill raw instruction blocks out of assistant chat text', async () => {
    const rawSkillContent = '---\nname: project-review\ndescription: RAW_SKILL_DESCRIPTION\n---\n# Project Review';
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable([rawSkillContent]),
          additional_kwargs: {
            content_blocks: [
              {
                type: 'skill_loaded',
                name: 'project-review',
                path: '/skills/project-review/SKILL.md',
                content: rawSkillContent
              }
            ]
          }
        },
        {
          text: createAsyncIterable(['最终回答：已按技能完成审查。'])
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const events: ChatRunEvent[] = [];
    const completed = waitForEvent(runtime, (event) => {
      events.push(event);
      return event.type === 'run_completed';
    });
    const started = await runtime.startRun({
      input: '按项目审查技能处理',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: ['project-review']
      }
    });
    const finished = await completed;

    const messageText = events
      .filter((event): event is Extract<ChatRunEvent, { type: 'message_delta' }> => event.type === 'message_delta')
      .map((event) => event.delta)
      .join('');
    const snapshot = services.taskService.getSnapshot();
    const assistantMessage = snapshot.recentEvents.find(
      (event) => event.runId === started.runId && event.type === 'message'
    );

    expect(messageText).toBe('最终回答：已按技能完成审查。');
    expect(messageText).not.toContain('RAW_SKILL_DESCRIPTION');
    expect(finished).toMatchObject({
      type: 'run_completed',
      assistantMessage: '最终回答：已按技能完成审查。'
    });
    expect(JSON.stringify(assistantMessage?.payload)).not.toContain('RAW_SKILL_DESCRIPTION');
  });

  it('passes the agent interrupt policy into deepagents for task runs', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([{ text: createAsyncIterable(['ok']) }]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });
    services.configService.savePermissions({
      schemaVersion: 3,
      mode: 'default',
      grants: []
    });
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');
    await runtime.startRun({
      input: '执行需要审批的任务',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['exa-hosted'],
        skills: []
      }
    });
    await completed;

    const call = mocked.createDeepAgentMock.mock.calls.at(-1)?.[0] as
      | {
          interruptOn?: Record<string, unknown>;
          checkpointer?: unknown;
        }
      | undefined;

    expect(call?.interruptOn).toMatchObject({
      delete_file: true
    });
    expect(call?.interruptOn).toMatchObject({
      web_search: true
    });
    expect(call?.checkpointer).toBeTruthy();
  });

  it('passes Anthropic prompt cache TTL only for task-mode runs', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([{ text: createAsyncIterable(['ok']) }]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });
    services.secretService.setProviderSecret('anthropic-local', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-sonnet-4-5',
      providers: [
        {
          id: 'anthropic-local',
          name: 'Anthropic Local',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test/v1/messages',
          credentialRef: 'secret:anthropic-local',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-5',
              displayName: 'Claude Sonnet 4.5',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });
    vi.spyOn(services.langChainModelFactory, 'createDefaultChatModel').mockRestore();

    const createDefaultChatModelSpy = vi.spyOn(services.langChainModelFactory, 'createDefaultChatModel');
    const createChatModelByModelIdSpy = vi.spyOn(services.langChainModelFactory, 'createChatModelByModelId');
    const runtime = createRuntime();

    const chatCompleted = waitForEvent(runtime, (event) => event.type === 'run_completed');
    await runtime.startRun({
      input: 'chat mode',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await chatCompleted;

    const taskCompleted = waitForEvent(runtime, (event) => event.type === 'run_completed');
    await runtime.startRun({
      input: 'task mode',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await taskCompleted;

    mocked.streamEventsMock.mockResolvedValueOnce({
      messages: createAsyncIterable([]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      interrupted: true,
      interrupts: [
        {
          interruptId: 'interrupt-task-cache-ttl',
          payload: {
            actionRequests: [
              {
                name: 'execute',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          }
        }
      ],
      output: Promise.resolve({
        interrupted: true
      })
    });
    mocked.streamEventsMock.mockResolvedValueOnce({
      messages: createAsyncIterable([{ text: createAsyncIterable(['resumed']) }]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const interrupted = waitForEvent(runtime, (event) => event.type === 'run_interrupted');
    await runtime.startRun({
      input: 'interrupt me',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const interruption = await interrupted as Extract<ChatRunEvent, { type: 'run_interrupted' }>;
    const resumed = waitForEvent(runtime, (event) => event.type === 'run_completed' && event.runId === interruption.runId);
    await runtime.resumeRun({
      runId: interruption.runId,
      threadId: interruption.threadId as string,
      interruptId: interruption.interruptId,
      decision: {
        type: 'approve'
      }
    });
    await resumed;

    expect(createDefaultChatModelSpy.mock.calls[0]?.[0]).toEqual({ streaming: true });
    expect(createDefaultChatModelSpy.mock.calls[1]?.[0]).toEqual({ streaming: true, cacheTtl: '1h' });
    expect(createChatModelByModelIdSpy.mock.calls.at(-1)?.[1]).toEqual({ streaming: true, cacheTtl: '1h' });
  });

  it('maps global default approval mode into interruptOn without affecting execute or web_read', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([{ text: createAsyncIterable(['ok']) }]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });
    services.configService.savePermissions({
      schemaVersion: 3,
      mode: 'default',
      grants: []
    });
    services.mcpService.upsertServer({
      id: 'docs-http',
      name: 'Docs HTTP MCP',
      transport: 'http',
      enabled: true,
      url: 'https://docs.example.test/mcp',
      preset: false,
      riskLevel: 'medium',
      allowedTools: ['search_docs']
    });

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');
    await runtime.startRun({
      input: '执行不需要 MCP 审批的任务',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['docs-http'],
        skills: []
      }
    });
    await completed;

    const call = mocked.createDeepAgentMock.mock.calls.at(-1)?.[0] as
      | {
          interruptOn?: Record<string, unknown>;
        }
      | undefined;

    expect(call?.interruptOn).toEqual({
      delete_file: true,
      search_docs: true
    });
  });

  it('records approval requests and moves the task thread into waiting_user when the agent interrupts', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      interrupted: true,
      interrupts: [
        {
          interruptId: 'interrupt-1',
          payload: {
            actionRequests: [
              {
                name: 'execute',
                args: {
                  command: 'git status'
                },
                description: '请确认执行命令'
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          }
        }
      ],
      output: Promise.resolve({
        interrupted: true
      })
    });

    const runtime = createRuntime();
    const interrupted = waitForEvent(runtime, (event) => event.type === 'run_interrupted');
    const started = await runtime.startRun({
      input: '执行 git status',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const event = await interrupted;
    const snapshot = services.taskService.getSnapshot();
    const approvalEvent = snapshot.recentEvents.find(
      (candidate) => candidate.runId === started.runId && candidate.type === 'approval_requested'
    );

    expect(event).toMatchObject({
      type: 'run_interrupted',
      runId: started.runId,
      threadId: started.threadId
    });
    expect(snapshot.threads[0]?.status).toBe('waiting_user');
    expect(approvalEvent?.payload).toMatchObject({
      interruptId: 'interrupt-1',
      actionRequests: [
        expect.objectContaining({
          name: 'execute',
          args: {
            command: 'git status'
          }
        })
      ],
      reviewConfigs: [
        expect.objectContaining({
          actionName: 'execute',
          allowedDecisions: ['approve', 'reject']
        })
      ]
    });
  });

  it('resumes the interrupted task run on the same thread via Command({ resume })', async () => {
    mocked.streamEventsMock.mockResolvedValueOnce({
      messages: createAsyncIterable([]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      interrupted: true,
      interrupts: [
        {
          interruptId: 'interrupt-2',
          payload: {
            actionRequests: [
              {
                name: 'execute',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
                allowedDecisions: ['approve', 'edit', 'reject']
              }
            ]
          }
        }
      ],
      output: Promise.resolve({
        interrupted: true
      })
    });
    mocked.invokeMock.mockResolvedValue({
      messages: [{ role: 'assistant', content: '已继续执行' }]
    });

    const runtime = createRuntime();
    const interrupted = waitForEvent(runtime, (event) => event.type === 'run_interrupted');
    const started = await runtime.startRun({
      input: '执行 git status',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await interrupted;
    expect(started.threadId).toBeTruthy();

    await expect(
      runtime.resumeRun({
        runId: started.runId,
        threadId: started.threadId as string,
        decision: {
          type: 'approve'
        }
      })
    ).resolves.toMatchObject({
      runId: started.runId,
      threadId: started.threadId
    });

    const resumeInput = mocked.streamEventsMock.mock.calls.at(-1)?.[0];
    const resumeConfig = mocked.streamEventsMock.mock.calls.at(-1)?.[1] as
      | {
          configurable?: {
            thread_id?: string;
            run_id?: string;
          };
        }
      | undefined;
    const snapshot = services.taskService.getSnapshot();
    const decisionEvent = snapshot.recentEvents.find(
      (candidate) => candidate.runId === started.runId && candidate.type === 'approval_decision'
    );

    expect(resumeInput).toBeInstanceOf(Command);
    expect(resumeConfig?.configurable?.thread_id).toBe(started.threadId);
    expect(decisionEvent?.payload).toMatchObject({
      interruptId: 'interrupt-2',
      decision: {
        type: 'approve'
      }
    });
  });

  it('resumes an interrupted task run even after the in-memory active run context is gone', async () => {
    mocked.streamEventsMock
      .mockResolvedValueOnce({
        messages: createAsyncIterable([]),
        toolCalls: createAsyncIterable([]),
        subagents: createAsyncIterable([]),
        interrupted: true,
        interrupts: [
          {
            interruptId: 'interrupt-resume-after-eviction',
            payload: {
              actionRequests: [
                {
                  name: 'execute',
                  args: {
                    command: 'git status'
                  }
                }
              ],
              reviewConfigs: [
                {
                  actionName: 'execute',
                  allowedDecisions: ['approve', 'reject']
                }
              ]
            }
          }
        ],
        output: Promise.resolve({
          interrupted: true
        })
      })
      .mockResolvedValueOnce({
        messages: createAsyncIterable([
          {
            text: createAsyncIterable(['已恢复并继续执行'])
          }
        ]),
        toolCalls: createAsyncIterable([]),
        subagents: createAsyncIterable([]),
        output: Promise.resolve({})
      });

    const runtime = createRuntime();
    const interrupted = waitForEvent(runtime, (event) => event.type === 'run_interrupted');
    const started = await runtime.startRun({
      input: '执行 git status',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await interrupted;

    const activeRuns = Reflect.get(runtime as object, 'activeRuns') as Map<string, unknown>;
    activeRuns.delete(started.runId);

    await expect(
      runtime.resumeRun({
        runId: started.runId,
        threadId: started.threadId as string,
        interruptId: 'interrupt-resume-after-eviction',
        decision: {
          type: 'approve'
        }
      })
    ).resolves.toMatchObject({
      runId: started.runId,
      threadId: started.threadId
    });

    const resumeInput = mocked.streamEventsMock.mock.calls.at(-1)?.[0];
    const resumeConfig = mocked.streamEventsMock.mock.calls.at(-1)?.[1] as
      | {
          configurable?: {
            thread_id?: string;
            run_id?: string;
          };
        }
      | undefined;

    expect(resumeInput).toBeInstanceOf(Command);
    expect(resumeConfig?.configurable).toMatchObject({
      thread_id: started.threadId,
      run_id: started.runId
    });
  });

  it('rejects resume when the provided interrupt id does not match the pending approval', async () => {
    mocked.streamEventsMock.mockResolvedValueOnce({
      messages: createAsyncIterable([]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      interrupted: true,
      interrupts: [
        {
          interruptId: 'interrupt-expected',
          payload: {
            actionRequests: [
              {
                name: 'execute',
                args: {
                  command: 'git status'
                }
              }
            ],
            reviewConfigs: [
              {
                actionName: 'execute',
                allowedDecisions: ['approve', 'reject']
              }
            ]
          }
        }
      ],
      output: Promise.resolve({
        interrupted: true
      })
    });

    const runtime = createRuntime();
    const interrupted = waitForEvent(runtime, (event) => event.type === 'run_interrupted');
    const started = await runtime.startRun({
      input: '执行 git status',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await interrupted;

    await expect(
      runtime.resumeRun({
        runId: started.runId,
        threadId: started.threadId as string,
        interruptId: 'interrupt-unexpected',
        decision: {
          type: 'approve'
        }
      })
    ).rejects.toMatchObject({
      code: 'chat_resume_interrupt_mismatch',
      message: '恢复运行时的审批中断 ID 与待处理审批不匹配。'
    });
  });

  it('continues a selected task thread instead of creating a new thread for the next turn', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['第二轮已完成'])
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const firstRun = services.taskService.createTaskRun({
      userInput: '第一轮输入',
      modelId: 'moonshotai/kimi-k2.6',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed' && event.threadId === firstRun.threadId);
    const started = await runtime.startRun({
      input: '第二轮输入',
      mode: 'task',
      threadId: firstRun.threadId,
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    const snapshot = services.taskService.getSnapshot();
    const userMessages = snapshot.recentEvents
      .filter((event) => event.threadId === firstRun.threadId && event.type === 'message')
      .map((event) => (event.payload as { role: string; content: string }).content);

    expect(started.threadId).toBe(firstRun.threadId);
    expect(snapshot.threads).toHaveLength(1);
    expect(services.taskService.getRun(started.runId).runNumber).toBe(2);
    expect(userMessages).toEqual(expect.arrayContaining(['第一轮输入', '第二轮输入']));
  });

  it('redacts provider failures before emitting task run failure events', async () => {
    mocked.streamEventsMock.mockRejectedValue(
      new RocDomainError({
        code: 'provider_http_error',
        message: 'Provider 请求失败：Authorization: Bearer sk-secret-value',
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络和凭据。'
      })
    );

    const runtime = createRuntime();
    const failed = waitForEvent(runtime, (event) => event.type === 'run_failed');
    const started = await runtime.startRun({
      input: '触发 provider 失败',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    const result = await failed;
    const snapshot = services.taskService.getSnapshot();
    const errorEvent = snapshot.recentEvents.find((event) => event.type === 'error');

    expect(started.runId).toBeTruthy();
    expect(result).toMatchObject({
      type: 'run_failed',
      code: 'provider_http_error',
      message: 'Provider 请求失败：[REDACTED]',
      retryable: true
    });
    expect(snapshot.threads[0]?.status).toBe('failed');
    expect(errorEvent?.payload).toMatchObject({
      code: 'provider_http_error',
      message: 'Provider 请求失败：[REDACTED]',
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2.6'
    });
    expect(JSON.stringify(errorEvent?.payload)).not.toContain('sk-secret-value');
  });

  it('retries retryable provider request failures before completing a chat run', async () => {
    vi.useFakeTimers();
    mocked.streamEventsMock
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockResolvedValueOnce({
        messages: createAsyncIterable([
          {
            text: createAsyncIterable(['Retry success'])
          }
        ]),
        toolCalls: createAsyncIterable([]),
        subagents: createAsyncIterable([]),
        output: Promise.resolve({})
      });

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');

    await runtime.startRun({
      input: '请在重试后完成',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await vi.runAllTimersAsync();
    const result = await completed;

    expect(mocked.streamEventsMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      type: 'run_completed',
      assistantMessage: 'Retry success'
    });
  });

  it('records provider usage including prompt cache fields on completed task runs', async () => {
    mocked.streamEventsMock.mockResolvedValue({
      messages: createAsyncIterable([
        {
          text: createAsyncIterable(['Cached answer']),
          usage_metadata: {
            input_tokens: 1200,
            output_tokens: 40,
            total_tokens: 1240,
            input_token_details: {
              cache_read: 900,
              cache_creation: 120
            }
          }
        }
      ]),
      toolCalls: createAsyncIterable([]),
      subagents: createAsyncIterable([]),
      output: Promise.resolve({})
    });

    const runtime = createRuntime();
    const completed = waitForEvent(runtime, (event) => event.type === 'run_completed');
    const started = await runtime.startRun({
      input: '统计缓存命中',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await completed;

    const snapshot = services.taskService.getSnapshot();
    const usageEvent = snapshot.recentEvents.find(
      (event) => event.runId === started.runId && event.type === 'agent_update'
    );

    expect(usageEvent?.payload).toMatchObject({
      usage: {
        promptTokens: 1200,
        completionTokens: 40,
        totalTokens: 1240,
        cacheReadTokens: 900,
        cacheCreationTokens: 120
      }
    });
  });

  it('emits the final retryable failure after exhausting provider request retries', async () => {
    vi.useFakeTimers();
    mocked.streamEventsMock.mockRejectedValue({
      status: 500,
      message: 'upstream failed'
    });

    const runtime = createRuntime();
    const failed = waitForEvent(runtime, (event) => event.type === 'run_failed');

    await runtime.startRun({
      input: '持续失败',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await vi.runAllTimersAsync();
    const result = await failed;

    expect(mocked.streamEventsMock).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      type: 'run_failed',
      code: 'provider_http_error',
      message: 'Provider 返回 HTTP 500。',
      retryable: true
    });
  });

  it('cancels immediately while waiting to retry a provider request', async () => {
    vi.useFakeTimers();
    mocked.streamEventsMock.mockRejectedValue(new Error('fetch failed'));

    const runtime = createRuntime();
    const failed = waitForEvent(runtime, (event) => event.type === 'run_failed');

    const started = await runtime.startRun({
      input: '取消重试等待',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    await Promise.resolve();

    expect(runtime.cancelRun(started.runId)).toEqual({
      runId: started.runId,
      cancelled: true
    });

    await vi.runAllTimersAsync();
    const result = await failed;

    expect(mocked.streamEventsMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      type: 'run_failed',
      code: 'chat_run_cancelled',
      message: '当前运行已取消。',
      retryable: true
    });
  });
});
