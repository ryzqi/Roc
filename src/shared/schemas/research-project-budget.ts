import { z } from 'zod';

const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectId = z.string().trim().min(1).max(256);
export const researchProjectBudgetLimitsSchema = z.object({
  maxTotalTokens: count, maxModelCalls: count, maxConcurrentModelCalls: count,
  maxCostMicrousd: amount.nullable()
}).strict();
export const researchProjectBudgetRequestSchema = z.object({ projectId }).strict();
export const researchProjectBudgetSaveSchema = researchProjectBudgetRequestSchema.extend({
  expectedRevision: amount, limits: researchProjectBudgetLimitsSchema
}).strict();
export const researchProjectBudgetStatusSchema = z.object({
  projectId, policyVersion: z.literal(1), revision: count, limits: researchProjectBudgetLimitsSchema,
  tokens: z.object({ settled: amount, unknown: amount, reserved: amount, remaining: amount }).strict(),
  models: z.object({ total: amount, reserved: amount }).strict(),
  cost: z.object({ state: z.enum(['known', 'unknown']), settledMicrousd: amount, reservedMicrousd: amount }).strict(),
  stopReason: z.string().nullable(), updatedAt: z.iso.datetime()
}).strict();
export type ResearchProjectBudgetLimits = z.infer<typeof researchProjectBudgetLimitsSchema>;
export type ResearchProjectBudgetStatus = z.infer<typeof researchProjectBudgetStatusSchema>;
export type ResearchProjectBudgetUpdated = z.infer<typeof researchProjectBudgetRequestSchema>;
