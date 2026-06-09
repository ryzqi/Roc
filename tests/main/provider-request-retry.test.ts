import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';
import { RocDomainError } from '../../src/main/services/errors';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-provider-retry-');
  services.secretService.setProviderSecret('provider-local', 'sk-local-test-secret');
  services.configService.saveProviders({
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
});
afterEach(async () => {
  vi.useRealTimers();
  await services.cleanup();
});

describe('Provider request retry behavior', () => {
  it('retries timeout failures up to three times before returning the final error', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => {
      throw new RocDomainError({
        code: 'provider_request_timeout',
        message: 'Provider 请求超时，请稍后重试或检查 Provider endpoint。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider endpoint 是否可访问。'
      });
    });
    Reflect.set(services.providerRuntimeService as object, 'deterministicTransport', transport);

    const resultPromise = services.providerRuntimeService.testProvider('provider-local');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(transport).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      providerId: 'provider-local',
      status: 'invalid',
      modelId: 'model-tools',
      error: 'Provider 请求超时，请稍后重试或检查 Provider endpoint。'
    });
    expect(services.metricsService.query({ name: 'provider.request.total' })).toHaveLength(4);
    expect(services.metricsService.query({ name: 'provider.request.errors', labels: { kind: 'timeout' } })).toHaveLength(4);
  });

  it('retries network failures up to three times before returning the final error', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => {
      throw new RocDomainError({
        code: 'provider_network_error',
        message: 'Provider 网络请求失败：fetch failed',
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider 网络、endpoint 和本机代理设置后重试。'
      });
    });
    Reflect.set(services.providerRuntimeService as object, 'deterministicTransport', transport);

    const resultPromise = services.providerRuntimeService.testProvider('provider-local');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(transport).toHaveBeenCalledTimes(4);
    expect(result.error).toBe('Provider 网络请求失败：fetch failed');
  });

  it('retries empty provider responses up to three times before returning the final error', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => {
      throw new RocDomainError({
        code: 'provider_empty_response',
        message: 'Provider 返回了空回复。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider 模型配置。'
      });
    });
    Reflect.set(services.providerRuntimeService as object, 'deterministicTransport', transport);

    const resultPromise = services.providerRuntimeService.testProvider('provider-local');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(transport).toHaveBeenCalledTimes(4);
    expect(result.error).toBe('Provider 返回了空回复。');
  });

  it('retries HTTP 429 failures up to three times before returning the final error', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(() => {
      throw new RocDomainError({
        code: 'provider_http_error',
        message: 'Provider 请求失败：HTTP 429 rate limited',
        category: 'external',
        retryable: true,
        userAction: '请检查 Provider endpoint、凭据、模型名称和服务状态后重试。'
      });
    });
    Reflect.set(services.providerRuntimeService as object, 'deterministicTransport', transport);

    const resultPromise = services.providerRuntimeService.testProvider('provider-local');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(transport).toHaveBeenCalledTimes(4);
    expect(result.error).toBe('Provider 请求失败：HTTP 429 rate limited');
  });

  it('does not retry HTTP 400 failures', async () => {
    const transport = vi.fn(() => {
      throw new RocDomainError({
        code: 'provider_http_error',
        message: 'Provider 请求失败：HTTP 400 invalid request',
        category: 'external',
        retryable: false,
        userAction: '请检查 Provider endpoint、凭据、模型名称和服务状态后重试。'
      });
    });
    Reflect.set(services.providerRuntimeService as object, 'deterministicTransport', transport);

    const result = await services.providerRuntimeService.testProvider('provider-local');

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.error).toBe('Provider 请求失败：HTTP 400 invalid request');
  });

  it('stops retrying as soon as a later attempt succeeds', async () => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new RocDomainError({
          code: 'provider_request_timeout',
          message: 'Provider 请求超时，请稍后重试或检查 Provider endpoint。',
          category: 'external',
          retryable: true,
          userAction: '请稍后重试，或检查 Provider endpoint 是否可访问。'
        });
      })
      .mockImplementationOnce(() => ({
        content: 'OK',
        finishReason: 'stop'
      }));
    Reflect.set(services.providerRuntimeService as object, 'deterministicTransport', transport);

    const resultPromise = services.providerRuntimeService.testProvider('provider-local');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(transport).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      providerId: 'provider-local',
      status: 'ready',
      modelId: 'model-tools',
      error: null
    });
  });
});
