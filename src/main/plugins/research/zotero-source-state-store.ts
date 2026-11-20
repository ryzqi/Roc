import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import {zoteroSourceStateRequestSchema, zoteroSourceStateBodySchema, zoteroSourceStateSchema,
  type ZoteroObjectRead, type ZoteroSourceState} from '../../../shared/schemas/research-zotero-source-state';
import {zoteroItemKeySchema, type zoteroImportedObjectSchema} from '../../../shared/schemas/research-zotero';
import type {LiteratureExecutionContext} from '../../services/literature-context';
import type {ZoteroObjectStore} from './zotero-object-store';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Immutable, owned observations. Source disappearance never deletes or rewrites library/evidence data. */
export class ZoteroSourceStateStore {
  constructor(private readonly db: Database, private readonly objects: ZoteroObjectStore, private readonly now: () => string) {}

  record(context: LiteratureExecutionContext, input: unknown,
    original: z.infer<typeof zoteroImportedObjectSchema>, remote: ZoteroObjectRead): ZoteroSourceState {
    const source = zoteroSourceStateRequestSchema.parse(input);
    let membership: ZoteroSourceState['membership'] = source.collectionKey === null ? 'not_requested' : 'unknown';
    if (source.collectionKey !== null && remote.status === 'present') {
      if (remote.item.data.collections === undefined) {
        if (!zoteroItemKeySchema.safeParse(remote.item.data.parentItem).success) throw new Error('zotero_response_invalid');
      } else {
        const collections = z.array(zoteroItemKeySchema).safeParse(remote.item.data.collections);
        if (!collections.success) throw new Error('zotero_response_invalid');
        membership = collections.data.includes(source.collectionKey) ? 'listed' : 'not_listed';
      }
    }
    const versionState = remote.status === 'not_found' ? 'missing' :
      remote.objectVersion < original.version ? 'regressed' : remote.objectVersion > original.version ? 'newer' :
        isDeepStrictEqual(remote.item.data, original.item.data) ? 'unchanged' : 'version_conflict';
    const body = zoteroSourceStateBodySchema.parse({stateId: `zotero_state_${randomUUID()}`, source,
      libraryItemId: original.libraryItemId, importedObjectVersion: original.version, remote, membership, versionState, recordedAt: this.now()});
    const state = {...body, contentHash: hash(body)};
    this.db.prepare(`INSERT INTO research_zotero_source_states
      (id,owner,scope_project,operation_id,server_id,library_kind,library_id,item_key,collection_key,state_json,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(state.stateId, context.owner, context.projectId ?? '', source.operationId,
        source.serverId, source.library.kind, source.library.id, source.itemKey, source.collectionKey, JSON.stringify(state), state.recordedAt);
    return state;
  }

  read(context: LiteratureExecutionContext, input: unknown): ZoteroSourceState | null {
    const source = zoteroSourceStateRequestSchema.parse(input);
    const original = this.objects.imported(context, source);
    const row = this.db.prepare(`SELECT id,state_json FROM research_zotero_source_states
      WHERE owner=? AND scope_project=? AND operation_id=? AND server_id=? AND library_kind=? AND library_id=?
      AND item_key=? AND collection_key IS ? ORDER BY rowid DESC LIMIT 1`)
      .get(context.owner, context.projectId ?? '', source.operationId, source.serverId, source.library.kind, source.library.id,
        source.itemKey, source.collectionKey) as {id: string; state_json: string} | undefined;
    if (row === undefined) return null;
    try {
      const state = zoteroSourceStateSchema.parse(JSON.parse(row.state_json));
      const {contentHash, ...body} = state;
      if (state.stateId !== row.id || !isDeepStrictEqual(state.source, source) || hash(body) !== contentHash ||
        state.libraryItemId !== original.libraryItemId || state.importedObjectVersion !== original.version) {
        throw new Error('zotero_source_state_integrity_invalid');
      }
      return state;
    } catch (cause) {throw new Error('zotero_source_state_storage_invalid', {cause});}
  }
}
