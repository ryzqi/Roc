import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * P6-04: a voluntary, default-off pilot profile.
 *
 * The pilot is never started by the normal request path. It requires an explicit opt-in written by
 * the user, a disclosed extra budget, a deterministic per-task bucket and a read-only/low-effect
 * capability profile. A circuit breaker opens on budget exhaustion or repeated failures, and the
 * user can roll back at any time; rollback also opens the breaker so nothing restarts silently.
 */

export const pilotProfiles = ['read-only', 'low-side-effect'] as const;
export type PilotProfile = (typeof pilotProfiles)[number];

const readOnlyGrants = new Set([
  'workspace.read', 'memory.read', 'research.read', 'files.preview', 'provider.model'
]);
const lowSideEffectGrants = new Set([
  ...readOnlyGrants, 'workspace.write', 'research.artifact.write'
]);
const readOnlyDeniedEffects = new Set(['external_call', 'host_execution', 'network_read', 'workspace_mutation']);
const lowSideEffectDeniedEffects = new Set(['external_call', 'host_execution', 'network_read']);

const settingsSchema = z.object({
  enabled: z.boolean(),
  profile: z.enum(pilotProfiles),
  rolloutPercent: z.number().int().min(0).max(100),
  saltRevision: z.string().min(1).max(80),
  extraBudgetMicrousd: z.number().int().min(0),
  budgetAcknowledgedAt: z.string().datetime().nullable(),
  maxFailureStreak: z.number().int().min(1).max(20),
  spentMicrousd: z.number().int().min(0),
  failureStreak: z.number().int().min(0),
  circuitOpen: z.boolean()
}).strict();

export type PilotSettings = z.infer<typeof settingsSchema>;

export const defaultPilotSettings: PilotSettings = {
  enabled: false,
  profile: 'read-only',
  rolloutPercent: 0,
  saltRevision: 'local-pilot-v1',
  extraBudgetMicrousd: 0,
  budgetAcknowledgedAt: null,
  maxFailureStreak: 2,
  spentMicrousd: 0,
  failureStreak: 0,
  circuitOpen: false
};

export type PilotDecision =
  | { start: false; reason: string }
  | {
    start: true;
    reason: 'pilot_started';
    profile: PilotProfile;
    bucket: number;
    extraBudgetMicrousd: number;
    remainingMicrousd: number;
    disclosure: string;
  };

export type PilotRequest = {
  taskId: string;
  grants: readonly string[];
  effectClasses: readonly string[];
};

function bucketFor(settings: PilotSettings, taskId: string): number {
  const digest = createHash('sha256').update(`${settings.saltRevision}:${taskId}`).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

/**
 * Pure decision. Every refusal names its reason so the caller can render a truthful state instead
 * of a silently missing optimization.
 */
export function evaluatePilotDecision(settings: PilotSettings, request: PilotRequest): PilotDecision {
  if (!settings.enabled) return { start: false, reason: 'pilot_not_opted_in' };
  if (settings.circuitOpen) return { start: false, reason: 'pilot_circuit_open' };
  if (settings.failureStreak >= settings.maxFailureStreak) return { start: false, reason: 'pilot_circuit_tripped' };
  if (settings.extraBudgetMicrousd <= 0) return { start: false, reason: 'pilot_budget_not_disclosed' };
  if (settings.budgetAcknowledgedAt === null) return { start: false, reason: 'pilot_budget_not_acknowledged' };
  if (settings.spentMicrousd >= settings.extraBudgetMicrousd) return { start: false, reason: 'pilot_budget_exhausted' };
  const bucket = bucketFor(settings, request.taskId);
  if (bucket >= settings.rolloutPercent) return { start: false, reason: 'pilot_bucket_excluded' };
  const allowed = settings.profile === 'read-only' ? readOnlyGrants : lowSideEffectGrants;
  for (const grant of request.grants) {
    if (!allowed.has(grant)) return { start: false, reason: `pilot_profile_denied:${grant}` };
  }
  // Read-only denies every effect class; low-side-effect allows declared local workspace writes
  // and still denies external, host and network effects.
  const deniedEffects = settings.profile === 'read-only' ? readOnlyDeniedEffects : lowSideEffectDeniedEffects;
  for (const effect of request.effectClasses) {
    if (deniedEffects.has(effect)) return { start: false, reason: `pilot_effect_denied:${effect}` };
  }
  return {
    start: true,
    reason: 'pilot_started',
    profile: settings.profile,
    bucket,
    extraBudgetMicrousd: settings.extraBudgetMicrousd,
    remainingMicrousd: settings.extraBudgetMicrousd - settings.spentMicrousd,
    disclosure: `Pilot ${settings.profile}: up to ${settings.extraBudgetMicrousd} microusd extra, read-only unless explicitly low-side-effect.`
  };
}

export class PilotStateStore {
  private readonly path: string;

  constructor(private readonly options: { directory: string; now?: () => string }) {
    mkdirSync(options.directory, { recursive: true });
    this.path = join(options.directory, 'pilot-state.json');
  }

  read(): PilotSettings {
    if (!existsSync(this.path)) return { ...defaultPilotSettings };
    try {
      return settingsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      throw new Error('pilot_state_corrupt');
    }
  }

  /** Opting in is explicit and cannot skip the budget acknowledgement. */
  enable(input: { profile: PilotProfile; rolloutPercent: number; extraBudgetMicrousd: number; budgetAcknowledged: boolean }): PilotSettings {
    const settings = this.read();
    if (!input.budgetAcknowledged || input.extraBudgetMicrousd <= 0) throw new Error('pilot_budget_not_acknowledged');
    if (input.rolloutPercent < 1 || input.rolloutPercent > 100) throw new Error('pilot_rollout_invalid');
    const next: PilotSettings = settingsSchema.parse({
      ...settings,
      enabled: true,
      profile: input.profile,
      rolloutPercent: input.rolloutPercent,
      extraBudgetMicrousd: input.extraBudgetMicrousd,
      budgetAcknowledgedAt: this.now(),
      spentMicrousd: 0,
      failureStreak: 0,
      circuitOpen: false
    });
    this.write(next);
    return next;
  }

  /** User-facing rollback: disable the pilot and keep the breaker open until a fresh opt-in. */
  rollback(): PilotSettings {
    const next: PilotSettings = { ...this.read(), enabled: false, circuitOpen: true, rolloutPercent: 0 };
    this.write(next);
    return next;
  }

  recordSpend(microusd: number): PilotSettings {
    if (!Number.isInteger(microusd) || microusd < 0) throw new Error('pilot_spend_invalid');
    const settings = this.read();
    const spentMicrousd = settings.spentMicrousd + microusd;
    const next: PilotSettings = {
      ...settings,
      spentMicrousd,
      circuitOpen: settings.circuitOpen || spentMicrousd >= settings.extraBudgetMicrousd
    };
    this.write(next);
    return next;
  }

  recordFailure(): PilotSettings {
    const settings = this.read();
    const failureStreak = settings.failureStreak + 1;
    const next: PilotSettings = { ...settings, failureStreak, circuitOpen: settings.circuitOpen || failureStreak >= settings.maxFailureStreak };
    this.write(next);
    return next;
  }

  decide(request: PilotRequest): PilotDecision {
    return evaluatePilotDecision(this.read(), request);
  }

  private write(settings: PilotSettings): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(settings, null, 2));
    renameSync(temporary, this.path);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}
