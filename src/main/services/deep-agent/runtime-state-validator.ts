import type { ProviderUsageAccumulator } from './stream-usage-accumulator';

export type RuntimeStateValidationError = {
  code: string;
  message: string;
  diagnostics: Record<string, unknown>;
};

// Context windows are enforced before individual requests by the context pipeline.
export function validateRunTokenBudget(
  usage: ProviderUsageAccumulator,
  maxTotalTokens: number | null
): RuntimeStateValidationError | null {
  if (maxTotalTokens === null || usage.totalTokens === null || usage.totalTokens <= maxTotalTokens) return null;
  return {
    code: 'run_total_token_budget_exhausted',
    message: `运行累计 token (${usage.totalTokens}) 超出总额度 (${maxTotalTokens})`,
    diagnostics: { totalTokens: usage.totalTokens, maxTotalTokens }
  };
}
