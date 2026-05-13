import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-langchain-model-factory-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('LangChainModelFactory', () => {
  it('builds a fixed NVIDIA ChatOpenAI model with thinking kwargs', async () => {
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
            thinking: true,
            temperature: 0.2,
            maxTokens: 2048
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel();

    expect(result.provider.id).toBe('nvidia');
    expect(result.modelId).toBe('moonshotai/kimi-k2.6');
    expect(result.runtime.providerType).toBe('nvidia');
    expect(result.runtime.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(result.runtime.streaming).toBe(true);
    expect(result.runtime.modelKwargs).toMatchObject({
      chat_template_kwargs: {
        thinking: true
      }
    });
    expect((result.model as { timeout?: number }).timeout).toBe(60_000);
    expect((result.model as { clientConfig?: { maxRetries?: number } }).clientConfig?.maxRetries).toBe(0);
  });

  it('builds anthropic-compatible models with a 60 second request timeout', async () => {
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

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel();

    expect(result.provider.id).toBe('anthropic-local');
    expect(result.modelId).toBe('claude-sonnet-4-5');
    expect((result.model as { clientOptions?: { timeout?: number; maxRetries?: number } }).clientOptions).toMatchObject({
      timeout: 60_000,
      maxRetries: 0
    });
  });
});
