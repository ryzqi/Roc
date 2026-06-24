import { HumanMessage } from '@langchain/core/messages';
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
  it('maps combined Anthropic phase 1 and thinking options into ChatAnthropic configuration', async () => {
    services.secretService.setProviderSecret('anthropic-phase1', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'anthropic-phase1:claude-opus-4-6',
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
              id: 'claude-opus-4-6',
              displayName: 'Claude Opus 4.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            temperature: 0.8,
            maxTokens: 4000,
            anthropicBetas: ['prompt-caching-2024-07-31'],
            anthropicThinking: { mode: 'adaptive' },
            invocationKwargs: {
              metadata: { app_version: '1.0.0' }
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as {
      temperature?: number;
      maxTokens?: number;
      thinking?: unknown;
      betas?: string[];
      invocationKwargs?: unknown;
    })).toMatchObject({
      temperature: 0.8,
      maxTokens: 4000,
      thinking: { type: 'adaptive' },
      betas: ['prompt-caching-2024-07-31'],
      invocationKwargs: {
        metadata: { app_version: '1.0.0' }
      }
    });
  });


  it('maps explicit OpenAI-compatible reasoning none into OpenAI reasoning requests', async () => {
    services.secretService.setProviderSecret('openai-reasoning-none', 'sk-openai-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'openai-reasoning-none:gpt-5.1',
      providers: [
        {
          id: 'openai-reasoning-none',
          name: 'OpenAI Reasoning None',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: 'secret:openai-reasoning-none',
          enabled: true,
          models: [
            {
              id: 'gpt-5.1',
              displayName: 'GPT 5.1',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            reasoning: {
              effort: 'none'
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<Record<string, unknown>> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
      reasoning?: unknown;
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as Record<string, unknown>);
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hi')]);

    expect(completionModel.reasoning).toEqual({
      effort: 'none'
    });
    expect(requests[0]).toMatchObject({
      reasoning_effort: 'none',
      stream: true
    });
  });


  it('rejects Anthropic enabled thinking budgets below the official minimum at runtime', async () => {
    services.secretService.setProviderSecret('anthropic-runtime-invalid', 'sk-ant-test');

    const factory = new LangChainModelFactory(services.configService, services.secretService);

    await expect(
      factory.createModelForProvider(
        {
          id: 'anthropic-runtime-invalid',
          name: 'Anthropic Runtime Invalid',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-runtime-invalid',
          enabled: true,
          models: [
            {
              id: 'claude-sonnet-4-5',
              displayName: 'Claude Sonnet 4.5',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            maxTokens: 4096,
            anthropicThinking: {
              mode: 'enabled',
              budgetTokens: 1023
            }
          }
        },
        'claude-sonnet-4-5',
        { streaming: true }
      )
    ).rejects.toThrow('Anthropic thinking budget tokens 必须大于等于 1024。');
  });


  it('maps explicit Anthropic disabled thinking into ChatAnthropic configuration', async () => {
    services.secretService.setProviderSecret('anthropic-disabled', 'sk-ant-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'anthropic-disabled:claude-opus-4-6',
      providers: [
        {
          id: 'anthropic-disabled',
          name: 'Anthropic Disabled',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-disabled',
          enabled: true,
          models: [
            {
              id: 'claude-opus-4-6',
              displayName: 'Claude Opus 4.6',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            anthropicThinking: {
              mode: 'disabled'
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect((result.model as { thinking?: unknown }).thinking).toEqual({
      type: 'disabled'
    });
  });

});
