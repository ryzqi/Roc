import {z} from 'zod';

export const rerankerTimeoutMs = {min: 100, max: 120_000, default: 30_000} as const;

export const rerankerSettingsSchema = z.object({
  endpoint: z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol)),
  model: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(rerankerTimeoutMs.min).max(rerankerTimeoutMs.max)
}).strict();
export const rerankerConfigSchema = rerankerSettingsSchema.extend({keyConfigured: z.boolean()});
export const rerankerSaveSchema = rerankerSettingsSchema.extend({apiKey: z.string().min(1)});
export const queryRouteSchema = z.object({
  intent: z.enum(['general', 'method', 'results', 'comparison', 'dispute', 'overview']),
  documentId: z.string().nullable(),
  diversify: z.boolean()
}).strict();
export const rerankerReceiptSchema = z.object({
  status: z.enum(['not_requested', 'config_missing', 'disabled', 'timeout', 'failed', 'succeeded']),
  model: z.string().nullable(), configHash: z.string().nullable(),
  elapsedMs: z.number().nonnegative()
}).strict();
export type QueryRoute = z.infer<typeof queryRouteSchema>;
export type RerankerReceipt = z.infer<typeof rerankerReceiptSchema>;
export type RerankerSave = z.infer<typeof rerankerSaveSchema>;
