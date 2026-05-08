import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { DeepAgentRuntimeService } from '../../src/main/services/deep-agent-runtime-service';
import { RocDomainError } from '../../src/main/services/errors';
import type { ChatRunEvent } from '../../src/shared/types';

const streamEventsMock = vi.fn();

vi.mock('deepagents', async () => {
  const actual = await vi.importActual<typeof import('deepagents')>('deepagents');
  return {
    ...actual,
    createDeepAgent: vi.fn(() => ({
      streamEvents: streamEventsMock
    }))
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
    services.workspaceService
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
  streamEventsMock.mockReset();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('DeepAgentRuntimeService', () => {
  it('emits message, reasoning, and completion events for a chat run', async () => {
    streamEventsMock.mockResolvedValue({
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
    streamEventsMock.mockResolvedValue({
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

  it('redacts provider failures before emitting task run failure events', async () => {
    streamEventsMock.mockRejectedValue(
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
