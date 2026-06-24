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
  it('passes NVIDIA tool_choice options to the request body', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'nvidia:meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            toolChoice: {
              type: 'function',
              function: {
                name: 'lookup'
              }
            }
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });
    const requests: Array<{ tool_choice?: unknown }> = [];
    const completionModel = result.model as unknown as {
      completions: {
        completionWithRetry: (request: unknown) => AsyncIterable<unknown>;
      };
    };
    completionModel.completions.completionWithRetry = async function* (request) {
      requests.push(request as { tool_choice?: unknown });
      yield {
        choices: [{ delta: { role: 'assistant', content: 'OK' }, index: 0, finish_reason: 'stop' }]
      };
    };

    await result.model.invoke([new HumanMessage('Hi')]);

    expect(requests[0]?.tool_choice).toEqual({
      type: 'function',
      function: {
        name: 'lookup'
      }
    });
  });


  it('uses endpointOverride as baseURL when set on NVIDIA provider', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'nvidia:meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: { endpointOverride: 'http://localhost:8000/v1' }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.baseUrl).toBe('http://localhost:8000/v1');
    expect((result.model as { clientConfig?: { baseURL?: string } }).clientConfig?.baseURL).toBe('http://localhost:8000/v1');
  });


  it('sends include_reasoning only in non-streaming NVIDIA requests', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'nvidia:qwen/qwen3-235b-a22b',
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
              id: 'qwen/qwen3-235b-a22b',
              displayName: 'Qwen3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: { includeReasoning: false }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const nonStreaming = await factory.createDefaultChatModel({ streaming: false });
    const streaming = await factory.createDefaultChatModel({ streaming: true });

    expect(nonStreaming.runtime.modelKwargs).toMatchObject({ include_reasoning: false });
    expect(streaming.runtime.modelKwargs).not.toHaveProperty('include_reasoning');
  });


  it('merges guided generation options into NVIDIA nvext', async () => {
    services.secretService.setProviderSecret('nvidia', 'nvapi-test');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'nvidia:meta/llama-3.3-70b-instruct',
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
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
            }
          ],
          options: {
            guidedJson: { type: 'object', properties: { name: { type: 'string' } } },
            guidedChoice: ['yes', 'no'],
            guidedRegex: '^[A-Z]{3}-\\d{4}$',
            guidedGrammar: '?start: "ok"'
          }
        }
      ]
    });

    const factory = new LangChainModelFactory(services.configService, services.secretService);
    const result = await factory.createDefaultChatModel({ streaming: true });

    expect(result.runtime.modelKwargs).toMatchObject({
      nvext: {
        guided_json: { type: 'object', properties: { name: { type: 'string' } } },
        guided_choice: ['yes', 'no'],
        guided_regex: '^[A-Z]{3}-\\d{4}$',
        guided_grammar: '?start: "ok"'
      }
    });
  });

});
