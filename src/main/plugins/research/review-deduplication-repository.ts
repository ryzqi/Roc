import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewDuplicateSaveSchema, researchReviewDuplicateSnapshotSchema, researchReviewDuplicateInspectionSchema,
  researchReviewDeduplicationGetSchema, researchReviewDuplicateHistorySchema, researchReviewDeduplicationFreezeSchema,
  researchReviewDeduplicationReceiptSchema, researchReviewDeduplicationInspectionSchema,
  type ResearchReviewDuplicateSave, type ResearchReviewDuplicateSnapshot, type ResearchReviewDuplicateInspection,
  type ResearchReviewDeduplicationFreeze, type ResearchReviewDeduplicationInspection
} from '../../../shared/schemas/research-review-deduplication';
import type {ResearchReviewCorpusInspection} from '../../../shared/schemas/research-review-corpus';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewCorpusRepository} from './review-corpus-repository';

type DecisionRow = {
  id: string; project_id: string; corpus_id: string; pair_key: string; version: number; parent_id: string | null;
  request_id: string; snapshot_json: string; snapshot_hash: string; created_at: string
};
type FreezeRow = {corpus_id: string; project_id: string; request_id: string; snapshot_json: string; snapshot_hash: string; created_at: string};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const pairKey = (left: string, right: string): string => hash(JSON.stringify([left, right].sort()));

