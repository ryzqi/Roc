import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHarnessProfile } from 'deepagents';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import type { ProviderConfig } from '../../src/shared/types';
import { ensureRocHarnessProfilesRegistered } from '../../src/main/services/deep-agent/harness-profiles';

describe('Roc harness profiles registration', () => {
  it('excludes the built-in SummarizationMiddleware under both provider keys', () => {
    ensureRocHarnessProfilesRegistered();

    const openai = getHarnessProfile('openai');
    const anthropic = getHarnessProfile('anthropic');

    expect(openai).toBeDefined();
    expect(anthropic).toBeDefined();
    expect(openai?.excludedMiddleware.has('SummarizationMiddleware')).toBe(true);
    expect(anthropic?.excludedMiddleware.has('SummarizationMiddleware')).toBe(true);
  });

  it('is idempotent: repeated calls neither throw nor drop the exclusion', () => {
    ensureRocHarnessProfilesRegistered();
    ensureRocHarnessProfilesRegistered();
    ensureRocHarnessProfilesRegistered();

    const openai = getHarnessProfile('openai');
    expect(Array.from(openai?.excludedMiddleware ?? [])).toContain('SummarizationMiddleware');
  });
});

describe('Roc provider → harness-profile key coverage', () => {
  let root: string;
  let services: AppServices;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roc-harness-profile-coverage-'));
    services = createAppServices(root);
    services.appService.initialize();
  });

  afterEach(async () => {
    await services.appService.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  async function resolveModelClassName(input: {
    provider: ProviderConfig;
    defaultModelId: string;
    secret?: { providerId: string; value: string };
  }): Promise<string> {
    if (input.secret) {
      services.secretService.setProviderSecret(input.secret.providerId, input.secret.value);
    }
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: input.defaultModelId,
      providers: [input.provider]
    });
    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: false });
    return (result.model as BaseChatModel).getName();
  }

  it('resolves anthropic_compatible to the "anthropic" provider key (ChatAnthropic)', async () => {
    const name = await resolveModelClassName({
      defaultModelId: 'claude-sonnet-4-5',
      secret: { providerId: 'anthropic-local', value: 'sk-ant-test' },
      provider: {
        id: 'anthropic-local',
        name: 'Anthropic Local',
        type: 'anthropic_compatible',
        endpoint: 'https://anthropic.example.test',
        credentialRef: 'secret:anthropic-local',
        enabled: true,
        models: [
          { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', enabled: true, supportsStreaming: true, supportsToolCalls: true }
        ]
      } as ProviderConfig
    });
    expect(name).toBe('ChatAnthropic');
  });

  it('resolves openai_compatible / openrouter / nvidia / llama_cpp to the "openai" provider key (ChatOpenAI)', async () => {
    const openaiCompatible = await resolveModelClassName({
      defaultModelId: 'qwen-local',
      secret: { providerId: 'openai-local', value: 'sk-openai-test' },
      provider: {
        id: 'openai-local',
        name: 'OpenAI Local',
        type: 'openai_compatible',
        endpoint: 'http://127.0.0.1:9090/v1',
        credentialRef: 'secret:openai-local',
        enabled: true,
        models: [{ id: 'qwen-local', displayName: 'Qwen Local', enabled: true, supportsStreaming: true, supportsToolCalls: true }]
      } as ProviderConfig
    });
    expect(openaiCompatible).toBe('ChatOpenAI');

    const openrouter = await resolveModelClassName({
      defaultModelId: '~openai/gpt-latest',
      secret: { providerId: 'openrouter', value: 'sk-or-v1-test' },
      provider: {
        id: 'openrouter',
        name: 'OpenRouter',
        type: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1',
        credentialRef: 'secret:openrouter',
        enabled: true,
        models: [{ id: '~openai/gpt-latest', displayName: 'OpenAI GPT Latest', enabled: true, supportsStreaming: true, supportsToolCalls: true }]
      } as ProviderConfig
    });
    expect(openrouter).toBe('ChatOpenAI');

    const nvidia = await resolveModelClassName({
      defaultModelId: 'moonshotai/kimi-k2.6',
      secret: { providerId: 'nvidia', value: 'nvapi-test' },
      provider: {
        id: 'nvidia',
        name: 'NVIDIA',
        type: 'nvidia',
        endpoint: 'https://integrate.api.nvidia.com/v1',
        credentialRef: 'secret:nvidia',
        enabled: true,
        models: [{ id: 'moonshotai/kimi-k2.6', displayName: 'Kimi K2.6', enabled: true, supportsStreaming: true, supportsToolCalls: true }]
      } as ProviderConfig
    });
    expect(nvidia).toBe('ChatOpenAI');

    const llamaCpp = await resolveModelClassName({
      defaultModelId: 'qwen3.5-4b',
      provider: {
        id: 'llama_cpp',
        name: 'llama.cpp',
        type: 'llama_cpp',
        endpoint: 'http://127.0.0.1:9090/v1',
        credentialRef: null,
        enabled: true,
        models: [{ id: 'qwen3.5-4b', displayName: 'Qwen 3.5 4B', enabled: true, supportsStreaming: true, supportsToolCalls: true }]
      } as ProviderConfig
    });
    expect(llamaCpp).toBe('ChatOpenAI');
  });

  it('registers a profile under exactly the two keys the providers resolve to', () => {
    ensureRocHarnessProfilesRegistered();
    // 上面两条用例证明 getName() 仅产出 'ChatAnthropic' / 'ChatOpenAI'，
    // getModelProvider 据此映射到 'anthropic' / 'openai'；这两个 key 必须都已注册并排除 summarization。
    expect(getHarnessProfile('anthropic')?.excludedMiddleware.has('SummarizationMiddleware')).toBe(true);
    expect(getHarnessProfile('openai')?.excludedMiddleware.has('SummarizationMiddleware')).toBe(true);
  });
});
