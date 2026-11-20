export type SamplingProfile = {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
};

const FAMILY_DEFAULTS = {
  // https://huggingface.co/Qwen/Qwen3-8B-Instruct
  qwen3: { temperature: 0.6, topP: 0.95, topK: 20 },
  // https://huggingface.co/Qwen/Qwen3.5-27B-A3B-Instruct
  'qwen3.5': { temperature: 1.0, topP: 0.95, topK: 20 },
  // https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct
  'qwen3-coder': { temperature: 0.7, topP: 0.8, topK: 20 },
  // https://huggingface.co/mistralai/Ministral-3B-Instruct-2410
  'ministral-3': { temperature: 0.05 },
  // https://huggingface.co/ibm-granite/granite-4.0-2b-instruct
  'granite-4': { temperature: 0, topP: 1, topK: 0 },
  // https://huggingface.co/google/gemma-4-it
  'gemma-4': { temperature: 0.7, topP: 0.95, topK: 50 }
} as const satisfies Record<string, SamplingProfile>;

type FamilyKey = keyof typeof FAMILY_DEFAULTS;

const FAMILY_RESOLVERS: ReadonlyArray<{ pattern: RegExp; family: FamilyKey }> = [
  { pattern: /Qwen3-Coder/i, family: 'qwen3-coder' },
  { pattern: /Qwen3\.5/i, family: 'qwen3.5' },
  { pattern: /Qwen3/i, family: 'qwen3' },
  { pattern: /Ministral-3/i, family: 'ministral-3' },
  { pattern: /granite-4/i, family: 'granite-4' },
  { pattern: /gemma-4/i, family: 'gemma-4' }
];

export function resolveSamplingProfile(modelId: string): SamplingProfile | null {
  for (const resolver of FAMILY_RESOLVERS) {
    if (resolver.pattern.test(modelId)) {
      return { ...FAMILY_DEFAULTS[resolver.family] };
    }
  }
  return null;
}

export function applyProviderOverride(base: SamplingProfile, override: Partial<SamplingProfile>): SamplingProfile {
  const merged: SamplingProfile = { ...base };
  for (const key of ['temperature', 'topP', 'topK', 'minP', 'presencePenalty', 'repeatPenalty'] as const) {
    if (override[key] !== undefined) {
      merged[key] = override[key];
    }
  }
  return merged;
}
