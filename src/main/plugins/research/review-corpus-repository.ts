import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchReviewCorpusCreateSchema, researchReviewCorpusSnapshotSchema, researchReviewCorpusSourceSchema,
  researchReviewCorpusHitSchema, researchReviewCorpusInspectionSchema, researchReviewCorpusGetSchema,
  researchReviewCorpusListSchema, researchReviewCorpusHitRequestSchema, researchReviewCorpusHitResultSchema,
  type ResearchReviewCorpusCreate, type ResearchReviewCorpusInspection, type ResearchReviewCorpusHitResult
} from '../../../shared/schemas/research-review-corpus';
import {researchRelationReviewerSchema, type ResearchRelationReviewer} from '../../../shared/schemas/research-evidence-relations';
import type {ResearchRepository} from './repository';
import type {ResearchReviewSearchService} from './review-search-service';

type CorpusRow = {
  id: string; project_id: string; protocol_version_id: string; request_id: string;
  snapshot_json: string; snapshot_hash: string; created_at: string
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A corpus seals references to the existing original result pools; it does not create another paper library. */
export class ResearchReviewCorpusRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly searches: Pick<ResearchReviewSearchService, 'get' | 'readFullPool'>, private readonly now: () => string) {}

  create(input: ResearchReviewCorpusCreate, createdBy: ResearchRelationReviewer): ResearchReviewCorpusInspection {
    const request = researchReviewCorpusCreateSchema.parse(input), actor = researchRelationReviewerSchema.parse(createdBy);
    return this.db.transaction(() => {
      if (this.repository.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const requestHash = hash(JSON.stringify(request));
      const replay = this.db.prepare('SELECT * FROM research_review_corpora WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as CorpusRow | undefined;
      if (replay !== undefined) {
        const existing = this.inspect(replay);
        if (existing.snapshot.requestHash !== requestHash || existing.snapshot.actor.id !== actor.id) throw new Error('research_review_request_conflict');
        return existing;
      }
      const protocol = this.repository.systematicReviews.requireFrozen(request.projectId, request.versionId, request.expectedFreezeHash);
      const id = `review_corpus_${randomUUID()}`;
      const {sources, hits} = this.capture(request, id);
      const snapshot = researchReviewCorpusSnapshotSchema.parse({
        id, request, requestHash, protocolVersionHash: protocol.versionHash, sources, hits, actor, recordedAt: this.now()
      });
      const json = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_corpora
        (id,project_id,protocol_version_id,request_id,snapshot_json,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, request.projectId, request.versionId, request.requestId, json, hash(json), snapshot.recordedAt);
      return this.get({projectId: request.projectId, corpusId: id});
    })();
  }

  get(input: {projectId: string; corpusId: string}): ResearchReviewCorpusInspection {
    const request = researchReviewCorpusGetSchema.parse(input);
    this.repository.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_review_corpora WHERE id=?').get(request.corpusId) as CorpusRow | undefined;
    if (row === undefined) throw new Error('research_review_corpus_not_found');
    if (row.project_id !== request.projectId) throw new Error('research_review_project_mismatch');
    return this.inspect(row);
  }

  list(input: {projectId: string; versionId: string; limit: number}): ResearchReviewCorpusInspection[] {
    const request = researchReviewCorpusListSchema.parse(input);
    this.repository.systematicReviews.get({projectId: request.projectId, versionId: request.versionId});
    const rows = this.db.prepare('SELECT * FROM research_review_corpora WHERE project_id=? AND protocol_version_id=? ORDER BY rowid DESC LIMIT ?')
      .all(request.projectId, request.versionId, request.limit) as CorpusRow[];
    return rows.map(row => this.inspect(row));
  }

  getHit(input: {projectId: string; corpusId: string; hitId: string}): ResearchReviewCorpusHitResult {
    const request = researchReviewCorpusHitRequestSchema.parse(input);
    const corpus = this.get({projectId: request.projectId, corpusId: request.corpusId});
    const reference = corpus.snapshot.hits.find(hit => hit.id === request.hitId);
    if (reference === undefined) throw new Error('research_review_corpus_hit_not_found');
    const source = corpus.snapshot.sources.find(source => source.reviewSearchId === reference.reviewSearchId);
    if (source === undefined) throw new Error('research_review_corpus_snapshot_invalid');
    const {pool} = this.searches.readFullPool({projectId: request.projectId, reviewSearchId: reference.reviewSearchId});
    const record = pool.records[reference.recordIndex];
    if (record === undefined || hash(JSON.stringify(record)) !== reference.recordHash) throw new Error('research_review_corpus_snapshot_invalid');
    return researchReviewCorpusHitResultSchema.parse({
      corpusId: corpus.snapshot.id, corpusHash: corpus.snapshotHash, protocolVersionId: corpus.snapshot.request.versionId,
      reference, source, record
    });
  }

  private inspect(row: CorpusRow): ResearchReviewCorpusInspection {
    if (hash(row.snapshot_json) !== row.snapshot_hash) throw new Error('research_review_corpus_snapshot_invalid');
    const parsed = researchReviewCorpusSnapshotSchema.safeParse(JSON.parse(row.snapshot_json));
    if (!parsed.success) throw new Error('research_review_corpus_snapshot_invalid');
    const snapshot = parsed.data, request = snapshot.request;
    if (JSON.stringify(snapshot) !== row.snapshot_json || snapshot.id !== row.id || request.projectId !== row.project_id ||
        request.versionId !== row.protocol_version_id || request.requestId !== row.request_id || snapshot.recordedAt !== row.created_at ||
        snapshot.requestHash !== hash(JSON.stringify(request))) throw new Error('research_review_corpus_snapshot_invalid');
    const protocol = this.repository.systematicReviews.get({projectId: request.projectId, versionId: request.versionId});
    if (protocol.versionHash !== snapshot.protocolVersionHash || protocol.freezeHash !== request.expectedFreezeHash) {
      throw new Error('research_review_corpus_snapshot_invalid');
    }
    const captured = this.capture(request, row.id);
    if (JSON.stringify(captured.sources) !== JSON.stringify(snapshot.sources) || JSON.stringify(captured.hits) !== JSON.stringify(snapshot.hits)) {
      throw new Error('research_review_corpus_snapshot_invalid');
    }
    return researchReviewCorpusInspectionSchema.parse({
      snapshot, snapshotHash: row.snapshot_hash, currentProtocol: protocol.isLatest,
      queryCount: snapshot.sources.length, identifiedRecords: snapshot.hits.length,
      searchCoverageComplete: snapshot.sources.every(source => source.coverageComplete)
    });
  }

  private capture(request: ResearchReviewCorpusCreate, corpusId: string): Pick<ResearchReviewCorpusInspection['snapshot'], 'sources' | 'hits'> {
    const protocol = this.repository.systematicReviews.get({projectId: request.projectId, versionId: request.versionId});
    const expectedQueries = protocol.version.body.databases.flatMap((database, databaseIndex) =>
      database.queries.map((_, queryIndex) => `${databaseIndex}:${queryIndex}`));
    const loaded = request.searches.map(selected => {
      const search = this.searches.get({projectId: request.projectId, reviewSearchId: selected.reviewSearchId});
      if (search.receipt === null || search.receiptHash === null) throw new Error('research_review_corpus_source_not_terminal');
      if (search.snapshot.request.versionId !== request.versionId || search.snapshot.protocolVersionHash !== protocol.versionHash ||
          search.snapshot.request.expectedFreezeHash !== request.expectedFreezeHash ||
          search.snapshotHash !== selected.expectedSnapshotHash || search.receiptHash !== selected.expectedReceiptHash) {
        throw new Error('research_review_corpus_source_changed');
      }
      return {...search, receipt: search.receipt, receiptHash: search.receiptHash};
    }).sort((a,b) => a.snapshot.request.databaseIndex-b.snapshot.request.databaseIndex ||
      a.snapshot.request.queryIndex-b.snapshot.request.queryIndex);
    const actualQueries = loaded.map(search => `${search.snapshot.request.databaseIndex}:${search.snapshot.request.queryIndex}`);
    if (JSON.stringify(actualQueries) !== JSON.stringify(expectedQueries)) throw new Error('research_review_corpus_query_set_incomplete');
    const sources: ResearchReviewCorpusInspection['snapshot']['sources'] = [];
    const hits: ResearchReviewCorpusInspection['snapshot']['hits'] = [];
    for (const search of loaded) {
      const receipt = search.receipt;
      const pool = receipt.poolHash === null ? null : this.searches.readFullPool({projectId: request.projectId, reviewSearchId: search.snapshot.id}).pool;
      const source = researchReviewCorpusSourceSchema.parse({
        reviewSearchId: search.snapshot.id, snapshotHash: search.snapshotHash, receiptHash: search.receiptHash,
        executionId: receipt.executionId, poolHash: receipt.poolHash, status: receipt.status,
        databaseIndex: search.snapshot.request.databaseIndex, queryIndex: search.snapshot.request.queryIndex,
        rawRecordCount: pool === null ? 0 : pool.records.length, coverageComplete: search.coverageComplete
      });
      sources.push(source);
      if (pool !== null) for (const [recordIndex, record] of pool.records.entries()) {
        hits.push(researchReviewCorpusHitSchema.parse({id: `${corpusId}:hit:${hits.length}`, reviewSearchId: search.snapshot.id,
          recordIndex, recordHash: hash(JSON.stringify(record))}));
      }
    }
    return {sources, hits};
  }
}
