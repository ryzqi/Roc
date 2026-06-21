import * as recordUtils from './record-utils';

export type ProviderUsageAccumulator = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export function createUsageAccumulator(): ProviderUsageAccumulator {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null
  };
}

export function updateUsageAccumulator(target: ProviderUsageAccumulator, message: unknown): void {
  const usageMetadata = recordUtils.readRecordValue(message, 'usage_metadata');
  const inputTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'input_tokens'));
  const outputTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'output_tokens'));
  const totalTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'total_tokens'));
  const inputTokenDetails = recordUtils.readRecordValue(usageMetadata, 'input_token_details');
  const cacheReadTokens = readNonNegativeInteger(recordUtils.readRecordValue(inputTokenDetails, 'cache_read'));
  const cacheCreationTokens = readNonNegativeInteger(recordUtils.readRecordValue(inputTokenDetails, 'cache_creation'));

  if (inputTokens !== null) {
    target.promptTokens = inputTokens;
  }
  if (outputTokens !== null) {
    target.completionTokens = outputTokens;
  }
  if (totalTokens !== null) {
    target.totalTokens = totalTokens;
  }
  if (cacheReadTokens !== null) {
    target.cacheReadTokens = cacheReadTokens;
  }
  if (cacheCreationTokens !== null) {
    target.cacheCreationTokens = cacheCreationTokens;
  }
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
