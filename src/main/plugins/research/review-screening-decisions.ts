import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewScreeningDecisionSaveSchema, researchReviewScreeningDecisionSnapshotSchema, researchReviewScreeningDecisionInspectionSchema,
  researchReviewScreeningSuggestionCreateSchema, researchReviewScreeningSuggestionOriginSchema,
  researchReviewScreeningSuggestionSnapshotSchema, researchReviewScreeningSuggestionInspectionSchema,
  researchReviewScreeningDecisionHistorySchema, researchReviewScreeningSuggestionListSchema, researchReviewScreeningPhaseGetSchema,
  researchReviewScreeningPhaseInspectionSchema,
  type ResearchReviewScreeningDecisionSave, type ResearchReviewScreeningDecisionInspection,
  type ResearchReviewScreeningSuggestionCreate, type ResearchReviewScreeningSuggestionOrigin, type ResearchReviewScreeningSuggestionInspection,
  type ResearchReviewScreeningPlanInspection, type ResearchReviewScreeningPhaseInspection
} from '../../../shared/schemas/research-review-screening';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewCorpusRepository} from './review-corpus-repository';
import type {ResearchReviewDeduplicationRepository} from './review-deduplication-repository';
import type {ResearchReviewScreeningRepository} from './review-screening-repository';

