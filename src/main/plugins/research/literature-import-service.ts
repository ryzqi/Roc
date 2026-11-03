import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  literatureAddSchema, literatureGetImportSchema, literatureReadSearchSchema, literatureSearchInputSchema,
  literatureSearchResultSchema, literatureImportResultSchema,
  type LiteratureAdd, type LiteratureCandidate, type LiteratureImportItem, type LiteratureImportResult, type LiteratureSearchResult
} from '../../../shared/schemas/literature-import';
import type { z } from 'zod';
import { assertLiteratureActive, literatureContext, type LiteratureExecutionContext } from '../../services/literature-context';
import { betterBibtexKey } from './cite-key';
import { normalizeResearchDoi } from './literature-identity';
import { groupLiteratureIdentities } from './literature-identity-graph';
import { fuseLiterature, literatureRanking } from './literature-fusion';
import { LiteratureSearchLedger, LiteratureRequestAuditError } from './literature-search-ledger';
import type { LiteratureSearchService } from './literature-service';
import type { ResearchLibraryService } from './library-service';
import type { ResearchLibraryRepository } from './library-repository';

type ProviderRecords = [LiteratureCandidate['record'], ...LiteratureCandidate['record'][]];
type FrozenSource = {kind: 'doi'; doi: string} | {kind: 'records'; records: ProviderRecords};
type FrozenEntry = { entry: LiteratureAdd['entries'][number]; source: FrozenSource; result: LiteratureImportItem };
type OperationRow = { id: string; owner: string; scope_project: string; input_hash: string; frozen_json: string; result_json: string; cancel_requested: number };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decode<T>(value: string, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(value)); }
  catch (cause) { throw new Error('literature_storage_invalid', { cause }); }
}
const terminal = (result: LiteratureImportResult): boolean => !['queued', 'running'].includes(result.status);

