import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import { z } from 'zod';

/**
 * P6-01: durable experience records written only after an adopted candidate produced evidence.
 *
 * An experience is not a free-form memory entry. It is a versioned, revocable claim tied to the
 * exact execution harness revision it was observed under, with its adoption evidence and failure
 * conditions stored next to it. Three properties are enforced structurally:
 *
 * - nothing is stored without an `adopted: candidate` record and at least one hashed evidence ref;
 * - cue/lesson text may not carry project-private data or a holdout verdict;
 * - retrieval can never read a record whose cue came from a task after the current one.
 */

export const experienceStatuses = ['active', 'quarantined', 'revoked'] as const;
export type ExperienceStatus = (typeof experienceStatuses)[number];

export const experienceConfidences = ['low', 'medium', 'high'] as const;
export type ExperienceConfidence = (typeof experienceConfidences)[number];

const hashPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const evidenceSchema = z.object({
  ref: z.string().min(1).max(200),
  sha256: z.string().regex(hashPattern)
}).strict();

const adoptionSchema = z.object({
  experimentId: z.string().min(1).max(80),
  adopted: z.literal('candidate'),
  adoptionHash: z.string().regex(hashPattern),
  evidence: z.array(evidenceSchema).min(1).max(8),
  harness: z.object({
    executionRevision: z.string().min(1).max(80),
    improvementRevision: z.string().min(1).max(80)
  }).strict()
}).strict();

const invalidationSchema = z.object({
  expiresAt: z.string().datetime().nullable(),
  invalidWhen: z.string().min(1).max(300).nullable()
}).strict();

export const experienceRecordInputSchema = z.object({
  id: z.string().regex(idPattern),
  cue: z.string().min(3).max(2000),
  lesson: z.string().min(3).max(2000),
  confidence: z.enum(experienceConfidences),
  counterexamples: z.array(z.string().min(3).max(500)).max(8),
  invalidation: invalidationSchema,
  adoption: adoptionSchema,
  projectScopeHash: z.string().regex(hashPattern).nullable(),
  taskId: z.string().min(1).max(200),
  /** Index of the task the cue was observed in; retrieval is bounded by this. */
  cueTaskIndex: z.number().int().nonnegative(),
  /** Index of the task that is current when the record is written (the "now"). */
  observedTaskIndex: z.number().int().nonnegative()
}).strict();

export type ExperienceRecordInput = z.infer<typeof experienceRecordInputSchema>;
export type ExperienceEvidence = z.infer<typeof evidenceSchema>;

export type ExperienceRecord = {
  id: string;
  version: number;
  status: ExperienceStatus;
  cue: string;
  lesson: string;
  confidence: ExperienceConfidence;
  evidence: ExperienceEvidence[];
  adoption: z.infer<typeof adoptionSchema>;
  counterexamples: string[];
  invalidation: z.infer<typeof invalidationSchema>;
  projectScopeHash: string | null;
  taskHash: string;
  cueTaskIndex: number;
  executionRevision: string;
  improvementRevision: string;
  contentHash: string;
  createdAt: string;
};

export type ExperienceQuery = {
  taskIndex: number;
  executionRevision: string;
  projectScopeHash?: string | null;
  now?: string;
};

type Row = {
  id: string;
  version: number;
  status: string;
  cue: string;
  lesson: string;
  confidence: string;
  evidence_json: string;
  adoption_json: string;
  counterexamples_json: string;
  invalidation_json: string;
  project_scope_hash: string | null;
  task_hash: string;
  cue_task_index: number;
  execution_revision: string;
  improvement_revision: string;
  content_hash: string;
  created_at: string;
};

/**
 * Absolute paths, home directories, URLs and e-mail addresses are project private. A holdout
 * verdict may never enter the experience library, so the token is rejected outright.
 */
