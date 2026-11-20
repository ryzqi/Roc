import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * P6-03: a signed release package, an active-release pointer and one-click rollback.
 *
 * The release is the only thing allowed to change the executing harness. It is built from a
 * declarative surface plus a review report that must show a holdout-backed gain with zero verifier
 * failures, and its declared permissions must be a subset of the baseline set: a candidate can
 * never widen access. Runs pin the release they started under, so activating or rolling back a
 * release does not rewrite history.
 */

const hashPattern = /^[a-f0-9]{64}$/u;
export const releaseSurfaceKinds = ['prompt', 'guidance', 'skill', 'context'] as const;

const surfaceSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().min(1).max(80),
  components: z.array(z.object({
    id: z.string().min(1).max(64),
    kind: z.enum(releaseSurfaceKinds),
    value: z.string().max(4000)
  }).strict()).min(1).max(64)
}).strict();

const reviewSchema = z.object({
  datasetHash: z.string().regex(hashPattern),
  comparison: z.literal('paired-holdout'),
  intervalMethod: z.literal('cluster-bootstrap-percentile'),
  ciLow: z.number(),
  ciHigh: z.number(),
  scenarios: z.number().int().min(45),
  clusters: z.number().int().min(9),
  verifierFailures: z.number().int().min(0)
}).strict().refine(review => review.ciHigh >= review.ciLow, 'review_interval_invalid');

export const releaseInputSchema = z.object({
  surface: surfaceSchema,
  review: reviewSchema,
  permissions: z.array(z.string().min(1).max(80)).max(64),
  basePermissions: z.array(z.string().min(1).max(80)).max(64),
  harness: z.object({
    executionRevision: z.string().min(1).max(80),
    improvementRevision: z.string().min(1).max(80)
  }).strict()
}).strict();

export type ReleaseInput = z.infer<typeof releaseInputSchema>;

export type ReleasePackage = ReleaseInput & {
  schemaVersion: 1;
  releaseId: string;
  createdAt: string;
  bodyHash: string;
  signature: string;
};

export type ReviewReport = ReleaseInput['review'] & { releaseId: string; createdAt: string; bodyHash: string };

const forbiddenToken =
  /(permission|authoriz|budget|cost|deadline|scorer|score|verifier|holdout|split|policy|tool|credential|secret|environment|middleware|approval)/iu;
const privateValue = /(?:\.\.\/|\0|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\))/u;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function bodyOf(pkg: ReleasePackage): Omit<ReleasePackage, 'signature' | 'bodyHash'> {
  const { signature: _signature, bodyHash: _bodyHash, ...body } = pkg;
  return body;
}

function sign(bodyHash: string, secret: string): string {
  return createHmac('sha256', secret).update(bodyHash).digest('hex');
}

function assertSafeRelease(input: ReleaseInput): string {
  const components = [...input.surface.components].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const component of components) {
    if (component.id.split('.').some(segment => forbiddenToken.test(segment))) {
      throw new Error(`release_surface_forbidden:${component.id}`);
    }
    if (forbiddenToken.test(component.value)) throw new Error(`release_surface_forbidden:${component.id}:value`);
    if (privateValue.test(component.value)) throw new Error(`release_surface_unsafe:${component.id}`);
  }
  const expectedRevision = `rev-${sha256({ schemaVersion: 1, components }).slice(0, 16)}`;
  if (input.surface.revision !== expectedRevision) throw new Error('release_surface_revision_mismatch');
  const base = new Set(input.basePermissions);
  for (const permission of input.permissions) {
    if (!base.has(permission)) throw new Error(`release_permissions_expanded:${permission}`);
  }
  if (input.review.verifierFailures !== 0) throw new Error('release_review_verifier_failures');
  if (input.review.ciLow <= 0) throw new Error('release_review_no_holdout_gain');
  if (input.harness.executionRevision === input.harness.improvementRevision) {
    throw new Error('release_harness_revision_conflated');
  }
  return sha256(input);
}

type ReleaseStoreOptions = {
  directory: string;
  secret: string;
  /** Frozen baseline permission set. A package may not widen it, and may not redefine it. */
  baselinePermissions: readonly string[];
  now?: () => string;
};

export class HarnessReleaseStore {
  constructor(private readonly options: ReleaseStoreOptions) {
    mkdirSync(options.directory, { recursive: true });
  }

  list(): string[] {
    if (!existsSync(this.options.directory)) return [];
    return readdirSync(this.options.directory)
      .flatMap(name => (/^rel-[a-f0-9]{16}\.json$/u.test(name) ? [name.replace(/\.json$/u, '')] : []))
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  create(input: unknown): ReleasePackage {
    const parsed = releaseInputSchema.parse(input);
    this.assertBaseline(parsed.basePermissions);
    const inputHash = assertSafeRelease(parsed);
    const releaseId = `rel-${inputHash.slice(0, 16)}`;
    const createdAt = this.now();
    const body: Omit<ReleasePackage, 'schemaVersion' | 'releaseId' | 'createdAt' | 'bodyHash' | 'signature'> = parsed;
    const bodyHash = sha256({ schemaVersion: 1, releaseId, createdAt, ...body });
    const pkg: ReleasePackage = {
      schemaVersion: 1, releaseId, createdAt, bodyHash,
      signature: sign(bodyHash, this.options.secret), ...body
    };
    this.writeAtomic(join(this.options.directory, `${releaseId}.json`), JSON.stringify(pkg, null, 2));
    const review: ReviewReport = { ...parsed.review, releaseId, createdAt, bodyHash };
    this.writeAtomic(join(this.options.directory, `review-${releaseId}.json`), JSON.stringify(review, null, 2));
    return pkg;
  }

  readRelease(releaseId: string): ReleasePackage {
    if (!/^rel-[a-f0-9]{16}$/u.test(releaseId)) throw new Error('release_id_invalid');
    const path = join(this.options.directory, `${releaseId}.json`);
    if (!existsSync(path)) throw new Error(`release_missing:${releaseId}`);
    let parsed: ReleasePackage;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as ReleasePackage;
    } catch {
      throw new Error(`release_corrupt:${releaseId}`);
    }
    return parsed;
  }

