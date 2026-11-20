import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewScreeningArbitrationSaveSchema, researchReviewScreeningArbitrationSnapshotSchema, researchReviewScreeningArbitrationInspectionSchema,
  researchReviewScreeningArbitrationHistorySchema, researchReviewScreeningResolvedPhaseSchema,
  type ResearchReviewScreeningArbitrationSave, type ResearchReviewScreeningArbitrationInspection,
  type ResearchReviewScreeningPhaseInspection, type ResearchReviewScreeningResolvedPhase
} from '../../../shared/schemas/research-review-screening';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewScreeningDecisions} from './review-screening-decisions';
import {requireScreeningPhaseOpen} from './review-screening-freeze';

type ArbitrationRow = {
  id: string; project_id: string; corpus_id: string; phase: string; hit_id: string; version: number; parent_id: string | null;
  request_id: string; snapshot_json: string; snapshot_hash: string; created_at: string
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const sameReferences = (left: ResearchReviewScreeningArbitrationSave['decisions'], right: ResearchReviewScreeningArbitrationSave['decisions']): boolean => {
  const sorted = (refs: typeof left): string => JSON.stringify([...refs].sort((a, b) => a.id.localeCompare(b.id)));
  return sorted(left) === sorted(right);
};

/** A human adjudicator can resolve only the exact, complete reviewer set they inspected. */
export class ResearchReviewScreeningArbitration {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly decisions: ResearchReviewScreeningDecisions, private readonly now: () => string) {}

  save(input: ResearchReviewScreeningArbitrationSave, resolvedBy: ResearchRelationReviewer): ResearchReviewScreeningArbitrationInspection {
    const request = researchReviewScreeningArbitrationSaveSchema.parse(input), actor = researchRelationReviewerSchema.parse(resolvedBy);
    return this.db.transaction(() => {
      if (this.repository.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const phase = this.decisions.getPhase({projectId: request.projectId, corpusId: request.corpusId, phase: request.phase});
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as ArbitrationRow | undefined;
      if (replay !== undefined) {
        if (replay.corpus_id !== request.corpusId) throw new Error('research_review_request_conflict');
        const previous = this.inspect(replay, phase);
        if (previous.snapshot.requestHash !== requestHash || previous.snapshot.actor.id !== actor.id) throw new Error('research_review_request_conflict');
        return previous;
      }
      if (!phase.plan.currentProtocol || phase.plan.snapshotHash !== request.expectedPlanHash) throw new Error('research_review_screening_version_conflict');
      requireScreeningPhaseOpen(this.db, request.projectId, request.corpusId, request.phase);
      if (phase.plan.snapshot.request.adjudicator.id !== request.reviewerId) throw new Error('research_review_screening_adjudicator_not_declared');
      const item = phase.items.find(item => item.hit.id === request.hitId);
      if (item === undefined) throw new Error('research_review_screening_hit_not_screenable');
      if (item.status === 'pending') throw new Error('research_review_screening_arbitration_incomplete');
      if (item.status !== 'conflict' && item.status !== 'uncertain') throw new Error('research_review_screening_arbitration_not_needed');
      const refs = item.decisions.map(decision => ({id: decision.snapshot.id, expectedHash: decision.snapshotHash}));
      if (!sameReferences(refs, request.decisions)) throw new Error('research_review_screening_arbitration_decisions_changed');
      this.validateOutcome(phase, request.outcome);
      const latest = this.latest(request.corpusId, request.phase, request.hitId);
      const parent = latest === undefined ? null : this.inspect(latest, phase);
      if (parent === null ? request.parentArbitrationId !== null :
          request.parentArbitrationId !== parent.snapshot.id || request.expectedParentHash !== parent.snapshotHash) {
        throw new Error('research_review_screening_version_conflict');
      }
      const snapshot = researchReviewScreeningArbitrationSnapshotSchema.parse({
        id: `review_screening_arbitration_${randomUUID()}`, version: parent === null ? 1 : parent.snapshot.version + 1,
        request, requestHash, adjudicator: phase.plan.snapshot.request.adjudicator, material: item.decisions[0].snapshot.material,
        actor, recordedAt: this.now()
      });
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_screening_arbitrations
        (id,project_id,corpus_id,phase,hit_id,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id, request.projectId, request.corpusId, request.phase, request.hitId,
          snapshot.version, request.parentArbitrationId, request.requestId, json, hash(json), snapshot.recordedAt);
      const row = this.latest(request.corpusId, request.phase, request.hitId);
      if (row === undefined || row.id !== snapshot.id) throw new Error('research_review_screening_snapshot_invalid');
      const current = this.decisions.getPhase({projectId: request.projectId, corpusId: request.corpusId, phase: request.phase});
      if (!current.plan.currentProtocol || current.plan.snapshotHash !== request.expectedPlanHash) throw new Error('research_review_screening_version_conflict');
      const saved = this.inspect(row, current);
      if (!saved.currentDecisionSet) throw new Error('research_review_screening_arbitration_decisions_changed');
      return saved;
    })();
  }

  getPhase(input: {projectId: string; corpusId: string; phase: 'title_abstract'}): ResearchReviewScreeningResolvedPhase {
    const phase = this.decisions.getPhase(input);
    const counts = {...phase.counts};
    const items = phase.items.map(item => {
      const row = this.latest(input.corpusId, input.phase, item.hit.id);
      const arbitration = row === undefined ? null : this.inspect(row, phase);
      let status = item.status;
      if (arbitration !== null && arbitration.currentDecisionSet && (status === 'conflict' || status === 'uncertain')) {
        counts[status] -= 1;
        status = arbitration.snapshot.request.outcome.decision === 'include' ? 'included' : 'excluded';
        counts[status] += 1;
      }
      return {...item, status, arbitration};
    });
    return researchReviewScreeningResolvedPhaseSchema.parse({...phase, items, counts});
  }

  history(input: {projectId: string; corpusId: string; arbitrationId: string}): ResearchReviewScreeningArbitrationInspection[] {
    const request = researchReviewScreeningArbitrationHistorySchema.parse(input);
    const selected = this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE id=?').get(request.arbitrationId) as ArbitrationRow | undefined;
    if (selected === undefined) throw new Error('research_review_screening_arbitration_not_found');
    if (selected.project_id !== request.projectId || selected.corpus_id !== request.corpusId) throw new Error('research_review_project_mismatch');
    const phase = this.decisions.getPhase({projectId: request.projectId, corpusId: request.corpusId, phase: 'title_abstract'});
    return (this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE corpus_id=? AND phase=? AND hit_id=? ORDER BY version')
      .all(request.corpusId, selected.phase, selected.hit_id) as ArbitrationRow[]).map(row => this.inspect(row, phase));
  }

  private latest(corpusId: string, phase: string, hitId: string): ArbitrationRow | undefined {
    return this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE corpus_id=? AND phase=? AND hit_id=? ORDER BY version DESC LIMIT 1')
      .get(corpusId, phase, hitId) as ArbitrationRow | undefined;
  }
  private validateOutcome(phase: ResearchReviewScreeningPhaseInspection, outcome: ResearchReviewScreeningArbitrationSave['outcome']): void {
    const body = this.repository.systematicReviews.get({projectId: phase.plan.snapshot.request.projectId, versionId: phase.plan.snapshot.protocolVersionId}).version.body;
    if (outcome.decision === 'include' ?
        outcome.inclusionCriterionIds.some(id => !body.inclusionCriteria.some(criterion => criterion.id === id)) :
        !body.exclusionCriteria.some(criterion => criterion.id === outcome.exclusionCriterionId)) {
      throw new Error('research_review_screening_criterion_not_declared');
    }
  }
  private read(row: ArbitrationRow, phase: ResearchReviewScreeningPhaseInspection): ResearchReviewScreeningArbitrationInspection['snapshot'] {
    const snapshot = researchReviewScreeningArbitrationSnapshotSchema.parse(JSON.parse(row.snapshot_json)), request = snapshot.request;
    if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(snapshot) !== row.snapshot_json ||
        snapshot.id !== row.id || request.projectId !== row.project_id || row.project_id !== phase.plan.snapshot.request.projectId ||
        request.corpusId !== row.corpus_id || row.corpus_id !== phase.plan.snapshot.request.corpusId || request.phase !== row.phase ||
        request.phase !== phase.phase || request.hitId !== row.hit_id || request.requestId !== row.request_id ||
        request.expectedPlanHash !== phase.plan.snapshotHash || request.parentArbitrationId !== row.parent_id ||
        snapshot.version !== row.version || snapshot.recordedAt !== row.created_at || snapshot.requestHash !== hash(JSON.stringify(request)) ||
        (snapshot.version === 1) !== (request.parentArbitrationId === null) ||
        request.reviewerId !== phase.plan.snapshot.request.adjudicator.id ||
        JSON.stringify(snapshot.adjudicator) !== JSON.stringify(phase.plan.snapshot.request.adjudicator)) throw new Error('research_review_screening_snapshot_invalid');
    const captured = request.decisions.map(ref => {
      const decision = this.decisions.history({projectId: request.projectId, corpusId: request.corpusId, decisionId: ref.id})
        .find(decision => decision.snapshot.id === ref.id);
      if (decision === undefined || decision.snapshotHash !== ref.expectedHash || decision.snapshot.request.hitId !== request.hitId ||
          decision.snapshot.request.phase !== request.phase) throw new Error('research_review_screening_snapshot_invalid');
      return decision;
    });
    if (captured.length !== phase.plan.snapshot.request.titleAbstractReviewers.length ||
        new Set(captured.map(decision => decision.snapshot.reviewer.id)).size !== captured.length ||
        captured.some(decision => JSON.stringify(decision.snapshot.material) !== JSON.stringify(snapshot.material))) {
      throw new Error('research_review_screening_snapshot_invalid');
    }
    this.validateOutcome(phase, request.outcome);
    return snapshot;
  }
  private inspect(row: ArbitrationRow, phase: ResearchReviewScreeningPhaseInspection): ResearchReviewScreeningArbitrationInspection {
    const snapshot = this.read(row, phase);
    let child = snapshot;
    while (child.request.parentArbitrationId !== null) {
      const parent = this.db.prepare('SELECT * FROM research_review_screening_arbitrations WHERE id=?')
        .get(child.request.parentArbitrationId) as ArbitrationRow | undefined;
      if (parent === undefined) throw new Error('research_review_screening_snapshot_invalid');
      const previous = this.read(parent, phase);
      if (previous.version !== child.version - 1 || previous.request.hitId !== child.request.hitId ||
          previous.request.phase !== child.request.phase || parent.snapshot_hash !== child.request.expectedParentHash) {
        throw new Error('research_review_screening_snapshot_invalid');
      }
      child = previous;
    }
    const item = phase.items.find(item => item.hit.id === row.hit_id);
    if (item === undefined) throw new Error('research_review_screening_snapshot_invalid');
    const latest = this.latest(row.corpus_id, row.phase, row.hit_id);
    if (latest === undefined) throw new Error('research_review_screening_snapshot_invalid');
    return researchReviewScreeningArbitrationInspectionSchema.parse({
      snapshot, snapshotHash: row.snapshot_hash, isLatest: latest.id === row.id,
      currentDecisionSet: sameReferences(snapshot.request.decisions, item.decisions.map(decision => ({id: decision.snapshot.id, expectedHash: decision.snapshotHash})))
    });
  }
}
