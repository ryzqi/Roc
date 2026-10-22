import { z } from 'zod';

/**
 * P6-04 pilot profile, shared by the main-process gate, the IPC contract and the settings surface.
 *
 * The pilot is a voluntary, default-off profile. Two facts are encoded here rather than in prose:
 * a start decision always names the extra allowance it spends, and cost is declared `unknown`
 * because Roc has no price table — the gate must never present a fabricated USD figure.
 */

export const pilotProfileSchema = z.enum(['read-only', 'low-side-effect']);

/** Extra headroom a pilot run may spend *above* its frozen run budget, in units the harness can measure. */
export const pilotAllowanceSchema = z
  .object({
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative()
  })
  .strict();

export const pilotSettingsSchema = z
  .object({
    enabled: z.boolean(),
    profile: pilotProfileSchema,
    rolloutPercent: z.number().int().min(0).max(100),
    saltRevision: z.string().min(1).max(80),
    extraBudgetMicrousd: z.number().int().min(0),
    budgetAcknowledgedAt: z.string().datetime().nullable(),
    maxFailureStreak: z.number().int().min(1).max(20),
    spentMicrousd: z.number().int().min(0),
    failureStreak: z.number().int().min(0),
    circuitOpen: z.boolean(),
    // Why the breaker opened. Null while closed, so a tripped pilot can explain itself instead of
    // silently refusing every task.
    breakerReason: z.string().max(120).nullable().default(null)
  })
  .strict();

/** One persisted pilot run, as the settings surface reads it back. */
export const pilotRunSummarySchema = z
  .object({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    decision: z.string().min(1),
    // What the user was told when the pilot started, kept per run so the disclosure is auditable.
    disclosure: z.string().min(1),
    profile: pilotProfileSchema.nullable(),
    bucket: z.number().int().min(0).max(99),
    extraBudgetMicrousd: z.number().int().min(0),
    allowance: pilotAllowanceSchema,
    spent: pilotAllowanceSchema,
    // `cancelled` is its own terminal state: a user cancellation is not a completed pilot run.
    state: z.enum(['active', 'exhausted', 'finished', 'cancelled']),
    createdAt: z.string()
  })
  .strict();

export const pilotStatusSchema = z
  .object({
    settings: pilotSettingsSchema,
    allowance: pilotAllowanceSchema,
    costState: z.literal('unknown_without_price_table'),
    lastRun: pilotRunSummarySchema.nullable()
  })
  .strict();

/** Opt-in cannot skip the budget acknowledgement; the IPC contract enforces the same rule. */
export const pilotOptInRequestSchema = z
  .object({
    profile: pilotProfileSchema,
    rolloutPercent: z.number().int().min(1).max(100),
    extraBudgetMicrousd: z.number().int().positive(),
    budgetAcknowledged: z.boolean()
  })
  .strict();

export type PilotProfile = z.infer<typeof pilotProfileSchema>;
export type PilotAllowance = z.infer<typeof pilotAllowanceSchema>;
export type PilotSettings = z.infer<typeof pilotSettingsSchema>;
export type PilotRunSummary = z.infer<typeof pilotRunSummarySchema>;
export type PilotStatus = z.infer<typeof pilotStatusSchema>;
export type PilotOptInRequest = z.infer<typeof pilotOptInRequestSchema>;
