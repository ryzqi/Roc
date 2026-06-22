import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-model-factory-');
});
afterEach(async () => {
  await services.cleanup();
});


describe('LangChainModelFactory', () => {
  it('keeps Anthropic-compatible behavior unchanged without phase 1 fields', async () => {
    services.secretService.setProviderSecret('anthropic-phase1', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-sonnet-4-6',
      providers: [
        {
          id: 'anthropic-phase1',
          name: 'Anthropic Phase 1',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-phase1',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-6',
              displayName: 'Claude Sonnet 4.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.7,
            maxTokens: 2000
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as {
      temperature?: number;
      maxTokens?: number;
      betas?: string[];
      invocationKwargs?: Record<string, unknown>;
    })).toMatchObject({
      temperature: 0.7,
      maxTokens: 2000,
      invocationKwargs: {}
    });
    expect((result.model as { betas?: string[] }).betas).toBeUndefined();
  });


  it('ignores legacy Anthropic cache TTL inputs and leaves cache_control to deepagents middleware', async () => {
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
    const result = await factory.createDefaultChatModel({ streaming: true, cacheTtl: '1h' } as never);

    expect((result.model as { defaultOptions?: { cache_control?: { type: string; ttl?: string } } }).defaultOptions?.cache_control).toBeUndefined();
  });

});

