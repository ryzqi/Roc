import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { RocDomainError, wrapIpc } from '../../src/main/services/errors';

let root: string;
let services: AppServices;

type CapturedProviderRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  rawBody: string;
  body: unknown;
};

type FakeProvider = {
  endpoint: string;
  requests: CapturedProviderRequest[];
  close: () => Promise<void>;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', rejectBody);
    request.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function startFakeProvider(responseBody: unknown, statusCode: number): Promise<FakeProvider> {
  const requests: CapturedProviderRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const rawBody = await readBody(request);
      const parsedBody = rawBody.length === 0 ? null : (JSON.parse(rawBody) as unknown);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        rawBody,
        body: parsedBody
      });
      response.statusCode = statusCode;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(responseBody));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'fake provider request failed'
        })
      );
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake provider did not expose a TCP address.');
  }
  const tcpAddress = address as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${tcpAddress.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      })
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-test-'));
  services = createAppServices(root);
  services.appService.initialize();
  services.providerRuntimeService.setDeterministicResponse({
    content: 'Provider runtime 测试回复。',
    finishReason: 'stop',
    promptTokens: 8,
    completionTokens: 6
  });
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Roc foundation services', () => {
  it('creates the .roc directory tree and config files', () => {
    expect(existsSync(join(root, 'config', 'settings.json'))).toBe(true);
    expect(existsSync(join(root, 'config', 'providers.json'))).toBe(true);
    expect(existsSync(join(root, 'config', 'mcp.servers.json'))).toBe(true);
    expect(existsSync(join(root, 'memory', 'hot', 'hot_memory.md'))).toBe(true);
    expect(existsSync(join(root, 'tasks', 'recovery'))).toBe(true);
    expect(existsSync(join(root, 'rtk', 'tee'))).toBe(true);
  });

  it('initializes SQLite with WAL and required first-wave tables', () => {
    const journalMode = services.databaseService.db.pragma('journal_mode', { simple: true });
    expect(String(journalMode).toLocaleLowerCase()).toBe('wal');

    const rows = services.databaseService.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((row) => row.name);

    expect(tableNames).toContain('task_threads');
    expect(tableNames).toContain('task_events');
    expect(tableNames).toContain('memory_entries_index');
    expect(tableNames).toContain('memory_candidates');
    expect(tableNames).toContain('memory_conflicts');
    expect(tableNames).toContain('memory_operations');
    expect(tableNames).toContain('mcp_servers');
    expect(tableNames).toContain('skills');
    expect(tableNames).toContain('doctor_findings');
  });

  it('returns a real empty task snapshot from SQLite', () => {
    const snapshot = services.taskService.getSnapshot();

    expect(snapshot.counts.total).toBe(0);
    expect(snapshot.counts.running).toBe(0);
    expect(snapshot.counts.failed).toBe(0);
    expect(snapshot.counts.pendingConfirmation).toBe(0);
    expect(snapshot.threads).toEqual([]);
    expect(snapshot.recentEvents).toEqual([]);
  });

  it('reports workspace state separately from the Roc data root', () => {
    const status = services.appService.getStatus();

    expect(status.workspace).toEqual({
      selectedPath: null,
      label: '未选择工作区'
    });
    expect(status.paths.root).toBe(root);
  });

  it('keeps Markdown as memory truth source and records accepted candidate writes', () => {
    const entry = services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户偏好把关键配置缺失视为显式错误。',
      confidence: 1,
      priority: 'high',
      source: 'user_explicit',
      sourceRef: 'test'
    });
    const accepted = services.memoryService.acceptCandidate(entry.id);

    const status = services.memoryService.status();
    const search = services.memoryService.search({ query: '关键配置' });
    const content = services.memoryService.get(accepted.id);
    const operationLog = readFileSync(join(root, 'logs', 'memory_operations.log'), 'utf8');

    expect(status.truthSource).toBe('markdown');
    expect(status.indexSource).toBe('sqlite');
    expect(status.vectorIndex.status).toBe('not_configured');
    expect(status.fullTextIndex.status).toBe('ready');
    expect(search.degraded).toBe(true);
    expect(search.items[0]).toMatchObject({
      id: accepted.id,
      layer: 'hot',
      scope: 'global',
      sourceRef: 'test'
    });
    expect(content).toContain('关键配置缺失');
    expect(operationLog).toContain('candidate_write');
    expect(operationLog).toContain('candidate_accept');
  });

  it('tracks candidate state, detects conflicts, and keeps unresolved candidates out of normal recall', () => {
    const activeCandidate = services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户喜欢简短回复。',
      confidence: 1,
      priority: 'high',
      source: 'user_explicit',
      sourceRef: 'test:active'
    });
    const active = services.memoryService.acceptCandidate(activeCandidate.id);
    const conflicting = services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户不喜欢简短回复。',
      confidence: 0.7,
      priority: 'high',
      source: 'agent_extract:session-1',
      sourceRef: 'session-1'
    });

    const candidates = services.memoryService.listCandidates();
    const conflicts = services.memoryService.listConflicts();
    const search = services.memoryService.search({ query: '不喜欢简短' });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        id: conflicting.id,
        state: 'conflict_detected',
        conflictCount: 1,
        suggestedAction: 'review_conflict'
      })
    );
    expect(conflicts).toContainEqual(
      expect.objectContaining({
        candidateId: conflicting.id,
        activeMemoryId: active.id,
        type: 'preference',
        scope: 'global',
        status: 'open'
      })
    );
    expect(search.items.some((item) => item.id === conflicting.id)).toBe(false);
  });

  it('writes and searches session recall without promoting it to curated memory', () => {
    const recall = services.memoryService.writeSessionRecall({
      sessionId: 'session-phase4',
      title: 'Phase 4 记忆设计讨论',
      summary: '讨论候选记忆中心、会话回忆和恢复链。',
      scope: 'project:roc',
      content: '本次会话明确删除单条记忆要走可恢复链，并且会话回忆不能自动晋升为策展记忆。',
      sourceRef: 'test-session'
    });

    const sessionSearch = services.memoryService.sessionSearch({ query: '恢复链', scope: 'project:roc' });
    const memorySearch = services.memoryService.search({ query: '恢复链', source: 'session', scope: 'project:roc' });
    const candidates = services.memoryService.listCandidates();
    const operationLog = readFileSync(join(root, 'logs', 'memory_operations.log'), 'utf8');

    expect(recall).toMatchObject({
      id: 'session-phase4',
      scope: 'project:roc',
      sourceRef: 'test-session'
    });
    expect(sessionSearch.items).toEqual([
      expect.objectContaining({
        id: 'session-phase4',
        title: 'Phase 4 记忆设计讨论',
        scope: 'project:roc',
        sourceRef: 'test-session'
      })
    ]);
    expect(memorySearch.items).toEqual([
      expect.objectContaining({
        id: 'session-phase4',
        layer: 'session',
        scope: 'project:roc',
        sourceRef: 'test-session'
      })
    ]);
    expect(candidates.some((candidate) => candidate.sourceRef === 'test-session')).toBe(false);
    expect(operationLog).toContain('session_recall_write');
  });

  it('deletes and restores active memory with audit records', () => {
    const candidate = services.memoryService.writeCandidate({
      type: 'project_context',
      scope: 'project:roc',
      content: 'Roc Phase 4 正在实现记忆系统核心闭环。',
      confidence: 0.9,
      priority: 'medium',
      source: 'user_explicit',
      sourceRef: 'test-delete-restore'
    });
    const active = services.memoryService.acceptCandidate(candidate.id);

    const deleted = services.memoryService.deleteMemory(active.id);
    const afterDelete = services.memoryService.search({ query: '核心闭环', scope: 'project:roc' });
    const restored = services.memoryService.restoreMemory(active.id);
    const afterRestore = services.memoryService.search({ query: '核心闭环', scope: 'project:roc' });
    const operationLog = readFileSync(join(root, 'logs', 'memory_operations.log'), 'utf8');

    expect(deleted).toMatchObject({
      id: active.id,
      status: 'archived',
      recoverable: true
    });
    expect(afterDelete.items.some((item) => item.id === active.id)).toBe(false);
    expect(restored).toMatchObject({
      id: active.id,
      status: 'active',
      recoverable: false
    });
    expect(afterRestore.items).toContainEqual(
      expect.objectContaining({
        id: active.id,
        layer: 'warm',
        scope: 'project:roc'
      })
    );
    expect(operationLog).toContain('memory_delete');
    expect(operationLog).toContain('memory_restore');
  });

  it('reports blocked agent state until default model is configured', () => {
    const status = services.agentService.getStatus();

    expect(status.deepAgentsPackage).toBe('available');
    expect(status.defaultModelConfigured).toBe(false);
    expect(status.memoryAccess).toBe('memory_service_only');
    expect(status.execution).toBe('blocked_until_provider_configured');
  });

  it('validates explicit default model selection from enabled provider models', () => {
    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    });

    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-disabled',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'credential:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-disabled',
              displayName: 'Disabled model',
              enabled: false,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'invalid',
      modelId: 'model-disabled',
      providerId: 'provider-openai',
      reason: '默认模型未启用。'
    });

    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'credential:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-ready',
              displayName: 'Ready model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'model-ready',
      providerId: 'provider-openai',
      reason: '默认模型可用。'
    });
  });

  it('exposes Deep Agents config preview without running a model', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'credential:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-ready',
              displayName: 'Ready model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const status = services.agentService.getStatus();
    const preview = services.agentService.getDeepAgentConfigPreview();

    expect(status.execution).toBe('ready');
    expect(status.deepAgentsApi.createDeepAgent).toBe(true);
    expect(preview).toEqual({
      runnable: false,
      model: 'model-ready',
      memoryAccess: 'memory_service_only',
      builtInTools: ['write_todos', 'task', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
      rocTools: ['memory_search', 'memory_get'],
      todoMapping: {
        sourceTool: 'write_todos',
        target: 'task_steps'
      },
      interruptOn: {
        write_file: true,
        edit_file: true,
        terminal_command: true,
        git_operation: true
      },
      reason: 'W2 只装配配置预览，不执行 Deep Agents run。'
    });
  });

  it('blocks chat without a valid default model and executes configured Provider chat and task first turn', async () => {
    await expect(
      services.chatService.submit({
        input: '帮我整理这个项目',
        mode: 'task',
        enabledCapabilities: {
          mcpServers: ['exa'],
          skills: ['project-review']
        }
      })
    ).rejects.toThrow('未配置默认模型。');

    services.providerRuntimeService.setDeterministicResponse({
      content: 'Provider runtime 已生成首轮回复。',
      finishReason: 'stop',
      promptTokens: 12,
      completionTokens: 8
    });
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'credential:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-ready',
              displayName: 'Ready model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const plainChat = await services.chatService.submit({
      input: '解释 Roc 当前状态',
      mode: 'chat',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });

    expect(plainChat).toMatchObject({
      status: 'answered',
      providerId: 'provider-openai',
      modelId: 'model-ready',
      assistantMessage: 'Provider runtime 已生成首轮回复。'
    });

    const chat = await services.chatService.submit({
      input: '检查当前项目并给出计划',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['exa'],
        skills: ['project-review']
      }
    });
    if (chat.status !== 'task_answered') {
      throw new Error(`Expected task_answered, received ${chat.status}`);
    }
    const snapshot = services.taskService.getSnapshot();
    const run = services.taskService.getRun(chat.runId);

    expect(chat).toMatchObject({
      status: 'task_answered',
      modelId: 'model-ready',
      providerId: 'provider-openai',
      assistantMessage: 'Provider runtime 已生成首轮回复。'
    });
    expect(snapshot.counts.total).toBe(1);
    expect(snapshot.threads[0]?.id).toBe(chat.threadId);
    expect(snapshot.threads[0]?.status).toBe('completed');
    expect(snapshot.recentEvents.some((event) => event.type === 'message')).toBe(true);
    expect(snapshot.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent_update',
          payload: expect.objectContaining({
            providerId: 'provider-openai',
            modelId: 'model-ready',
            finishReason: 'stop'
          })
        }),
        expect.objectContaining({
          type: 'message',
          payload: expect.objectContaining({
            role: 'assistant',
            content: 'Provider runtime 已生成首轮回复。'
          })
        })
      ])
    );
    expect(run).toMatchObject({
      id: chat.runId,
      threadId: chat.threadId,
      userInput: '检查当前项目并给出计划',
      modelId: 'model-ready',
      enabledCapabilities: {
        mcpServers: ['exa'],
        skills: ['project-review']
      },
      status: 'completed'
    });
  });

  it('returns unsupported Provider execution errors without pretending success', async () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'anthropic-model',
      providers: [
        {
          id: 'provider-anthropic',
          name: 'Anthropic compatible',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'credential:provider-anthropic',
          enabled: true,
          models: [
            {
              id: 'anthropic-model',
              displayName: 'Anthropic model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const result = await wrapIpc(() =>
      services.chatService.submit({
        input: '测试不支持的 provider',
        mode: 'chat',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      })
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'provider_type_unsupported',
        message: '当前 Provider 类型尚未支持聊天执行。',
        category: 'external',
        retryable: false,
        userAction: '请先使用 OpenAI-compatible Provider，或等待后续 Provider 映射支持。'
      }
    });
  });

  it('redacts Provider failures and records failed task execution events', async () => {
    services.providerRuntimeService.setDeterministicFailure(
      new RocDomainError({
        code: 'provider_http_error',
        message: 'Provider 请求失败：Authorization: Bearer sk-secret-value',
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络和凭据。'
      })
    );
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'credential:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-ready',
              displayName: 'Ready model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const result = await wrapIpc(() =>
      services.chatService.submit({
        input: '触发 provider 失败',
        mode: 'task',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      })
    );
    const snapshot = services.taskService.getSnapshot();
    const failedThread = snapshot.threads.find((thread) => thread.goal === '触发 provider 失败');
    const errorEvent = snapshot.recentEvents.find((event) => event.type === 'error');

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'provider_http_error',
        message: 'Provider 请求失败：[REDACTED]',
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络和凭据。'
      }
    });
    expect(failedThread?.status).toBe('failed');
    expect(errorEvent?.payload).toMatchObject({
      code: 'provider_http_error',
      message: 'Provider 请求失败：[REDACTED]',
      providerId: 'provider-openai',
      modelId: 'model-ready'
    });
    expect(JSON.stringify(errorEvent?.payload)).not.toContain('sk-secret-value');
  });

  it('executes OpenAI-compatible live chat completions through an env credentialRef', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Live provider fake response.'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 5,
          total_tokens: 26
        }
      },
      200
    );
    const previousApiKey = process.env.ROC_TEST_PROVIDER_API_KEY;
    process.env.ROC_TEST_PROVIDER_API_KEY = 'sk-live-test-secret';

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'live-model',
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'env:ROC_TEST_PROVIDER_API_KEY',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await liveServices.chatService.submit({
        input: '请调用 live provider',
        mode: 'chat',
        enabledCapabilities: {
          mcpServers: ['docs-http'],
          skills: ['project-review']
        }
      });

      expect(result).toMatchObject({
        status: 'answered',
        providerId: 'provider-live-openai',
        modelId: 'live-model',
        assistantMessage: 'Live provider fake response.'
      });
      expect(fakeProvider.requests).toHaveLength(1);
      expect(fakeProvider.requests[0]).toMatchObject({
        method: 'POST',
        url: '/v1/chat/completions',
        authorization: 'Bearer sk-live-test-secret'
      });
      expect(fakeProvider.requests[0]?.body).toMatchObject({
        model: 'live-model',
        stream: false,
        messages: [
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('tools_not_invoked=true')
          }),
          expect.objectContaining({
            role: 'user',
            content: '请调用 live provider'
          })
        ]
      });
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      if (previousApiKey === undefined) {
        delete process.env.ROC_TEST_PROVIDER_API_KEY;
      } else {
        process.env.ROC_TEST_PROVIDER_API_KEY = previousApiKey;
      }
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsupported live credential refs without sending a Provider request', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'This response should not be requested.'
            },
            finish_reason: 'stop'
          }
        ]
      },
      200
    );

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'live-model',
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'credential:provider-live-openai',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await wrapIpc(() =>
        liveServices.chatService.submit({
          input: '不应发出 live 请求',
          mode: 'chat',
          enabledCapabilities: {
            mcpServers: [],
            skills: []
          }
        })
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'provider_credential_ref_unsupported',
          message: '当前 live Provider 只支持 env:VAR_NAME 凭据引用。',
          category: 'validation',
          retryable: false,
          userAction: '请把 Provider 凭据引用配置为 env:VAR_NAME，或等待后续安全凭据存储支持。'
        }
      });
      expect(fakeProvider.requests).toHaveLength(0);
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('fails live Provider calls when credentialRef is missing or env credential is unavailable', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'This response should not be requested.'
            },
            finish_reason: 'stop'
          }
        ]
      },
      200
    );
    const previousApiKey = process.env.ROC_TEST_PROVIDER_API_KEY;
    delete process.env.ROC_TEST_PROVIDER_API_KEY;

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'live-model',
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: null,
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const missingRef = await wrapIpc(() =>
        liveServices.chatService.submit({
          input: '缺少 credentialRef',
          mode: 'chat',
          enabledCapabilities: {
            mcpServers: [],
            skills: []
          }
        })
      );

      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'live-model',
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'env:ROC_TEST_PROVIDER_API_KEY',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });
      const missingEnv = await wrapIpc(() =>
        liveServices.chatService.submit({
          input: '缺少 env secret',
          mode: 'chat',
          enabledCapabilities: {
            mcpServers: [],
            skills: []
          }
        })
      );

      expect(missingRef).toEqual({
        ok: false,
        error: {
          code: 'provider_credential_missing',
          message: 'Provider 缺少凭据引用。',
          category: 'validation',
          retryable: false,
          userAction: '请在设置页为 Provider 配置凭据后再重试。'
        }
      });
      expect(missingEnv).toEqual({
        ok: false,
        error: {
          code: 'provider_credential_unavailable',
          message: 'Provider 凭据环境变量 ROC_TEST_PROVIDER_API_KEY 不存在或为空。',
          category: 'validation',
          retryable: false,
          userAction: '请在启动 Roc 前设置对应环境变量，或重新配置 Provider 凭据引用。'
        }
      });
      expect(fakeProvider.requests).toHaveLength(0);
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      if (previousApiKey === undefined) {
        delete process.env.ROC_TEST_PROVIDER_API_KEY;
      } else {
        process.env.ROC_TEST_PROVIDER_API_KEY = previousApiKey;
      }
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('maps live Provider network failures to retryable structured errors', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'This response should not be requested.'
            },
            finish_reason: 'stop'
          }
        ]
      },
      200
    );
    const previousApiKey = process.env.ROC_TEST_PROVIDER_API_KEY;
    process.env.ROC_TEST_PROVIDER_API_KEY = 'sk-live-test-secret';
    await fakeProvider.close();

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'live-model',
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'env:ROC_TEST_PROVIDER_API_KEY',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await wrapIpc(() =>
        liveServices.chatService.submit({
          input: '触发网络失败',
          mode: 'chat',
          enabledCapabilities: {
            mcpServers: [],
            skills: []
          }
        })
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('Expected live Provider network error.');
      }
      expect(result.error).toMatchObject({
        code: 'provider_network_error',
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络、endpoint 和本机代理设置后重试。'
      });
      expect(result.error.message).not.toContain('sk-live-test-secret');
    } finally {
      liveServices.databaseService.close();
      if (previousApiKey === undefined) {
        delete process.env.ROC_TEST_PROVIDER_API_KEY;
      } else {
        process.env.ROC_TEST_PROVIDER_API_KEY = previousApiKey;
      }
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('redacts live Provider HTTP errors before returning IPC failures or task events', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        error: {
          message: 'bad Authorization: Bearer sk-live-test-secret'
        }
      },
      401
    );
    const previousApiKey = process.env.ROC_TEST_PROVIDER_API_KEY;
    process.env.ROC_TEST_PROVIDER_API_KEY = 'sk-live-test-secret';

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'live-model',
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'env:ROC_TEST_PROVIDER_API_KEY',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await wrapIpc(() =>
        liveServices.chatService.submit({
          input: '触发 live provider HTTP 失败',
          mode: 'task',
          enabledCapabilities: {
            mcpServers: [],
            skills: []
          }
        })
      );
      const snapshot = liveServices.taskService.getSnapshot();
      const errorEvent = snapshot.recentEvents.find((event) => event.type === 'error');

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('Expected live Provider HTTP error.');
      }
      expect(result.error).toMatchObject({
        code: 'provider_http_error',
        category: 'external',
        retryable: false
      });
      expect(result.error.message).toContain('HTTP 401');
      expect(result.error.message).toContain('[REDACTED]');
      expect(result.error.message).not.toContain('sk-live-test-secret');
      expect(JSON.stringify(errorEvent?.payload)).not.toContain('sk-live-test-secret');
      expect(JSON.stringify(errorEvent?.payload)).toContain('[REDACTED]');
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      if (previousApiKey === undefined) {
        delete process.env.ROC_TEST_PROVIDER_API_KEY;
      } else {
        process.env.ROC_TEST_PROVIDER_API_KEY = previousApiKey;
      }
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns structured errors for malformed live Provider responses', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider({ choices: [{}] }, 200);
    const previousApiKey = process.env.ROC_TEST_PROVIDER_API_KEY;
    process.env.ROC_TEST_PROVIDER_API_KEY = 'sk-live-test-secret';

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'live-model',
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'env:ROC_TEST_PROVIDER_API_KEY',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await wrapIpc(() =>
        liveServices.chatService.submit({
          input: '触发 malformed response',
          mode: 'chat',
          enabledCapabilities: {
            mcpServers: [],
            skills: []
          }
        })
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'provider_response_malformed',
          message: 'Provider 响应不符合 OpenAI-compatible chat completions 格式。',
          category: 'external',
          retryable: true,
          userAction: '请稍后重试，或检查 Provider endpoint 是否兼容 OpenAI chat completions。'
        }
      });
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      if (previousApiKey === undefined) {
        delete process.env.ROC_TEST_PROVIDER_API_KEY;
      } else {
        process.env.ROC_TEST_PROVIDER_API_KEY = previousApiKey;
      }
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns a validation error for empty chat input at the IPC boundary', async () => {
    const result = await wrapIpc(() =>
      services.chatService.submit({
        input: '   ',
        mode: 'chat',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      })
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'chat_input_empty',
        message: '聊天输入不能为空。',
        category: 'validation',
        retryable: true,
        userAction: '请输入要发送给 Roc 的内容。'
      }
    });
  });

  it('selects a real workspace and keeps the app status bound to the same path', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      const workspace = services.workspaceService.selectWorkspace(workspaceRoot);
      const current = services.workspaceService.getCurrentWorkspace();
      const status = services.appService.getStatus();

      expect(workspace.path).toBe(workspaceRoot);
      expect(workspace.displayName).toBe(workspaceRoot.split(/[\\/]/).pop());
      expect(workspace.trustState).toBe('trusted');
      expect(current?.path).toBe(workspaceRoot);
      expect(status.workspace).toEqual({
        selectedPath: workspaceRoot,
        label: workspaceRoot
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists, searches, previews, and writes workspace files with recovery points', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      mkdirSync(join(workspaceRoot, 'src'));
      writeFileSync(join(workspaceRoot, 'src', 'notes.md'), 'alpha\nphase three boundary\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const tree = services.fileService.listTree({ relativePath: '' });
      const search = services.fileService.search({ query: 'phase three' });
      const preview = services.fileService.readPreview({ relativePath: 'src/notes.md' });
      const writeResult = services.fileService.writeTextFile({
        relativePath: 'src/notes.md',
        content: 'updated phase three boundary\n',
        source: 'test'
      });
      const recoverySnapshot = readFileSync(writeResult.recoveryPoint.snapshotPath, 'utf8');
      const updatedContent = readFileSync(join(workspaceRoot, 'src', 'notes.md'), 'utf8');

      expect(tree.entries).toContainEqual(
        expect.objectContaining({
          name: 'src',
          relativePath: 'src',
          type: 'directory'
        })
      );
      expect(search.matches).toEqual([
        expect.objectContaining({
          relativePath: 'src/notes.md',
          line: 2,
          preview: 'phase three boundary'
        })
      ]);
      expect(preview).toMatchObject({
        relativePath: 'src/notes.md',
        kind: 'text',
        truncated: false,
        content: 'alpha\nphase three boundary\n'
      });
      expect(writeResult.recoveryPoint.relativePath).toBe('src/notes.md');
      expect(recoverySnapshot).toBe('alpha\nphase three boundary\n');
      expect(updatedContent).toBe('updated phase three boundary\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns structured workspace and git errors instead of implicit fallbacks', async () => {
    const missingWorkspace = await wrapIpc(() => services.workspaceService.selectWorkspace(join(root, 'missing')));
    expect(missingWorkspace).toEqual({
      ok: false,
      error: {
        code: 'workspace_path_missing',
        message: '工作区路径不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在的目录作为工作区。'
      }
    });

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const gitStatus = await wrapIpc(() => services.gitService.getStatus());

      expect(gitStatus).toEqual({
        ok: false,
        error: {
          code: 'git_repository_missing',
          message: '当前工作区不是 Git 仓库。',
          category: 'not_found',
          retryable: false,
          userAction: '请选择一个 Git 仓库工作区，或在外部初始化仓库后重试。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs only low-risk workspace commands and records agent command events', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'terminal output\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);
      services.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'model-ready',
        providers: [
          {
            id: 'provider-openai',
            name: 'OpenAI compatible',
            type: 'openai_compatible',
            endpoint: 'https://api.example.test/v1',
            credentialRef: 'credential:provider-openai',
            enabled: true,
            models: [
              {
                id: 'model-ready',
                displayName: 'Ready model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });
      const task = await services.chatService.submit({
        input: '读取工作区文件',
        mode: 'task',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      if (task.status !== 'task_answered') {
        throw new Error(`Expected task_answered, received ${task.status}`);
      }

      const commandResult = services.shellExecutionService.execute({
        command: 'dir',
        cwd: workspaceRoot,
        source: 'agent',
        threadId: task.threadId,
        runId: task.runId
      });
      const blockedResult = services.shellExecutionService.evaluate({
        command: 'Remove-Item notes.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });
      const snapshot = services.taskService.getSnapshot();

      expect(commandResult).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        exitCode: 0,
        usedRtk: false,
        bypassReason: 'rtk_binary_missing'
      });
      expect(commandResult.stdout).toContain('notes.txt');
      expect(blockedResult).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'remove-item notes.txt'
      });
      expect(snapshot.recentEvents.some((event) => event.type === 'terminal_command')).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks compound shell commands even when they start with a read-only command', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);

      const pipedRemoval = services.shellExecutionService.evaluate({
        command: 'dir | Remove-Item -Recurse',
        cwd: workspaceRoot,
        source: 'agent'
      });
      const chainedRemoval = services.shellExecutionService.evaluate({
        command: 'dir; Remove-Item notes.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });

      expect(pipedRemoval).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir | remove-item -recurse'
      });
      expect(chainedRemoval).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir; remove-item notes.txt'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns a permission error when executing a high-risk shell command through IPC boundary', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);

      const result = await wrapIpc(() =>
        services.shellExecutionService.execute({
          command: 'Remove-Item notes.txt',
          cwd: workspaceRoot,
          source: 'agent'
        })
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'command_requires_confirmation',
          message: '命令需要确认，未执行。',
          category: 'permission',
          retryable: false,
          userAction: '请在任务确认卡片中查看命令、作用目录和风险原因后再决定是否执行。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks shell redirection because it can write workspace files', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);

      const redirectedListing = services.shellExecutionService.evaluate({
        command: 'dir > created-by-redirection.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });

      expect(redirectedListing).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir > created-by-redirection.txt'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports RTK resources as degraded when the bundled binary is missing', () => {
    const status = services.rtkService.getStatus();

    expect(status).toEqual({
      enabledForAgentCommands: true,
      binaryPath: join(root, 'tools', 'roc-rtk.exe'),
      configPath: join(root, 'config', 'rtk.toml'),
      teeDir: join(root, 'rtk', 'tee'),
      resourceState: 'missing',
      bypassReason: 'rtk_binary_missing'
    });
  });

  it('returns Doctor findings from real service state', () => {
    const doctor = services.doctorService.run();

    expect(doctor.summary.pass).toBeGreaterThanOrEqual(3);
    expect(doctor.summary.degraded).toBeGreaterThanOrEqual(1);
    expect(doctor.findings.some((finding) => finding.checkId === 'provider.default_model')).toBe(true);
    expect(doctor.findings.some((finding) => finding.checkId === 'rtk.binary')).toBe(true);
    expect(doctor.findings.some((finding) => finding.checkId === 'workspace.default')).toBe(true);
  });

  it('keeps unexpected IPC errors sanitized while preserving domain errors', async () => {
    const domainResult = await wrapIpc(() => {
      throw new RocDomainError({
        code: 'memory_not_found',
        message: '记忆条目不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请重新搜索记忆。'
      });
    });

    const unexpectedResult = await wrapIpc(() => {
      throw new Error('SQLITE_CANTOPEN: C:\\Users\\任彦舟\\.roc\\roc.sqlite');
    });

    expect(domainResult).toEqual({
      ok: false,
      error: {
        code: 'memory_not_found',
        message: '记忆条目不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请重新搜索记忆。'
      }
    });
    expect(unexpectedResult).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Roc 内部错误，已记录到本地日志。',
        category: 'internal',
        retryable: false,
        userAction: '请查看 Roc 日志或重新运行 Doctor。'
      }
    });
  });

  it('manages providers, tests local provider readiness, and clears invalid default models', () => {
    const provider = services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: 'credential:provider-local',
      enabled: true,
      models: [
        {
          id: 'model-tools',
          displayName: 'Tool capable model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    const testResult = services.configService.testProvider(provider.id);
    services.configService.setDefaultModel('model-tools');

    expect(provider.credentialRef).toBe('credential:provider-local');
    expect(testResult).toMatchObject({
      providerId: 'provider-local',
      status: 'ready',
      defaultModelReady: false
    });
    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'model-tools',
      providerId: 'provider-local',
      reason: '默认模型可用。'
    });

    services.configService.deleteProvider(provider.id);

    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    });
  });

  it('manages MCP servers and validates local MCP test requirements', () => {
    const exaPreset = services.mcpService.ensureExaPreset();
    const server = services.mcpService.upsertServer({
      id: 'docs-http',
      name: 'Docs HTTP MCP',
      transport: 'http',
      enabled: true,
      url: 'https://docs.example.test/mcp',
      preset: false,
      riskLevel: 'medium',
      allowedTools: ['search_docs']
    });
    const disabled = services.mcpService.setServerEnabled('docs-http', false);
    const testResult = services.mcpService.testServer('docs-http');
    const servers = services.mcpService.listServers();

    expect(exaPreset).toMatchObject({
      id: 'exa-hosted',
      transport: 'http',
      preset: true
    });
    expect(server.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);
    expect(testResult).toMatchObject({
      serverId: 'docs-http',
      status: 'ready',
      checked: ['id', 'name', 'transport', 'url']
    });
    expect(servers).toContainEqual(
      expect.objectContaining({
        id: 'docs-http',
        enabled: false,
        status: 'not_connected'
      })
    );

    services.mcpService.deleteServer('docs-http');
    expect(services.mcpService.listServers().some((item) => item.id === 'docs-http')).toBe(false);
  });

  it('imports, disables, enables, and deletes local skills without a marketplace', () => {
    const source = mkdtempSync(join(tmpdir(), 'roc-skill-source-'));
    try {
      writeFileSync(
        join(source, 'SKILL.md'),
        ['---', 'name: project-review', 'description: Review a local project', '---', '', '# Skill', ''].join('\n'),
        'utf8'
      );

      const imported = services.skillService.importSkill({ sourcePath: source, id: 'project-review' });
      const disabled = services.skillService.setEnabled('project-review', false);
      const enabled = services.skillService.setEnabled('project-review', true);
      const skills = services.skillService.list();

      expect(imported).toMatchObject({
        id: 'project-review',
        name: 'project-review',
        enabled: true,
        status: 'ready'
      });
      expect(resolve(imported.path).startsWith(resolve(root, 'skills'))).toBe(true);
      expect(disabled.enabled).toBe(false);
      expect(enabled.enabled).toBe(true);
      expect(skills).toContainEqual(expect.objectContaining({ id: 'project-review', enabled: true }));

      services.skillService.deleteSkill('project-review');
      expect(services.skillService.list().some((item) => item.id === 'project-review')).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('stores chat turn MCP and Skill selections on the created task run only', async () => {
    services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: null,
      enabled: true,
      models: [
        {
          id: 'model-ready',
          displayName: 'Ready model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.setDefaultModel('model-ready');
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

    const chat = await services.chatService.submit({
      input: '用本轮能力检查项目',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['docs-http'],
        skills: ['project-review']
      }
    });
    if (chat.status !== 'task_answered') {
      throw new Error(`Expected task_answered, received ${chat.status}`);
    }
    const run = services.taskService.getRun(chat.runId);
    const mcpServers = services.mcpService.listServers();
    const skills = services.skillService.list();

    expect(run.enabledCapabilities).toEqual({
      mcpServers: ['docs-http'],
      skills: ['project-review']
    });
    expect(mcpServers).toContainEqual(expect.objectContaining({ id: 'docs-http', enabled: true }));
    expect(skills).toContainEqual(expect.objectContaining({ id: 'project-review', enabled: true }));
  });

  it('builds an Agent capability preview from the current turn MCP and Skill selections', () => {
    services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: null,
      enabled: true,
      models: [
        {
          id: 'model-ready',
          displayName: 'Ready model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.setDefaultModel('model-ready');
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
    services.mcpService.upsertServer({
      id: 'disabled-mcp',
      name: 'Disabled MCP',
      transport: 'http',
      enabled: false,
      url: 'https://disabled.example.test/mcp',
      preset: false,
      riskLevel: 'low',
      allowedTools: ['disabled_tool']
    });
    mkdirSync(join(root, 'skills', 'project-review'));
    writeFileSync(
      join(root, 'skills', 'project-review', 'SKILL.md'),
      ['---', 'name: project-review', 'description: Review a local project', '---', ''].join('\n'),
      'utf8'
    );

    const preview = services.agentService.getCapabilityPreview({
      mcpServers: ['docs-http', 'disabled-mcp', 'missing-mcp'],
      skills: ['project-review', 'missing-skill']
    });

    expect(preview).toMatchObject({
      runnable: false,
      modelId: 'model-ready',
      untrustedContextPolicy: 'external_content_reference_only',
      selectedCapabilities: {
        mcpServers: ['docs-http'],
        skills: ['project-review']
      }
    });
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'mcp:docs-http:search_docs',
        name: 'search_docs',
        capabilityType: 'mcp_tool',
        scope: 'external',
        riskLevel: 'medium',
        auditCategory: 'mcp_call',
        requiresApproval: true
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'web:web_read',
        name: 'web_read',
        capabilityType: 'web_read',
        scope: 'network',
        untrustedContext: true
      })
    );
    expect(preview.skillCards).toContainEqual(
      expect.objectContaining({
        id: 'skill:project-review',
        name: 'project-review',
        capabilityType: 'skill',
        sourcePath: join(root, 'skills', 'project-review')
      })
    );
    expect(preview.subagents).toContainEqual(
      expect.objectContaining({
        id: 'code-review',
        inheritsSkills: false
      })
    );
    expect(preview.skippedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'disabled-mcp', type: 'mcp_server', reason: 'disabled' }),
        expect.objectContaining({ id: 'missing-mcp', type: 'mcp_server', reason: 'not_found' }),
        expect.objectContaining({ id: 'missing-skill', type: 'skill', reason: 'not_found' })
      ])
    );
    expect(preview.interruptOn).toMatchObject({
      write_file: true,
      edit_file: true,
      terminal_command: true,
      git_operation: true,
      search_docs: true,
      web_read: true
    });
  });

  it('records Agent capability manifest and skill_loaded events when creating a task run', async () => {
    services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: null,
      enabled: true,
      models: [
        {
          id: 'model-ready',
          displayName: 'Ready model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.setDefaultModel('model-ready');
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

    const chat = await services.chatService.submit({
      input: '用本轮能力做代码审查',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: ['docs-http', 'missing-mcp'],
        skills: ['project-review']
      }
    });
    if (chat.status !== 'task_answered') {
      throw new Error(`Expected task_answered, received ${chat.status}`);
    }
    const snapshot = services.taskService.getSnapshot();
    const manifestEvent = snapshot.recentEvents.find((event) => event.type === 'context_manifest');
    const skillEvent = snapshot.recentEvents.find((event) => event.type === 'skill_loaded');

    expect(manifestEvent?.payload).toMatchObject({
      requestedCapabilities: {
        mcpServers: ['docs-http', 'missing-mcp'],
        skills: ['project-review']
      },
      resolvedCapabilities: {
        mcpServers: ['docs-http'],
        skills: ['project-review']
      },
      untrustedContextPolicy: 'external_content_reference_only'
    });
    expect(manifestEvent?.payload).toMatchObject({
      skippedCapabilities: [expect.objectContaining({ id: 'missing-mcp', type: 'mcp_server', reason: 'not_found' })]
    });
    expect(skillEvent?.payload).toMatchObject({
      skillId: 'project-review',
      enabledBy: 'turn_selection',
      source: 'agent_capability_preview'
    });
  });

  it('creates scheduled background tasks and keeps tray summary bound to task state', () => {
    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '每天检查项目测试状态',
      trigger: {
        type: 'schedule',
        description: '每天 09:00',
        nextRunAt: '2026-04-29T01:00:00.000Z'
      },
      workspacePath: root,
      allowedActions: ['pnpm test'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);
    const paused = services.taskService.pauseBackgroundTask(task.id);
    const resumed = services.taskService.resumeBackgroundTask(task.id);
    const tray = services.lifecycleService.getTraySummary();
    const snapshot = services.taskService.getSnapshot();

    expect(preview).toMatchObject({
      goal: '每天检查项目测试状态',
      scheduled: true,
      nextRunAt: '2026-04-29T01:00:00.000Z',
      riskLevel: 'medium',
      requiresConfirmation: false
    });
    expect(task).toMatchObject({
      goal: '每天检查项目测试状态',
      status: 'running',
      triggerDescription: '每天 09:00',
      nextRunAt: '2026-04-29T01:00:00.000Z'
    });
    expect(paused.status).toBe('paused');
    expect(resumed.status).toBe('running');
    expect(tray).toMatchObject({
      residentEnabled: true,
      backgroundPaused: false,
      backgroundTasks: {
        total: 1,
        running: 1,
        failed: 0,
        pendingConfirmation: 0
      },
      nextRunAt: '2026-04-29T01:00:00.000Z'
    });
    expect(snapshot.counts.running).toBe(1);
    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: task.threadId,
        status: 'running'
      })
    );
    expect(snapshot.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'background_task_created' }),
        expect.objectContaining({ type: 'background_task_paused' }),
        expect.objectContaining({ type: 'background_task_resumed' })
      ])
    );
  });

  it('returns structured errors for illegal background task transitions', async () => {
    const missing = await wrapIpc(() => services.taskService.pauseBackgroundTask('missing-background-task'));

    expect(missing).toEqual({
      ok: false,
      error: {
        code: 'background_task_not_found',
        message: '后台任务不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请刷新任务工作台后重试。'
      }
    });

    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '检查取消状态',
      trigger: {
        type: 'manual',
        description: '手动触发',
        nextRunAt: null
      },
      workspacePath: root,
      allowedActions: ['pnpm test'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);
    services.taskService.cancelBackgroundTask(task.id);

    const resumeCancelled = await wrapIpc(() => services.taskService.resumeBackgroundTask(task.id));

    expect(resumeCancelled).toEqual({
      ok: false,
      error: {
        code: 'background_task_invalid_transition',
        message: '后台任务当前状态不能继续。',
        category: 'conflict',
        retryable: false,
        userAction: '请查看任务状态，必要时创建新的后台任务。'
      }
    });
  });

  it('keeps Doctor latest separate from a new run and includes Phase 6 repair actions', () => {
    const first = services.doctorService.run();
    const latest = services.doctorService.getLatest();
    const second = services.doctorService.run();
    const doctorRuns = services.databaseService.db.prepare('SELECT id FROM doctor_runs').all() as Array<{ id: string }>;

    expect(latest.generatedAt).toBe(first.generatedAt);
    expect(second.generatedAt >= first.generatedAt).toBe(true);
    expect(doctorRuns.length).toBe(2);
    expect(second.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: 'background.tasks',
          repairAction: expect.objectContaining({
            label: '打开任务工作台'
          })
        }),
        expect.objectContaining({
          checkId: 'diagnostics.directory',
          repairAction: expect.objectContaining({
            label: '打开诊断目录'
          })
        }),
        expect.objectContaining({
          checkId: 'performance.sample',
          repairAction: expect.objectContaining({
            label: '重新采样'
          })
        })
      ])
    );
  });

  it('generates redacted diagnostic packages with task, Doctor, RTK and performance evidence', () => {
    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '生成诊断包',
      trigger: {
        type: 'manual',
        description: '手动触发',
        nextRunAt: null
      },
      workspacePath: root,
      allowedActions: ['echo diagnostic'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);
    const pack = services.diagnosticsService.createDiagnosticPackage({
      taskId: task.id,
      errorSummary: 'Authorization: Bearer sk-secret-value'
    });
    const content = readFileSync(pack.path, 'utf8');

    expect(pack).toMatchObject({
      taskId: task.id,
      redacted: true,
      includes: expect.arrayContaining(['task_snapshot', 'doctor_findings', 'performance_sample', 'rtk_status'])
    });
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-secret-value');
    expect(content).not.toContain('Bearer sk-secret-value');
  });

  it('records performance samples for Doctor and exposes the package directory script target', () => {
    const sample = services.diagnosticsService.samplePerformance({
      mode: 'test',
      memoryBudgetMb: 300
    });
    const doctor = services.doctorService.run();

    expect(sample).toMatchObject({
      mode: 'test',
      memoryBudgetMb: 300
    });
    expect(sample.rssMb).toBeGreaterThan(0);
    expect(sample.heapUsedMb).toBeGreaterThan(0);
    expect(typeof sample.exceedsBudget).toBe('boolean');
    expect(doctor.findings).toContainEqual(
      expect.objectContaining({
        checkId: 'performance.sample',
        status: sample.exceedsBudget ? 'degraded' : 'pass'
      })
    );
    expect(existsSync(resolve('scripts/package-dir.mjs'))).toBe(true);
  });
});
