import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import {zoteroFrozenObjectSchema, zoteroSourcesRequestSchema, zoteroImportedObjectSchema,
  type zoteroSourcesPageSchema, type ZoteroFrozenObject, type ZoteroPreview} from '../../../shared/schemas/research-zotero';
import {normalizeResearchDoi} from './literature-identity';
import type {LiteratureExecutionContext} from '../../services/literature-context';
import {zoteroSourceStateRequestSchema} from '../../../shared/schemas/research-zotero-source-state';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Row = {item_id: string; object_version: number; item_hash: string};
const creatorsSchema = z.array(z.object({
  creatorType: z.string().min(1), name: z.string().trim().min(1).optional(),
  firstName: z.string().trim().optional(), lastName: z.string().trim().optional()
}).passthrough().refine(creator => creator.name !== undefined || Boolean(creator.firstName || creator.lastName)));

export function freezeZoteroObject(preview: ZoteroPreview, key: string): ZoteroFrozenObject {
  const item = preview.sourcePage.records.find(record => record.key === key);
  if (item === undefined) throw new Error('zotero_preview_item_not_found');
  const data = item.data;
  if (['attachment', 'note', 'annotation'].includes(data.itemType)) throw new Error('zotero_item_not_bibliographic');
  if (typeof data.title !== 'string' || !data.title.trim() || !Array.isArray(data.creators)) throw new Error('zotero_item_metadata_invalid');
  if (typeof item.csljson !== 'string' || !item.csljson.trim()) throw new Error('zotero_item_csl_missing');
  const creators = creatorsSchema.safeParse(data.creators);
  if (!creators.success) throw new Error('zotero_item_metadata_invalid');
  const authors = creators.data.filter(creator => creator.creatorType === 'author')
    .map(creator => creator.name ?? [creator.firstName, creator.lastName].filter(value => value !== undefined && value !== '').join(' '));
  const scope = {serverId: preview.sourcePage.serverId, library: preview.sourcePage.library};
  const externalId = hash([scope.serverId, scope.library.kind, scope.library.id, key]);
  const text = (value: unknown): string | null => {
    if (value === undefined || value === '') return null;
    if (typeof value !== 'string') throw new Error('zotero_item_metadata_invalid');
    return value;
  };
  const doi = text(data.DOI);
  const metadata = {id: `zotero:${externalId}`, source: 'zotero' as const, externalId,
    doi: doi === null ? null : normalizeResearchDoi(doi), title: data.title.trim(), authors,
    abstract: text(data.abstractNote), publishedYear: null, citationCount: null,
    url: text(data.url), openAccessUrl: null, importedAt: preview.sourcePage.fetchedAt, updatedAt: preview.sourcePage.fetchedAt};
  return zoteroFrozenObjectSchema.parse({previewId: preview.previewId, scope, libraryVersion: preview.sourcePage.libraryVersion,
    item, itemHash: hash(item), metadata, cslJson: item.csljson, capturedAt: preview.sourcePage.fetchedAt});
}

/** Object keys partition synchronization; DOI is only the literature identity used by import. */
export class ZoteroObjectStore {
  constructor(private readonly db: Database, private readonly now: () => string) {}

  validate(frozen: ZoteroFrozenObject): Row | null {
    const row = this.current(frozen);
    if (row === null) return null;
    if (row.object_version > frozen.item.version) throw new Error('zotero_object_version_regressed');
    if (row.object_version === frozen.item.version && row.item_hash !== frozen.itemHash) throw new Error('zotero_object_version_conflict');
    return row;
  }

  current(frozen: ZoteroFrozenObject): Row | null {
    const row = this.db.prepare(`SELECT item_id,object_version,item_hash FROM research_zotero_objects
      WHERE server_id=? AND library_kind=? AND library_id=? AND item_key=?`).get(...this.key(frozen)) as Row | undefined;
    return row ?? null;
  }

