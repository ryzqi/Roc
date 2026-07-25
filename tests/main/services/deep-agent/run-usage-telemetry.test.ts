import { describe, expect, it } from 'vitest';

import { createUsageAccumulator, updateUsageAccumulator } from '../../../../src/main/services/deep-agent/stream-usage-accumulator';

describe('ProviderUsageAccumulator', () => {
  it('accumulates usage from every model call while replacing repeated snapshots for the same call', () => {
    const accumulator = createUsageAccumulator();

    updateUsageAccumulator(accumulator, {
      id: 'main-call',
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_token_details: { cache_read: 50 }
      }
    });
    updateUsageAccumulator(accumulator, {
      id: 'summary-call',
      usage_metadata: {
        input_tokens: 40,
        output_tokens: 10,
        total_tokens: 50,
        input_token_details: { cache_creation: 25 }
      }
    });
    updateUsageAccumulator(accumulator, {
      id: 'main-call',
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 24,
        total_tokens: 124,
        input_token_details: { cache_read: 50 }
      }
    });

    expect(accumulator).toMatchObject({
      promptTokens: 140,
      completionTokens: 34,
      totalTokens: 174,
      cacheReadTokens: 50,
      cacheCreationTokens: 25
    });
  });

  it('merges partial stream metadata for one model call without erasing earlier fields', () => {
    const accumulator = createUsageAccumulator();

    updateUsageAccumulator(accumulator, {
      id: 'retry-call',
      usage_metadata: {
        input_tokens: 80,
        input_token_details: { cache_read: 30 }
      }
    });
    updateUsageAccumulator(accumulator, {
      id: 'retry-call',
      usage_metadata: {
        output_tokens: 15,
        total_tokens: 95
      }
    });

    expect(accumulator).toMatchObject({
      promptTokens: 80,
      completionTokens: 15,
      totalTokens: 95,
      cacheReadTokens: 30,
      cacheCreationTokens: null
    });
  });

  it('does not count metadata without a stable model-call identifier', () => {
    const accumulator = createUsageAccumulator();

    updateUsageAccumulator(accumulator, {
      usage_metadata: {
        input_tokens: 80,
        output_tokens: 15,
        total_tokens: 95
      }
    });

    expect(accumulator).toMatchObject({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null
    });
  });
});
