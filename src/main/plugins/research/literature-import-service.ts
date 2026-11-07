import { createHash, randomUUID } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type { Database } from 'better-sqlite3';
import {
  literatureAddSchema, literatureGetImportSchema, literatureReadSearchSchema, literatureSearchInputSchema,
  literatureSearchResultSchema, literatureImportResultSchema,
  type LiteratureAdd, type LiteratureCandidate, type LiteratureImportItem, type LiteratureImportResult, type LiteratureSearchResult
} from '../../../shared/schemas/literature-import';
import type { z } from 'zod';
import { assertLiteratureActive, literatureContext, type LiteratureExecutionContext } from '../../services/literature-context';
import { betterBibtexKey } from './cite-key';
import { normalizeResearchDoi, literatureIdentity } from './literature-identity';
import { groupLiteratureIdentities } from './literature-identity-graph';
import type {LiteratureProviderIdentifierRecord} from '../../../shared/schemas/literature-identifiers';
import type {LiteratureReviewRecord} from '../../../shared/schemas/literature-review';
import {literatureReadPoolSchema, literatureSearchPoolBodySchema, literatureSearchPoolSchema,
  type literatureSearchPoolPageSchema} from '../../../shared/schemas/literature-search-pool';
import { fuseLiterature, literatureRanking } from './literature-fusion';
import { LiteratureSearchLedger, LiteratureRequestAuditError } from './literature-search-ledger';
import type { LiteratureSearchService } from './literature-service';
import type { ResearchLibraryService } from './library-service';
import type { ResearchLibraryRepository } from './library-repository';
import {zoteroItemsRequestSchema, zoteroSourcesRequestSchema, type zoteroSourcesPageSchema,
  zoteroReviewRequestSchema, type ZoteroReview, type ZoteroPreviewPage, type ZoteroFrozenObject} from '../../../shared/schemas/research-zotero';
import type {ZoteroAdapter} from './zotero-adapter';
import {ZoteroPreviewStore} from './zotero-preview-store';
import {ZoteroObjectStore, freezeZoteroObject} from './zotero-object-store';
import {ZoteroSyncStore} from './zotero-sync-store';
import {zoteroSyncPageSchema, type ZoteroSync, type ZoteroSyncCapturedPage} from '../../../shared/schemas/research-zotero-sync';
import {ZoteroSourceStateStore} from './zotero-source-state-store';
import {zoteroSourceStateRequestSchema, type ZoteroSourceState} from '../../../shared/schemas/research-zotero-source-state';
import {zoteroAttachmentRequestSchema, zoteroAttachmentGrantRequestSchema, type ZoteroAttachmentInspection,
  type ZoteroAttachmentFile, type ZoteroAttachmentGrant, type ZoteroAttachmentGrantOutcome} from '../../../shared/schemas/research-zotero-attachment';
import {ZoteroAttachmentStore, inspectZoteroAttachmentFile, zoteroAttachmentLinkModeSchema} from './zotero-attachment-store';
import {ZoteroAttachmentGrantStore, type ZoteroAttachmentPicker} from './zotero-attachment-grant-store';
import {zoteroAttachmentImportRequestSchema, type ZoteroAttachmentImport} from '../../../shared/schemas/research-zotero-attachment';
import {ZoteroAttachmentImportStore} from './zotero-attachment-import-store';
import {readZoteroGrantedFile} from './zotero-granted-file';
import type {ResearchDocumentService} from './document-service';
import {zoteroChildrenRequestSchema, type ZoteroChildrenPage} from '../../../shared/schemas/research-zotero-attachment';

