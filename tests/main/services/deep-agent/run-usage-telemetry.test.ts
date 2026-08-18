import { describe, expect, it } from 'vitest';

import { createUsageAccumulator, updateUsageAccumulator } from '../../../../src/main/services/deep-agent/stream-usage-accumulator';

describe('ProviderUsageAccumulator', () => {
  it('accumulates usage from every model call while replacing repeated snapshots for the same call', () => {
    const accumulator = createUsageAccumulator();

    updateUsageAccumulator(accumulator, 'main-call', {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 50,
      cacheCreationTokens: null
    });
    updateUsageAccumulator(accumulator, 'summary-call', {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      cacheReadTokens: null,
      cacheCreationTokens: 25
    });
    updateUsageAccumulator(accumulator, 'main-call', {
      inputTokens: 100,
      outputTokens: 24,
      totalTokens: 124,
      cacheReadTokens: 50,
      cacheCreationTokens: null
    });

    expect(accumulator).toMatchObject({
      inputTokens: 140,
      outputTokens: 34,
      totalTokens: 174,
      cacheReadTokens: 50,
      cacheCreationTokens: 25
    });
  });

  it('merges partial stream metadata for one model call without erasing earlier fields', () => {
    const accumulator = createUsageAccumulator();

    updateUsageAccumulator(accumulator, 'retry-call', {
      inputTokens: 80,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: 30,
      cacheCreationTokens: null
    });
    updateUsageAccumulator(accumulator, 'retry-call', {
      inputTokens: null,
      outputTokens: 15,
      totalTokens: 95,
      cacheReadTokens: null,
      cacheCreationTokens: null
    });

    expect(accumulator).toMatchObject({
      inputTokens: 80,
      outputTokens: 15,
      totalTokens: 95,
      cacheReadTokens: 30,
      cacheCreationTokens: null
    });
  });

  it('rejects usage without an adapter-provided model-call key', () => {
    const accumulator = createUsageAccumulator();

    expect(() => updateUsageAccumulator(accumulator, '', {
      inputTokens: 80,
      outputTokens: 15,
      totalTokens: 95,
      cacheReadTokens: null,
      cacheCreationTokens: null
    })).toThrow('provider_usage_key_missing');
  });
});
