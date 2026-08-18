import type { TokenUsage } from '../../../shared/types';

export type ProviderUsageAccumulator = TokenUsage & {
  callUsage: Map<string, TokenUsage>;
};

export function createUsageAccumulator(): ProviderUsageAccumulator {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    callUsage: new Map()
  };
}

export function updateUsageAccumulator(
  target: ProviderUsageAccumulator,
  usageKey: string,
  usage: TokenUsage
): void {
  if (usageKey.length === 0) {
    throw new Error('provider_usage_key_missing');
  }
  if (!hasUsage(usage)) {
    return;
  }
  const previous = target.callUsage.get(usageKey);
  target.callUsage.set(usageKey, mergeUsage(previous, usage));
  const aggregate = aggregateUsage(target.callUsage.values());
  target.inputTokens = aggregate.inputTokens;
  target.outputTokens = aggregate.outputTokens;
  target.totalTokens = aggregate.totalTokens;
  target.cacheReadTokens = aggregate.cacheReadTokens;
  target.cacheCreationTokens = aggregate.cacheCreationTokens;
}

function hasUsage(usage: TokenUsage): boolean {
  return Object.values(usage).some((value) => value !== null);
}

function mergeUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    inputTokens: retainPreviousUsage(previous, next.inputTokens, 'inputTokens'),
    outputTokens: retainPreviousUsage(previous, next.outputTokens, 'outputTokens'),
    totalTokens: retainPreviousUsage(previous, next.totalTokens, 'totalTokens'),
    cacheReadTokens: retainPreviousUsage(previous, next.cacheReadTokens, 'cacheReadTokens'),
    cacheCreationTokens: retainPreviousUsage(previous, next.cacheCreationTokens, 'cacheCreationTokens')
  };
}

function retainPreviousUsage(
  previous: TokenUsage | undefined,
  next: number | null,
  field: keyof TokenUsage
): number | null {
  if (next !== null) {
    return next;
  }
  return previous === undefined ? null : previous[field];
}

function aggregateUsage(usages: Iterable<TokenUsage>): TokenUsage {
  const values = [...usages];
  return {
    inputTokens: sumUsage(values, 'inputTokens'),
    outputTokens: sumUsage(values, 'outputTokens'),
    totalTokens: sumUsage(values, 'totalTokens'),
    cacheReadTokens: sumUsage(values, 'cacheReadTokens'),
    cacheCreationTokens: sumUsage(values, 'cacheCreationTokens')
  };
}

function sumUsage(usages: readonly TokenUsage[], field: keyof TokenUsage): number | null {
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
