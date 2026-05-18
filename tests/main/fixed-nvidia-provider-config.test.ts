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

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('fixed NVIDIA provider config', () => {
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
});
