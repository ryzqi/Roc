import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail, hash } from './common.mjs';
import { BudgetController, budgetOptionsSchema } from './budget.mjs';

export { BudgetController, budgetOptionsSchema, pricingSchema } from './budget.mjs';

export const providerOptionsSchema = z.strictObject({
  maxInputBytes: z.number().int().min(1024).max(1024 * 1024).default(262144),
  requestTimeoutMs: z.number().int().min(100).max(300000).default(120000),
  taskTimeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  budget: budgetOptionsSchema.optional()
}).transform(options => ({ ...options,
  budget: { ...options.budget, maxTaskDurationMs: options.budget?.maxTaskDurationMs ?? options.taskTimeoutMs } }));
export const validateProviderOptions = value => providerOptionsSchema.parse(value);

// UTF-8 bytes reserve at least one token per byte, including the serialized tool schemas and
// metadata. Extra framing accounts for message/tool envelopes; these are upper bounds, not usage.
export function estimateChatInputTokens(body) {
  return Buffer.byteLength(JSON.stringify(body)) + 32 * (1 + (body.messages?.length ?? 0) + (body.tools?.length ?? 0));
}

async function invokeOnce(complete, body, signal, correlation) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([complete(body, signal, correlation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createProvider(config, record, { complete, budget, now, estimateInputTokens = estimateChatInputTokens }) {
  const binding = structuredClone(config);
  const controller = budget ?? new BudgetController(binding.budget ?? { maxTaskDurationMs: binding.taskTimeoutMs }, record, { now });
  controller.assertPricing(binding.providerId, binding.model);
  return {
    budget: controller,
    snapshot({ includeBudget = false, legacy = false } = {}) {
      const snapshot = controller.snapshot();
      // Explicit compatibility only: legacy subtotals hide unknown usage and cannot prove totals.
      return includeBudget ? snapshot : { requests: snapshot.requests,
        inputTokens: legacy ? snapshot.knownInputTokens ?? 0 : snapshot.inputTokens,
        outputTokens: legacy ? snapshot.knownOutputTokens ?? 0 : snapshot.outputTokens };
    },
    async complete(body, signal, { trialId = 'unscoped', requestId = randomUUID() } = {}) {
      const serialized = JSON.stringify(body), request = JSON.parse(serialized);
      if (request.model !== binding.model || request.stream !== false || request.max_tokens !== (binding.maxOutputTokens ?? 4096)
        || request.temperature !== binding.temperature) fail('policy', 'provider_request_binding_changed');
      if (Buffer.byteLength(serialized) > binding.maxInputBytes) fail('policy', 'provider_input_limit');
      signal.throwIfAborted();
      const requestHash = hash(request);
      const reservation = controller.reserve({ trialId, requestId, requestHash, kind: 'chat', providerId: binding.providerId,
        model: binding.model, inputTokens: estimateInputTokens(request), outputTokens: request.max_tokens });
      const correlation = { trialId, requestId, requestHash, requestNumber: reservation.requestNumber };
      const run = controller.checkRunDuration(correlation), task = controller.checkTaskDuration(trialId, correlation);
      const timeoutMs = Math.min(binding.requestTimeoutMs, run.remainingMs ?? Infinity, task.remainingMs ?? Infinity);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      let response;
      try {
        signal.throwIfAborted();
        controller.dispatch(requestId, correlation);
        // Keep the legacy marker immediately before transport; budget_dispatched is durable first.
        record({ type: 'provider_admitted', ...correlation });
        response = await invokeOnce(complete, request, requestSignal, correlation);
      } catch (error) {
        const state = controller.snapshot({ trialId }).reservations.find(value => value.requestId === requestId)?.state;
        if (state === 'dispatched') controller.unknown(requestId, 'provider_transport_failed');
        if (error?.failureClass) throw error;
        fail('provider', 'provider_transport_failed');
      }
      controller.settle(requestId, response?.usage);
      if (!Array.isArray(response?.choices) || response.choices.length !== 1 || !response.choices[0].message
        || response.model !== undefined && response.model !== binding.model) {
        fail('provider', 'provider_response_invalid');
      }
      record({ type: 'provider_completed', ...correlation, usage: response.usage ?? null });
      return response;
    }
  };
}
