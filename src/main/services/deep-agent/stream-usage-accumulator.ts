import type { DeepAgents110V3Usage } from './deep-agents-1-10-stream-adapter';

export type ProviderUsageAccumulator = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  callUsage: Map<string, ProviderUsageSnapshot>;
};

type ProviderUsageSnapshot = DeepAgents110V3Usage;

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

export function updateUsageAccumulator(
  target: ProviderUsageAccumulator,
  usageKey: string,
  usage: DeepAgents110V3Usage
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
  target.promptTokens = aggregate.inputTokens;
  target.completionTokens = aggregate.outputTokens;
  target.totalTokens = aggregate.totalTokens;
  target.cacheReadTokens = aggregate.cacheReadTokens;
  target.cacheCreationTokens = aggregate.cacheCreationTokens;
}

function hasUsage(usage: ProviderUsageSnapshot): boolean {
  return Object.values(usage).some((value) => value !== null);
}

function mergeUsage(previous: ProviderUsageSnapshot | undefined, next: ProviderUsageSnapshot): ProviderUsageSnapshot {
  return {
    inputTokens: retainPreviousUsage(previous, next.inputTokens, 'inputTokens'),
    outputTokens: retainPreviousUsage(previous, next.outputTokens, 'outputTokens'),
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
    inputTokens: sumUsage(values, 'inputTokens'),
    outputTokens: sumUsage(values, 'outputTokens'),
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
