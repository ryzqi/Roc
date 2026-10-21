import { z } from 'zod';
import { redact } from '../deep-agent/redaction';
import { experienceContentHash } from './experience-records';

/**
 * P6-05: a production failure becomes a minimal, redacted fixture.
 *
 * Only allowlisted fields survive. The free-form transcript, tool input, user text and workspace
 * path never do; text fields are scrubbed for paths, credentials, URLs and e-mail addresses before
 * hashing. A holdout verdict is refused rather than redacted, because a partially scrubbed holdout
 * sample is still an information leak.
 */

export const failureFixtureFields = ['failureClass', 'failureCode', 'toolName', 'stage', 'tokens'] as const;

const fixtureInputSchema = z.object({
  failureClass: z.enum(['infra', 'provider', 'policy', 'effect', 'state', 'verifier', 'agent']),
  failureCode: z.string().min(1).max(120),
  toolName: z.string().min(1).max(80).nullable(),
  stage: z.string().min(1).max(80),
  tokens: z.number().int().nonnegative().max(10_000_000).nullable()
}).strict();

export type FailureFixture = {
  schemaVersion: 1;
  failureClass: (typeof fixtureInputSchema)['_output']['failureClass'];
  failureCode: string;
  toolName: string | null;
  stage: string;
  tokens: number | null;
  redactions: string[];
  hash: string;
};

const scrubRules: readonly { label: string; pattern: RegExp; replacement: string }[] = [
  // Any absolute path, home path, drive-letter path or UNC path — not only known roots.
  { label: 'path', pattern: /(^|[\s"'(])(?:\/[^\s"'`]*|~\/[^\s"'`]*)/gu, replacement: '$1<path>' },
  { label: 'path', pattern: /\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]*/gu, replacement: '<path>' },
  { label: 'path', pattern: /\\\\[^\s\\]+\\[^\s\\]*/gu, replacement: '<path>' },
  { label: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gu, replacement: '<email>' },
  { label: 'url', pattern: /\bhttps?:\/\/[^\s"'`]+/giu, replacement: '<url>' },
  { label: 'secret', pattern: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[psoru]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu, replacement: '<secret>' },
  { label: 'secret', pattern: /\b(?:AKIA[0-9A-Z]{16})\b/gu, replacement: '<secret>' }
];

const holdoutPattern = /\bhold[-\s]?out\b/iu;

function scrub(value: string): { value: string; redactions: string[] } {
  const redactions = new Set<string>();
  // Reuse the harness-wide credential policy so Bearer/api_key/password never survive.
  const credentials = redact(value);
  if (credentials !== value) redactions.add('secret');
  let scrubbed = credentials;
  for (const rule of scrubRules) {
    if (rule.pattern.test(scrubbed)) {
      redactions.add(rule.label);
      scrubbed = scrubbed.replace(rule.pattern, rule.replacement);
    }
    rule.pattern.lastIndex = 0;
  }
  return { value: scrubbed, redactions: [...redactions].sort((left, right) => left.localeCompare(right, 'en')) };
}

export function buildFailureFixture(input: unknown): FailureFixture {
  const parsed = fixtureInputSchema.safeParse(input);
  if (!parsed.success) {
    // An unknown key means unredacted data was offered; refuse instead of dropping it silently.
    throw new Error(`failure_fixture_field_rejected:${parsed.error.issues[0]?.path.join('.') ?? 'root'}`);
  }
  for (const value of [parsed.data.failureCode, parsed.data.toolName ?? '', parsed.data.stage]) {
    if (holdoutPattern.test(value)) throw new Error('failure_fixture_holdout_forbidden');
  }
  const code = scrub(parsed.data.failureCode);
  const tool = parsed.data.toolName === null ? { value: null, redactions: [] as string[] } : scrub(parsed.data.toolName);
  const stage = scrub(parsed.data.stage);
  const fixture = {
    schemaVersion: 1 as const,
    failureClass: parsed.data.failureClass,
    failureCode: code.value,
    toolName: tool.value,
    stage: stage.value,
    tokens: parsed.data.tokens,
    redactions: [...new Set([...code.redactions, ...tool.redactions, ...stage.redactions])]
      .sort((left, right) => left.localeCompare(right, 'en'))
  };
  return { ...fixture, hash: experienceContentHash(fixture) };
}

export type VersionFingerprint = {
  providerId: string;
  modelId: string | null;
  framework: Record<string, string>;
  harnessImplementation: string;
};

export type UpgradeGateResult = {
  allowed: boolean;
  reason: string;
  changed: string[];
};

function flattenVersions(fingerprint: VersionFingerprint): Record<string, string> {
  const flat: Record<string, string> = {
    providerId: fingerprint.providerId,
    modelId: fingerprint.modelId ?? '',
    harnessImplementation: fingerprint.harnessImplementation
  };
  for (const [name, version] of Object.entries(fingerprint.framework)) flat[`framework.${name}`] = version;
  return flat;
}

/**
 * P6-05: any provider or framework change must be re-tested before the gate reopens. A re-test
 * receipt only counts when it was recorded against the exact versions now in force.
 */
export function evaluateUpgradeGate(input: {
  recorded: VersionFingerprint | null;
  current: VersionFingerprint;
  retest: { passed: boolean; receiptHash: string; versions: VersionFingerprint } | null;
}, options: { knownReceipts?: ReadonlySet<string> } = {}): UpgradeGateResult {
  if (input.recorded === null) return { allowed: true, reason: 'initial_baseline', changed: [] };
  const previous = flattenVersions(input.recorded);
  const next = flattenVersions(input.current);
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter(key => previous[key] !== next[key])
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (changed.length === 0) return { allowed: true, reason: 'versions_unchanged', changed };
  if (input.retest === null) return { allowed: false, reason: 'upgrade_retest_required', changed };
  const retestVersions = flattenVersions(input.retest.versions);
  const retestMatches = [...Object.keys(next), ...Object.keys(retestVersions)]
    .every(key => retestVersions[key] === next[key]);
  if (!retestMatches) return { allowed: false, reason: 'upgrade_retest_mismatch', changed };
  if (!input.retest.passed) return { allowed: false, reason: 'upgrade_retest_failed', changed };
  if (!/^[a-f0-9]{64}$/u.test(input.retest.receiptHash)) {
    return { allowed: false, reason: 'upgrade_retest_receipt_invalid', changed };
  }
  // When the caller keeps a receipt registry, a self-declared hash is not enough.
  if (options.knownReceipts !== undefined && !options.knownReceipts.has(input.retest.receiptHash)) {
    return { allowed: false, reason: 'upgrade_retest_receipt_unknown', changed };
  }
  return { allowed: true, reason: 'upgrade_retested', changed };
}