const privatePatterns: readonly RegExp[] = [
  // Any absolute path, not just a known home/volume root.
  /(?:^|[\s"'(])(?:\/|~\/|[A-Za-z]:\\|\\\\[^\\])/u,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/u,
  /\bhttps?:\/\//iu,
  /\bhold[-\s]?out\b/iu
];

function assertPublic(value: string, field: string): void {
  for (const pattern of privatePatterns) {
    if (pattern.test(value)) throw new Error(`experience_record_private:${field}`);
  }
}

/** Stable hash: sorted keys, no whitespace, so equal content has one identity. */
export function experienceContentHash(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (entry === null || typeof entry !== 'object') return JSON.stringify(entry) ?? 'null';
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function assertSafeInput(input: ExperienceRecordInput): void {
  if (input.cueTaskIndex > input.observedTaskIndex) {
    // A record may not be cued by a task that has not happened yet.
    throw new Error('experience_record_future_cue');
  }
  assertPublic(input.cue, 'cue');
  assertPublic(input.lesson, 'lesson');
  for (const counterexample of input.counterexamples) assertPublic(counterexample, 'counterexamples');
  if (input.invalidation.invalidWhen !== null) assertPublic(input.invalidation.invalidWhen, 'invalidation');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(input.adoption.experimentId)) {
    throw new Error('experience_record_adoption_invalid');
  }
  for (const evidence of input.adoption.evidence) assertPublic(evidence.ref, 'evidence');
  if (input.adoption.harness.executionRevision === input.adoption.harness.improvementRevision) {
    // P6-02 keeps the executing harness and the improvement harness independently versioned.
    throw new Error('experience_record_harness_revision_conflated');
  }
}

function toRecord(row: Row): ExperienceRecord {
  try {
    return {
      id: row.id,
      version: row.version,
      status: row.status as ExperienceStatus,
      cue: row.cue,
      lesson: row.lesson,
      confidence: row.confidence as ExperienceConfidence,
      evidence: z.array(evidenceSchema).parse(JSON.parse(row.evidence_json)),
      adoption: adoptionSchema.parse(JSON.parse(row.adoption_json)),
      counterexamples: z.array(z.string()).parse(JSON.parse(row.counterexamples_json)),
      invalidation: invalidationSchema.parse(JSON.parse(row.invalidation_json)),
      projectScopeHash: row.project_scope_hash,
      taskHash: row.task_hash,
      cueTaskIndex: row.cue_task_index,
      executionRevision: row.execution_revision,
      improvementRevision: row.improvement_revision,
      contentHash: row.content_hash,
      createdAt: row.created_at
    };
  } catch {
    throw new Error(`experience_record_corrupt:${row.id}@${row.version}`);
  }
}

const latestSelect = `
  SELECT * FROM experience_records current
  WHERE NOT EXISTS (
    SELECT 1 FROM experience_records newer
    WHERE newer.id = current.id AND newer.version > current.version
  )`;

export class ExperienceRecordStore {
  private readonly now: () => string;

  constructor(private readonly db: DatabaseConnection, options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Writes one immutable version. The id is the logical identity; every correction or status
   * change appends a version instead of overwriting history.
   */
  record(input: unknown): ExperienceRecord {
    const parsed = experienceRecordInputSchema.parse(input);
    assertSafeInput(parsed);
    const existing = this.latest(parsed.id);
    if (existing?.status === 'revoked') throw new Error('experience_record_terminal');
    const version = (existing?.version ?? 0) + 1;
    const createdAt = this.now();
    const record: ExperienceRecord = {
      id: parsed.id,
      version,
      // Re-recording may add evidence, but it may not silently revive a quarantined lesson.
      status: existing?.status === 'quarantined' ? 'quarantined' : 'active',
      cue: parsed.cue,
      lesson: parsed.lesson,
      confidence: parsed.confidence,
      evidence: parsed.adoption.evidence,
      adoption: parsed.adoption,
      counterexamples: parsed.counterexamples,
      invalidation: parsed.invalidation,
      projectScopeHash: parsed.projectScopeHash,
      taskHash: experienceContentHash(parsed.taskId),
      cueTaskIndex: parsed.cueTaskIndex,
      executionRevision: parsed.adoption.harness.executionRevision,
      improvementRevision: parsed.adoption.harness.improvementRevision,
      contentHash: experienceContentHash({
        cue: parsed.cue, lesson: parsed.lesson, confidence: parsed.confidence,
        evidence: parsed.adoption.evidence, counterexamples: parsed.counterexamples,
        invalidation: parsed.invalidation, projectScopeHash: parsed.projectScopeHash,
        cueTaskIndex: parsed.cueTaskIndex, adoption: parsed.adoption
      }),
      createdAt
    };
    this.insert(record);
    this.appendEvent(parsed.id, version, 'recorded', {
      experimentId: parsed.adoption.experimentId,
      adoptionHash: parsed.adoption.adoptionHash,
      evidence: parsed.adoption.evidence.length
    });
    return record;
  }

  /**
   * Quarantine hides a lesson while it is re-tested; revocation is terminal and needs a concrete
   * counterexample so a wrong lesson cannot silently disappear.
   */
  setStatus(input: { id: string; status: Exclude<ExperienceStatus, never>; reason: string; counterexample?: string }): ExperienceRecord {
    const current = this.latest(input.id);
    if (current === null) throw new Error('experience_record_missing');
    if (current.status === 'revoked') throw new Error('experience_record_terminal');
    const reason = input.reason.trim();
    if (reason.length < 3) throw new Error('experience_record_reason_required');
    assertPublic(reason, 'reason');
    if (input.status === 'active') {
      if (current.status !== 'quarantined') throw new Error('experience_record_transition_invalid');
    }
    let counterexamples = current.counterexamples;
    if (input.status === 'revoked') {
      const counterexample = input.counterexample?.trim() ?? '';
      if (counterexample.length < 3) throw new Error('experience_record_counterexample_required');
      assertPublic(counterexample, 'counterexamples');
      counterexamples = [...counterexamples, counterexample];
    }
    const version = current.version + 1;
    const updated: ExperienceRecord = {
      ...current,
      version,
      status: input.status,
      counterexamples,
      createdAt: this.now(),
      contentHash: experienceContentHash({
        cue: current.cue, lesson: current.lesson, confidence: current.confidence,
        evidence: current.evidence, counterexamples, invalidation: current.invalidation,
        projectScopeHash: current.projectScopeHash, cueTaskIndex: current.cueTaskIndex,
        adoption: current.adoption, status: input.status
      })
    };
    this.insert(updated);
    this.appendEvent(input.id, version, input.status, { reason, counterexample: input.counterexample ?? null });
    return updated;
  }

  latest(id: string): ExperienceRecord | null {
    const row = this.db.prepare(`${latestSelect} AND current.id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** Latest version of every record, including revoked history markers. */
  list(): ExperienceRecord[] {
    return (this.db.prepare(`${latestSelect} ORDER BY current.id`).all() as Row[]).map(toRecord);
  }

  /**
   * Records that may inform the current task. A record is applicable only when it was adopted
   * under the exact execution revision now in force, is active, has not expired, matches the
   * project scope (global records match every project) and its cue is not from a future task.
   */
  applicable(query: ExperienceQuery): ExperienceRecord[] {
    const now = query.now ?? this.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error('experience_query_time_invalid');
    if (!Number.isInteger(query.taskIndex) || query.taskIndex < 0) throw new Error('experience_query_task_invalid');
    const scope = query.projectScopeHash ?? null;
    if (scope !== null && !hashPattern.test(scope)) throw new Error('experience_query_scope_invalid');
    return this.list().filter(record => {
      if (record.status !== 'active') return false;
      if (record.cueTaskIndex > query.taskIndex) return false;
      if (record.executionRevision !== query.executionRevision) return false;
      if (record.projectScopeHash !== null && record.projectScopeHash !== scope) return false;
      if (record.invalidation.expiresAt !== null && Date.parse(record.invalidation.expiresAt) <= nowMs) return false;
      return true;
    });
  }

  /** P6-05: deleting a record purges its history and events in one transaction. */
  deleteById(id: string): { records: number; events: number } {
    return this.db.transaction(() => ({
      records: this.db.prepare('DELETE FROM experience_records WHERE id = ?').run(id).changes,
      events: this.db.prepare('DELETE FROM experience_events WHERE record_id = ?').run(id).changes
    }))();
  }

  deleteAll(): { records: number; events: number } {
    return this.db.transaction(() => ({
      records: this.db.prepare('DELETE FROM experience_records').run().changes,
      events: this.db.prepare('DELETE FROM experience_events').run().changes
    }))();
  }

  eventCount(id?: string): number {
    const row = id === undefined
      ? this.db.prepare('SELECT COUNT(*) AS count FROM experience_events').get() as { count: number }
      : this.db.prepare('SELECT COUNT(*) AS count FROM experience_events WHERE record_id = ?').get(id) as { count: number };
    return row.count;
  }

  private insert(record: ExperienceRecord): void {
    this.db.prepare(`INSERT INTO experience_records
      (id, version, status, cue, lesson, confidence, evidence_json, adoption_json, counterexamples_json,
       invalidation_json, project_scope_hash, task_hash, cue_task_index, execution_revision,
       improvement_revision, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.version, record.status, record.cue, record.lesson, record.confidence,
      JSON.stringify(record.evidence), JSON.stringify(record.adoption), JSON.stringify(record.counterexamples),
      JSON.stringify(record.invalidation), record.projectScopeHash, record.taskHash, record.cueTaskIndex,
      record.executionRevision, record.improvementRevision, record.contentHash, record.createdAt
    );
  }

  private appendEvent(recordId: string, version: number, type: string, detail: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO experience_events (record_id, record_version, type, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(recordId, version, type, JSON.stringify(detail), this.now());
  }
}
