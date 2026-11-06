import { setTimeout as delay } from 'node:timers/promises';
import { ToolResourceCoordinator } from '../../services/deep-agent/tool-resource-coordinator';
import type { LiteratureSearchResult } from '../../../shared/schemas/literature-import';

export const researchProviderHosts = {
  openalex: 'api.openalex.org', crossref: 'api.crossref.org',
  semantic_scholar: 'api.semanticscholar.org', arxiv: 'export.arxiv.org',
  pubmed: 'www.ebi.ac.uk', europe_pmc: 'www.ebi.ac.uk', datacite: 'api.datacite.org', huggingface: 'huggingface.co'
} as const;
export type ResearchMetadataProvider = keyof typeof researchProviderHosts;

export type LiteratureProviderPolicy = {
  minIntervalMs: number; maxRequests: number; windowMs: number;
  failureThreshold: number; cooldownMs: number;
};
type Health = {
  used: number; resetAt: number; nextAt: number; retryAt: number; circuitAt: number;
  failures: number; intervalMs: number; lastSuccessAt: string | null; lastFailureAt: string | null;
};
type Observation = LiteratureSearchResult['sources'][number]['governance'];

export class LiteratureProviderAdmissionError extends Error {
  constructor(readonly code: 'literature_provider_quota_exhausted' | 'literature_provider_cooldown', readonly retryAfterMs: number) {
    super(code);
  }
}

/** Shared host admission uses the existing FIFO coordinator; cache reads never enter it. */
export class LiteratureProviderGovernor {
  private readonly coordinator = new ToolResourceCoordinator();
  private readonly health = new Map<string, Health>();

  constructor(
    private readonly policies: Readonly<Record<string, LiteratureProviderPolicy>>,
    private readonly now: () => number,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  ) {}

  async acquire(host: string, signal: AbortSignal): Promise<() => void> {
    const release = await this.coordinator.acquire([{kind: 'network', key: `literature:${host}`, access: 'write'}], signal);
    try {
      signal.throwIfAborted();
      let health = this.state(host);
      this.checkAdmission(host, health);
      // Recheck time after waiting: another outcome may have extended host cooldown.
      while (Math.max(health.nextAt, health.retryAt) > this.now()) {
        await this.wait(Math.min(1000, Math.max(health.nextAt, health.retryAt) - this.now()), signal);
        signal.throwIfAborted();
        health = this.state(host);
        this.checkAdmission(host, health);
      }
      health.used++;
      health.nextAt = this.now() + health.intervalMs;
      return release;
    } catch (error) { release(); throw error; }
  }

  success(host: string): void {
    const health = this.state(host);
    health.failures = 0;
    health.retryAt = 0;
    health.circuitAt = 0;
    health.lastSuccessAt = new Date(this.now()).toISOString();
  }

  failure(host: string, retryAfterMs: number | null): void {
    const health = this.state(host);
    const policy = this.policy(host);
    health.failures++;
    health.lastFailureAt = new Date(this.now()).toISOString();
    if (retryAfterMs !== null) health.retryAt = Math.max(health.retryAt, this.now() + retryAfterMs);
    if (health.failures >= policy.failureThreshold) health.circuitAt = Math.max(health.circuitAt, this.now() + policy.cooldownMs);
  }

  responseLimits(host: string, headers: Headers): void {
    const limitText = headers.get('x-rate-limit-limit');
    const intervalText = headers.get('x-rate-limit-interval');
    if (limitText === null || intervalText === null) return;
    const limit = Number(limitText);
    const match = /^(\d+(?:\.\d+)?)s$/u.exec(intervalText);
    if (!Number.isFinite(limit) || limit <= 0 || match === null) return;
    const interval = Number(match[1]) * 1000 / limit;
    if (!Number.isFinite(interval) || interval <= 0) return;
    const health = this.state(host);
    const previous = health.intervalMs;
    health.intervalMs = Math.max(previous, interval);
    health.nextAt += health.intervalMs - previous;
  }

  observe(host: string): Observation {
    const health = this.state(host);
    const policy = this.policy(host);
    const cooldownUntil = Math.max(health.retryAt, health.circuitAt);
    return {
      host, state: health.used >= policy.maxRequests ? 'quota_exhausted' :
        cooldownUntil > this.now() ? 'cooldown' : health.failures > 0 ? 'degraded' :
          health.lastSuccessAt === null ? 'unknown' : 'healthy',
      consecutiveFailures: health.failures, remainingRequests: policy.maxRequests - health.used,
      quotaResetAt: new Date(health.resetAt).toISOString(), minIntervalMs: health.intervalMs,
      cooldownUntil: cooldownUntil > this.now() ? new Date(cooldownUntil).toISOString() : null,
      lastSuccessAt: health.lastSuccessAt, lastFailureAt: health.lastFailureAt
    };
  }

  private checkAdmission(host: string, health: Health): void {
    if (health.used >= this.policy(host).maxRequests) {
      throw new LiteratureProviderAdmissionError('literature_provider_quota_exhausted', health.resetAt - this.now());
    }
    if (health.circuitAt > this.now()) {
      throw new LiteratureProviderAdmissionError('literature_provider_cooldown', health.circuitAt - this.now());
    }
  }

  private policy(host: string): LiteratureProviderPolicy {
    const policy = this.policies[host];
    if (policy === undefined) throw new Error('literature_provider_policy_missing');
    return policy;
  }

  private state(host: string): Health {
    const policy = this.policy(host);
    let health = this.health.get(host);
    if (health === undefined) {
      health = {used: 0, resetAt: this.now() + policy.windowMs, nextAt: 0, retryAt: 0, circuitAt: 0,
        failures: 0, intervalMs: policy.minIntervalMs, lastSuccessAt: null, lastFailureAt: null};
      this.health.set(host, health);
    }
    if (health.resetAt <= this.now()) { health.used = 0; health.resetAt = this.now() + policy.windowMs; }
    return health;
  }
}

export function createLiteratureProviderGovernor(): LiteratureProviderGovernor {
  const policies = Object.fromEntries(Object.values(researchProviderHosts).map(host => [host, {
    minIntervalMs: host === researchProviderHosts.arxiv ? 3000 : 1000,
    maxRequests: 300, windowMs: 60 * 60_000, failureThreshold: 3, cooldownMs: 60_000
  }]));
  return new LiteratureProviderGovernor(policies, Date.now, async (ms, signal) => { await delay(ms, undefined, {signal}); });
}
