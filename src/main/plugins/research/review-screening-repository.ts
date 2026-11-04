import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewScreeningPlanCreateSchema, researchReviewScreeningPlanGetSchema, researchReviewScreeningPlanSnapshotSchema,
  researchReviewScreeningPlanInspectionSchema,
  type ResearchReviewScreeningPlanCreate, type ResearchReviewScreeningPlanInspection
} from '../../../shared/schemas/research-review-screening';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewCorpusRepository} from './review-corpus-repository';
import type {ResearchReviewDeduplicationRepository} from './review-deduplication-repository';

type PlanRow = {
  id: string; corpus_id: string; project_id: string; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** One explicit human reviewer plan binds both screening phases to the frozen protocol and deduplication. */
export class ResearchReviewScreeningRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly corpora: ResearchReviewCorpusRepository, private readonly deduplication: ResearchReviewDeduplicationRepository,
    private readonly now: () => string) {}

  createPlan(input: ResearchReviewScreeningPlanCreate, declaredBy: ResearchRelationReviewer): ResearchReviewScreeningPlanInspection {
    const request = researchReviewScreeningPlanCreateSchema.parse(input), actor = researchRelationReviewerSchema.parse(declaredBy);
    return this.db.transaction(() => {
      if (this.repository.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_screening_plans WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as PlanRow | undefined;
      if (replay !== undefined) {
        if (replay.corpus_id !== request.corpusId) throw new Error('research_review_request_conflict');
        const previous = this.getPlan({projectId: request.projectId, corpusId: request.corpusId});
        if (previous.snapshot.requestHash !== requestHash || previous.snapshot.actor.id !== actor.id) throw new Error('research_review_request_conflict');
        return previous;
      }
      const corpus = this.corpora.get({projectId: request.projectId, corpusId: request.corpusId});
      if (corpus.snapshotHash !== request.expectedCorpusHash || !corpus.currentProtocol) throw new Error('research_review_screening_version_conflict');
      this.deduplication.requireFrozen(request.projectId, request.corpusId, request.expectedDedupFreezeHash);
      const marker = this.db.prepare('SELECT screening_plan_hash FROM research_review_corpora WHERE id=?').pluck().get(request.corpusId);
      const existing = this.db.prepare('SELECT id FROM research_review_screening_plans WHERE corpus_id=?').get(request.corpusId);
      if (marker !== null || existing !== undefined) {
        this.getPlan({projectId: request.projectId, corpusId: request.corpusId});
        throw new Error('research_review_screening_plan_exists');
      }
      const protocol = this.repository.systematicReviews.get({projectId: request.projectId, versionId: corpus.snapshot.request.versionId});
      this.checkReviewerCounts(request, protocol.version.body.screening);
      const snapshot = researchReviewScreeningPlanSnapshotSchema.parse({
        id: `review_screening_plan_${randomUUID()}`, request, requestHash,
        protocolVersionId: protocol.version.id, protocolVersionHash: protocol.versionHash, actor, recordedAt: this.now()
      });
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_screening_plans
        (id,corpus_id,project_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(snapshot.id, request.corpusId, request.projectId, request.requestId, json, hash(json), snapshot.recordedAt);
      this.db.prepare('UPDATE research_review_corpora SET screening_plan_hash=? WHERE id=? AND screening_plan_hash IS NULL')
        .run(hash(json), request.corpusId);
      return this.getPlan({projectId: request.projectId, corpusId: request.corpusId});
    })();
  }

  getPlan(input: {projectId: string; corpusId: string}): ResearchReviewScreeningPlanInspection {
    const request = researchReviewScreeningPlanGetSchema.parse(input);
    const corpus = this.corpora.get(request), deduplication = this.deduplication.get(request);
    const marker = this.db.prepare('SELECT screening_plan_hash FROM research_review_corpora WHERE id=?').pluck().get(request.corpusId);
    const row = this.db.prepare('SELECT * FROM research_review_screening_plans WHERE corpus_id=?').get(request.corpusId) as PlanRow | undefined;
    if (row === undefined && marker === null) throw new Error('research_review_screening_plan_not_found');
    if (row === undefined || row.snapshot_hash !== marker) throw new Error('research_review_screening_snapshot_invalid');
    const snapshot = researchReviewScreeningPlanSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    const saved = snapshot.request;
    if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(snapshot) !== row.snapshot_json ||
        snapshot.id !== row.id || saved.corpusId !== row.corpus_id || row.corpus_id !== request.corpusId ||
        saved.projectId !== row.project_id || row.project_id !== request.projectId || saved.requestId !== row.request_id ||
        snapshot.requestHash !== hash(JSON.stringify(saved)) || snapshot.recordedAt !== row.created_at ||
        saved.expectedCorpusHash !== corpus.snapshotHash || saved.expectedDedupFreezeHash !== deduplication.freezeHash ||
        deduplication.freeze === null || snapshot.protocolVersionId !== corpus.snapshot.request.versionId ||
        snapshot.protocolVersionHash !== corpus.snapshot.protocolVersionHash) throw new Error('research_review_screening_snapshot_invalid');
    const protocol = this.repository.systematicReviews.get({projectId: request.projectId, versionId: snapshot.protocolVersionId});
    this.checkReviewerCounts(saved, protocol.version.body.screening);
    return researchReviewScreeningPlanInspectionSchema.parse({snapshot, snapshotHash: row.snapshot_hash, currentProtocol: corpus.currentProtocol});
  }

  private checkReviewerCounts(request: ResearchReviewScreeningPlanCreate,
    strategy: {titleAbstractReviewers: 1 | 2; fullTextReviewers: 1 | 2}): void {
    if (request.titleAbstractReviewers.length !== strategy.titleAbstractReviewers ||
        request.fullTextReviewers.length !== strategy.fullTextReviewers) throw new Error('research_review_screening_reviewer_count_mismatch');
  }
}