/** Human pair decisions are append-only. Only an explicit freeze establishes the screening set. */
export class ResearchReviewDeduplicationRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly corpora: ResearchReviewCorpusRepository, private readonly now: () => string) {}

  save(input: ResearchReviewDuplicateSave, reviewedBy: ResearchRelationReviewer): ResearchReviewDuplicateInspection {
    const request = researchReviewDuplicateSaveSchema.parse(input), actor = researchRelationReviewerSchema.parse(reviewedBy);
    return this.db.transaction(() => {
      this.requireWritable(request.projectId);
      const corpus = this.corpora.get({projectId: request.projectId, corpusId: request.corpusId});
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_duplicate_decisions WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as DecisionRow | undefined;
      if (replay !== undefined) {
        if (replay.corpus_id !== request.corpusId) throw new Error('research_review_request_conflict');
        const existing = this.inspectDecision(replay, corpus);
        if (existing.snapshot.requestHash !== requestHash || existing.snapshot.actor.id !== actor.id) throw new Error('research_review_request_conflict');
        this.get({projectId: request.projectId, corpusId: request.corpusId});
        return existing;
      }
      this.requireOpen(corpus, request.expectedCorpusHash);
      const key = pairKey(request.leftHitId, request.rightHitId);
      const previous = this.latestRows(request.corpusId).find(row => row.pair_key === key);
      const parent = previous === undefined ? null : this.inspectDecision(previous, corpus);
      if (parent === null ? request.parentDecisionId !== null :
          request.parentDecisionId !== parent.snapshot.id || request.expectedParentHash !== parent.snapshotHash) {
        throw new Error('research_review_duplicate_version_conflict');
      }
      const snapshot = researchReviewDuplicateSnapshotSchema.parse({
        id: `review_duplicate_${randomUUID()}`, pairKey: key, version: parent === null ? 1 : parent.snapshot.version + 1,
        request, requestHash, left: this.endpoint(corpus, request.leftHitId), right: this.endpoint(corpus, request.rightHitId),
        actor, recordedAt: this.now()
      });
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_duplicate_decisions
        (id,project_id,corpus_id,pair_key,version,parent_id,request_id,snapshot_json,snapshot_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(snapshot.id, request.projectId, request.corpusId, key, snapshot.version,
          request.parentDecisionId, request.requestId, json, hash(json), snapshot.recordedAt);
      const state = this.get({projectId: request.projectId, corpusId: request.corpusId});
      const saved = state.decisions.find(decision => decision.snapshot.id === snapshot.id);
      if (saved === undefined) throw new Error('research_review_duplicate_snapshot_invalid');
      return saved;
    })();
  }

  get(input: {projectId: string; corpusId: string}): ResearchReviewDeduplicationInspection {
    const request = researchReviewDeduplicationGetSchema.parse(input);
    const corpus = this.corpora.get(request), decisions = this.latestRows(request.corpusId).map(row => this.inspectDecision(row, corpus));
    const marker = this.db.prepare('SELECT dedup_freeze_hash FROM research_review_corpora WHERE id=?').pluck().get(request.corpusId);
    const receipt = this.db.prepare('SELECT * FROM research_review_deduplication_freezes WHERE corpus_id=?')
      .get(request.corpusId) as FreezeRow | undefined;
    if ((receipt === undefined) !== (marker === null) || (receipt !== undefined && receipt.snapshot_hash !== marker)) {
      throw new Error('research_review_duplicate_snapshot_invalid');
    }
    let freeze: ResearchReviewDeduplicationInspection['freeze'] = null;
    if (receipt !== undefined) {
      freeze = researchReviewDeduplicationReceiptSchema.parse(JSON.parse(receipt.snapshot_json));
      const captured = this.resolve(corpus, decisions);
      if (hash(receipt.snapshot_json) !== receipt.snapshot_hash || JSON.stringify(freeze) !== receipt.snapshot_json ||
          receipt.corpus_id !== corpus.snapshot.id || receipt.project_id !== request.projectId ||
          freeze.request.projectId !== request.projectId || freeze.request.corpusId !== corpus.snapshot.id ||
          freeze.request.expectedCorpusHash !== corpus.snapshotHash || freeze.request.requestId !== receipt.request_id ||
          freeze.requestHash !== hash(JSON.stringify(freeze.request)) || freeze.frozenAt !== receipt.created_at ||
          !this.sameReferences(freeze.request.decisions, captured.decisions) ||
          JSON.stringify(this.capturedFields(freeze)) !== JSON.stringify(captured)) {
        throw new Error('research_review_duplicate_snapshot_invalid');
      }
    }
    return researchReviewDeduplicationInspectionSchema.parse({
      corpusId: corpus.snapshot.id, corpusHash: corpus.snapshotHash, currentProtocol: corpus.currentProtocol,
      decisions, freeze, freezeHash: receipt === undefined ? null : receipt.snapshot_hash
    });
  }

  history(input: {projectId: string; corpusId: string; decisionId: string}): ResearchReviewDuplicateInspection[] {
    const request = researchReviewDuplicateHistorySchema.parse(input);
    const corpus = this.corpora.get({projectId: request.projectId, corpusId: request.corpusId});
    const selected = this.db.prepare('SELECT * FROM research_review_duplicate_decisions WHERE id=?')
      .get(request.decisionId) as DecisionRow | undefined;
    if (selected === undefined) throw new Error('research_review_duplicate_not_found');
    if (selected.project_id !== request.projectId || selected.corpus_id !== request.corpusId) throw new Error('research_review_project_mismatch');
    return (this.db.prepare('SELECT * FROM research_review_duplicate_decisions WHERE corpus_id=? AND pair_key=? ORDER BY version')
      .all(request.corpusId, selected.pair_key) as DecisionRow[]).map(row => this.inspectDecision(row, corpus));
  }

  freeze(input: ResearchReviewDeduplicationFreeze, reviewedBy: ResearchRelationReviewer): ResearchReviewDeduplicationInspection {
    const request = researchReviewDeduplicationFreezeSchema.parse(input), actor = researchRelationReviewerSchema.parse(reviewedBy);
    return this.db.transaction(() => {
      this.requireWritable(request.projectId);
      const state = this.get({projectId: request.projectId, corpusId: request.corpusId}), requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_deduplication_freezes WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as FreezeRow | undefined;
      if (replay !== undefined) {
        const previous = this.get({projectId: request.projectId, corpusId: replay.corpus_id});
        if (previous.freeze === null || previous.freeze.requestHash !== requestHash || previous.freeze.actor.id !== actor.id) {
          throw new Error('research_review_request_conflict');
        }
        return previous;
      }
      const corpus = this.corpora.get({projectId: request.projectId, corpusId: request.corpusId});
      this.requireOpen(corpus, request.expectedCorpusHash);
      const captured = this.resolve(corpus, state.decisions);
      if (!this.sameReferences(request.decisions, captured.decisions)) throw new Error('research_review_duplicate_decision_set_changed');
      const receipt = researchReviewDeduplicationReceiptSchema.parse({request, requestHash, ...captured, actor, frozenAt: this.now()});
      const json = JSON.stringify(receipt);
      this.db.prepare(`INSERT INTO research_review_deduplication_freezes
        (corpus_id,project_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?)`)
        .run(request.corpusId, request.projectId, request.requestId, json, hash(json), receipt.frozenAt);
      this.db.prepare('UPDATE research_review_corpora SET dedup_freeze_hash=? WHERE id=? AND dedup_freeze_hash IS NULL')
        .run(hash(json), request.corpusId);
      return this.get({projectId: request.projectId, corpusId: request.corpusId});
    })();
  }

  requireFrozen(projectId: string, corpusId: string, expectedFreezeHash: string): ResearchReviewDeduplicationInspection {
    const state = this.get({projectId, corpusId});
    if (state.freeze === null) throw new Error('research_review_duplicate_not_frozen');
    if (!state.currentProtocol || state.freezeHash !== expectedFreezeHash) throw new Error('research_review_duplicate_version_conflict');
    return state;
  }

  private requireWritable(projectId: string): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  private requireOpen(corpus: ResearchReviewCorpusInspection, expectedHash: string): void {
    if (!corpus.currentProtocol || corpus.snapshotHash !== expectedHash) throw new Error('research_review_duplicate_version_conflict');
    if (this.get({projectId: corpus.snapshot.request.projectId, corpusId: corpus.snapshot.id}).freeze !== null) {
      throw new Error('research_review_duplicate_already_frozen');
    }
  }
  private latestRows(corpusId: string): DecisionRow[] {
    return this.db.prepare(`SELECT * FROM research_review_duplicate_decisions d WHERE corpus_id=? AND
      version=(SELECT MAX(version) FROM research_review_duplicate_decisions WHERE corpus_id=d.corpus_id AND pair_key=d.pair_key)
      ORDER BY pair_key`).all(corpusId) as DecisionRow[];
  }
  private endpoint(corpus: ResearchReviewCorpusInspection, hitId: string): ResearchReviewDuplicateSnapshot['left'] {
    const hit = corpus.snapshot.hits.find(value => value.id === hitId);
    if (hit === undefined) throw new Error('research_review_corpus_hit_not_found');
    const source = corpus.snapshot.sources.find(value => value.reviewSearchId === hit.reviewSearchId);
    if (source === undefined) throw new Error('research_review_duplicate_snapshot_invalid');
    return {hit, source};
  }
  private readDecision(row: DecisionRow, corpus: ResearchReviewCorpusInspection): ResearchReviewDuplicateSnapshot {
    const snapshot = researchReviewDuplicateSnapshotSchema.parse(JSON.parse(row.snapshot_json)), request = snapshot.request;
    if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(snapshot) !== row.snapshot_json ||
        snapshot.id !== row.id || request.projectId !== row.project_id || request.projectId !== corpus.snapshot.request.projectId ||
        request.corpusId !== row.corpus_id || row.corpus_id !== corpus.snapshot.id || request.expectedCorpusHash !== corpus.snapshotHash ||
        request.requestId !== row.request_id || snapshot.requestHash !== hash(JSON.stringify(request)) ||
        request.parentDecisionId !== row.parent_id || snapshot.version !== row.version || snapshot.recordedAt !== row.created_at ||
        snapshot.pairKey !== row.pair_key || row.pair_key !== pairKey(request.leftHitId, request.rightHitId) ||
        JSON.stringify(snapshot.left) !== JSON.stringify(this.endpoint(corpus, request.leftHitId)) ||
        JSON.stringify(snapshot.right) !== JSON.stringify(this.endpoint(corpus, request.rightHitId)) ||
        (snapshot.version === 1) !== (request.parentDecisionId === null)) throw new Error('research_review_duplicate_snapshot_invalid');
    return snapshot;
  }
  private inspectDecision(row: DecisionRow, corpus: ResearchReviewCorpusInspection): ResearchReviewDuplicateInspection {
    const snapshot = this.readDecision(row, corpus);
    let child = snapshot;
    while (child.request.parentDecisionId !== null) {
      const parent = this.db.prepare('SELECT * FROM research_review_duplicate_decisions WHERE id=?')
        .get(child.request.parentDecisionId) as DecisionRow | undefined;
      if (parent === undefined) throw new Error('research_review_duplicate_snapshot_invalid');
      const previous = this.readDecision(parent, corpus);
      if (previous.version !== child.version - 1 || previous.pairKey !== child.pairKey || parent.snapshot_hash !== child.request.expectedParentHash) {
        throw new Error('research_review_duplicate_snapshot_invalid');
      }
      child = previous;
    }
    const latest = this.db.prepare('SELECT id FROM research_review_duplicate_decisions WHERE corpus_id=? AND pair_key=? ORDER BY version DESC LIMIT 1')
      .pluck().get(row.corpus_id, row.pair_key);
    return researchReviewDuplicateInspectionSchema.parse({snapshot, snapshotHash: row.snapshot_hash, isLatest: latest === row.id});
  }
  private sameReferences(left: ResearchReviewDeduplicationFreeze['decisions'], right: ResearchReviewDeduplicationFreeze['decisions']): boolean {
    const sorted = (values: typeof left): string => JSON.stringify([...values].sort((a, b) => a.decisionId.localeCompare(b.decisionId)));
    return sorted(left) === sorted(right);
  }
  private capturedFields(receipt: NonNullable<ResearchReviewDeduplicationInspection['freeze']>): ReturnType<ResearchReviewDeduplicationRepository['resolve']> {
    return {decisions: receipt.decisions, removed: receipt.removed, screenableHitIds: receipt.screenableHitIds,
      identifiedRecords: receipt.identifiedRecords, removedDuplicates: receipt.removedDuplicates, recordsToScreen: receipt.recordsToScreen};
  }
  private resolve(corpus: ResearchReviewCorpusInspection, decisions: ResearchReviewDuplicateInspection[]): Pick<
    NonNullable<ResearchReviewDeduplicationInspection['freeze']>,
    'decisions' | 'removed' | 'screenableHitIds' | 'identifiedRecords' | 'removedDuplicates' | 'recordsToScreen'> {
    const edges = new Map<string, string>();
    for (const {snapshot} of decisions) if (snapshot.request.decision === 'duplicate') {
      if (edges.has(snapshot.request.leftHitId)) throw new Error('research_review_duplicate_ambiguous_removal');
      edges.set(snapshot.request.leftHitId, snapshot.request.rightHitId);
    }
    const representative = (hitId: string): string => {
      const seen = new Set<string>();
      let current = hitId;
      while (edges.has(current)) {
        if (seen.has(current)) throw new Error('research_review_duplicate_cycle');
        seen.add(current);
        const next = edges.get(current);
        if (next === undefined) throw new Error('research_review_duplicate_snapshot_invalid');
        current = next;
      }
      return current;
    };
    const removed = corpus.snapshot.hits.filter(hit => edges.has(hit.id)).map(hit => ({hitId: hit.id, retainedHitId: representative(hit.id)}));
    for (const {snapshot} of decisions) if (snapshot.request.decision === 'distinct' &&
      representative(snapshot.request.leftHitId) === representative(snapshot.request.rightHitId)) {
      throw new Error('research_review_duplicate_distinct_conflict');
    }
    const screenableHitIds = corpus.snapshot.hits.filter(hit => !edges.has(hit.id)).map(hit => hit.id);
    return {decisions: decisions.map(decision => ({decisionId: decision.snapshot.id, expectedHash: decision.snapshotHash})),
      removed, screenableHitIds, identifiedRecords: corpus.identifiedRecords, removedDuplicates: removed.length, recordsToScreen: screenableHitIds.length};
  }
}
