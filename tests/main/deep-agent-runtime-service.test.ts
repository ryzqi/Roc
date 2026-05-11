import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  mcpClientCloseMock: vi.fn()
}));

vi.mock('deepagents', async () => {
  const actual = await vi.importActual<typeof import('deepagents')>('deepagents');
  return {
    ...actual,
    createDeepAgent: mocked.createDeepAgentMock.mockImplementation(() => ({
      streamEvents: mocked.streamEventsMock
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
    services.agentService,
    services.workspaceService,
    services.mcpService,
    services.webReadService
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
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-deep-agent-runtime-'));
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
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
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

  it('stores selected MCP and Skill capabilities on task runs and records manifest events', async () => {
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
    mkdirSync(join(root, 'skills', 'project-review'));
    writeFileSync(
      join(root, 'skills', 'project-review', 'SKILL.md'),
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
    const skillEvent = snapshot.recentEvents.find((event) => event.type === 'skill_loaded');

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
    expect(skillEvent?.payload).toMatchObject({
      skillId: 'project-review',
      enabledBy: 'turn_selection',
      source: 'agent_capability_preview'
    });
  });

  it('mounts real web_search and web_read tools for task runs when Exa is enabled', async () => {
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
      | { tools?: Array<{ name: string; invoke: (input: unknown) => Promise<unknown> }> }
      | undefined;
    const toolNames = createAgentCall?.tools?.map((tool) => tool.name) ?? [];
    const webSearchTool = createAgentCall?.tools?.find((tool) => tool.name === 'web_search');
    const webReadTool = createAgentCall?.tools?.find((tool) => tool.name === 'web_read');

    expect(toolNames).toEqual(expect.arrayContaining(['web_search', 'web_read']));
    await expect(webSearchTool?.invoke({ query: 'langchain mcp adapters' })).resolves.toBe('Exa search results');
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
});