type FrozenOrigin = {origin: LiteratureCandidate['origins'][number]; executionId: string};
type FrozenSource = {kind: 'doi'; doi: string} | {kind: 'records'; origins: FrozenOrigin[]} |
  {kind: 'zotero'; object: ZoteroFrozenObject};
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
  private readonly zoteroPreviews: ZoteroPreviewStore;
  private readonly zoteroObjects: ZoteroObjectStore;
  private readonly zoteroSyncs: ZoteroSyncStore;
  private readonly syncJobs = new Set<Promise<ZoteroSyncCapturedPage>>();
  private readonly syncReads = new Map<string, AbortController>();
  private readonly zoteroSourceStates: ZoteroSourceStateStore;
  private readonly sourceStateJobs = new Set<Promise<ZoteroSourceState>>();
  private readonly zoteroAttachments: ZoteroAttachmentStore;
  private readonly attachmentJobs = new Set<Promise<ZoteroAttachmentInspection>>();
  private readonly zoteroAttachmentGrants: ZoteroAttachmentGrantStore;
  private readonly attachmentGrantJobs = new Map<string, Promise<ZoteroAttachmentGrantOutcome>>();
  private readonly zoteroAttachmentImports: ZoteroAttachmentImportStore;
  private readonly attachmentImportJobs = new Map<string, {controller: AbortController; promise: Promise<ZoteroAttachmentImport>}>();
  private readonly zoteroChildrenJobs = new Set<Promise<ZoteroChildrenPage>>();
  private readonly previewJobs = new Set<Promise<ZoteroPreviewPage>>();
  private closed = false;
  constructor(private readonly db: Database, private readonly library: ResearchLibraryRepository,
    private readonly searchService: LiteratureSearchService, private readonly prepare: Pick<ResearchLibraryService, 'prepareDoi' | 'prepareRecord' | 'prepareZotero'>,
    private readonly changed: (result: LiteratureImportResult) => Promise<void>, private readonly now: () => string = () => new Date().toISOString()) {
    this.searchLedger = new LiteratureSearchLedger(db, now);
    this.zoteroPreviews = new ZoteroPreviewStore(db, now);
    this.zoteroObjects = new ZoteroObjectStore(db, now);
    this.zoteroSyncs = new ZoteroSyncStore(db, this.zoteroPreviews, now);
    this.zoteroSourceStates = new ZoteroSourceStateStore(db, this.zoteroObjects, now);
    this.zoteroAttachments = new ZoteroAttachmentStore(db, this.zoteroObjects, now);
    this.zoteroAttachmentGrants = new ZoteroAttachmentGrantStore(db, this.zoteroAttachments, now);
    this.zoteroAttachmentImports = new ZoteroAttachmentImportStore(db, this.zoteroAttachmentGrants, this.zoteroAttachments, now);
  }

  async search(input: unknown): Promise<LiteratureSearchResult> {
    const pending = this.executeSearch(input);
    this.searches.add(pending);
    try { return await pending; }
    finally { this.searches.delete(pending); }
  }

  async previewZotero(input: unknown, adapter: ZoteroAdapter): Promise<ZoteroPreviewPage> {
    const request = zoteroItemsRequestSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    this.library.validateDestination(context.projectId);
    const pending = (async (): Promise<ZoteroPreviewPage> => {
      const signal = AbortSignal.any([this.lifetime.signal, ...(context.signal === undefined ? [] : [context.signal])]);
      const sourcePage = await adapter.itemsWithBibliography(request, signal);
      this.requireActive(context);
      return this.zoteroPreviews.capture(context, request, sourcePage);
    })();
    this.previewJobs.add(pending);
    try { return await pending; }
    finally { this.previewJobs.delete(pending); }
  }

  readZoteroPreview(input: unknown): ZoteroPreviewPage {
    const context = literatureContext();
    this.requireActive(context);
    return this.zoteroPreviews.read(context, input);
  }

  readZoteroSources(input: unknown): z.infer<typeof zoteroSourcesPageSchema> {
    const request = zoteroSourcesRequestSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    this.library.get(request.id);
    return this.zoteroObjects.read(context, request);
  }

  reviewZotero(input: unknown): ZoteroReview {
    const request = zoteroReviewRequestSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    const preview = this.zoteroPreviews.load(context, request.previewId);
    const items = request.itemKeys.map(key => {
      const source = freezeZoteroObject(preview, key);
      const mapped = this.zoteroObjects.current(source);
      const target = this.library.findByIdentity(literatureIdentity(source.metadata), []);
      const localItem = mapped === null ? target : this.library.get(mapped.item_id);
      let objectState: ZoteroReview['items'][number]['objectState'] = mapped === null ? 'new' :
        mapped.object_version === source.item.version ? 'unchanged' : 'new_version';
      if (mapped !== null) {
        if (mapped.object_version > source.item.version) objectState = 'version_regressed';
        else if (mapped.object_version === source.item.version && mapped.item_hash !== source.itemHash) objectState = 'version_conflict';
        else if (target?.id !== mapped.item_id) objectState = 'identity_changed';
      }
      const fields = ['title', 'authors', 'doi', 'abstract', 'url'] as const;
      const present = (value: string | string[] | null): boolean =>
        Array.isArray(value) ? value.length > 0 : value !== null && value.trim() !== '';
      const differences = localItem === null ? [] : fields.flatMap(field => {
        const remote = source.metadata[field], local = localItem.metadata[field];
        return present(remote) && present(local) && JSON.stringify(remote) !== JSON.stringify(local) ? [{field, source: remote, local}] : [];
      });
      const local = localItem === null ? null : {
        id: localItem.id, revision: localItem.revision, archived: localItem.archived,
        metadata: localItem.metadata, bibliography: localItem.bibliography, updatedAt: localItem.updatedAt
      };
      return {source, objectState, mappedVersion: mapped?.object_version ?? null, local, differences,
        previousScopedSource: this.zoteroObjects.latestScoped(context, source)};
    });
    return {previewId: preview.previewId, scope: {serverId: preview.sourcePage.serverId, library: preview.sourcePage.library},
      libraryVersion: preview.sourcePage.libraryVersion, reviewedAt: this.now(), policy: 'retain_existing_fill_missing', items};
  }

  startZoteroSync(input: unknown): ZoteroSync {
    const context = literatureContext();
    this.requireActive(context);
    this.library.validateDestination(context.projectId);
    return this.zoteroSyncs.start(context, input);
  }

  readZoteroSync(input: unknown): ZoteroSync {
    const context = literatureContext();
    this.requireActive(context);
    return this.zoteroSyncs.read(context, input);
  }

  findZoteroSync(input: unknown): ZoteroSync | null {
    const context = literatureContext();
    this.requireActive(context);
    return this.zoteroSyncs.find(context, input);
  }

  readZoteroSyncPage(input: unknown): ZoteroSyncCapturedPage {
    const context = literatureContext();
    this.requireActive(context);
    return this.zoteroSyncs.readPage(context, input);
  }

  controlZoteroSync(input: unknown): ZoteroSync {
    const context = literatureContext();
    this.requireActive(context);
    const state = this.zoteroSyncs.control(context, input);
    if (state.status !== 'active') this.syncReads.get(state.syncId)?.abort();
    return state;
  }

  acknowledgeZoteroSync(input: unknown): ZoteroSync {
    const context = literatureContext();
    this.requireActive(context);
    this.library.validateDestination(context.projectId);
    return this.zoteroSyncs.acknowledge(context, input);
  }

  async captureZoteroSyncPage(input: unknown, adapter: ZoteroAdapter): Promise<ZoteroSyncCapturedPage> {
    const context = literatureContext();
    this.requireActive(context);
    this.library.validateDestination(context.projectId);
    const request = zoteroSyncPageSchema.parse(input);
    const query = this.zoteroSyncs.pageRequest(context, request);
    if (this.syncReads.has(request.syncId)) throw new Error('zotero_sync_page_in_progress');
    const controller = new AbortController();
    this.syncReads.set(request.syncId, controller);
    const pending = (async (): Promise<ZoteroSyncCapturedPage> => {
      try {
        const signal = AbortSignal.any([this.lifetime.signal, controller.signal,
          ...(context.signal === undefined ? [] : [context.signal])]);
        const source = await adapter.itemsWithBibliography(query, signal);
        this.requireActive(context);
        return this.zoteroSyncs.capture(context, input, source);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['zotero_server_changed', 'zotero_library_version_changed',
          'zotero_sync_version_regressed', 'zotero_sync_total_changed', 'zotero_sync_page_duplicate'].includes(code)) {
          this.zoteroSyncs.invalidate(context, input, code);
        }
        throw error;
      }
    })();
    this.syncJobs.add(pending);
    try {return await pending;}
    finally {this.syncJobs.delete(pending); this.syncReads.delete(request.syncId);}
  }

  readZoteroSourceState(input: unknown): ZoteroSourceState | null {
    const context = literatureContext();
    this.requireActive(context);
    return this.zoteroSourceStates.read(context, input);
  }

  readZoteroAttachment(inspectionId: string): ZoteroAttachmentInspection {
    const context = literatureContext();
    this.requireActive(context);
    return this.zoteroAttachments.read(context, inspectionId);
  }

  async readZoteroChildren(input: unknown, adapter: ZoteroAdapter): Promise<ZoteroChildrenPage> {
    const request = zoteroChildrenRequestSchema.parse(input);
    const {offset, limit, expectedLibraryVersion, ...source} = request;
    const context = literatureContext();
    this.requireActive(context);
    const parent = this.zoteroObjects.imported(context, {...source, collectionKey: null});
    const pending = (async (): Promise<ZoteroChildrenPage> => {
      const signal = AbortSignal.any([this.lifetime.signal, ...(context.signal === undefined ? [] : [context.signal])]);
      const page = await adapter.children({...parent.scope, offset, limit, expectedLibraryVersion}, parent.itemKey, signal);
      this.requireActive(context);
      return {parent, request, page};
    })();
    this.zoteroChildrenJobs.add(pending);
    try {return await pending;}
    finally {this.zoteroChildrenJobs.delete(pending);}
  }

  readZoteroAttachmentGrant(grantId: string): ZoteroAttachmentGrant {
    const context = literatureContext();
    this.requireActive(context);
    return this.zoteroAttachmentGrants.read(context, grantId);
  }

  readZoteroAttachmentImport(requestId: string): ZoteroAttachmentImport {
    const context = literatureContext();
    this.requireActive(context);
    const result = this.zoteroAttachmentImports.find(context, requestId);
    if (result === null) throw new Error('zotero_attachment_import_not_found');
    return result;
  }

  cancelZoteroAttachmentImport(requestId: string): {requestId: string; cancelRequested: boolean} {
    const context = literatureContext();
    this.requireActive(context);
    const active = this.attachmentImportJobs.get(JSON.stringify([context.owner, context.projectId, requestId]));
    if (active !== undefined) {
      active.controller.abort(new Error('zotero_attachment_import_cancelled'));
      return {requestId, cancelRequested: true};
    }
    this.readZoteroAttachmentImport(requestId);
    return {requestId, cancelRequested: false};
  }

  async importZoteroAttachment(input: unknown, documents: Pick<ResearchDocumentService, 'importPrepared'>): Promise<ZoteroAttachmentImport> {
    const request = zoteroAttachmentImportRequestSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    const existing = this.zoteroAttachmentImports.find(context, request.requestId);
    const destinationProjectId = request.destination === 'current_project' ? context.projectId : null;
    if (request.destination === 'current_project' && destinationProjectId === null) throw new Error('literature_project_required');
    if (existing !== null) {
      if (existing.grantId !== request.grantId || existing.destinationProjectId !== destinationProjectId) throw new Error('zotero_attachment_import_request_conflict');
      return existing;
    }
    const grant = this.zoteroAttachmentGrants.read(context, request.grantId);
    const inspection = this.zoteroAttachments.read(context, grant.inspectionId);
    this.library.validateDestination(destinationProjectId);
    if (this.library.get(inspection.libraryItemId).archived) throw new Error('research_library_item_archived');
    const key = JSON.stringify([context.owner, context.projectId, request.requestId]);
    if (this.attachmentImportJobs.has(key)) throw new Error('zotero_attachment_import_active');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(context.signal === undefined ? [] : [context.signal])]);
    const pending = (async (): Promise<ZoteroAttachmentImport> => {
      const bytes = await readZoteroGrantedFile(grant, signal);
      this.requireActive(context);
      let receipt!: ZoteroAttachmentImport;
      await documents.importPrepared({target: 'library-item', sourcePath: grant.selectedPath,
        libraryItemId: inspection.libraryItemId, projectId: destinationProjectId}, bytes, document => {
          this.requireActive(context);
          signal.throwIfAborted();
          receipt = this.zoteroAttachmentImports.record(context, request.requestId, grant, inspection, destinationProjectId, document);
        }, signal);
      return receipt;
    })();
    this.attachmentImportJobs.set(key, {controller, promise: pending});
    try {return await pending;}
    catch (error) {
      if (signal.aborted) throw new Error('zotero_attachment_import_cancelled', {cause: error});
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('zotero_attachment_source_missing', {cause: error});
      if (code === 'EACCES' || code === 'EPERM') throw new Error('zotero_attachment_source_denied', {cause: error});
      if (code === 'ELOOP') throw new Error('zotero_attachment_file_changed', {cause: error});
      throw error;
    }
    finally {this.attachmentImportJobs.delete(key);}
  }

  async grantZoteroAttachment(input: unknown, pick: ZoteroAttachmentPicker): Promise<ZoteroAttachmentGrantOutcome> {
    const request = zoteroAttachmentGrantRequestSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    const inspection = this.zoteroAttachments.read(context, request.inspectionId);
    const existing = this.zoteroAttachmentGrants.find(context, request.requestId);
    if (existing !== null) {
      if (existing.inspectionId !== request.inspectionId) throw new Error('zotero_attachment_grant_request_conflict');
      return {status: 'granted', grant: existing};
    }
    const key = JSON.stringify([context.owner, context.projectId, request.requestId]);
    if (this.attachmentGrantJobs.has(key)) throw new Error('zotero_attachment_grant_active');
    if (inspection.file.status !== 'ready') throw new Error('zotero_attachment_file_not_ready');
    const file = inspection.file;
    const pending = (async (): Promise<ZoteroAttachmentGrantOutcome> => {
      const current = await inspectZoteroAttachmentFile(file.resolvedPath);
      this.requireActive(context);
      if (current.status !== 'ready' || current.resolvedPath !== file.resolvedPath || !isDeepStrictEqual(current.identity, file.identity)) {
        throw new Error('zotero_attachment_file_changed');
      }
      const signal = AbortSignal.any([this.lifetime.signal, ...(context.signal === undefined ? [] : [context.signal])]);
      const selected = await pick(context, file.resolvedPath, signal);
      this.requireActive(context);
      if (selected === null) return {status: 'cancelled', grant: null};
      const chosen = await inspectZoteroAttachmentFile(selected);
      this.requireActive(context);
      if (chosen.status !== 'ready' || chosen.resolvedPath !== file.resolvedPath) throw new Error('zotero_attachment_selected_file_mismatch');
      if (!isDeepStrictEqual(chosen.identity, file.identity)) throw new Error('zotero_attachment_file_changed');
      return {status: 'granted', grant: this.zoteroAttachmentGrants.record(context, request.requestId, inspection)};
    })();
    this.attachmentGrantJobs.set(key, pending);
    try {return await pending;}
    finally {this.attachmentGrantJobs.delete(key);}
  }

  async inspectZoteroAttachment(input: unknown, adapter: ZoteroAdapter): Promise<ZoteroAttachmentInspection> {
    const request = zoteroAttachmentRequestSchema.parse(input);
    const {attachmentKey, ...parent} = request;
    const context = literatureContext();
    this.requireActive(context);
    const original = this.zoteroObjects.imported(context, {...parent, collectionKey: null});
    const pending = (async (): Promise<ZoteroAttachmentInspection> => {
      const signal = AbortSignal.any([this.lifetime.signal, ...(context.signal === undefined ? [] : [context.signal])]);
      const remote = await adapter.inspectObject(original.scope, attachmentKey, signal);
      this.requireActive(context);
      let linkMode: ZoteroAttachmentInspection['linkMode'] = null;
      let file: ZoteroAttachmentFile;
      if (remote.status === 'not_found') file = {status: 'not_requested', reason: 'source_not_found'};
      else {
        if (remote.item.data.itemType !== 'attachment' || remote.item.data.parentItem !== original.itemKey ||
          attachmentKey === original.itemKey) throw new Error('zotero_attachment_parent_mismatch');
        const mode = zoteroAttachmentLinkModeSchema.safeParse(remote.item.data.linkMode);
        if (!mode.success) throw new Error('zotero_response_invalid');
        linkMode = mode.data;
        if (remote.status === 'trashed') file = {status: 'not_requested', reason: 'trashed'};
        else if (linkMode === 'linked_url' || linkMode === 'embedded_image') file = {status: 'not_requested', reason: linkMode};
        else {
          const path = await adapter.attachmentPath(original.scope, attachmentKey, signal);
          this.requireActive(context);
          file = await inspectZoteroAttachmentFile(path);
        }
      }
      this.requireActive(context);
      return this.zoteroAttachments.record(context, request, {remote, linkMode, file});
    })();
    this.attachmentJobs.add(pending);
    try {return await pending;}
    finally {this.attachmentJobs.delete(pending);}
  }

  async observeZoteroSource(input: unknown, adapter: ZoteroAdapter): Promise<ZoteroSourceState> {
    const request = zoteroSourceStateRequestSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    const original = this.zoteroObjects.imported(context, request);
    const pending = (async (): Promise<ZoteroSourceState> => {
      const signal = AbortSignal.any([this.lifetime.signal, ...(context.signal === undefined ? [] : [context.signal])]);
      const remote = await adapter.inspectObject(original.scope, original.itemKey, signal);
      this.requireActive(context);
      return this.zoteroSourceStates.record(context, request, original, remote);
    })();
    this.sourceStateJobs.add(pending);
    try {return await pending;}
    finally {this.sourceStateJobs.delete(pending);}
  }

  private async executeSearch(input: unknown): Promise<LiteratureSearchResult> {
    const request = literatureSearchInputSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    this.library.validateDestination(context.projectId);
    let strategy: LiteratureSearchResult['strategy'] = null;
    if (context.searchStrategy !== undefined) {
      if (context.queryId === undefined) throw new Error('research_search_query_id_required');
      const plan = context.searchStrategy.plan;
      const selected = plan.queries.find(query => query.id === context.queryId);
      if (selected === undefined) throw new Error('research_search_query_id_invalid');
      const {id: _id, maxRequests, ...query} = selected;
      const {projectId: _projectId, ...parameters} = request;
      if (JSON.stringify(parameters) !== JSON.stringify(query)) throw new Error('research_search_query_changed');
      strategy = {artifactId: context.searchStrategy.artifactId, contentHash: context.searchStrategy.contentHash,
        approvedAt: context.searchStrategy.approvedAt, researchQuestion: plan.researchQuestion, planVersion: plan.version,
        queryId: context.queryId, perspectiveIds: plan.perspectives.filter(view => view.queryIds.includes(context.queryId!)).map(view => view.id), maxRequests};
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
      const pool = literatureSearchPoolBodySchema.parse({schemaVersion: 1, executionId, createdAt,
        request: scopedRequest, strategy, status: found.status, sources: found.sources, records: found.records});
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
      const result: LiteratureSearchResult = { schemaVersion: 14, ranking: literatureRanking(request.sources), executionId, strategy,
        searchId: `search_${randomUUID()}`, createdAt, expiresAt: new Date(Date.parse(createdAt) + 7 * 86400_000).toISOString(),
        status: found.status, candidates, sources: found.sources, truncated: found.truncated || grouped.length > request.limit,
        warnings: [...found.warnings, ...(unknownYear ? ['年份未知的候选未计入年份筛选结果。'] : [])], total: candidates.length, nextOffset: null };
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO research_literature_search_pools(execution_id,pool_json) VALUES (?,?)')
          .run(executionId, JSON.stringify({...pool, contentHash: hash(pool)}));
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

  readPool(input: unknown): z.infer<typeof literatureSearchPoolPageSchema> {
    const request = literatureReadPoolSchema.parse(input);
    const context = literatureContext();
    this.requireActive(context);
    const row = this.db.prepare(`SELECT p.pool_json FROM research_literature_search_pools p
      JOIN research_literature_search_executions e ON e.id=p.execution_id
      WHERE p.execution_id=? AND e.owner=? AND e.project_id IS ?`)
      .get(request.executionId, context.owner, context.projectId) as {pool_json: string} | undefined;
    if (row === undefined) throw new Error('literature_pool_not_found');
    const {contentHash, ...pool} = decode(row.pool_json, literatureSearchPoolSchema);
    if (hash(pool) !== contentHash) throw new Error('literature_pool_integrity_invalid');
    const total = pool.records.length;
    return {...pool, contentHash, records: pool.records.slice(request.offset, request.offset + request.limit),
      total, nextOffset: request.offset + request.limit < total ? request.offset + request.limit : null};
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
      else if (entry.kind === 'zotero') {
        const object = freezeZoteroObject(this.zoteroPreviews.load(context, entry.previewId), entry.itemKey);
        this.zoteroObjects.validate(object);
        source = {kind: 'zotero', object};
        key = object.metadata.id;
      }
      else {
        const snapshot = this.loadSearch(entry.searchId, context);
        const candidate = snapshot.candidates.find((candidate) => candidate.candidateId === entry.candidateId);
        if (candidate === undefined) throw new Error('literature_candidate_not_found');
        source = {kind: 'records', origins: uniqueOrigins(candidate.origins.map(origin => ({origin, executionId: snapshot.executionId})))};
        key = candidate.identity;
      }
      const duplicate = frozen.find((item) => item.result.entryKey === key);
      if (duplicate !== undefined) {
        duplicate.result.inputPositions.push(position);
        if (source.kind === 'records') {
          if (duplicate.source.kind === 'doi') duplicate.source = source;
          else if (duplicate.source.kind === 'records') duplicate.source =
            {kind: 'records', origins: uniqueOrigins([...duplicate.source.origins, ...source.origins])};
          else throw new Error('literature_import_selection_conflict');
        } else if (source.kind === 'zotero' && hash(source) !== hash(duplicate.source)) {
          throw new Error('zotero_selection_conflict');
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
    await Promise.allSettled([...this.searches, ...this.previewJobs, ...this.syncJobs, ...this.sourceStateJobs, ...this.attachmentJobs,
      ...this.attachmentGrantJobs.values(),
      ...[...this.attachmentImportJobs.values()].map(job => job.promise),
      ...this.zoteroChildrenJobs,
      ...[...this.active.values()].map((task) => task.promise)]);
  }

  private async execute(context: LiteratureExecutionContext, signal: AbortSignal, result: LiteratureImportResult, frozen: FrozenEntry[]): Promise<LiteratureImportResult> {
    result.status = 'running'; this.save(result);
    for (const [position, entry] of frozen.entries()) {
      const item = result.items[position];
      const uncommitted = structuredClone(item);
      let committed = false;
      try {
        this.requireActive({ ...context, signal });
        const prepared: (Awaited<ReturnType<ResearchLibraryService['prepareRecord']>> & {
          providerRecord?: LiteratureCandidate['record']; identifierRecord?: LiteratureProviderIdentifierRecord; reviewRecord?: LiteratureReviewRecord})[] = [];
        const known = entry.source.kind === 'zotero' ? this.zoteroObjects.validate(entry.source.object) : null;
        const reusable = known !== null && entry.source.kind === 'zotero' && known.object_version === entry.source.object.item.version ? known : null;
        if (reusable === null) {
          if (entry.source.kind === 'doi') {
            prepared.push(await this.prepare.prepareDoi(entry.source.doi, context.projectId, signal));
          } else if (entry.source.kind === 'zotero') {
            const object = entry.source.object;
            prepared.push({...await this.prepare.prepareZotero(object.metadata, object.cslJson, context.projectId, signal), providerRecord: object.metadata});
          } else {
            for (const {origin, executionId} of entry.source.origins) {
              this.requireActive({ ...context, signal });
              const identifierRecord = origin.rawIdentifiers === null ? undefined : {metadataHash: origin.metadataHash, executionId,
                source: origin.source, externalId: origin.externalId, rank: origin.rank, retrievedAt: origin.retrievedAt,
                raw: origin.rawIdentifiers, identifiers: origin.identifiers};
              prepared.push({...await this.prepare.prepareRecord(origin.record, context.projectId, signal), providerRecord: origin.record, identifierRecord,
                reviewRecord: {metadataHash: origin.metadataHash, executionId, source: origin.source, externalId: origin.externalId,
                  rank: origin.rank, retrievedAt: origin.retrievedAt, review: origin.review}});
            }
          }
        }
        const identities = groupLiteratureIdentities(prepared.map(record => ({record: record.metadata,
          identifiers: record.identifierRecord === undefined ? [] : record.identifierRecord.identifiers})));
        const expectedIdentity = entry.source.kind === 'zotero' ? literatureIdentity(entry.source.object.metadata) : item.entryKey;
        if (reusable === null && (identities.length !== 1 || identities[0].identity !== expectedIdentity)) throw new Error('literature_import_identity_changed');
        this.db.transaction(() => {
          this.requireActive({ ...context, signal });
          this.library.validateDestination(context.projectId);
          const row = this.db.prepare('SELECT cancel_requested FROM research_literature_imports WHERE id = ?').get(result.operationId) as { cancel_requested: number };
          if (row.cancel_requested === 1) throw new Error('literature_import_cancelled');
          const current = reusable === null ? this.library.findByIdentity(expectedIdentity, identities[0].aliases) : this.library.get(reusable.item_id);
          if (current?.archived === true) {
            Object.assign(item, { disposition: 'skipped_archived', libraryItemId: current.id, citationKey: current.bibliography.citationKey });
          } else {
            let saved: ReturnType<ResearchLibraryRepository['get']>;
            if (reusable !== null) {
              saved = this.library.get(reusable.item_id);
              if (result.destinationProjectId !== null && !saved.projectIds.includes(result.destinationProjectId)) {
                saved = this.library.link(saved.id, result.destinationProjectId, true, {notify: false});
              }
            } else {
              const citationKey = current?.bibliography.citationKey ?? betterBibtexKey(prepared[0].metadata, this.library.usedCitationKeys());
              for (const source of prepared) source.bibliography.citationKey = citationKey;
              saved = this.library.import(prepared, result.destinationProjectId, {flush: false, notify: false, skipArchived: true}).items[0];
            }
            Object.assign(item, { disposition: current === null ? 'created' : result.destinationProjectId !== null && !current.projectIds.includes(result.destinationProjectId) ? 'linked' : 'already_present',
              libraryItemId: saved.id, citationKey: saved.bibliography.citationKey, metadata: 'ready', metadataUpdated: current !== null && current.revision !== saved.revision,
              index: { scope: 'metadata', keyword: 'ready', vector: 'not_requested' } });
            if (entry.source.kind === 'zotero') this.zoteroObjects.record(entry.source.object, saved.id, result.operationId);
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
        const invalidFrozenCsl = entry.source.kind === 'zotero' &&
          (errorCode.startsWith('research_csl_') || errorCode === 'research_json_invalid' ||
            errorCode.startsWith('research_bibliography_'));
        Object.assign(item, { disposition: cancelled ? 'cancelled' : 'failed', metadata: cancelled ? 'not_requested' : 'failed',
          errorCode, retryable: !cancelled && !invalidFrozenCsl && !['research_literature_identity_ambiguous', 'literature_import_identity_changed',
            'research_library_identifier_observation_mismatch', 'research_library_identifier_observation_conflict',
            'research_library_review_observation_mismatch', 'research_library_review_observation_conflict',
            'zotero_object_version_regressed', 'zotero_object_version_conflict', 'zotero_object_identity_changed',
            'zotero_csl_metadata_mismatch'].includes(errorCode) });
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
function uniqueOrigins(origins: FrozenOrigin[]): FrozenOrigin[] {
  const seen = new Set<string>();
  return origins.filter(record => {
    const fingerprint = hash(record);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}
function safeFailure(error: unknown): string {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
  return /^(research|literature|zotero)_[a-z_]+$/u.test(code) ? code : 'literature_metadata_import_failed';
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