type DecisionRow = {
  id: string; project_id: string; corpus_id: string; phase: string; hit_id: string; reviewer_id: string;
  version: number; parent_id: string | null; request_id: string; snapshot_json: string; snapshot_hash: string; created_at: string
};
type SuggestionRow = {
  id: string; project_id: string; corpus_id: string; phase: string; hit_id: string;
  request_id: string; snapshot_json: string; snapshot_hash: string; created_at: string
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Reviewer decisions and agent proposals have separate storage and authority. Neither rewrites raw search records. */
export class ResearchReviewScreeningDecisions {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly corpora: ResearchReviewCorpusRepository, private readonly deduplication: ResearchReviewDeduplicationRepository,
    private readonly screening: ResearchReviewScreeningRepository, private readonly now: () => string) {}

  save(input: ResearchReviewScreeningDecisionSave, reviewedBy: ResearchRelationReviewer): ResearchReviewScreeningDecisionInspection {
    const request = researchReviewScreeningDecisionSaveSchema.parse(input), actor = researchRelationReviewerSchema.parse(reviewedBy);
    return this.db.transaction(() => {
      this.requireWritable(request.projectId);
      const plan = this.screening.getPlan({projectId: request.projectId, corpusId: request.corpusId}), requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_screening_decisions WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as DecisionRow | undefined;
      if (replay !== undefined) {
        if (replay.corpus_id !== request.corpusId) throw new Error('research_review_request_conflict');
        const previous = this.inspectDecision(replay, plan);
        if (previous.snapshot.requestHash !== requestHash || previous.snapshot.actor.id !== actor.id) throw new Error('research_review_request_conflict');
        return previous;
      }
      this.requireCurrent(plan, request.expectedPlanHash);
      const reviewer = plan.snapshot.request.titleAbstractReviewers.find(value => value.id === request.reviewerId);
      if (reviewer === undefined) throw new Error('research_review_screening_reviewer_not_declared');
      this.validateOutcome(plan, request.outcome);
      const previous = this.latestRow(request.corpusId, request.hitId, request.reviewerId);
      const parent = previous === undefined ? null : this.inspectDecision(previous, plan);
      if (parent === null ? request.parentDecisionId !== null :
          request.parentDecisionId !== parent.snapshot.id || request.expectedParentHash !== parent.snapshotHash) {
        throw new Error('research_review_screening_version_conflict');
      }
      const material = this.material(plan, request.hitId);
      this.validateSuggestion(request, plan);
      const snapshot = researchReviewScreeningDecisionSnapshotSchema.parse({
        id: `review_screening_decision_${randomUUID()}`, version: parent === null ? 1 : parent.snapshot.version + 1,
        request, requestHash, reviewer, material, actor, recordedAt: this.now()
      });
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_screening_decisions
        (id,project_id,corpus_id,phase,hit_id,reviewer_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id, request.projectId, request.corpusId, request.phase, request.hitId, request.reviewerId,
          snapshot.version, request.parentDecisionId, request.requestId, json, hash(json), snapshot.recordedAt);
      const row = this.latestRow(request.corpusId, request.hitId, request.reviewerId);
      if (row === undefined || row.id !== snapshot.id) throw new Error('research_review_screening_snapshot_invalid');
      const current = this.screening.getPlan({projectId: request.projectId, corpusId: request.corpusId});
      return this.inspectDecision(row, current);
    })();
  }

  suggest(input: ResearchReviewScreeningSuggestionCreate, proposedBy: ResearchReviewScreeningSuggestionOrigin): ResearchReviewScreeningSuggestionInspection {
    const request = researchReviewScreeningSuggestionCreateSchema.parse(input), origin = researchReviewScreeningSuggestionOriginSchema.parse(proposedBy);
    return this.db.transaction(() => {
      this.requireWritable(request.projectId);
      const plan = this.screening.getPlan({projectId: request.projectId, corpusId: request.corpusId}), requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_screening_suggestions WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as SuggestionRow | undefined;
      if (replay !== undefined) {
        if (replay.corpus_id !== request.corpusId) throw new Error('research_review_request_conflict');
        const previous = this.inspectSuggestion(replay, plan), existing = previous.snapshot.origin;
        if (previous.snapshot.requestHash !== requestHash || existing.operationId !== origin.operationId ||
            existing.idempotencyKey !== origin.idempotencyKey || existing.toolCallId !== origin.toolCallId ||
            existing.canonicalToolIdentity !== origin.canonicalToolIdentity || existing.toolVersion !== origin.toolVersion ||
            existing.capabilityVersion !== origin.capabilityVersion) {
          throw new Error('research_review_request_conflict');
        }
        return previous;
      }
      this.requireCurrent(plan, request.expectedPlanHash);
      this.validateOutcome(plan, request.outcome);
      const snapshot = researchReviewScreeningSuggestionSnapshotSchema.parse({
        id: `review_screening_suggestion_${randomUUID()}`, request, requestHash, material: this.material(plan, request.hitId), origin, recordedAt: this.now()
      });
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_screening_suggestions
        (id,project_id,corpus_id,phase,hit_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(snapshot.id, request.projectId, request.corpusId, request.phase, request.hitId, request.requestId, json, hash(json), snapshot.recordedAt);
      const current = this.screening.getPlan({projectId: request.projectId, corpusId: request.corpusId});
      const row = this.db.prepare('SELECT * FROM research_review_screening_suggestions WHERE id=?').get(snapshot.id) as SuggestionRow | undefined;
      if (row === undefined) throw new Error('research_review_screening_snapshot_invalid');
      return this.inspectSuggestion(row, current);
    })();
  }

  history(input: {projectId: string; corpusId: string; decisionId: string}): ResearchReviewScreeningDecisionInspection[] {
    const request = researchReviewScreeningDecisionHistorySchema.parse(input);
    const plan = this.screening.getPlan({projectId: request.projectId, corpusId: request.corpusId});
    const selected = this.db.prepare('SELECT * FROM research_review_screening_decisions WHERE id=?').get(request.decisionId) as DecisionRow | undefined;
    if (selected === undefined) throw new Error('research_review_screening_decision_not_found');
    if (selected.project_id !== request.projectId || selected.corpus_id !== request.corpusId) throw new Error('research_review_project_mismatch');
    return (this.db.prepare('SELECT * FROM research_review_screening_decisions WHERE corpus_id=? AND phase=? AND hit_id=? AND reviewer_id=? ORDER BY version')
      .all(request.corpusId, selected.phase, selected.hit_id, selected.reviewer_id) as DecisionRow[]).map(row => this.inspectDecision(row, plan));
  }

  listSuggestions(input: {projectId: string; corpusId: string; phase: 'title_abstract'; hitId: string; offset: number; limit: number}): ResearchReviewScreeningSuggestionInspection[] {
    const request = researchReviewScreeningSuggestionListSchema.parse(input);
    const plan = this.screening.getPlan({projectId: request.projectId, corpusId: request.corpusId});
    this.material(plan, request.hitId);
    return (this.db.prepare('SELECT * FROM research_review_screening_suggestions WHERE corpus_id=? AND phase=? AND hit_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(request.corpusId, request.phase, request.hitId, request.limit, request.offset) as SuggestionRow[]).map(row => this.inspectSuggestion(row, plan));
  }

  getPhase(input: {projectId: string; corpusId: string; phase: 'title_abstract'}): ResearchReviewScreeningPhaseInspection {
    const request = researchReviewScreeningPhaseGetSchema.parse(input);
    const plan = this.screening.getPlan({projectId: request.projectId, corpusId: request.corpusId});
    const deduplication = this.deduplication.get({projectId: request.projectId, corpusId: request.corpusId});
    if (deduplication.freeze === null) throw new Error('research_review_duplicate_not_frozen');
    const corpus = this.corpora.get({projectId: request.projectId, corpusId: request.corpusId});
    const counts: ResearchReviewScreeningPhaseInspection['counts'] = {
      recordsToScreen: deduplication.freeze.recordsToScreen, pending: 0, uncertain: 0, conflict: 0, included: 0, excluded: 0
    };
    const items = deduplication.freeze.screenableHitIds.map(hitId => {
      const hit = corpus.snapshot.hits.find(value => value.id === hitId);
      if (hit === undefined) throw new Error('research_review_screening_snapshot_invalid');
      const decisions = plan.snapshot.request.titleAbstractReviewers.flatMap(reviewer => {
        const row = this.latestRow(request.corpusId, hitId, reviewer.id);
        return row === undefined ? [] : [this.inspectDecision(row, plan)];
      });
      let status: ResearchReviewScreeningPhaseInspection['items'][number]['status'];
      if (decisions.length !== plan.snapshot.request.titleAbstractReviewers.length) status = 'pending';
      else if (decisions.some(value => value.snapshot.request.outcome.decision === 'uncertain')) status = 'uncertain';
      else if (new Set(decisions.map(value => value.snapshot.request.outcome.decision)).size > 1) status = 'conflict';
      else if (new Set(decisions.flatMap(value => {
        const outcome = value.snapshot.request.outcome;
        return outcome.decision === 'exclude' ? [outcome.exclusionCriterionId] : [];
      })).size > 1) status = 'conflict';
      else status = decisions[0].snapshot.request.outcome.decision === 'include' ? 'included' : 'excluded';
      counts[status] += 1;
      const suggestions = this.db.prepare("SELECT * FROM research_review_screening_suggestions WHERE corpus_id=? AND phase='title_abstract' AND hit_id=?")
        .all(request.corpusId, hitId) as SuggestionRow[];
      for (const suggestion of suggestions) this.inspectSuggestion(suggestion, plan);
      const suggestionCount = suggestions.length;
      return {hit, decisions, status, suggestionCount};
    });
    return researchReviewScreeningPhaseInspectionSchema.parse({plan, phase: request.phase, items, counts});
  }

  private requireWritable(projectId: string): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  private requireCurrent(plan: ResearchReviewScreeningPlanInspection, expectedHash: string): void {
    if (!plan.currentProtocol || plan.snapshotHash !== expectedHash) throw new Error('research_review_screening_version_conflict');
  }
  private validateOutcome(plan: ResearchReviewScreeningPlanInspection, outcome: ResearchReviewScreeningDecisionSave['outcome']): void {
    const body = this.repository.systematicReviews.get({projectId: plan.snapshot.request.projectId, versionId: plan.snapshot.protocolVersionId}).version.body;
    if (outcome.decision === 'include' && outcome.inclusionCriterionIds.some(id => !body.inclusionCriteria.some(criterion => criterion.id === id)) ||
        outcome.decision === 'exclude' && !body.exclusionCriteria.some(criterion => criterion.id === outcome.exclusionCriterionId)) {
      throw new Error('research_review_screening_criterion_not_declared');
    }
  }
  private material(plan: ResearchReviewScreeningPlanInspection, hitId: string): ResearchReviewScreeningDecisionInspection['snapshot']['material'] {
    const request = {projectId: plan.snapshot.request.projectId, corpusId: plan.snapshot.request.corpusId};
    const deduplication = this.deduplication.get(request);
    if (deduplication.freeze === null || !deduplication.freeze.screenableHitIds.includes(hitId)) throw new Error('research_review_screening_hit_not_screenable');
    const original = this.corpora.getHit({...request, hitId});
    const abstract = original.record.record.abstract;
    return {hit: original.reference, source: original.source, abstractStatus: abstract === null || abstract.trim().length === 0 ? 'missing' : 'present'};
  }
  private latestRow(corpusId: string, hitId: string, reviewerId: string): DecisionRow | undefined {
    return this.db.prepare("SELECT * FROM research_review_screening_decisions WHERE corpus_id=? AND phase='title_abstract' AND hit_id=? AND reviewer_id=? ORDER BY version DESC LIMIT 1")
      .get(corpusId, hitId, reviewerId) as DecisionRow | undefined;
  }
  private validateSuggestion(request: ResearchReviewScreeningDecisionSave, plan: ResearchReviewScreeningPlanInspection): void {
    if (request.consideredSuggestion === null) return;
    const row = this.db.prepare('SELECT * FROM research_review_screening_suggestions WHERE id=?')
      .get(request.consideredSuggestion.id) as SuggestionRow | undefined;
    if (row === undefined) throw new Error('research_review_screening_suggestion_not_found');
    const suggestion = this.inspectSuggestion(row, plan);
    if (suggestion.snapshotHash !== request.consideredSuggestion.expectedHash || suggestion.snapshot.request.hitId !== request.hitId ||
        suggestion.snapshot.request.phase !== request.phase) {
      throw new Error('research_review_screening_version_conflict');
    }
  }
  private readDecision(row: DecisionRow, plan: ResearchReviewScreeningPlanInspection): ResearchReviewScreeningDecisionInspection['snapshot'] {
    const snapshot = researchReviewScreeningDecisionSnapshotSchema.parse(JSON.parse(row.snapshot_json)), request = snapshot.request;
    if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(snapshot) !== row.snapshot_json ||
        snapshot.id !== row.id || request.projectId !== row.project_id || request.projectId !== plan.snapshot.request.projectId ||
        request.corpusId !== row.corpus_id || row.corpus_id !== plan.snapshot.request.corpusId || request.phase !== row.phase || request.hitId !== row.hit_id ||
        request.reviewerId !== row.reviewer_id || request.expectedPlanHash !== plan.snapshotHash || request.requestId !== row.request_id ||
        request.parentDecisionId !== row.parent_id || snapshot.version !== row.version || snapshot.recordedAt !== row.created_at ||
        snapshot.requestHash !== hash(JSON.stringify(request)) || (snapshot.version === 1) !== (request.parentDecisionId === null) ||
        JSON.stringify(snapshot.reviewer) !== JSON.stringify(plan.snapshot.request.titleAbstractReviewers.find(reviewer => reviewer.id === request.reviewerId)) ||
        JSON.stringify(snapshot.material) !== JSON.stringify(this.material(plan, request.hitId))) throw new Error('research_review_screening_snapshot_invalid');
    this.validateOutcome(plan, request.outcome);
    this.validateSuggestion(request, plan);
    return snapshot;
  }
  private inspectDecision(row: DecisionRow, plan: ResearchReviewScreeningPlanInspection): ResearchReviewScreeningDecisionInspection {
    const snapshot = this.readDecision(row, plan);
    let child = snapshot;
    while (child.request.parentDecisionId !== null) {
      const parent = this.db.prepare('SELECT * FROM research_review_screening_decisions WHERE id=?')
        .get(child.request.parentDecisionId) as DecisionRow | undefined;
      if (parent === undefined) throw new Error('research_review_screening_snapshot_invalid');
      const previous = this.readDecision(parent, plan);
      if (previous.version !== child.version - 1 || previous.request.phase !== child.request.phase || previous.request.hitId !== child.request.hitId ||
          previous.request.reviewerId !== child.request.reviewerId || parent.snapshot_hash !== child.request.expectedParentHash) {
        throw new Error('research_review_screening_snapshot_invalid');
      }
      child = previous;
    }
    const latest = this.latestRow(row.corpus_id, row.hit_id, row.reviewer_id);
    if (latest === undefined) throw new Error('research_review_screening_snapshot_invalid');
    return researchReviewScreeningDecisionInspectionSchema.parse({snapshot, snapshotHash: row.snapshot_hash, isLatest: latest.id === row.id});
  }
  private inspectSuggestion(row: SuggestionRow, plan: ResearchReviewScreeningPlanInspection): ResearchReviewScreeningSuggestionInspection {
    const snapshot = researchReviewScreeningSuggestionSnapshotSchema.parse(JSON.parse(row.snapshot_json)), request = snapshot.request;
    if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(snapshot) !== row.snapshot_json ||
        snapshot.id !== row.id || request.projectId !== row.project_id || request.projectId !== plan.snapshot.request.projectId ||
        request.corpusId !== row.corpus_id || row.corpus_id !== plan.snapshot.request.corpusId || request.phase !== row.phase || request.hitId !== row.hit_id ||
        request.expectedPlanHash !== plan.snapshotHash || request.requestId !== row.request_id || snapshot.recordedAt !== row.created_at ||
        snapshot.requestHash !== hash(JSON.stringify(request)) ||
        JSON.stringify(snapshot.material) !== JSON.stringify(this.material(plan, request.hitId))) throw new Error('research_review_screening_snapshot_invalid');
    this.validateOutcome(plan, request.outcome);
    return researchReviewScreeningSuggestionInspectionSchema.parse({snapshot, snapshotHash: row.snapshot_hash});
  }
}
