import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  pilotSettingsSchema,
  type PilotProfile,
  type PilotOptInRequest,
  type PilotSettings
} from '../../../shared/schemas/harness-pilot';

/** Explicit opt-in, task rollout and capability checks for pilot runs. */

const readOnlyGrants = new Set([
  'workspace.read', 'memory.read', 'research.read', 'files.preview', 'provider.model'
]);
const lowSideEffectGrants = new Set([
  ...readOnlyGrants, 'workspace.write', 'research.artifact.write'
]);
const readOnlyDeniedEffects = new Set(['external_call', 'host_execution', 'network_read', 'workspace_mutation']);
const lowSideEffectDeniedEffects = new Set(['external_call', 'host_execution', 'network_read']);

export const defaultPilotSettings: PilotSettings = {
  enabled: false,
  profile: 'read-only',
  rolloutPercent: 0,
  saltRevision: 'local-pilot-v1',
  maxFailureStreak: 2,
  failureStreak: 0,
  circuitOpen: false,
  breakerReason: null
};

export type PilotDecision =
  | { start: false; reason: string }
  | {
    start: true;
    reason: 'pilot_started';
    profile: PilotProfile;
    bucket: number;
    disclosure: string;
  };

export type PilotRequest = {
  taskId: string;
  grants: readonly string[];
  effectClasses: readonly string[];
};

/** One predicate per profile dimension, so the decision and the manifest restriction cannot disagree. */
export function isGrantAllowedForProfile(profile: PilotProfile, grant: string): boolean {
  return (profile === 'read-only' ? readOnlyGrants : lowSideEffectGrants).has(grant);
}

export function isEffectAllowedForProfile(profile: PilotProfile, effectClass: string): boolean {
  return !(profile === 'read-only' ? readOnlyDeniedEffects : lowSideEffectDeniedEffects).has(effectClass);
}

export function bucketForTask(settings: PilotSettings, taskId: string): number {
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
  const bucket = bucketForTask(settings, request.taskId);
  if (bucket >= settings.rolloutPercent) return { start: false, reason: 'pilot_bucket_excluded' };
  for (const grant of request.grants) {
    if (!isGrantAllowedForProfile(settings.profile, grant)) {
      return { start: false, reason: `pilot_profile_denied:${grant}` };
    }
  }
  // Read-only denies every effect class; low-side-effect allows declared local workspace writes
  // and still denies external, host and network effects.
  for (const effect of request.effectClasses) {
    if (!isEffectAllowedForProfile(settings.profile, effect)) {
      return { start: false, reason: `pilot_effect_denied:${effect}` };
    }
  }
  return {
    start: true,
    reason: 'pilot_started',
    profile: settings.profile,
    bucket,
    disclosure: `Pilot ${settings.profile}: restricted capabilities, user rollback available.`
  };
}

export class PilotStateStore {
  private readonly path: string;

  constructor(options: { directory: string; now?: () => string }) {
    mkdirSync(options.directory, { recursive: true });
    this.path = join(options.directory, 'pilot-state.json');
  }

  read(): PilotSettings {
    if (!existsSync(this.path)) return { ...defaultPilotSettings };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      return pilotSettingsSchema.parse(raw);
    } catch {
      throw new Error('pilot_state_corrupt');
    }
  }

  enable(input: PilotOptInRequest): PilotSettings {
    const settings = this.read();
    if (input.rolloutPercent < 1 || input.rolloutPercent > 100) throw new Error('pilot_rollout_invalid');
    const next: PilotSettings = pilotSettingsSchema.parse({
      ...settings,
      enabled: true,
      profile: input.profile,
      rolloutPercent: input.rolloutPercent,
      failureStreak: 0,
      circuitOpen: false,
      breakerReason: null
    });
    this.write(next);
    return next;
  }

  /** User-facing rollback: disable the pilot and keep the breaker open until a fresh opt-in. */
  rollback(): PilotSettings {
    const next: PilotSettings = {
      ...this.read(),
      enabled: false,
      circuitOpen: true,
      rolloutPercent: 0,
      breakerReason: 'user_rollback'
    };
    this.write(next);
    return next;
  }

  recordFailure(): PilotSettings {
    const settings = this.read();
    const failureStreak = settings.failureStreak + 1;
    const tripped = failureStreak >= settings.maxFailureStreak;
    const next: PilotSettings = {
      ...settings,
      failureStreak,
      circuitOpen: settings.circuitOpen || tripped,
      breakerReason: settings.breakerReason ?? (tripped ? 'pilot_failure_streak' : null)
    };
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
}
