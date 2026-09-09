import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangChainModelFactory } from '../../src/main/services/langchain-model-factory';
import type { ProviderConfig, ProviderModelOptions } from '../../src/shared/types';
import { createProviderTestServices, type ProviderTestServices } from './provider-test-fixture';

let services: ProviderTestServices;

beforeEach(() => {
  services = createProviderTestServices('roc-langchain-model-factory-');
});
afterEach(async () => {
  await services.cleanup();
});


describe('LangChainModelFactory', () => {
  describe('buildAnthropicClientOptions', () => {
    it('uses provider timeout when configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          timeout?: number;
          maxRetries?: number;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {
          timeoutMs: 30_000
        }
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.timeout).toBe(30_000);
      expect(result.maxRetries).toBe(0);
    });

    it('uses the default timeout when provider timeout is not configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          timeout?: number;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {}
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.timeout).toBe(60_000);
    });

    it('includes default headers when configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          defaultHeaders?: Record<string, string>;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {
          defaultHeaders: { 'X-Custom': 'value' }
        }
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.defaultHeaders).toEqual({ 'X-Custom': 'value' });
    });

    it('omits default headers when they are not configured', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        buildAnthropicClientOptions(provider: ProviderConfig, timeoutMs: number): {
          defaultHeaders?: Record<string, string>;
        };
      };
      const provider = {
        type: 'anthropic_compatible',
        options: {}
      } as unknown as ProviderConfig;

      const result = factory.buildAnthropicClientOptions(provider, 60_000);

      expect(result.defaultHeaders).toBeUndefined();
    });
  });


  describe('applyAnthropicSamplingParams', () => {
    it('applies all configured sampling params', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicSamplingParams(config: Record<string, unknown>, options: ProviderModelOptions): void;
      };
      const config: Record<string, unknown> = {};
      const options: ProviderModelOptions = {
        temperature: 0.7,
        maxTokens: 1000,
        topP: 0.9,
        topK: 10,
        stop: ['stop1', 'stop2']
      };

      factory.applyAnthropicSamplingParams(config, options);

      expect(config.temperature).toBe(0.7);
      expect(config.maxTokens).toBe(1000);
      expect(config.topP).toBe(0.9);
      expect(config.topK).toBe(10);
      expect(config.stopSequences).toEqual(['stop1', 'stop2']);
    });

    it('skips undefined sampling params', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicSamplingParams(config: Record<string, unknown>, options: ProviderModelOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicSamplingParams(config, { temperature: 0.7 });

      expect(config.temperature).toBe(0.7);
      expect(config.maxTokens).toBeUndefined();
      expect(config.topP).toBeUndefined();
    });

    it('skips empty stop arrays', () => {
      const factory = new LangChainModelFactory(services.configService, services.secretService) as unknown as {
        applyAnthropicSamplingParams(config: Record<string, unknown>, options: ProviderModelOptions): void;
      };
      const config: Record<string, unknown> = {};

      factory.applyAnthropicSamplingParams(config, { stop: [] });

      expect(config.stopSequences).toBeUndefined();
    });
  });
});
