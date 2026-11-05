import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {literatureSearchInputSchema} from '../../../shared/schemas/literature-import';
import {literatureSearchPoolSchema, type LiteratureSearchPool} from '../../../shared/schemas/literature-search-pool';
import {
  researchReviewSearchStartSchema, researchReviewSearchSnapshotSchema, researchReviewSearchReceiptSchema,
  researchReviewSearchInspectionSchema, researchReviewSearchGetSchema, researchReviewSearchListSchema,
  researchReviewSearchPoolRequestSchema, researchReviewSearchCancelSchema, researchReviewSearchCancelReceiptSchema,
  researchReviewSearchOwnershipSchema,
  type ResearchReviewSearchStart, type ResearchReviewSearchInspection, type ResearchReviewSearchSnapshot,
  type ResearchReviewSearchReceipt, type ResearchReviewSearchCancel, type ResearchReviewSearchPoolResult,
  type ResearchReviewSearchOwnership, type ResearchReviewOwnedSearchInspection
} from '../../../shared/schemas/research-review-search';
import {researchRelationReviewerSchema, type ResearchRelationReviewer, type ResearchRelationActor} from '../../../shared/schemas/research-evidence-relations';
import {assertReviewSearchDispatchGrant, assertReviewSearchOwner,
  type ConsumedReviewSearchDispatchGrant, type ConsumedReviewSearchOwner} from '../../services/deep-agent/execution-grant-broker';
import {reviewSearchDispatchRequestHash} from '../../services/research-review-dispatch-context';
import {withLiteratureContext} from '../../services/literature-context';
import type {ResearchRepository} from './repository';
import type {LiteratureImportService} from './literature-import-service';

