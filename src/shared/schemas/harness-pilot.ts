import { z } from 'zod';

/** Voluntary pilot profile and persisted run status. */

export const pilotProfileSchema = z.enum(['read-only', 'low-side-effect']);

export const pilotSettingsSchema = z
  .object({
    enabled: z.boolean(),
    profile: pilotProfileSchema,
    rolloutPercent: z.number().int().min(0).max(100),
    saltRevision: z.string().min(1).max(80),
    maxFailureStreak: z.number().int().min(1).max(20),
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
    // `cancelled` is its own terminal state: a user cancellation is not a completed pilot run.
    state: z.enum(['active', 'finished', 'cancelled']),
    createdAt: z.string()
  })
  .strict();

export const pilotStatusSchema = z
  .object({
    settings: pilotSettingsSchema,
    lastRun: pilotRunSummarySchema.nullable()
  })
  .strict();

export const pilotOptInRequestSchema = z
  .object({
    profile: pilotProfileSchema,
    rolloutPercent: z.number().int().min(1).max(100)
  })
  .strict();

export type PilotProfile = z.infer<typeof pilotProfileSchema>;
export type PilotSettings = z.infer<typeof pilotSettingsSchema>;
export type PilotRunSummary = z.infer<typeof pilotRunSummarySchema>;
export type PilotStatus = z.infer<typeof pilotStatusSchema>;
export type PilotOptInRequest = z.infer<typeof pilotOptInRequestSchema>;
