import * as recordUtils from './record-utils';

export type ProviderUsageAccumulator = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  callUsage: Map<string, ProviderUsageSnapshot>;
};

type ProviderUsageSnapshot = {
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
    cacheCreationTokens: null,
    callUsage: new Map()
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
  const usage: ProviderUsageSnapshot = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens
  };
  if (!hasUsage(usage)) {
    return;
  }
  const messageId = readMessageId(message);
  if (messageId === null) {
    return;
  }
  const previous = target.callUsage.get(messageId);
  target.callUsage.set(messageId, mergeUsage(previous, usage));
  const aggregate = aggregateUsage(target.callUsage.values());
  target.promptTokens = aggregate.promptTokens;
  target.completionTokens = aggregate.completionTokens;
  target.totalTokens = aggregate.totalTokens;
  target.cacheReadTokens = aggregate.cacheReadTokens;
  target.cacheCreationTokens = aggregate.cacheCreationTokens;
}

function hasUsage(usage: ProviderUsageSnapshot): boolean {
  return Object.values(usage).some((value) => value !== null);
}

function readMessageId(message: unknown): string | null {
  const id = recordUtils.readRecordValue(message, 'id');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function mergeUsage(previous: ProviderUsageSnapshot | undefined, next: ProviderUsageSnapshot): ProviderUsageSnapshot {
  return {
    promptTokens: retainPreviousUsage(previous, next.promptTokens, 'promptTokens'),
    completionTokens: retainPreviousUsage(previous, next.completionTokens, 'completionTokens'),
    totalTokens: retainPreviousUsage(previous, next.totalTokens, 'totalTokens'),
    cacheReadTokens: retainPreviousUsage(previous, next.cacheReadTokens, 'cacheReadTokens'),
    cacheCreationTokens: retainPreviousUsage(previous, next.cacheCreationTokens, 'cacheCreationTokens')
  };
}

function retainPreviousUsage(
  previous: ProviderUsageSnapshot | undefined,
  next: number | null,
  field: keyof ProviderUsageSnapshot
): number | null {
  if (next !== null) {
    return next;
  }
  return previous === undefined ? null : previous[field];
}

function aggregateUsage(usages: Iterable<ProviderUsageSnapshot>): ProviderUsageSnapshot {
  const values = [...usages];
  return {
    promptTokens: sumUsage(values, 'promptTokens'),
    completionTokens: sumUsage(values, 'completionTokens'),
    totalTokens: sumUsage(values, 'totalTokens'),
    cacheReadTokens: sumUsage(values, 'cacheReadTokens'),
    cacheCreationTokens: sumUsage(values, 'cacheCreationTokens')
  };
}

function sumUsage(usages: readonly ProviderUsageSnapshot[], field: keyof ProviderUsageSnapshot): number | null {
  let total = 0;
  let observed = false;
  for (const usage of usages) {
    const value = usage[field];
    if (value !== null) {
      total += value;
      observed = true;
    }
  }
  return observed ? total : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
