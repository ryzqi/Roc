export const RUN_BUDGET_POLICY_VERSION = 1;
export const RUN_BUDGET_PRICING_CATALOG_VERSION = 'roc-pricing-2026-10-29-v1';
export const DEFAULT_RUN_MODEL_OUTPUT_TOKENS = 16_384;
export const DEFAULT_RUN_DEADLINE_MS = 30 * 60 * 1_000;
export const DEFAULT_RUN_MAX_MODEL_CALLS = 100;
export const DEFAULT_RUN_MAX_TOOL_CALLS = 500;
export const DEFAULT_RUN_MAX_CHILD_TASKS = 8;
export const DEFAULT_RUN_MAX_CONCURRENT_MODEL_CALLS = 4;
export const DEFAULT_RUN_MAX_CONCURRENT_TOOL_CALLS = 4;
export const DEFAULT_RUN_MAX_CONCURRENT_CHILD_TASKS = 2;
export const RUN_BUDGET_INPUT_MARGIN_MIN_TOKENS = 128;
export const RUN_BUDGET_INPUT_MARGIN_RATIO = 0.05;

export type ModelPricingCatalogEntry = {
  providerId: string;
  modelId: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
  cacheReadMicrousdPerMillionTokens: number;
  cacheWriteMicrousdPerMillionTokens: number;
  source: string;
};

/**
 * Price rows are intentionally empty until a provider publishes a stable, attributable rate for an
 * exact provider/model identifier. Mutable aliases and custom endpoints cannot be priced safely.
 */
export const RUN_MODEL_PRICING_CATALOG: Readonly<{
  version: typeof RUN_BUDGET_PRICING_CATALOG_VERSION;
  effectiveDate: '2026-10-29';
  entries: readonly ModelPricingCatalogEntry[];
}> = Object.freeze({
  version: RUN_BUDGET_PRICING_CATALOG_VERSION,
  effectiveDate: '2026-10-29',
  entries: Object.freeze([])
});

export function resolveModelPricing(input: {
  catalogVersion: string;
  providerId: string;
  modelId: string;
  asOf: string;
}): ModelPricingCatalogEntry | null {
  if (input.catalogVersion !== RUN_MODEL_PRICING_CATALOG.version) return null;
  const date = input.asOf.slice(0, 10);
  return RUN_MODEL_PRICING_CATALOG.entries.find((entry) =>
    entry.providerId === input.providerId && entry.modelId === input.modelId &&
    entry.effectiveFrom <= date && (entry.effectiveUntil === null || date < entry.effectiveUntil)
  ) ?? null;
}

export function estimateModelReservationMicrousd(input: {
  inputTokens: number;
  outputTokens: number;
  price: ModelPricingCatalogEntry;
}): number | null {
  const { inputTokens, outputTokens, price } = input;
  if (!isNonnegativeSafeInteger(inputTokens) || !isNonnegativeSafeInteger(outputTokens)) return null;
  const worstInputRate = Math.max(
    price.inputMicrousdPerMillionTokens,
    price.cacheReadMicrousdPerMillionTokens,
    price.cacheWriteMicrousdPerMillionTokens
  );
  return ceilMicrousd(
    inputTokens * worstInputRate + outputTokens * price.outputMicrousdPerMillionTokens
  );
}

export function calculateModelCostMicrousd(input: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  price: ModelPricingCatalogEntry;
}): number | null {
  const { inputTokens, outputTokens, price } = input;
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(isNonnegativeSafeInteger)) return null;
  if (cacheReadTokens + cacheWriteTokens > inputTokens) return null;
  const uncachedInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens;
  return ceilMicrousd(
    uncachedInputTokens * price.inputMicrousdPerMillionTokens +
    cacheReadTokens * price.cacheReadMicrousdPerMillionTokens +
    cacheWriteTokens * price.cacheWriteMicrousdPerMillionTokens +
    outputTokens * price.outputMicrousdPerMillionTokens
  );
}

export function resolveRunModelOutputTokens(contextWindowTokens: number, requested = DEFAULT_RUN_MODEL_OUTPUT_TOKENS): number {
  if (!isNonnegativeSafeInteger(contextWindowTokens) || contextWindowTokens <= 0 ||
    !isNonnegativeSafeInteger(requested) || requested <= 0) {
    throw new Error('run_budget_output_limit_invalid');
  }
  return Math.min(requested, DEFAULT_RUN_MODEL_OUTPUT_TOKENS, Math.max(1, Math.floor(contextWindowTokens / 4)));
}

export function deriveModelCallTokenReservation(contextWindowTokens: number, maxOutputTokens: number): number {
  if (!isNonnegativeSafeInteger(contextWindowTokens) || contextWindowTokens <= 0 ||
    !isNonnegativeSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error('run_budget_model_token_limit_invalid');
  }
  const inputMargin = Math.max(
    RUN_BUDGET_INPUT_MARGIN_MIN_TOKENS,
    Math.ceil(contextWindowTokens * RUN_BUDGET_INPUT_MARGIN_RATIO)
  );
  const reservation = contextWindowTokens + inputMargin + maxOutputTokens;
  if (!Number.isSafeInteger(reservation)) throw new Error('run_budget_model_token_limit_invalid');
  return reservation;
}

function ceilMicrousd(weightedTokenRates: number): number | null {
  if (!Number.isFinite(weightedTokenRates) || weightedTokenRates < 0) return null;
  const amount = Math.ceil(weightedTokenRates / 1_000_000);
  return Number.isSafeInteger(amount) ? amount : null;
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