/** Bounded metadata import ledger. No provider or bibliography worker runs inside a transaction. */
export class LiteratureImportService {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<LiteratureImportResult> }>();
  private readonly searches = new Set<Promise<LiteratureSearchResult>>();
  private readonly lifetime = new AbortController();
  private readonly searchLedger: LiteratureSearchLedger;
  private closed = false;
  constructor(private readonly db: Database, private readonly library: ResearchLibraryRepository,
    private readonly searchService: LiteratureSearchService, private readonly prepare: Pick<ResearchLibraryService, 'prepareDoi' | 'prepareRecord'>,
    private readonly changed: (result: LiteratureImportResult) => Promise<void>, private readonly now: () => string = () => new Date().toISOString()) {
    this.searchLedger = new LiteratureSearchLedger(db, now);
  }

  async search(input: unknown): Promise<LiteratureSearchResult> {
    const pending = this.executeSearch(input);
    this.searches.add(pending);
    try { return await pending; }
    finally { this.searches.delete(pending); }
  }

  private async executeSearch(input: unknown): Promise<LiteratureSearchResult> {
    const request = literatureSearchInputSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    this.library.validateDestination(context.projectId);
    let strategy: LiteratureSearchResult['strategy'] = null;
    if (context.searchStrategy !== undefined) {
      if (context.queryIndex === undefined) throw new Error('research_search_query_index_required');
      const query = context.searchStrategy.plan.queries[context.queryIndex];
      if (query === undefined) throw new Error('research_search_query_index_invalid');
      const {projectId: _projectId, ...parameters} = request;
      if (JSON.stringify(parameters) !== JSON.stringify(query)) throw new Error('research_search_query_changed');
      strategy = {artifactId: context.searchStrategy.artifactId, contentHash: context.searchStrategy.contentHash,
        approvedAt: context.searchStrategy.approvedAt, researchQuestion: context.searchStrategy.plan.researchQuestion, queryIndex: context.queryIndex};
    }
    const scopedRequest = {...request, projectId: context.projectId};
    const executionId = this.searchLedger.begin(context, scopedRequest, strategy);
    try {
      const signal = AbortSignal.any([this.lifetime.signal, ...(context.signal === undefined ? [] : [context.signal])]);
      const audit = this.searchLedger.audit(executionId);
      const found = await this.searchService.searchDetailed(scopedRequest, signal, (phase, source, receipt) => {
        if (phase === 'started') {
          try { this.requireActive(context); } catch (cause) { throw new LiteratureRequestAuditError(cause); }
        }
        audit(phase, source, receipt);
      });
      this.requireActive(context);
      const createdAt = this.now();
      let unknownYear = false;
      const grouped = fuseLiterature(found.records).filter(candidate => {
        if (request.yearFrom === undefined && request.yearTo === undefined) return true;
        if (candidate.record.publishedYear === null) { unknownYear = true; return false; }
        return (request.yearFrom === undefined || candidate.record.publishedYear >= request.yearFrom)
          && (request.yearTo === undefined || candidate.record.publishedYear <= request.yearTo);
      });
      const candidates: LiteratureCandidate[] = grouped.slice(0, request.limit).map(candidate => {
        const match = this.library.findByIdentity(candidate.identity, candidate.aliases);
        return {...candidate, matchedLibraryItemId: match?.id ?? null, archived: match?.archived ?? false,
          missingFields: ['doi', 'abstract', 'publishedYear'].filter(field => candidate.record[field as 'doi' | 'abstract' | 'publishedYear'] === null)};
      });
      const result: LiteratureSearchResult = { schemaVersion: 11, ranking: literatureRanking(request.sources), executionId, strategy,
        searchId: `search_${randomUUID()}`, createdAt, expiresAt: new Date(Date.parse(createdAt) + 7 * 86400_000).toISOString(),
        status: found.status, candidates, sources: found.sources, truncated: found.truncated || grouped.length > request.limit,
        warnings: [...found.warnings, ...(unknownYear ? ['年份未知的候选未计入年份筛选结果。'] : [])], total: candidates.length, nextOffset: null };
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM research_literature_searches WHERE expires_at <= ?').run(createdAt);
        this.db.prepare('INSERT INTO research_literature_searches (id,owner,project_id,request_json,result_json,expires_at) VALUES (?,?,?,?,?,?)')
          .run(result.searchId, context.owner, context.projectId, JSON.stringify(scopedRequest), JSON.stringify(result), result.expiresAt);
        this.searchLedger.finish(executionId, result.status, result.searchId, null);
      })();
      return result;
    } catch (error) {
      const interrupted = this.closed || error instanceof Error &&
        ['literature_service_closed', 'research_run_interrupted_by_shutdown'].includes(error.message);
      const status = interrupted ? 'interrupted' : context.signal?.aborted ? 'cancelled' : 'failed';
      const errorCode = interrupted ? 'literature_search_interrupted' : status === 'cancelled' ? 'literature_search_cancelled' :
        error instanceof LiteratureRequestAuditError ? error.message : 'literature_search_failed';
      try { this.searchLedger.finish(executionId, status, null, errorCode); }
      catch (ledgerError) { throw new AggregateError([error, ledgerError], 'literature_search_record_failed'); }
      throw error;
    }
  }

  readSearch(input: unknown): LiteratureSearchResult {
    const request = literatureReadSearchSchema.parse(input);
    const result = this.loadSearch(request.searchId, literatureContext());
    return { ...result, candidates: result.candidates.slice(request.offset, request.offset + request.limit),
      nextOffset: request.offset + request.limit < result.total ? request.offset + request.limit : null };
  }

  async add(input: unknown): Promise<LiteratureImportResult> {
    const request = literatureAddSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    const destinationProjectId = request.destination === 'current_project' ? context.projectId : null;
    if (request.destination === 'current_project' && destinationProjectId === null) throw new Error('literature_project_required');
    this.library.validateDestination(context.projectId);
    const entries = request.entries.map((entry) => entry.kind === 'doi' ? { ...entry, doi: normalizeResearchDoi(entry.doi) } : entry);
    const inputHash = hash({ destinationProjectId, entries });
    const previous = this.db.prepare('SELECT * FROM research_literature_imports WHERE owner = ? AND scope_project = ? AND request_id = ?')
      .get(context.owner, context.projectId ?? '', request.requestId) as OperationRow | undefined;
    if (previous !== undefined) {
      if (previous.input_hash !== inputHash) throw new Error('import_request_conflict');
      return this.active.get(previous.id)?.promise ?? this.result(previous);
    }
    // Resolve all candidate references before creating an operation or mutating the library.
    const frozen: FrozenEntry[] = [];
    for (const [position, entry] of entries.entries()) {
      let source: FrozenSource;
      let key: string;
      if (entry.kind === 'doi') { source = {kind: 'doi', doi: entry.doi}; key = `doi:${entry.doi}`; }
      else {
        const candidate = this.loadSearch(entry.searchId, context).candidates.find((candidate) => candidate.candidateId === entry.candidateId);
        if (candidate === undefined) throw new Error('literature_candidate_not_found');
        source = {kind: 'records', records: uniqueRecords(candidate.record, candidate.origins.map(origin => origin.record))};
        key = candidate.identity;
      }
      const duplicate = frozen.find((item) => item.result.entryKey === key);
      if (duplicate !== undefined) {
        duplicate.result.inputPositions.push(position);
        if (source.kind === 'records') {
          duplicate.source = duplicate.source.kind === 'doi' ? source :
            {kind: 'records', records: uniqueRecords(duplicate.source.records[0], [...duplicate.source.records.slice(1), ...source.records])};
        }
        continue;
      }
      frozen.push({ entry, source, result: { entryKey: key, inputPositions: [position], libraryItemId: null, citationKey: null,
        disposition: 'not_processed', metadataUpdated: false, errorCode: null, retryable: false, metadata: 'not_requested',
        attachment: 'not_requested', parse: 'not_requested', index: { scope: 'metadata', keyword: 'not_requested', vector: 'not_requested' } } });
    }
    const result = summarize({ operationId: `import_${randomUUID()}`, requestId: request.requestId, status: 'queued', destinationProjectId,
      requestedCount: frozen.length, processedCount: 0, counts: emptyCounts(), items: frozen.map((item) => item.result), nextOffset: null });
    const timestamp = this.now();
    this.db.prepare(`INSERT INTO research_literature_imports (id,owner,scope_project,run_id,request_id,input_hash,frozen_json,result_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(result.operationId, context.owner, context.projectId ?? '', context.runId ?? null, request.requestId, inputHash,
        JSON.stringify(frozen), JSON.stringify(result), timestamp, timestamp);
    const controller = new AbortController();
    const signal = context.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, context.signal]);
    const task = { controller, promise: Promise.resolve(result) };
    this.active.set(result.operationId, task);
    task.promise = this.execute(context, signal, result, frozen).finally(() => { this.active.delete(result.operationId); });
    return task.promise;
  }

  get(input: unknown): LiteratureImportResult {
    const request = literatureGetImportSchema.parse(input);
    const context = literatureContext();
    const row = (request.operationId !== undefined
      ? this.db.prepare('SELECT * FROM research_literature_imports WHERE id = ? AND owner = ? AND scope_project = ?').get(request.operationId, context.owner, context.projectId ?? '')
      : this.db.prepare('SELECT * FROM research_literature_imports WHERE request_id = ? AND owner = ? AND scope_project = ?').get(request.requestId, context.owner, context.projectId ?? '')) as OperationRow | undefined;
    if (row === undefined) throw new Error('literature_import_not_found');
    const result = this.result(row);
    return { ...result, items: result.items.slice(request.offset, request.offset + request.limit),
      nextOffset: request.offset + request.limit < result.items.length ? request.offset + request.limit : null };
  }

  cancel(operationId: string): LiteratureImportResult {
    const result = this.get({ operationId, offset: 0, limit: 30 });
    if (terminal(result)) return result;
    this.db.prepare('UPDATE research_literature_imports SET cancel_requested = 1 WHERE id = ?').run(operationId);
    this.active.get(operationId)?.controller.abort();
    return result;
  }

  /** A restart cannot prove a former run is still authorized. Preserve commits and terminate remaining items. */
  recover(): void {
    this.searchLedger.recover();
    const rows = this.db.prepare('SELECT * FROM research_literature_imports').all() as OperationRow[];
    for (const row of rows) {
      const result = this.result(row);
      if (terminal(result)) continue;
      for (const item of result.items) if (item.disposition === 'not_processed') {
        item.disposition = 'failed'; item.metadata = 'failed'; item.errorCode = 'literature_import_interrupted'; item.retryable = true;
      }
      this.save(summarize(result));
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new Error('literature_service_closed'));
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.searches, ...[...this.active.values()].map((task) => task.promise)]);
  }

  private async execute(context: LiteratureExecutionContext, signal: AbortSignal, result: LiteratureImportResult, frozen: FrozenEntry[]): Promise<LiteratureImportResult> {
    result.status = 'running'; this.save(result);
    for (const [position, entry] of frozen.entries()) {
      const item = result.items[position];
      const uncommitted = structuredClone(item);
      let committed = false;
      try {
        this.requireActive({ ...context, signal });
        const prepared: (Awaited<ReturnType<ResearchLibraryService['prepareRecord']>> & {providerRecord?: LiteratureCandidate['record']})[] = [];
        if (entry.source.kind === 'doi') {
          prepared.push(await this.prepare.prepareDoi(entry.source.doi, signal));
        } else {
          for (const record of entry.source.records) {
            this.requireActive({ ...context, signal });
            prepared.push({...await this.prepare.prepareRecord(record, signal), providerRecord: record});
          }
        }
        const identities = groupLiteratureIdentities(prepared.map(record => record.metadata));
        if (identities.length !== 1 || identities[0].identity !== item.entryKey) throw new Error('literature_import_identity_changed');
        this.db.transaction(() => {
          this.requireActive({ ...context, signal });
          this.library.validateDestination(context.projectId);
          const row = this.db.prepare('SELECT cancel_requested FROM research_literature_imports WHERE id = ?').get(result.operationId) as { cancel_requested: number };
          if (row.cancel_requested === 1) throw new Error('literature_import_cancelled');
          const current = this.library.findByIdentity(item.entryKey, identities[0].aliases);
          if (current?.archived === true) {
            Object.assign(item, { disposition: 'skipped_archived', libraryItemId: current.id, citationKey: current.bibliography.citationKey });
          } else {
            const citationKey = current?.bibliography.citationKey ?? betterBibtexKey(prepared[0].metadata, this.library.usedCitationKeys());
            for (const source of prepared) source.bibliography.citationKey = citationKey;
            const imported = this.library.import(prepared, result.destinationProjectId, { flush: false, notify: false, skipArchived: true });
            const saved = imported.items[0];
            Object.assign(item, { disposition: current === null ? 'created' : result.destinationProjectId !== null && !current.projectIds.includes(result.destinationProjectId) ? 'linked' : 'already_present',
              libraryItemId: saved.id, citationKey: saved.bibliography.citationKey, metadata: 'ready', metadataUpdated: current !== null && current.revision !== saved.revision,
              index: { scope: 'metadata', keyword: 'ready', vector: 'not_requested' } });
          }
          this.save(summarize(result));
        })();
        committed = true;
        try { this.library.flushIndex(); }
        catch { item.index.keyword = 'pending'; this.save(summarize(result)); }
        try { await this.changed(result); } catch { /* The ledger and focus refresh remain authoritative. */ }
      } catch (error) {
        if (!committed) Object.assign(item, uncommitted);
        const cancelled = signal.aborted || this.closed || (error instanceof Error && error.message === 'literature_import_cancelled');
        const errorCode = cancelled ? 'literature_import_cancelled' : safeFailure(error);
        Object.assign(item, { disposition: cancelled ? 'cancelled' : 'failed', metadata: cancelled ? 'not_requested' : 'failed',
          errorCode, retryable: !cancelled && !['research_literature_identity_ambiguous', 'literature_import_identity_changed'].includes(errorCode) });
        if (cancelled) {
          for (const remaining of result.items.slice(position + 1)) remaining.disposition = 'cancelled';
          break;
        }
      }
      this.save(summarize(result));
    }
    this.save(summarize(result));
    return result;
  }

  private loadSearch(searchId: string, context: LiteratureExecutionContext): LiteratureSearchResult {
    const row = this.db.prepare('SELECT result_json, expires_at FROM research_literature_searches WHERE id = ? AND owner = ? AND project_id IS ?')
      .get(searchId, context.owner, context.projectId) as { result_json: string; expires_at: string } | undefined;
    if (row === undefined) throw new Error('literature_search_not_found');
    if (row.expires_at <= this.now()) throw new Error('literature_search_expired');
    return decode(row.result_json, literatureSearchResultSchema);
  }
  private result(row: OperationRow): LiteratureImportResult { return decode(row.result_json, literatureImportResultSchema); }
  private save(result: LiteratureImportResult): void {
    this.db.prepare('UPDATE research_literature_imports SET result_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(result), this.now(), result.operationId);
  }
  private requireActive(context: LiteratureExecutionContext): void {
    if (this.closed) throw new Error('literature_import_closed');
    assertLiteratureActive(context);
  }
}
function uniqueRecords(primary: LiteratureCandidate['record'], records: LiteratureCandidate['record'][]): ProviderRecords {
  const seen = new Set<string>([hash(primary)]);
  return [primary, ...records.filter(record => {
    const fingerprint = hash(record);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  })];
}
function safeFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return /^(research|literature)_[a-z_]+$/u.test(code) ? code : 'literature_metadata_import_failed';
}
function emptyCounts(): LiteratureImportResult['counts'] {
  return { created: 0, linked: 0, alreadyPresent: 0, skippedArchived: 0, failed: 0, cancelled: 0, notProcessed: 0 };
}
function summarize(result: LiteratureImportResult): LiteratureImportResult {
  const counts = emptyCounts();
  const keys = { created: 'created', linked: 'linked', already_present: 'alreadyPresent', skipped_archived: 'skippedArchived',
    failed: 'failed', cancelled: 'cancelled', not_processed: 'notProcessed' } as const;
  for (const item of result.items) counts[keys[item.disposition]] += 1;
  result.counts = counts;
  result.processedCount = result.requestedCount - counts.notProcessed;
  if (counts.notProcessed > 0) result.status = 'running';
  else if (counts.failed + counts.cancelled === 0) result.status = 'completed';
  else if (counts.failed + counts.cancelled < result.requestedCount) result.status = 'partial';
  else result.status = counts.cancelled === result.requestedCount ? 'cancelled' : 'failed';
  return result;
}
