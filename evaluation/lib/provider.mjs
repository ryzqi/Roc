import { z } from 'zod';
import { fail } from './common.mjs';

export const budgetSchema = z.strictObject({
  maxRequestsPerTask: z.number().int().min(1).max(100).default(12),
  maxInputBytes: z.number().int().min(1024).max(1024 * 1024).default(262144),
  requestTimeoutMs: z.number().int().min(100).max(300000).default(120000),
  taskTimeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  maxTotalRequests: z.number().int().positive().default(60),
  maxTotalEstimatedUsd: z.number().positive().optional(),
  pricing: z.strictObject({ version: z.string().min(1), inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative() }).optional()
}).refine(c => (c.pricing === undefined) === (c.maxTotalEstimatedUsd === undefined), 'pricing_and_estimate_required_together');
export const validateBudget = value => budgetSchema.parse(value);
export function createProvider(config, record, { complete }) {
  let requests = 0, reservedUsd = 0, knownUsd = 0, unknown = false, inputTokens = 0, outputTokens = 0;
  // Byte count + message framing is an estimate, not a provider-enforced billing cap.
  // Keep both a hard request limit and a conservative estimated-spend admission limit.
  return {
    snapshot: () => ({ requests, reservedUsd, knownUsd, costUsd: unknown || !config.pricing ? null : knownUsd, inputTokens, outputTokens,
      costBasis: config.pricing ? 'configured-price-estimate' : 'unknown-no-price-configured', billingCapEnforced: false }),
    async complete(body, signal) {
      const bytes = Buffer.byteLength(JSON.stringify(body));
      if (body.model !== config.model || body.stream !== false || body.max_tokens !== 4096 || body.temperature !== config.temperature) fail('policy', 'provider_request_binding_changed');
      if (bytes > config.maxInputBytes) fail('policy', 'provider_input_limit');
      const ceiling = config.pricing ? ((bytes + 1024) * config.pricing.inputPerMillion + 4096 * config.pricing.outputPerMillion) / 1e6 : 0;
      if (requests >= config.maxTotalRequests || (config.maxTotalEstimatedUsd !== undefined && reservedUsd + ceiling > config.maxTotalEstimatedUsd)) fail('budget', 'provider_run_budget_exhausted');
      requests++; reservedUsd += ceiling;
      // Reserve durably before network dispatch. Unknown/failed requests retain their ceiling.
      record({ type: 'provider_admitted', requestNumber: requests, reservedUsd, estimatedCeilingUsd: ceiling });
      signal.throwIfAborted();
      let response;
      try {
        response = await complete(body, AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]));
        if (!Array.isArray(response.choices) || response.choices.length !== 1 || !response.choices[0].message) fail('provider', 'provider_response_invalid');
      } catch (error) {
        unknown = true;
        if (error.failureClass) throw error;
        fail('provider', 'provider_transport_failed'); // Never persist headers, URL queries or server bodies in errors.
      }
      const usage = response.usage;
      let costUsd = null;
      if (Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) {
        inputTokens += usage.prompt_tokens; outputTokens += usage.completion_tokens;
        costUsd = config.pricing ? (usage.prompt_tokens * config.pricing.inputPerMillion + usage.completion_tokens * config.pricing.outputPerMillion) / 1e6 : null;
        knownUsd += costUsd ?? 0;
        if (usage.completion_tokens > 4096 || (costUsd !== null && costUsd > ceiling)) { unknown = true; fail('policy', 'provider_usage_exceeds_reservation'); }
        reservedUsd -= ceiling - (costUsd ?? 0);
      } else unknown = true;
      record({ type: 'provider_completed', requestNumber: requests, costUsd, usage: usage ?? null });
      return response;
    }
  };
}
