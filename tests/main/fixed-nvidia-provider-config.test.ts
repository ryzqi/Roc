import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-fixed-nvidia-provider-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('fixed NVIDIA provider config', () => {
  it('always exposes a normalized built-in OpenRouter provider while preserving configured models', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'openrouter',
          name: 'Custom Router',
          type: 'openai_compatible',
          endpoint: 'https://example.invalid/v1',
          credentialRef: 'secret:custom',
          enabled: false,
          models: [
            {
              id: 'custom/openrouter-model',
              displayName: 'Custom OpenRouter model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.1,
            maxTokens: 512,
            contextBudgetTokens: 4096
          }
        }
      ]
    });

    const providers = services.configService.getProviders().providers;
    const openRouter = providers.find((provider) => provider.id === 'openrouter');

    expect(openRouter).toEqual({
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      credentialRef: 'secret:openrouter',
      enabled: false,
      models: [
        {
          id: 'custom/openrouter-model',
          displayName: 'Custom OpenRouter model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: undefined
    });
  });

  it('always exposes a normalized built-in NVIDIA provider while preserving multiple saved models', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'nvidia',
          name: 'Custom NVIDIA',
          type: 'nvidia',
          endpoint: 'https://example.invalid',
          credentialRef: 'secret:custom',
          enabled: false,
          models: [
            {
              id: 'moonshotai/kimi-k2.6',
              displayName: 'Kimi',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            },
            {
              id: 'meta/llama-3.3-70b-instruct',
              displayName: 'Llama 3.3 70B',
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

    const providers = services.configService.getProviders().providers;
    const nvidia = providers.find((provider) => provider.id === 'nvidia');

    expect(nvidia).toEqual({
      id: 'nvidia',
      name: 'NVIDIA',
      type: 'nvidia',
      endpoint: 'https://integrate.api.nvidia.com/v1',
      credentialRef: 'secret:nvidia',
      enabled: false,
      models: [
        {
          id: 'moonshotai/kimi-k2.6',
          displayName: 'Kimi',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        },
        {
          id: 'meta/llama-3.3-70b-instruct',
          displayName: 'Llama 3.3 70B',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: {
        thinking: true
      }
    });
  });

  it('honors endpointOverride for self-hosted NIM containers', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'nvidia',
          name: 'Self-hosted',
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
              supportsToolCalls: true
            }
          ],
          options: {
            endpointOverride: 'http://localhost:8000/v1'
          }
        }
      ]
    });

    const nvidia = services.configService.getProviders().providers.find((provider) => provider.id === 'nvidia');

    expect(nvidia?.endpoint).toBe('https://integrate.api.nvidia.com/v1');
    expect(nvidia?.options?.endpointOverride).toBe('http://localhost:8000/v1');
  });

  it('always exposes a normalized built-in llama.cpp provider with a writable endpoint and optional credentials', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'llama_cpp',
          name: 'Custom llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:9090/v1',
          credentialRef: null,
          enabled: false,
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

    const providers = services.configService.getProviders().providers;
    const llamaCpp = providers.find((provider) => provider.id === 'llama_cpp');

    expect(llamaCpp).toEqual({
      id: 'llama_cpp',
      name: 'llama.cpp',
      type: 'llama_cpp',
      endpoint: 'http://127.0.0.1:9090/v1',
      credentialRef: null,
      enabled: false,
      models: [
        {
          id: 'qwen3.5-4b',
          displayName: 'Qwen 3.5 4B',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ],
      options: undefined
    });
  });

  it('drops stale saved llama.cpp credential references during normalization', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'llama_cpp',
          name: 'Custom llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:9090',
          credentialRef: 'secret:llama_cpp',
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

    const llamaCpp = services.configService.getProviders().providers.find((provider) => provider.id === 'llama_cpp');

    expect(llamaCpp).toMatchObject({
      id: 'llama_cpp',
      endpoint: 'http://127.0.0.1:9090',
      credentialRef: null
    });
  });

  it('normalizes legacy llama.cpp root endpoint to the OpenAI-compatible /v1 base path', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'llama_cpp',
          name: 'Custom llama.cpp',
          type: 'llama_cpp',
          endpoint: 'http://127.0.0.1:8081',
          credentialRef: 'secret:llama_cpp',
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

    const llamaCpp = services.configService.getProviders().providers.find((provider) => provider.id === 'llama_cpp');

    expect(llamaCpp?.endpoint).toBe('http://127.0.0.1:8081/v1');
    expect(llamaCpp?.credentialRef).toBeNull();
  });
});
