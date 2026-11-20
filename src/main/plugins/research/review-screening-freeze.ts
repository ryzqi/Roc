import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewScreeningAuthoritySchema, researchReviewScreeningFreezeRequestSchema, researchReviewScreeningFreezeReceiptSchema,
  researchReviewScreeningFrozenPhaseSchema, researchReviewScreeningPhaseGetSchema,
  type ResearchReviewScreeningAuthority, type ResearchReviewScreeningFreezeRequest, type ResearchReviewScreeningFreezeReceipt,
  type ResearchReviewScreeningFrozenPhase, type ResearchReviewScreeningResolvedPhase
} from '../../../shared/schemas/research-review-screening';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewScreeningArbitration} from './review-screening-arbitration';

type FreezeRow = {
  project_id: string; corpus_id: string; phase: string; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Shared write boundary: a marked missing/corrupt receipt must never reopen a phase. */
export function readScreeningFreeze(db: Database, projectId: string, corpusId: string, phase: 'title_abstract'):
  {receipt: ResearchReviewScreeningFreezeReceipt; receiptHash: string} | null {
  researchReviewScreeningPhaseGetSchema.parse({projectId, corpusId, phase});
  const plan = db.prepare('SELECT project_id,title_freeze_hash FROM research_review_screening_plans WHERE corpus_id=?')
    .get(corpusId) as {project_id: string; title_freeze_hash: string | null} | undefined;
  if (plan === undefined) throw new Error('research_review_screening_plan_not_found');
  if (plan.project_id !== projectId) throw new Error('research_review_project_mismatch');
  const row = db.prepare('SELECT * FROM research_review_screening_freezes WHERE corpus_id=? AND phase=?')
    .get(corpusId, phase) as FreezeRow | undefined;
  if ((row === undefined) !== (plan.title_freeze_hash === null) ||
      (row !== undefined && row.snapshot_hash !== plan.title_freeze_hash)) throw new Error('research_review_screening_snapshot_invalid');
  if (row === undefined) return null;
  const receipt = researchReviewScreeningFreezeReceiptSchema.parse(JSON.parse(row.snapshot_json));
  if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(receipt) !== row.snapshot_json ||
      row.project_id !== projectId || receipt.request.projectId !== projectId || row.corpus_id !== corpusId ||
      receipt.request.corpusId !== corpusId || row.phase !== phase || receipt.request.phase !== phase ||
      receipt.request.requestId !== row.request_id || receipt.frozenAt !== row.created_at ||
      receipt.requestHash !== hash(JSON.stringify(receipt.request)) ||
      receipt.reviewHash !== hash(JSON.stringify(receipt.authority)) || receipt.request.expectedReviewHash !== receipt.reviewHash ||
      receipt.authority.corpusId !== corpusId || receipt.authority.phase !== phase) throw new Error('research_review_screening_snapshot_invalid');
  return {receipt, receiptHash: row.snapshot_hash};
}
export function requireScreeningPhaseOpen(db: Database, projectId: string, corpusId: string, phase: 'title_abstract'): void {
  if (readScreeningFreeze(db, projectId, corpusId, phase) !== null) throw new Error('research_review_screening_already_frozen');
}