  /** Integrity + signature + reproducibility, all recomputed from package bytes. */
  verify(releaseId: string): ReleasePackage {
    const pkg = this.readRelease(releaseId);
    const bodyHash = sha256(bodyOf(pkg));
    if (bodyHash !== pkg.bodyHash) throw new Error(`release_integrity:${releaseId}`);
    const expected = Buffer.from(sign(pkg.bodyHash, this.options.secret), 'hex');
    const actual = Buffer.from(pkg.signature, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error(`release_signature:${releaseId}`);
    }
    const inputHash = assertSafeRelease({
      surface: pkg.surface, review: pkg.review, permissions: pkg.permissions,
      basePermissions: pkg.basePermissions, harness: pkg.harness
    });
    if (`rel-${inputHash.slice(0, 16)}` !== pkg.releaseId) throw new Error(`release_reproducibility:${releaseId}`);
    this.assertBaseline(pkg.basePermissions);
    this.assertReviewFile(pkg);
    return pkg;
  }

  activate(releaseId: string): ActivePointer {
    this.verify(releaseId);
    const pointer = this.readPointer();
    if (pointer.activeReleaseId === releaseId) return pointer;
    const history = pointer.activeReleaseId === null
      ? pointer.history
      : [pointer.activeReleaseId, ...pointer.history.filter(id => id !== pointer.activeReleaseId)];
    const next: ActivePointer = { ...pointer, activeReleaseId: releaseId, history, activatedAt: this.now() };
    this.writePointer(next);
    return next;
  }

  /** One-click rollback: restore the previously active release, which must still verify. */
  rollback(): ActivePointer {
    const pointer = this.readPointer();
    const [previous, ...rest] = pointer.history;
    if (pointer.activeReleaseId === null || previous === undefined) throw new Error('release_no_rollback_target');
    this.verify(previous);
    const next: ActivePointer = { ...pointer, activeReleaseId: previous, history: rest, activatedAt: this.now() };
    this.writePointer(next);
    return next;
  }

  active(): ActivePointer {
    return this.readPointer();
  }

  /** A run pins the release it started under; later activation never rewrites that run. */
  pinForRun(runId: string): string {
    const pointer = this.readPointer();
    const existing = pointer.pinned[runId];
    if (existing !== undefined) return existing;
    if (pointer.activeReleaseId === null) throw new Error('release_not_active');
    const next: ActivePointer = { ...pointer, pinned: { ...pointer.pinned, [runId]: pointer.activeReleaseId } };
    this.writePointer(next);
    return pointer.activeReleaseId;
  }

  resolveForRun(runId: string): ReleasePackage {
    const pointer = this.readPointer();
    const releaseId = pointer.pinned[runId];
    if (releaseId === undefined) throw new Error(`release_run_unpinned:${runId}`);
    return this.verify(releaseId);
  }

  private readPointer(): ActivePointer {
    const path = join(this.options.directory, 'active.json');
    if (!existsSync(path)) return { schemaVersion: 1, activeReleaseId: null, history: [], pinned: {}, activatedAt: null };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ActivePointer;
      if (parsed.schemaVersion !== 1) throw new Error('version');
      return parsed;
    } catch {
      throw new Error('release_pointer_corrupt');
    }
  }

  private writePointer(pointer: ActivePointer): void {
    this.writeAtomic(join(this.options.directory, 'active.json'), JSON.stringify(pointer, null, 2));
  }

  private writeAtomic(path: string, content: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  }

  private assertBaseline(basePermissions: readonly string[]): void {
    const baseline = [...this.options.baselinePermissions].sort((left, right) => left.localeCompare(right, 'en'));
    const declared = [...basePermissions].sort((left, right) => left.localeCompare(right, 'en'));
    if (baseline.length !== declared.length || baseline.some((value, index) => value !== declared[index])) {
      throw new Error('release_baseline_mismatch');
    }
  }

  /** The review report is part of the release, so verify() re-reads and matches it. */
  private assertReviewFile(pkg: ReleasePackage): void {
    const path = join(this.options.directory, `review-${pkg.releaseId}.json`);
    if (!existsSync(path)) throw new Error(`release_review_missing:${pkg.releaseId}`);
    let review: ReviewReport;
    try {
      review = JSON.parse(readFileSync(path, 'utf8')) as ReviewReport;
    } catch {
      throw new Error(`release_review_corrupt:${pkg.releaseId}`);
    }
    const { releaseId, createdAt: _createdAt, bodyHash, ...reviewBody } = review;
    if (releaseId !== pkg.releaseId || bodyHash !== pkg.bodyHash || canonical(reviewBody) !== canonical(pkg.review)) {
      throw new Error(`release_review_mismatch:${pkg.releaseId}`);
    }
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

export type ActivePointer = {
  schemaVersion: 1;
  activeReleaseId: string | null;
  history: string[];
  pinned: Record<string, string>;
  activatedAt: string | null;
};