  imported(context: LiteratureExecutionContext, input: unknown): z.infer<typeof zoteroImportedObjectSchema> {
    const request = zoteroSourceStateRequestSchema.parse(input);
    const row = this.db.prepare(`SELECT v.item_id,v.item_hash,v.item_json,v.object_version,
      o.library_version,o.preview_id,o.captured_at,o.imported_at
      FROM research_zotero_object_versions v JOIN research_zotero_import_observations o
      ON o.server_id=v.server_id AND o.library_kind=v.library_kind AND o.library_id=v.library_id
      AND o.item_key=v.item_key AND o.object_version=v.object_version
      JOIN research_zotero_previews p ON p.id=o.preview_id
      WHERE o.operation_id=? AND v.server_id=? AND v.library_kind=? AND v.library_id=? AND v.item_key=?
      AND p.owner=? AND p.project_id IS ?`)
      .get(request.operationId, request.serverId, request.library.kind, request.library.id, request.itemKey,
        context.owner, context.projectId) as {
          item_id: string; item_hash: string; item_json: string; object_version: number;
          library_version: number; preview_id: string; captured_at: string; imported_at: string
        } | undefined;
    if (row === undefined) throw new Error('zotero_source_observation_not_found');
    try {
      const record = zoteroImportedObjectSchema.parse({scope: {serverId: request.serverId, library: request.library},
        operationId: request.operationId, itemKey: request.itemKey, version: row.object_version,
        libraryItemId: row.item_id, itemHash: row.item_hash, item: JSON.parse(row.item_json),
        libraryVersion: row.library_version, previewId: row.preview_id, capturedAt: row.captured_at, importedAt: row.imported_at});
      if (record.item.key !== record.itemKey || record.item.version !== record.version || hash(record.item) !== record.itemHash) {
        throw new Error('zotero_object_integrity_invalid');
      }
      return record;
    } catch (cause) {throw new Error('zotero_object_storage_invalid', {cause});}
  }

  /** Prior originals are visible only in the owner/project that observed them. */
  latestScoped(context: LiteratureExecutionContext, frozen: ZoteroFrozenObject): z.infer<typeof zoteroImportedObjectSchema> | null {
    const row = this.db.prepare(`SELECT v.item_id,v.item_hash,v.item_json,v.object_version,
      o.operation_id,o.library_version,o.preview_id,o.captured_at,o.imported_at
      FROM research_zotero_object_versions v JOIN research_zotero_import_observations o
      ON o.server_id=v.server_id AND o.library_kind=v.library_kind AND o.library_id=v.library_id
      AND o.item_key=v.item_key AND o.object_version=v.object_version
      JOIN research_zotero_previews p ON p.id=o.preview_id
      WHERE v.server_id=? AND v.library_kind=? AND v.library_id=? AND v.item_key=? AND p.owner=? AND p.project_id IS ?
      ORDER BY v.object_version DESC,o.imported_at DESC,o.operation_id DESC LIMIT 1`)
      .get(...this.key(frozen), context.owner, context.projectId) as {
        item_id: string; item_hash: string; item_json: string; object_version: number;
        operation_id: string; library_version: number; preview_id: string; captured_at: string; imported_at: string
      } | undefined;
    if (row === undefined) return null;
    try {
      const record = zoteroImportedObjectSchema.parse({scope: frozen.scope, itemKey: frozen.item.key, version: row.object_version,
        libraryItemId: row.item_id, itemHash: row.item_hash, item: JSON.parse(row.item_json), operationId: row.operation_id,
        libraryVersion: row.library_version, previewId: row.preview_id, capturedAt: row.captured_at, importedAt: row.imported_at});
      if (record.item.key !== record.itemKey || record.item.version !== record.version || hash(record.item) !== record.itemHash) {
        throw new Error('zotero_object_integrity_invalid');
      }
      return record;
    } catch (cause) {throw new Error('zotero_object_storage_invalid', {cause});}
  }

