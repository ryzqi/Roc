import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  zoteroSyncStartSchema, zoteroSyncReadSchema, zoteroSyncPageSchema,
  zoteroSyncControlSchema, zoteroSyncAcknowledgeSchema, zoteroSyncSchema,
  type ZoteroSync, type ZoteroSyncCapturedPage
} from '../../../shared/schemas/research-zotero-sync';
import type {zoteroItemsPageSchema, zoteroItemsRequestSchema} from '../../../shared/schemas/research-zotero';
import type {LiteratureExecutionContext} from '../../services/literature-context';
import type {ZoteroPreviewStore} from './zotero-preview-store';

type Row = {id: string; revision: number; status: ZoteroSync['status']; state_json: string; scope_key: string};

/** Checkpoints mean every captured object was imported or explicitly skipped, not that the library is exhaustive. */
export class ZoteroSyncStore {
  constructor(private readonly db: Database, private readonly previews: ZoteroPreviewStore, private readonly now: () => string) {}

  start(context: LiteratureExecutionContext, input: unknown): ZoteroSync {
    const request = zoteroSyncStartSchema.parse(input);
    return this.db.transaction(() => {
      const scope = {serverId: request.serverId, library: request.library};
      const scopeKey = this.key(context, scope, request.collectionKey);
      if (this.db.prepare(`SELECT id FROM research_zotero_syncs WHERE scope_key=? AND status IN ('active','paused')`)
        .get(scopeKey) !== undefined) throw new Error('zotero_sync_already_active');
      const checkpoint = this.db.prepare('SELECT library_version FROM research_zotero_sync_checkpoints WHERE scope_key=?')
        .get(scopeKey) as {library_version: number} | undefined;
      const checkpointVersion = checkpoint?.library_version ?? null;
      const timestamp = this.now();
      const state: ZoteroSync = {syncId: `zotero_sync_${randomUUID()}`, scope, collectionKey: request.collectionKey,
        mode: request.mode, limit: request.limit, revision: 0, status: 'active', checkpointVersion,
        since: request.mode === 'incremental' ? checkpointVersion : null, targetVersion: null, total: null,
        nextOffset: 0, pendingPreviewId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp};
      this.db.prepare(`INSERT INTO research_zotero_syncs
        (id,owner,scope_project,scope_key,status,revision,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(state.syncId, context.owner, context.projectId ?? '', scopeKey, state.status, state.revision,
          JSON.stringify(state), timestamp, timestamp);
      return state;
    })();
  }

  read(context: LiteratureExecutionContext, input: unknown): ZoteroSync {
    const {syncId} = zoteroSyncReadSchema.parse(input);
    const row = this.db.prepare('SELECT * FROM research_zotero_syncs WHERE id=? AND owner=? AND scope_project=?')
      .get(syncId, context.owner, context.projectId ?? '') as Row | undefined;
    if (row === undefined) throw new Error('zotero_sync_not_found');
    let state: ZoteroSync;
    try {state = zoteroSyncSchema.parse(JSON.parse(row.state_json));}
    catch (cause) {throw new Error('zotero_sync_storage_invalid', {cause});}
    if (state.syncId !== row.id || state.revision !== row.revision || state.status !== row.status ||
      this.key(context, state.scope, state.collectionKey) !== row.scope_key) throw new Error('zotero_sync_storage_invalid');
    return state;
  }

  pageRequest(context: LiteratureExecutionContext, input: unknown): z.infer<typeof zoteroItemsRequestSchema> {
    const request = zoteroSyncPageSchema.parse(input);
    const state = this.expected(context, request, 'active');
    if (state.pendingPreviewId !== request.replacePreviewId) throw new Error('zotero_sync_page_pending');
    return {...state.scope, collectionKey: state.collectionKey, since: state.since,
      offset: state.nextOffset, limit: state.limit, expectedLibraryVersion: state.targetVersion};
  }

  capture(context: LiteratureExecutionContext, input: unknown, source: z.infer<typeof zoteroItemsPageSchema>): ZoteroSyncCapturedPage {
    const request = zoteroSyncPageSchema.parse(input);
    return this.db.transaction(() => {
      const query = this.pageRequest(context, request);
      const state = this.read(context, {syncId: request.syncId});
      if (source.libraryVersion < (state.checkpointVersion ?? 0)) throw new Error('zotero_sync_version_regressed');
      if (state.total !== null && source.total !== state.total) throw new Error('zotero_sync_total_changed');
      for (const item of source.records) {
        if (this.db.prepare('SELECT 1 FROM research_zotero_sync_seen WHERE sync_id=? AND item_key=?')
          .get(state.syncId, item.key) !== undefined) throw new Error('zotero_sync_page_duplicate');
      }
      // Adapter validates source instance/version/page completeness before this atomic publication.
      const preview = this.previews.capture(context, query, source);
      state.targetVersion = source.libraryVersion;
      state.total = source.total;
      state.pendingPreviewId = preview.previewId;
      return {sync: this.save(state), preview};
    })();
  }

  acknowledge(context: LiteratureExecutionContext, input: unknown): ZoteroSync {
    const request = zoteroSyncAcknowledgeSchema.parse(input);
    return this.db.transaction(() => {
      const state = this.expected(context, request, 'active');
      if (state.pendingPreviewId !== request.previewId) throw new Error('zotero_sync_page_mismatch');
      const preview = this.previews.load(context, request.previewId);
      if (preview.request.offset !== state.nextOffset || preview.request.since !== state.since ||
        preview.request.collectionKey !== state.collectionKey || preview.request.limit !== state.limit ||
        JSON.stringify({serverId: preview.request.serverId, library: preview.request.library}) !== JSON.stringify(state.scope) ||
        preview.sourcePage.libraryVersion !== state.targetVersion || preview.sourcePage.total !== state.total) {
        throw new Error('zotero_sync_storage_invalid');
      }
      const keys = new Set([...request.importedKeys, ...request.skipped.map(item => item.itemKey)]);
      if (keys.size !== preview.sourcePage.records.length || preview.sourcePage.records.some(item => !keys.has(item.key))) {
        throw new Error('zotero_sync_page_incomplete');
      }
      for (const itemKey of request.importedKeys) {
        const item = preview.sourcePage.records.find(item => item.key === itemKey)!;
        const receipt = this.db.prepare(`SELECT o.operation_id FROM research_zotero_import_observations o
          JOIN research_literature_imports i ON i.id=o.operation_id
          WHERE o.preview_id=? AND o.item_key=? AND o.object_version=? AND i.owner=? AND i.scope_project=? LIMIT 1`)
          .get(preview.previewId, itemKey, item.version, context.owner, context.projectId ?? '');
        if (receipt === undefined) throw new Error('zotero_sync_import_receipt_missing');
      }
      this.db.prepare(`INSERT INTO research_zotero_sync_pages
        (sync_id,source_offset,preview_id,decisions_json,acknowledged_at) VALUES (?,?,?,?,?)`)
        .run(state.syncId, state.nextOffset, preview.previewId,
          JSON.stringify({importedKeys: request.importedKeys, skipped: request.skipped}), this.now());
      for (const item of preview.sourcePage.records) {
        this.db.prepare('INSERT INTO research_zotero_sync_seen(sync_id,item_key,object_version,source_offset) VALUES (?,?,?,?)')
          .run(state.syncId, item.key, item.version, state.nextOffset);
      }
      state.pendingPreviewId = null;
      state.nextOffset = preview.sourcePage.nextOffset ?? preview.sourcePage.offset + preview.sourcePage.records.length;
      if (preview.sourcePage.nextOffset === null) {
        state.status = 'completed';
        state.checkpointVersion = preview.sourcePage.libraryVersion;
        this.db.prepare(`INSERT INTO research_zotero_sync_checkpoints(scope_key,sync_id,library_version,updated_at)
          VALUES (?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET
            sync_id=excluded.sync_id,library_version=excluded.library_version,updated_at=excluded.updated_at`)
          .run(this.key(context, state.scope, state.collectionKey), state.syncId, state.checkpointVersion, this.now());
      }
      return this.save(state);
    })();
  }

  control(context: LiteratureExecutionContext, input: unknown): ZoteroSync {
    const request = zoteroSyncControlSchema.parse(input);
    return this.db.transaction(() => {
      const state = this.expected(context, request, request.action === 'resume' ? ['paused'] :
        request.action === 'pause' ? ['active'] : ['active', 'paused']);
      state.status = request.action === 'pause' ? 'paused' : request.action === 'resume' ? 'active' : 'reset_required';
      state.errorCode = request.action === 'abandon' ? 'zotero_sync_abandoned' : null;
      return this.save(state);
    })();
  }

  invalidate(context: LiteratureExecutionContext, input: unknown, code: string): void {
    const request = zoteroSyncPageSchema.parse(input);
    this.db.transaction(() => {
      const state = this.expected(context, request, 'active');
      state.status = 'reset_required';
      state.errorCode = code;
      this.save(state);
    })();
  }

  private expected(context: LiteratureExecutionContext, request: {syncId: string; expectedRevision: number},
    status: ZoteroSync['status'] | readonly ZoteroSync['status'][]): ZoteroSync {
    const state = this.read(context, {syncId: request.syncId});
    if (state.revision !== request.expectedRevision) throw new Error('zotero_sync_revision_conflict');
    if (typeof status === 'string' ? state.status !== status : !status.includes(state.status)) {
      throw new Error('zotero_sync_state_conflict');
    }
    return state;
  }

  private save(state: ZoteroSync): ZoteroSync {
    state.revision++;
    state.updatedAt = this.now();
    this.db.prepare('UPDATE research_zotero_syncs SET status=?,revision=?,state_json=?,updated_at=? WHERE id=?')
      .run(state.status, state.revision, JSON.stringify(state), state.updatedAt, state.syncId);
    return state;
  }

  private key(context: LiteratureExecutionContext, scope: ZoteroSync['scope'], collectionKey: string | null): string {
    return createHash('sha256').update(JSON.stringify([context.owner, context.projectId, scope.serverId,
      scope.library.kind, scope.library.id, collectionKey])).digest('hex');
  }
}