/** Explicit human freeze of the complete current reviewer/adjudication authority set. */
export class ResearchReviewScreeningFreeze {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly arbitration: ResearchReviewScreeningArbitration, private readonly now: () => string) {}

  getPhase(input: {projectId: string; corpusId: string; phase: 'title_abstract'}): ResearchReviewScreeningFrozenPhase {
    const request = researchReviewScreeningPhaseGetSchema.parse(input), phase = this.arbitration.getPhase(request);
    const authority = this.capture(phase), reviewHash = hash(JSON.stringify(authority));
    const sealed = readScreeningFreeze(this.db, request.projectId, request.corpusId, request.phase);
    if (sealed !== null && (sealed.receipt.reviewHash !== reviewHash ||
        JSON.stringify(sealed.receipt.authority) !== JSON.stringify(authority))) throw new Error('research_review_screening_snapshot_invalid');
    return researchReviewScreeningFrozenPhaseSchema.parse({
      ...phase, reviewHash, freeze: sealed === null ? null : sealed.receipt, freezeHash: sealed === null ? null : sealed.receiptHash
    });
  }

  freeze(input: ResearchReviewScreeningFreezeRequest, reviewedBy: ResearchRelationReviewer): ResearchReviewScreeningFrozenPhase {
    const request = researchReviewScreeningFreezeRequestSchema.parse(input), actor = researchRelationReviewerSchema.parse(reviewedBy);
    return this.db.transaction(() => {
      if (this.repository.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const phase = this.getPhase({projectId: request.projectId, corpusId: request.corpusId, phase: request.phase});
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_screening_freezes WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as FreezeRow | undefined;
      if (replay !== undefined) {
        const previous = this.getPhase({projectId: request.projectId, corpusId: replay.corpus_id, phase: 'title_abstract'});
        if (previous.freeze === null || previous.freeze.requestHash !== requestHash || previous.freeze.actor.id !== actor.id) {
          throw new Error('research_review_request_conflict');
        }
        return previous;
      }
      if (phase.freeze !== null) throw new Error('research_review_screening_already_frozen');
      if (!phase.plan.currentProtocol || phase.reviewHash !== request.expectedReviewHash) throw new Error('research_review_screening_version_conflict');
      if (phase.counts.pending !== 0 || phase.counts.uncertain !== 0 || phase.counts.conflict !== 0) throw new Error('research_review_screening_incomplete');
      const receipt = researchReviewScreeningFreezeReceiptSchema.parse({
        request, requestHash, authority: this.capture(phase), reviewHash: phase.reviewHash, actor, frozenAt: this.now()
      });
      const json = JSON.stringify(receipt);
      this.db.prepare(`INSERT INTO research_review_screening_freezes
        (project_id,corpus_id,phase,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(request.projectId, request.corpusId, request.phase, request.requestId, json, hash(json), receipt.frozenAt);
      this.db.prepare('UPDATE research_review_screening_plans SET title_freeze_hash=? WHERE corpus_id=? AND title_freeze_hash IS NULL')
        .run(hash(json), request.corpusId);
      const saved = this.getPhase({projectId: request.projectId, corpusId: request.corpusId, phase: request.phase});
      if (!saved.plan.currentProtocol || saved.reviewHash !== request.expectedReviewHash) throw new Error('research_review_screening_version_conflict');
      return saved;
    })();
  }

  requireFrozen(projectId: string, corpusId: string, expectedFreezeHash: string): ResearchReviewScreeningFrozenPhase {
    const phase = this.getPhase({projectId, corpusId, phase: 'title_abstract'});
    if (phase.freeze === null) throw new Error('research_review_screening_not_frozen');
    if (!phase.plan.currentProtocol || phase.freezeHash !== expectedFreezeHash) throw new Error('research_review_screening_version_conflict');
    return phase;
  }

  private capture(phase: ResearchReviewScreeningResolvedPhase): ResearchReviewScreeningAuthority {
    return researchReviewScreeningAuthoritySchema.parse({
      corpusId: phase.plan.snapshot.request.corpusId, corpusHash: phase.plan.snapshot.request.expectedCorpusHash,
      planId: phase.plan.snapshot.id, planHash: phase.plan.snapshotHash, phase: phase.phase, counts: phase.counts,
      items: phase.items.map(item => {
        const applied = item.arbitration !== null && item.arbitration.isLatest && item.arbitration.currentDecisionSet ? item.arbitration : null;
        let primaryExclusionCriterionId: string | null = null;
        if (item.status === 'excluded') {
          const outcome = applied === null ? item.decisions[0].snapshot.request.outcome : applied.snapshot.request.outcome;
          if (outcome.decision !== 'exclude') throw new Error('research_review_screening_snapshot_invalid');
          primaryExclusionCriterionId = outcome.exclusionCriterionId;
        }
        return {hit: item.hit, status: item.status,
          decisions: item.decisions.map(decision => ({id: decision.snapshot.id, expectedHash: decision.snapshotHash})),
          arbitration: applied === null ? null : {id: applied.snapshot.id, expectedHash: applied.snapshotHash}, primaryExclusionCriterionId};
      })
    });
  }
}