  record(frozen: ZoteroFrozenObject, itemId: string, operationId: string): void {
    if (!this.db.inTransaction) throw new Error('zotero_import_transaction_required');
    const existing = this.validate(frozen);
    if (existing !== null && existing.item_id !== itemId) throw new Error('zotero_object_identity_changed');
    const timestamp = this.now();
    if (existing === null || existing.object_version !== frozen.item.version) {
      this.db.prepare(`INSERT INTO research_zotero_objects
      (server_id,library_kind,library_id,item_key,item_id,object_version,item_hash,imported_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(server_id,library_kind,library_id,item_key) DO UPDATE SET
        object_version=excluded.object_version,item_hash=excluded.item_hash,imported_at=excluded.imported_at`)
        .run(...this.key(frozen), itemId, frozen.item.version, frozen.itemHash, timestamp);
      this.db.prepare(`INSERT INTO research_zotero_object_versions
      (server_id,library_kind,library_id,item_key,object_version,item_id,item_hash,preview_id,item_json,captured_at,imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...this.key(frozen), frozen.item.version, itemId, frozen.itemHash, frozen.previewId, JSON.stringify(frozen.item), frozen.capturedAt, timestamp);
    }
    this.db.prepare(`INSERT INTO research_zotero_import_observations
      (operation_id,server_id,library_kind,library_id,item_key,object_version,library_version,preview_id,captured_at,imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(operationId, ...this.key(frozen), frozen.item.version, frozen.libraryVersion, frozen.previewId, frozen.capturedAt, timestamp);
  }

  read(context: LiteratureExecutionContext, input: unknown): z.infer<typeof zoteroSourcesPageSchema> {
    const request = zoteroSourcesRequestSchema.parse(input);
    const where = `FROM research_zotero_object_versions v JOIN research_zotero_import_observations o
      ON o.server_id=v.server_id AND o.library_kind=v.library_kind AND o.library_id=v.library_id
      AND o.item_key=v.item_key AND o.object_version=v.object_version
      JOIN research_zotero_previews p ON p.id=o.preview_id
      WHERE v.item_id=? AND p.owner=? AND p.project_id IS ?`;
    const parameters = [request.id, context.owner, context.projectId];
    const total = this.db.prepare(`SELECT count(*) ${where}`).pluck().get(...parameters) as number;
    const rows = this.db.prepare(`SELECT v.*,o.operation_id AS import_operation,o.library_version AS observed_library_version,
      o.preview_id AS observation_preview,
      o.captured_at AS observation_captured,o.imported_at AS observation_imported ${where}
      ORDER BY o.imported_at,v.server_id,v.library_kind,v.library_id,v.item_key,v.object_version,o.operation_id LIMIT ? OFFSET ?`)
      .all(...parameters, request.limit, request.offset) as Array<{
        server_id: string; library_kind: 'user' | 'group'; library_id: number; item_key: string;
        object_version: number; item_id: string; item_hash: string; preview_id: string; item_json: string;
        import_operation: string; observed_library_version: number;
        observation_preview: string; observation_captured: string; observation_imported: string
      }>;
    const records = rows.map(row => {
      try {
        const record = zoteroImportedObjectSchema.parse({scope: {serverId: row.server_id,
          library: {kind: row.library_kind, id: row.library_id}}, itemKey: row.item_key, version: row.object_version,
          operationId: row.import_operation, libraryVersion: row.observed_library_version,
          libraryItemId: row.item_id, itemHash: row.item_hash, previewId: row.observation_preview, item: JSON.parse(row.item_json),
          capturedAt: row.observation_captured, importedAt: row.observation_imported});
        if (hash(record.item) !== record.itemHash || record.item.key !== record.itemKey || record.item.version !== record.version) {
          throw new Error('zotero_object_integrity_invalid');
        }
        return record;
      } catch (cause) { throw new Error('zotero_object_storage_invalid', {cause}); }
    });
    return {itemId: request.id, records, total, nextOffset: request.offset + request.limit < total ? request.offset + request.limit : null};
  }

  private key(frozen: ZoteroFrozenObject): [string, string, number, string] {
    return [frozen.scope.serverId, frozen.scope.library.kind, frozen.scope.library.id, frozen.item.key];
  }
}
