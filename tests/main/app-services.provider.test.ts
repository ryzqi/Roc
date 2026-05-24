import { createAppServices } from '../../src/main/services/app-service';
import { RocDomainError } from '../../src/main/services/errors';
import { DEEP_AGENT_BUILT_IN_TOOLS } from '../../src/main/services/deep-agent/types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupAppServicesTest, initializeAppServicesTest, normalizeLineEndings, startFakeProvider, type AppServicesTestContext } from './app-service-fixtures';


describe('Roc foundation services providers', () => {
  let context: AppServicesTestContext;

  beforeEach(() => {
    context = initializeAppServicesTest();
  });

  afterEach(() => {
    cleanupAppServicesTest(context);
  });

  it('reports blocked agent state until default model is configured', () => {
    const status = context.services.agentService.getStatus();

    expect(status.deepAgentsPackage).toBe('available');
    expect(status.defaultModelConfigured).toBe(false);
    expect(status.memoryAccess).toBe('store_backend');
    expect(status.execution).toBe('blocked_until_provider_configured');
  });

  it('validates explicit default model selection from enabled provider models', () => {
    expect(context.services.configService.getDefaultModelState()).toEqual({
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    });

    context.services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-disabled',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'secret:provider-openai',
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

    expect(context.services.configService.getDefaultModelState()).toEqual({
      status: 'invalid',
      modelId: 'model-disabled',
      providerId: 'provider-openai',
      reason: '默认模型未启用。'
    });

    context.services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'secret:provider-openai',
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

    expect(context.services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'model-ready',
      providerId: 'provider-openai',
      reason: '默认模型可用。'
    });
  });

  it('exposes Deep Agents config preview without running a model', () => {
    context.services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'secret:provider-openai',
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

    const status = context.services.agentService.getStatus();
    const preview = context.services.agentService.getDeepAgentConfigPreview();

    expect(status.execution).toBe('ready');
    expect(status.deepAgentsApi.createDeepAgent).toBe(true);
    expect(preview).toEqual({
      runnable: false,
      model: 'model-ready',
      memoryAccess: 'store_backend',
      builtInTools: [...DEEP_AGENT_BUILT_IN_TOOLS],
      rocTools: [],
      todoMapping: {
        sourceTool: 'write_todos',
        target: 'task_steps'
      },
      interruptOn: {
        propose_background_task: {
          allowedDecisions: ['approve', 'edit', 'reject']
        },
        update_background_task: {
          allowedDecisions: ['approve', 'edit', 'reject']
        },
        cancel_background_task: {
          allowedDecisions: ['approve', 'reject']
        }
      },
      reason: 'Roc 不在 preview 阶段实际装配 Deep Agents，本结果反映下一轮装配将使用的参数。'
    });
  });

  it('rejects providers saved with non-secret credential refs at the schema boundary', () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);

    try {
      liveServices.appService.initialize();
      expect(() =>
        liveServices.configService.saveProviders({
          schemaVersion: 1,
          defaultModelId: 'live-model',
          providers: [
            {
              id: 'provider-live-openai',
              name: 'Live OpenAI compatible',
              type: 'openai_compatible',
              endpoint: 'https://example.test/v1',
              credentialRef: 'env:LEGACY_KEY',
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
        })
      ).toThrow();
    } finally {
      liveServices.databaseService.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('manages providers and clears invalid default models', () => {
    const provider = context.services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: 'secret:provider-local',
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
    context.services.configService.setDefaultModel('model-tools');

    expect(provider.credentialRef).toBe('secret:provider-local');
    expect(context.services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'model-tools',
      providerId: 'provider-local',
      reason: '默认模型可用。'
    });

    context.services.configService.deleteProvider(provider.id);

    expect(context.services.configService.getDefaultModelState()).toEqual({
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    });
  });

  it('tests a saved provider through the live transport without relying on the default model', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'OK'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 1,
          total_tokens: 12
        }
      },
      200
    );

    try {
      liveServices.appService.initialize();
      liveServices.secretService.setProviderSecret('provider-live-openai', 'sk-live-test-secret');
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-live-openai',
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

      const result = await liveServices.providerRuntimeService.testProvider('provider-live-openai');

      expect(result).toMatchObject({
        providerId: 'provider-live-openai',
        status: 'ready',
        defaultModelReady: false,
        modelId: 'live-model',
        error: null
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
            role: 'system'
          }),
          expect.objectContaining({
            role: 'user',
            content: 'Reply with OK only.'
          })
        ]
      });
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('tests the fixed llama.cpp provider through the live transport without sending Authorization when no API key is configured', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      null,
      200,
      {
        contentType: 'text/event-stream',
        rawBody: [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"qwen3.5-4b","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
          '',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"qwen3.5-4b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
          ''
        ].join('\n')
      }
    );

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'llama_cpp',
            name: 'llama.cpp',
            type: 'llama_cpp',
            endpoint: fakeProvider.endpoint,
            credentialRef: null,
            enabled: true,
            models: [
              {
                id: 'qwen3.5-4b',
                displayName: 'Qwen 3.5 4B',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await liveServices.providerRuntimeService.testProvider('llama_cpp');

      expect(result).toMatchObject({
        providerId: 'llama_cpp',
        status: 'ready',
        defaultModelReady: false,
        modelId: 'qwen3.5-4b',
        error: null
      });
      expect(fakeProvider.requests).toHaveLength(1);
      expect(fakeProvider.requests[0]).toMatchObject({
        method: 'POST',
        url: '/v1/chat/completions',
        authorization: undefined
      });
      expect(fakeProvider.requests[0]?.body).toMatchObject({
        model: 'qwen3.5-4b',
        stream: true,
        cache_prompt: true,
        messages: [
          expect.objectContaining({
            role: 'system'
          }),
          expect.objectContaining({
            role: 'user',
            content: 'Reply with OK only.'
          })
        ]
      });
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns local validation failures for provider tests without issuing live requests', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
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
        defaultModelId: null,
        providers: [
          {
            id: 'provider-disabled',
            name: 'Disabled provider',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-disabled',
            enabled: false,
            models: [
              {
                id: 'disabled-model',
                displayName: 'Disabled model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          },
          {
            id: 'provider-no-models',
            name: 'No ready models',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-no-models',
            enabled: true,
            models: [
              {
                id: 'disabled-model',
                displayName: 'Disabled model',
                enabled: false,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          },
          {
            id: 'provider-missing-secret',
            name: 'Missing secret',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-missing-secret',
            enabled: true,
            models: [
              {
                id: 'missing-secret-model',
                displayName: 'Missing secret model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const disabled = await liveServices.providerRuntimeService.testProvider('provider-disabled');
      const noModels = await liveServices.providerRuntimeService.testProvider('provider-no-models');
      const missingSecret = await liveServices.providerRuntimeService.testProvider('provider-missing-secret');

      expect(disabled).toMatchObject({
        providerId: 'provider-disabled',
        status: 'invalid',
        defaultModelReady: false,
        modelId: null,
        error: 'Provider 未启用。'
      });
      expect(noModels).toMatchObject({
        providerId: 'provider-no-models',
        status: 'invalid',
        defaultModelReady: false,
        modelId: null,
        error: 'Provider 没有已启用模型。'
      });
      expect(missingSecret).toMatchObject({
        providerId: 'provider-missing-secret',
        status: 'invalid',
        defaultModelReady: false,
        modelId: 'missing-secret-model',
        error: 'Provider 凭据未存储。'
      });
      expect(fakeProvider.requests).toHaveLength(0);
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns redacted HTTP failures in provider tests after issuing a live request', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        error: {
          message: 'bad Authorization: Bearer sk-live-test-secret'
        }
      },
      401
    );

    try {
      liveServices.appService.initialize();
      liveServices.secretService.setProviderSecret('provider-live-openai', 'sk-live-test-secret');
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-live-openai',
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

      const result = await liveServices.providerRuntimeService.testProvider('provider-live-openai');

      expect(result).toMatchObject({
        providerId: 'provider-live-openai',
        status: 'invalid',
        defaultModelReady: false,
        modelId: 'live-model'
      });
      expect(result.error).toContain('HTTP 401');
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain('sk-live-test-secret');
      expect(fakeProvider.requests).toHaveLength(1);
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns retryable network failures as invalid provider test results', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
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
    await fakeProvider.close();

    try {
      liveServices.appService.initialize();
      liveServices.secretService.setProviderSecret('provider-live-openai', 'sk-live-test-secret');
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-live-openai',
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

      const result = await liveServices.providerRuntimeService.testProvider('provider-live-openai');

      expect(result).toMatchObject({
        providerId: 'provider-live-openai',
        status: 'invalid',
        defaultModelReady: false,
        modelId: 'live-model'
      });
      expect(result.error).toContain('Provider 网络请求失败');
      expect(result.error).not.toContain('sk-live-test-secret');
    } finally {
      liveServices.databaseService.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns provider timeout failures as invalid test results', async () => {
    vi.useFakeTimers();
    context.services.secretService.setProviderSecret('provider-local', 'sk-local-test-secret');
    context.services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'provider-local',
          name: 'Local OpenAI-compatible',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:11434/v1',
          credentialRef: 'secret:provider-local',
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
        }
      ]
    });
    context.services.providerRuntimeService.setDeterministicFailure(
      new RocDomainError({
        code: 'provider_request_timeout',
        message: 'Provider 请求超时，请稍后重试或检查 Provider endpoint。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider endpoint 是否可访问。'
      })
    );

    const resultPromise = context.services.providerRuntimeService.testProvider('provider-local');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({
      providerId: 'provider-local',
      status: 'invalid',
      defaultModelReady: false,
      modelId: 'model-tools',
      error: 'Provider 请求超时，请稍后重试或检查 Provider endpoint。'
    });
  });

  it('keeps multiple OpenAI-compatible and Anthropic-compatible providers as independent default-model choices', () => {
    context.services.configService.upsertProvider({
      id: 'provider-openai-a',
      name: 'OpenAI A',
      type: 'openai_compatible',
      endpoint: 'https://openai-a.example.test/v1',
      credentialRef: 'secret:provider-openai-a',
      enabled: true,
      models: [
        {
          id: 'openai-a-model',
          displayName: 'OpenAI A model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    context.services.configService.upsertProvider({
      id: 'provider-openai-b',
      name: 'OpenAI B',
      type: 'openai_compatible',
      endpoint: 'https://openai-b.example.test/v1',
      credentialRef: 'secret:provider-openai-b',
      enabled: true,
      models: [
        {
          id: 'openai-b-model',
          displayName: 'OpenAI B model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: false
        }
      ]
    });
    context.services.configService.upsertProvider({
      id: 'provider-anthropic-a',
      name: 'Anthropic A',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic-a.example.test/v1',
      credentialRef: 'secret:provider-anthropic-a',
      enabled: true,
      models: [
        {
          id: 'anthropic-a-model',
          displayName: 'Anthropic A model',
          enabled: true,
          supportsStreaming: false,
          supportsToolCalls: false
        }
      ]
    });
    context.services.configService.upsertProvider({
      id: 'provider-anthropic-b',
      name: 'Anthropic B',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic-b.example.test/v1',
      credentialRef: 'secret:provider-anthropic-b',
      enabled: true,
      models: [
        {
          id: 'anthropic-b-model',
          displayName: 'Anthropic B model',
          enabled: true,
          supportsStreaming: false,
          supportsToolCalls: false
        }
      ]
    });

    const config = context.services.configService.getProviders();
    context.services.configService.setDefaultModel('anthropic-b-model');

    expect(config.providers.map((provider) => `${provider.type}:${provider.id}`)).toEqual([
      'nvidia:nvidia',
      'llama_cpp:llama_cpp',
      'openai_compatible:provider-openai-a',
      'openai_compatible:provider-openai-b',
      'anthropic_compatible:provider-anthropic-a',
      'anthropic_compatible:provider-anthropic-b'
    ]);
    expect(context.services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'anthropic-b-model',
      providerId: 'provider-anthropic-b',
      reason: '默认模型可用。'
    });
  });

  it('manages MCP servers and validates local MCP test requirements', () => {
    const exaPreset = context.services.mcpService.ensureExaPreset();
    const server = context.services.mcpService.upsertServer({
      id: 'docs-http',
      name: 'Docs HTTP MCP',
      transport: 'http',
      enabled: true,
      url: 'https://docs.example.test/mcp',
      preset: false,
      riskLevel: 'medium',
      allowedTools: ['search_docs']
    });
    const disabled = context.services.mcpService.setServerEnabled('docs-http', false);
    const testResult = context.services.mcpService.testServer('docs-http');
    const servers = context.services.mcpService.listServers();

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

    context.services.mcpService.deleteServer('docs-http');
    expect(context.services.mcpService.listServers().some((item) => item.id === 'docs-http')).toBe(false);
  });

  it('ensures the Exa preset exists on startup', () => {
    const exaServer = context.services.mcpService.listServers().find((server) => server.id === 'exa-hosted');

    expect(exaServer).toMatchObject({
      id: 'exa-hosted',
      name: 'Exa Hosted MCP',
      transport: 'http',
      preset: true,
      enabled: false,
      url: 'https://mcp.exa.ai/mcp'
    });
  });

  it('keeps the Exa preset visible after critical-only startup initialization', () => {
    cleanupAppServicesTest(context);
    context = initializeAppServicesTest({ skipInitialize: true });

    context.services.appService.initializeCritical();
    const exaServer = context.services.mcpService.listServers().find((server) => server.id === 'exa-hosted');

    expect(exaServer).toMatchObject({
      id: 'exa-hosted',
      name: 'Exa Hosted MCP',
      transport: 'http',
      preset: true,
      enabled: false,
      url: 'https://mcp.exa.ai/mcp'
    });
  });

  it('imports, disables, enables, and deletes local skills without a marketplace', () => {
    const source = mkdtempSync(join(tmpdir(), 'roc-skill-source-'));
    try {
      writeFileSync(
        join(source, 'SKILL.md'),
        ['---', 'name: project-review', 'description: Review a local project', '---', '', '# Skill', ''].join('\n'),
        'utf8'
      );

      const imported = context.services.skillService.importSkill({ sourcePath: source });
      const disabled = context.services.skillService.setEnabled('project-review', false);
      const enabled = context.services.skillService.setEnabled('project-review', true);
      const skills = context.services.skillService.list();

      expect(imported).toMatchObject({
        id: 'project-review',
        name: 'project-review',
        enabled: true,
        status: 'ready'
      });
      expect(resolve(imported.path).startsWith(resolve(context.services.paths.skillsDir))).toBe(true);
      expect(disabled.enabled).toBe(false);
      expect(enabled.enabled).toBe(true);
      expect(skills).toContainEqual(expect.objectContaining({ id: 'project-review', enabled: true }));

      context.services.skillService.deleteSkill('project-review');
      expect(context.services.skillService.list().some((item) => item.id === 'project-review')).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('builds an Agent capability preview from the current turn MCP and Skill selections', () => {
    context.services.configService.upsertProvider({
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
    context.services.configService.setDefaultModel('model-ready');
    context.services.mcpService.upsertServer({
      id: 'docs-http',
      name: 'Docs HTTP MCP',
      transport: 'http',
      enabled: true,
      url: 'https://docs.example.test/mcp',
      preset: false,
      riskLevel: 'medium',
      allowedTools: ['search_docs']
    });
    context.services.mcpService.upsertServer({
      id: 'disabled-mcp',
      name: 'Disabled MCP',
      transport: 'http',
      enabled: false,
      url: 'https://disabled.example.test/mcp',
      preset: false,
      riskLevel: 'low',
      allowedTools: ['disabled_tool']
    });
    mkdirSync(join(context.services.paths.skillsDir, 'project-review'), { recursive: true });
    writeFileSync(
      join(context.services.paths.skillsDir, 'project-review', 'SKILL.md'),
      ['---', 'name: project-review', 'description: Review a local project', '---', ''].join('\n'),
      'utf8'
    );

    const preview = context.services.agentService.getCapabilityPreview({
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
        requiresApproval: false
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:execute',
        name: 'execute',
        capabilityType: 'terminal_tool',
        scope: 'workspace',
        auditCategory: 'agent_execute',
        requiresApproval: false
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:delete_file',
        name: 'delete_file',
        capabilityType: 'terminal_tool',
        auditCategory: 'workspace_delete',
        requiresApproval: false
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
        sourcePath: join(context.services.paths.skillsDir, 'project-review')
      })
    );
    expect(preview.subagents).toContainEqual(
      expect.objectContaining({
        id: 'code-review',
        skills: []
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
      propose_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      update_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      cancel_background_task: {
        allowedDecisions: ['approve', 'reject']
      }
    });
  });

  it('normalizes the Exa preset into a single web_search capability card', () => {
    context.services.configService.upsertProvider({
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
    context.services.configService.setDefaultModel('model-ready');
    context.services.mcpService.setServerEnabled(context.services.mcpService.ensureExaPreset().id, true);

    const preview = context.services.agentService.getCapabilityPreview({
      mcpServers: ['exa-hosted'],
      skills: []
    });

    expect(preview.selectedCapabilities.mcpServers).toEqual(['exa-hosted']);
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'mcp:exa-hosted:web_search',
        name: 'web_search',
        capabilityType: 'mcp_tool',
        auditCategory: 'mcp_call',
        requiresApproval: false
      })
    );
    expect(preview.toolCards).not.toContainEqual(
      expect.objectContaining({
        name: 'web_search_exa'
      })
    );
    expect(preview.interruptOn).toMatchObject({
      propose_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      update_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      cancel_background_task: {
        allowedDecisions: ['approve', 'reject']
      }
    });
  });

  it('switches capability preview to default approval mode for MCP and delete_file only', () => {
    context.services.configService.upsertProvider({
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
    context.services.configService.setDefaultModel('model-ready');
    context.services.configService.savePermissions({
      schemaVersion: 3,
      mode: 'default',
      grants: []
    });
    context.services.mcpService.setServerEnabled(context.services.mcpService.ensureExaPreset().id, true);

    const preview = context.services.agentService.getCapabilityPreview({
      mcpServers: ['exa-hosted'],
      skills: []
    });

    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:delete_file',
        name: 'delete_file',
        requiresApproval: true
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'mcp:exa-hosted:web_search',
        name: 'web_search',
        requiresApproval: true
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:execute',
        name: 'execute',
        requiresApproval: false
      })
    );
    expect(preview.interruptOn).toEqual({
      propose_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      update_background_task: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      cancel_background_task: {
        allowedDecisions: ['approve', 'reject']
      },
      delete_file: {
        allowedDecisions: ['approve', 'edit', 'reject']
      },
      web_search: {
        allowedDecisions: ['approve', 'reject']
      }
    });
  });
});
