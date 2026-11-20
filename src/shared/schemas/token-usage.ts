import { z } from 'zod';

const nullableTokenCountSchema = z.number().int().nonnegative().nullable();

export const tokenUsageSchema = z
  .object({
    inputTokens: nullableTokenCountSchema,
    outputTokens: nullableTokenCountSchema,
    totalTokens: nullableTokenCountSchema,
    cacheReadTokens: nullableTokenCountSchema,
    cacheCreationTokens: nullableTokenCountSchema
  })
  .strict();

export type TokenUsage = z.infer<typeof tokenUsageSchema>;
