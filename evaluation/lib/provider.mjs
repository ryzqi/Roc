import { z } from 'zod';
import { fail } from './common.mjs';

export const providerOptionsSchema = z.strictObject({
  maxInputBytes: z.number().int().min(1024).max(1024 * 1024).default(262144),
  requestTimeoutMs: z.number().int().min(100).max(300000).default(120000),
  taskTimeoutMs: z.number().int().min(1000).max(3600000).default(300000)
});
export const validateProviderOptions = value => providerOptionsSchema.parse(value);
export function createProvider(config, record, { complete }) {
  let requests = 0, inputTokens = 0, outputTokens = 0;
  return {
    snapshot: () => ({ requests, inputTokens, outputTokens }),
    async complete(body, signal) {
      const bytes = Buffer.byteLength(JSON.stringify(body));
      if (body.model !== config.model || body.stream !== false || body.max_tokens !== 4096 || body.temperature !== config.temperature) fail('policy', 'provider_request_binding_changed');
      if (bytes > config.maxInputBytes) fail('policy', 'provider_input_limit');
      const requestNumber = ++requests;
      record({ type: 'provider_admitted', requestNumber });
      signal.throwIfAborted();
      let response;
      try {
        response = await complete(body, AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]));
        if (!Array.isArray(response.choices) || response.choices.length !== 1 || !response.choices[0].message) fail('provider', 'provider_response_invalid');
      } catch (error) {
        if (error.failureClass) throw error;
        fail('provider', 'provider_transport_failed');
      }
      const usage = response.usage;
      if (Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) {
        inputTokens += usage.prompt_tokens;
        outputTokens += usage.completion_tokens;
      }
      record({ type: 'provider_completed', requestNumber, usage: usage ?? null });
      return response;
    }
  };
}