type SearchRow = {
  id: string; project_id: string; protocol_version_id: string; database_index: number; query_index: number;
  retry_of: string | null; request_id: string; snapshot_json: string; snapshot_hash: string;
  status: ResearchReviewSearchInspection['status']; revision: number;
  receipt_json: string | null; receipt_hash: string | null; cancellation_hash: string | null;
  owner_hash: string | null; updated_at: string
};
type LedgerRow = {
  id: string; owner: string; project_id: string; run_id: string; request_json: string; status: string
};
type Job = {projectId: string; controller: AbortController; promise: Promise<void>};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** One declared database query per durable execution; original provider pools remain authoritative. */
export class ResearchReviewSearchService {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly imports: Pick<LiteratureImportService, 'search'>, private readonly reportFailure: (error: unknown) => void,
    private readonly onTaskChanged: (taskId: string, projectId: string) => void,
    private readonly now: () => string = () => new Date().toISOString()) {}

  start(input: ResearchReviewSearchStart, createdBy: ResearchRelationReviewer): ResearchReviewSearchInspection {
    return this.startQuery(input, researchRelationReviewerSchema.parse(createdBy), null);
  }

  startOwned(input: ResearchReviewSearchStart, grant: ConsumedReviewSearchDispatchGrant, signal: AbortSignal): ResearchReviewOwnedSearchInspection {
    assertReviewSearchDispatchGrant(grant);
    signal.throwIfAborted();
    const request = researchReviewSearchStartSchema.parse(input);
    if (grant.projectId !== request.projectId || grant.requestHash !== reviewSearchDispatchRequestHash(request)) {
      throw new Error('research_dispatch_request_mismatch');
    }
    const search = this.startQuery(request, {kind: 'agent', id: grant.runId}, {grant, signal});
    return {search, association: this.repository.tasks.requireExecution('review_search', search.snapshot.id, request.projectId)};
  }

  private startQuery(input: ResearchReviewSearchStart, actor: ResearchRelationActor,
    dispatch: {grant: ConsumedReviewSearchDispatchGrant; signal: AbortSignal} | null): ResearchReviewSearchInspection {
    if (this.closed) throw new Error('research_review_search_closed');
    const request = researchReviewSearchStartSchema.parse(input);
    const requestHash = hash(JSON.stringify(request));
    let created = false;
    const row = this.db.transaction(() => {
      this.requireWritable(request.projectId);
      const replay = this.db.prepare('SELECT * FROM research_review_searches WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as SearchRow | undefined;
      if (replay !== undefined) {
        const snapshot = this.readSnapshot(replay);
        if (snapshot.requestHash !== requestHash || snapshot.actor.id !== actor.id || snapshot.actor.kind !== actor.kind) {
          throw new Error('research_review_request_conflict');
        }
        const owner = this.readOwnership(replay, snapshot);
        if (dispatch === null ? owner !== null : owner === null || !this.sameOwner(owner, dispatch.grant)) {
          throw new Error('research_review_owner_mismatch');
        }
        return replay;
      }
      const protocol = this.repository.systematicReviews.requireFrozen(request.projectId, request.versionId, request.expectedFreezeHash);
      const database = protocol.version.body.databases[request.databaseIndex];
      const query = database?.queries[request.queryIndex];
      if (database === undefined || query === undefined) throw new Error('research_review_query_not_declared');
      const latest = this.db.prepare(`SELECT * FROM research_review_searches
        WHERE project_id=? AND protocol_version_id=? AND database_index=? AND query_index=? ORDER BY rowid DESC LIMIT 1`)
        .get(request.projectId, request.versionId, request.databaseIndex, request.queryIndex) as SearchRow | undefined;
      if (latest === undefined ? request.retryOf !== null : request.retryOf !== latest.id) throw new Error('research_review_search_retry_conflict');
      if (latest !== undefined) {
        const previous = this.inspect(latest);
        if (previous.snapshotHash !== request.expectedRetrySnapshotHash ||
            previous.status === 'running' || previous.status === 'cancelling' || previous.coverageComplete) {
          throw new Error('research_review_search_retry_conflict');
        }
      }
      const years = protocol.version.body.publicationYears;
      const parameters = literatureSearchInputSchema.parse({query, sources: [database.source], limit: database.pageSize, maxPages: database.maxPages,
        ...(years.from === null ? {} : {yearFrom: years.from}), ...(years.to === null ? {} : {yearTo: years.to}), projectId: request.projectId});
      const snapshot = researchReviewSearchSnapshotSchema.parse({
        id: `review_search_${randomUUID()}`, request, requestHash, protocolVersionHash: protocol.versionHash,
        parameters, actor, startedAt: this.now()
      });
      const snapshotJson = JSON.stringify(snapshot);
      this.db.prepare(`INSERT INTO research_review_searches
        (id,project_id,protocol_version_id,database_index,query_index,retry_of,request_id,snapshot_json,snapshot_hash,status,revision,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'running',1,?)`).run(snapshot.id, request.projectId, request.versionId, request.databaseIndex,
          request.queryIndex, request.retryOf, request.requestId, snapshotJson, hash(snapshotJson), snapshot.startedAt);
      if (dispatch !== null) {
        const owner = JSON.stringify(researchReviewSearchOwnershipSchema.parse(dispatch.grant)), ownerHash = hash(owner);
        this.db.prepare('INSERT INTO research_review_search_owners(review_search_id,snapshot_json,snapshot_hash) VALUES (?,?,?)')
          .run(snapshot.id, owner, ownerHash);
        this.db.prepare('UPDATE research_review_searches SET owner_hash=? WHERE id=?').run(ownerHash, snapshot.id);
      }
      created = true;
      return this.row(request.projectId, snapshot.id);
    })();
    if (created) {
      if (dispatch !== null) {
        try {
          dispatch.signal.throwIfAborted();
          const snapshot = this.readSnapshot(row);
          this.repository.tasks.linkReviewSearch(snapshot, dispatch.grant);
          this.repository.tasks.assertReviewSearchActive(dispatch.grant, row.id,
            hash(JSON.stringify({snapshot, parentManifestHash: dispatch.grant.manifestHash})));
        } catch (error) {
          this.finish(row, dispatch.signal.aborted ? 'cancelled' : 'failed',
            error instanceof Error ? error.message.split(':')[0] : 'research_review_task_link_failed');
          throw error;
        }
      }
      const controller = new AbortController();
      const cancelParent = () => controller.abort(new Error('research_review_search_cancelled'));
      const parent = dispatch?.signal;
      const deadline = dispatch === null ? null : setTimeout(() => controller.abort(new Error('run_deadline_exhausted')),
        Math.max(0, Date.parse(this.repository.tasks.budgetForExecution('chat', dispatch.grant.runId, request.projectId).deadlineAt) - Date.now()));
      parent?.addEventListener('abort', cancelParent, {once: true});
      if (parent?.aborted) cancelParent();
      const promise = Promise.resolve().then(() => this.execute(row, controller)).catch(error => this.reportFailure(error))
        .finally(() => {
          parent?.removeEventListener('abort', cancelParent);
          if (deadline !== null) clearTimeout(deadline);
          this.jobs.delete(row.id);
        });
      this.jobs.set(row.id, {projectId: request.projectId, controller, promise});
      this.notifyTask(row);
    }
    return this.get({projectId: request.projectId, reviewSearchId: row.id});
  }

  getOwned(input: {projectId: string; reviewSearchId: string}, owner: ConsumedReviewSearchOwner): ResearchReviewOwnedSearchInspection {
    assertReviewSearchOwner(owner);
    this.repository.tasks.assertReviewSearchParent(owner);
    const request = researchReviewSearchGetSchema.parse(input);
    const row = this.row(request.projectId, request.reviewSearchId), snapshot = this.readSnapshot(row);
    const stored = this.readOwnership(row, snapshot);
    if (owner.projectId !== request.projectId || stored === null || !this.sameOwner(stored, owner)) {
      throw new Error('research_review_owner_mismatch');
    }
    const association = this.repository.tasks.requireExecution('review_search', row.id, request.projectId);
    const parent = this.repository.tasks.requireExecution('chat', owner.runId, request.projectId);
    if (association.parentKind !== 'chat' || association.parentExecutionId !== owner.runId ||
        parent.taskId !== association.taskId || parent.manifestHash !== owner.manifestHash ||
        association.manifestHash !== hash(JSON.stringify({snapshot, parentManifestHash: owner.manifestHash}))) {
      throw new Error('research_review_owner_mismatch');
    }
    return {search: this.get(request), association};
  }

  get(input: {projectId: string; reviewSearchId: string}): ResearchReviewSearchInspection {
    const request = researchReviewSearchGetSchema.parse(input), row = this.row(request.projectId, request.reviewSearchId);
    if ((row.status === 'running' || row.status === 'cancelling') && !this.jobs.has(row.id)) throw new Error('research_review_search_state_lost');
    return this.inspect(row);
  }

  list(input: {projectId: string; versionId: string; limit: number}): ResearchReviewSearchInspection[] {
    const request = researchReviewSearchListSchema.parse(input);
    this.repository.systematicReviews.get({projectId: request.projectId, versionId: request.versionId});
    const rows = this.db.prepare('SELECT * FROM research_review_searches WHERE project_id=? AND protocol_version_id=? ORDER BY rowid DESC LIMIT ?')
      .all(request.projectId, request.versionId, request.limit) as SearchRow[];
    return rows.map(row => this.get({projectId: request.projectId, reviewSearchId: row.id}));
  }

  readPool(input: {projectId: string; reviewSearchId: string; offset: number; limit: number}): ResearchReviewSearchPoolResult {
    const request = researchReviewSearchPoolRequestSchema.parse(input);
    const {reviewSearch, pool} = this.readFullPool({projectId: request.projectId, reviewSearchId: request.reviewSearchId});
    return {reviewSearch, pool: {...pool, records: pool.records.slice(request.offset, request.offset + request.limit),
      total: pool.records.length, nextOffset: request.offset + request.limit < pool.records.length ? request.offset + request.limit : null}};
  }

  /** Main-process consumers can seal all original records without the paged renderer preview limit. */
  readFullPool(input: {projectId: string; reviewSearchId: string}): {reviewSearch: ResearchReviewSearchInspection; pool: LiteratureSearchPool} {
    const request = researchReviewSearchGetSchema.parse(input);
    const reviewSearch = this.get({projectId: request.projectId, reviewSearchId: request.reviewSearchId});
    if (reviewSearch.receipt === null || reviewSearch.receipt.poolHash === null) throw new Error('research_review_search_pool_unavailable');
    const pool = this.readPoolSnapshot(reviewSearch.snapshot, reviewSearch.receipt);
    if (pool === null) throw new Error('research_review_search_pool_unavailable');
    return {reviewSearch, pool};
  }

  cancel(input: ResearchReviewSearchCancel, cancelledBy: ResearchRelationReviewer): ResearchReviewSearchInspection {
    return this.cancelQuery(input, researchRelationReviewerSchema.parse(cancelledBy));
  }

  cancelOwned(input: ResearchReviewSearchCancel, owner: ConsumedReviewSearchOwner): ResearchReviewOwnedSearchInspection {
    assertReviewSearchOwner(owner, 'research_review_cancel_query');
    this.getOwned({projectId: input.projectId, reviewSearchId: input.reviewSearchId}, owner);
    this.cancelQuery(input, {kind: 'agent', id: owner.runId});
    return this.getOwned({projectId: input.projectId, reviewSearchId: input.reviewSearchId}, owner);
  }

  private cancelQuery(input: ResearchReviewSearchCancel, actor: ResearchRelationActor): ResearchReviewSearchInspection {
    const request = researchReviewSearchCancelSchema.parse(input);
    const requestHash = hash(JSON.stringify(request));
    const replay = this.db.prepare('SELECT * FROM research_review_search_cancellations WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as {review_search_id: string; snapshot_json: string; snapshot_hash: string} | undefined;
    if (replay !== undefined) {
      const receipt = researchReviewSearchCancelReceiptSchema.parse(JSON.parse(replay.snapshot_json));
      if (hash(replay.snapshot_json) !== replay.snapshot_hash || JSON.stringify(receipt) !== replay.snapshot_json) {
        throw new Error('research_review_search_snapshot_invalid');
      }
      if (receipt.requestHash !== requestHash || receipt.actor.id !== actor.id || receipt.actor.kind !== actor.kind ||
          receipt.request.reviewSearchId !== replay.review_search_id) {
        throw new Error('research_review_request_conflict');
      }
      return this.get({projectId: request.projectId, reviewSearchId: replay.review_search_id});
    }
    this.requireWritable(request.projectId);
    const current = this.get({projectId: request.projectId, reviewSearchId: request.reviewSearchId});
    const job = this.jobs.get(request.reviewSearchId);
    if (current.status !== 'running' || current.revision !== request.expectedRevision || job === undefined) throw new Error('research_review_search_not_active');
    const receipt = researchReviewSearchCancelReceiptSchema.parse({request, requestHash, actor, recordedAt: this.now()});
    const snapshot = JSON.stringify(receipt);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO research_review_search_cancellations
        (project_id,request_id,review_search_id,snapshot_json,snapshot_hash) VALUES (?,?,?,?,?)`)
        .run(request.projectId, request.requestId, request.reviewSearchId, snapshot, hash(snapshot));
      const update = this.db.prepare("UPDATE research_review_searches SET status='cancelling',revision=revision+1,cancellation_hash=?,updated_at=? WHERE id=? AND status='running' AND revision=?")
        .run(hash(snapshot), receipt.recordedAt, request.reviewSearchId, request.expectedRevision);
      if (update.changes !== 1) throw new Error('research_review_search_not_active');
    })();
    job.controller.abort(new Error('research_review_search_cancelled'));
    this.notifyTask(this.row(request.projectId, request.reviewSearchId));
    return this.get({projectId: request.projectId, reviewSearchId: request.reviewSearchId});
  }

  async cancelTaskQuery(projectId: string, reviewSearchId: string): Promise<void> {
    const row = this.row(projectId, reviewSearchId);
    if (this.readOwnership(row, this.readSnapshot(row)) === null) throw new Error('research_review_owner_mismatch');
    this.get({projectId, reviewSearchId});
    const job = this.jobs.get(reviewSearchId);
    if (job === undefined) return;
    job.controller.abort(new Error('research_review_search_cancelled'));
    await job.promise;
  }

  recover(): void {
    if (this.jobs.size !== 0) throw new Error('research_review_search_recovery_while_active');
    const rows = this.db.prepare("SELECT * FROM research_review_searches WHERE status IN ('running','cancelling')").all() as SearchRow[];
    for (const row of rows) this.finish(row, 'interrupted', 'research_review_search_interrupted');
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('research_review_search_interrupted'));
    await Promise.all([...this.jobs.values()].map(job => job.promise));
  }

  async releaseProject(projectId: string): Promise<void> {
    const pending = [...this.jobs.values()].filter(job => job.projectId === projectId);
    for (const job of pending) job.controller.abort(new Error('research_review_search_cancelled'));
    await Promise.all(pending.map(job => job.promise));
  }

  private async execute(row: SearchRow, controller: AbortController): Promise<void> {
    const snapshot = this.readSnapshot(row);
    let failure: unknown = null;
    try {
      this.assertActive(snapshot, controller);
      await withLiteratureContext({owner: `systematic-review:${snapshot.id}`, projectId: row.project_id,
        runId: row.id, signal: controller.signal, assertActive: () => this.assertActive(snapshot, controller)},
      () => this.imports.search(snapshot.parameters));
    } catch (error) {failure = error;}
    // The current task/parent boundary owns the terminal reason even if the
    // transport's audit wrapper reports an earlier request-boundary failure.
    if (!controller.signal.aborted) {
      try {this.assertActive(snapshot, controller);}
      catch (error) {failure = error;}
    }
    const current = this.row(row.project_id, row.id);
    if (controller.signal.aborted) {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message.split(':')[0] : 'research_review_search_cancelled';
      this.finish(current, reason === 'research_review_search_interrupted' ? 'interrupted' : 'cancelled', reason);
    } else if (failure !== null) {
      this.finish(current, 'failed', failure instanceof Error ? failure.message.split(':')[0] : 'research_review_search_failed');
    } else {
      const ledger = this.ledger(snapshot);
      if (ledger === null) throw new Error('research_review_search_ledger_missing');
      const pool = this.poolForLedger(snapshot, ledger);
      if (pool === null) throw new Error('research_review_search_pool_missing');
      this.finish(current, pool.status === 'failed' ? 'failed' : this.completeCoverage(pool) ? 'complete' : 'partial', null);
    }
  }

  private assertActive(snapshot: ResearchReviewSearchSnapshot, controller: AbortController): void {
    controller.signal.throwIfAborted();
    if (this.closed) throw new Error('research_review_search_closed');
    this.requireWritable(snapshot.request.projectId);
    const protocol = this.repository.systematicReviews.requireFrozen(snapshot.request.projectId, snapshot.request.versionId, snapshot.request.expectedFreezeHash);
    if (protocol.versionHash !== snapshot.protocolVersionHash) throw new Error('research_review_version_conflict');
    const owner = this.readOwnership(this.row(snapshot.request.projectId, snapshot.id), snapshot);
    if (owner !== null) this.repository.tasks.assertReviewSearchActive(owner, snapshot.id,
      hash(JSON.stringify({snapshot, parentManifestHash: owner.manifestHash})));
  }

  private finish(row: SearchRow, status: ResearchReviewSearchReceipt['status'], errorCode: string | null): void {
    const snapshot = this.readSnapshot(row), ledger = this.ledger(snapshot);
    const pool = ledger === null ? null : this.poolForLedger(snapshot, ledger);
    const receipt = researchReviewSearchReceiptSchema.parse({reviewSearchId: row.id, status,
      executionId: ledger === null ? null : ledger.id, poolHash: pool === null ? null : pool.contentHash, errorCode, endedAt: this.now()});
    const json = JSON.stringify(receipt);
    const result = this.db.prepare(`UPDATE research_review_searches
      SET status=?,revision=revision+1,receipt_json=?,receipt_hash=?,updated_at=? WHERE id=? AND status IN ('running','cancelling')`)
      .run(status, json, hash(json), receipt.endedAt, row.id);
    if (result.changes !== 1) throw new Error('research_review_search_not_active');
    this.notifyTask(this.row(row.project_id, row.id));
  }

  private notifyTask(row: SearchRow): void {
    const owner = this.readOwnership(row, this.readSnapshot(row));
    if (owner === null) return;
    const association = this.repository.tasks.findExecution('review_search', row.id, row.project_id);
    if (association !== null) this.onTaskChanged(association.taskId, row.project_id);
  }

  private inspect(row: SearchRow): ResearchReviewSearchInspection {
    const snapshot = this.readSnapshot(row);
    const receipt = row.receipt_json === null ? null : researchReviewSearchReceiptSchema.parse(JSON.parse(row.receipt_json));
    if (receipt !== null && (hash(row.receipt_json!) !== row.receipt_hash || receipt.reviewSearchId !== row.id ||
        receipt.status !== row.status || receipt.endedAt !== row.updated_at || JSON.stringify(receipt) !== row.receipt_json)) {
      throw new Error('research_review_search_snapshot_invalid');
    }
    const pool = receipt === null ? null : this.readPoolSnapshot(snapshot, receipt);
    const cancellation = this.cancellation(row);
    const inspected = researchReviewSearchInspectionSchema.safeParse({snapshot, snapshotHash: row.snapshot_hash, status: row.status,
      revision: row.revision, receipt, receiptHash: row.receipt_hash, cancellation, cancellationHash: row.cancellation_hash,
      sources: pool === null ? [] : pool.sources,
      rawRecordCount: pool === null ? 0 : pool.records.length, coverageComplete: receipt?.status === 'complete' && pool !== null && this.completeCoverage(pool)});
    if (!inspected.success) throw new Error('research_review_search_snapshot_invalid');
    return inspected.data;
  }

  private cancellation(row: SearchRow): ResearchReviewSearchInspection['cancellation'] {
    const stored = this.db.prepare('SELECT * FROM research_review_search_cancellations WHERE review_search_id=?')
      .get(row.id) as {project_id: string; request_id: string; snapshot_json: string; snapshot_hash: string} | undefined;
    if ((stored === undefined) !== (row.cancellation_hash === null)) throw new Error('research_review_search_snapshot_invalid');
    if (stored === undefined) return null;
    const parsed = researchReviewSearchCancelReceiptSchema.safeParse(JSON.parse(stored.snapshot_json));
    if (!parsed.success) throw new Error('research_review_search_snapshot_invalid');
    const cancellation = parsed.data;
    if (stored.project_id !== row.project_id || stored.snapshot_hash !== row.cancellation_hash ||
        hash(stored.snapshot_json) !== stored.snapshot_hash || JSON.stringify(cancellation) !== stored.snapshot_json ||
        cancellation.request.projectId !== row.project_id || cancellation.request.reviewSearchId !== row.id ||
        cancellation.request.requestId !== stored.request_id ||
        cancellation.requestHash !== hash(JSON.stringify(cancellation.request))) throw new Error('research_review_search_snapshot_invalid');
    return cancellation;
  }

  private readSnapshot(row: SearchRow): ResearchReviewSearchSnapshot {
    if (hash(row.snapshot_json) !== row.snapshot_hash) throw new Error('research_review_search_snapshot_invalid');
    const parsed = researchReviewSearchSnapshotSchema.safeParse(JSON.parse(row.snapshot_json));
    if (!parsed.success) throw new Error('research_review_search_snapshot_invalid');
    const snapshot = parsed.data, request = snapshot.request;
    if (hash(row.snapshot_json) !== row.snapshot_hash || JSON.stringify(snapshot) !== row.snapshot_json ||
        snapshot.id !== row.id || request.projectId !== row.project_id || request.versionId !== row.protocol_version_id ||
        request.requestId !== row.request_id || request.databaseIndex !== row.database_index || request.queryIndex !== row.query_index ||
        request.retryOf !== row.retry_of || snapshot.requestHash !== hash(JSON.stringify(request))) throw new Error('research_review_search_snapshot_invalid');
    this.readOwnership(row, snapshot);
    const protocol = this.repository.systematicReviews.get({projectId: row.project_id, versionId: row.protocol_version_id});
    if (protocol.versionHash !== snapshot.protocolVersionHash || protocol.freezeHash !== request.expectedFreezeHash) {
      throw new Error('research_review_search_snapshot_invalid');
    }
    const database = protocol.version.body.databases[request.databaseIndex], query = database?.queries[request.queryIndex];
    if (database === undefined || query === undefined) throw new Error('research_review_search_snapshot_invalid');
    const years = protocol.version.body.publicationYears;
    const parameters = literatureSearchInputSchema.parse({query, sources: [database.source], limit: database.pageSize, maxPages: database.maxPages,
      ...(years.from === null ? {} : {yearFrom: years.from}), ...(years.to === null ? {} : {yearTo: years.to}), projectId: row.project_id});
    if (JSON.stringify(parameters) !== JSON.stringify(snapshot.parameters)) throw new Error('research_review_search_snapshot_invalid');
    return snapshot;
  }

  private sameOwner(stored: ResearchReviewSearchOwnership, owner: Pick<ConsumedReviewSearchOwner, 'runId' | 'threadId' | 'projectId' | 'manifestHash'>): boolean {
    return stored.runId === owner.runId && stored.threadId === owner.threadId && stored.projectId === owner.projectId &&
      stored.manifestHash === owner.manifestHash;
  }

  private readOwnership(row: SearchRow, snapshot: ResearchReviewSearchSnapshot): ResearchReviewSearchOwnership | null {
    const stored = this.db.prepare('SELECT snapshot_json,snapshot_hash FROM research_review_search_owners WHERE review_search_id=?')
      .get(row.id) as {snapshot_json: string; snapshot_hash: string} | undefined;
    if (stored === undefined && row.owner_hash === null && snapshot.actor.kind === 'user') return null;
    if (stored === undefined || row.owner_hash === null || snapshot.actor.kind !== 'agent') throw new Error('research_review_owner_invalid');
    const owner = researchReviewSearchOwnershipSchema.parse(JSON.parse(stored.snapshot_json));
    if (hash(stored.snapshot_json) !== stored.snapshot_hash || stored.snapshot_hash !== row.owner_hash ||
        JSON.stringify(owner) !== stored.snapshot_json || owner.projectId !== row.project_id || owner.runId !== snapshot.actor.id ||
        owner.requestHash !== reviewSearchDispatchRequestHash(snapshot.request)) throw new Error('research_review_owner_invalid');
    return owner;
  }

  private row(projectId: string, id: string): SearchRow {
    this.repository.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_review_searches WHERE id=?').get(id) as SearchRow | undefined;
    if (row === undefined) throw new Error('research_review_search_not_found');
    if (row.project_id !== projectId) throw new Error('research_review_project_mismatch');
    return row;
  }

  private ledger(snapshot: ResearchReviewSearchSnapshot): LedgerRow | null {
    const rows = this.db.prepare('SELECT * FROM research_literature_search_executions WHERE run_id=?').all(snapshot.id) as LedgerRow[];
    if (rows.length > 1) throw new Error('research_review_search_ledger_conflict');
    if (rows.length === 0) return null;
    const row = rows[0], expected = JSON.stringify({request: snapshot.parameters, strategy: null});
    if (row.owner !== `systematic-review:${snapshot.id}` || row.project_id !== snapshot.request.projectId ||
        row.request_json !== expected) throw new Error('research_review_search_ledger_conflict');
    return row;
  }

  private poolForLedger(snapshot: ResearchReviewSearchSnapshot, ledger: LedgerRow): LiteratureSearchPool | null {
    const row = this.db.prepare('SELECT pool_json FROM research_literature_search_pools WHERE execution_id=?').pluck().get(ledger.id) as string | undefined;
    if (row === undefined) return null;
    const pool = literatureSearchPoolSchema.parse(JSON.parse(row)), {contentHash, ...body} = pool;
    if (hash(JSON.stringify(body)) !== contentHash || pool.executionId !== ledger.id || pool.strategy !== null ||
        JSON.stringify(pool.request) !== JSON.stringify(snapshot.parameters) || ledger.status !== pool.status) {
      throw new Error('research_review_search_pool_invalid');
    }
    const receipts = this.db.prepare('SELECT source,attempt,state,receipt_json FROM research_literature_request_receipts WHERE execution_id=? ORDER BY source,attempt')
      .all(ledger.id) as {source: string; attempt: number; state: string; receipt_json: string}[];
    const expected = pool.sources.flatMap(source => source.requests.map(receipt => ({source: source.source, attempt: receipt.attempt,
      state: 'received', receipt_json: JSON.stringify(receipt)}))).sort((a,b) => a.source.localeCompare(b.source) || a.attempt-b.attempt);
    if (JSON.stringify(receipts) !== JSON.stringify(expected)) throw new Error('research_review_search_ledger_conflict');
    return pool;
  }

  private readPoolSnapshot(snapshot: ResearchReviewSearchSnapshot, receipt: ResearchReviewSearchReceipt): LiteratureSearchPool | null {
    const ledger = this.ledger(snapshot);
    if (receipt.executionId !== (ledger === null ? null : ledger.id)) throw new Error('research_review_search_ledger_conflict');
    const pool = ledger === null ? null : this.poolForLedger(snapshot, ledger);
    if (receipt.poolHash !== (pool === null ? null : pool.contentHash)) throw new Error('research_review_search_pool_invalid');
    return pool;
  }

  private completeCoverage(pool: LiteratureSearchPool): boolean {
    return pool.status === 'complete' && pool.sources.length === 1 &&
      pool.sources[0].coverage.state === 'reported_end' && pool.sources[0].coverage.nextPage === null &&
      pool.sources[0].stopReason === 'reported_end';
  }

  private requireWritable(projectId: string): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
}
