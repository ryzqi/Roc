export const DEFAULT_MODEL_OUTPUT_TOKENS = 16_384;

export function resolveRunModelOutputTokens(contextWindowTokens: number, requested = DEFAULT_MODEL_OUTPUT_TOKENS): number {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0 ||
      !Number.isSafeInteger(requested) || requested <= 0) throw new Error('model_output_limit_invalid');
  return Math.min(requested, Math.max(1, Math.floor(contextWindowTokens / 4)));
}
