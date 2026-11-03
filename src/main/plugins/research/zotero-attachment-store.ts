import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access, lstat, realpath} from 'node:fs/promises';
import {extname, isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import {zoteroAttachmentBodySchema, zoteroAttachmentInspectionSchema, zoteroAttachmentRequestSchema,
  type ZoteroAttachmentFile, type ZoteroAttachmentInspection} from '../../../shared/schemas/research-zotero-attachment';
import {documentMediaTypes, maximumDocumentBytes} from './document-files';
import type {LiteratureExecutionContext} from '../../services/literature-context';
import type {ZoteroObjectStore} from './zotero-object-store';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const zoteroAttachmentLinkModeSchema = z.enum(['imported_file', 'imported_url', 'linked_file', 'linked_url', 'embedded_image']);

/** Inspect metadata only. A Zotero path is a reference, never permission to open its bytes. */
export async function inspectZoteroAttachmentFile(referencePath: string): Promise<ZoteroAttachmentFile> {
  let resolvedPath: string | null = null;
  if (!isAbsolute(referencePath)) return {status: 'invalid', referencePath, resolvedPath, errorCode: 'zotero_attachment_path_invalid'};
  try {
    const info = await lstat(referencePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return {status: 'invalid', referencePath, resolvedPath, errorCode: 'zotero_attachment_file_required'};
    }
    resolvedPath = await realpath(referencePath);
    await access(resolvedPath, constants.R_OK);
    if (documentMediaTypes[extname(resolvedPath).toLowerCase()] === undefined || info.size > maximumDocumentBytes) {
      return {status: 'unsupported_format', referencePath, resolvedPath, errorCode: 'zotero_attachment_document_unsupported'};
    }
    const current = await lstat(resolvedPath);
    if (!current.isFile() || current.isSymbolicLink() || info.dev !== current.dev || info.ino !== current.ino ||
      info.size !== current.size || info.mtimeMs !== current.mtimeMs || info.ctimeMs !== current.ctimeMs) {
      throw new Error('zotero_attachment_changed_during_inspection');
    }
    return {status: 'ready', referencePath, resolvedPath,
      identity: {device: current.dev, inode: current.ino, size: current.size, modifiedMs: current.mtimeMs, changedMs: current.ctimeMs}};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {status: 'missing', referencePath, resolvedPath, errorCode: code};
    if (code === 'EACCES' || code === 'EPERM') return {status: 'denied', referencePath, resolvedPath, errorCode: code};
    throw error;
  }
}

export class ZoteroAttachmentStore {
  constructor(private readonly db: Database, private readonly objects: ZoteroObjectStore, private readonly now: () => string) {}

  record(context: LiteratureExecutionContext, input: unknown,
    observation: Pick<ZoteroAttachmentInspection, 'remote' | 'linkMode' | 'file'>): ZoteroAttachmentInspection {
    const source = zoteroAttachmentRequestSchema.parse(input);
    const {attachmentKey: _attachment, ...parent} = source;
    const original = this.objects.imported(context, {...parent, collectionKey: null});
    const body = zoteroAttachmentBodySchema.parse({inspectionId: `zotero_attachment_${randomUUID()}`, source,
      libraryItemId: original.libraryItemId, importedObjectVersion: original.version, ...observation, recordedAt: this.now()});
    const state = {...body, contentHash: hash(body)};
    this.db.prepare(`INSERT INTO research_zotero_attachment_inspections
      (id,owner,scope_project,operation_id,server_id,library_kind,library_id,item_key,attachment_key,inspection_json,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(state.inspectionId, context.owner, context.projectId ?? '', source.operationId,
      source.serverId, source.library.kind, source.library.id, source.itemKey, source.attachmentKey, JSON.stringify(state), state.recordedAt);
    return state;
  }

  read(context: LiteratureExecutionContext, inspectionId: string): ZoteroAttachmentInspection {
    const row = this.db.prepare(`SELECT id,inspection_json FROM research_zotero_attachment_inspections
      WHERE id=? AND owner=? AND scope_project=?`).get(inspectionId, context.owner, context.projectId ?? '') as
      {id: string; inspection_json: string} | undefined;
    if (row === undefined) throw new Error('zotero_attachment_inspection_not_found');
    try {
      const state = zoteroAttachmentInspectionSchema.parse(JSON.parse(row.inspection_json));
      const {attachmentKey: _attachment, ...source} = state.source;
      const original = this.objects.imported(context, {...source, collectionKey: null});
      const {contentHash, ...body} = state;
      if (row.id !== state.inspectionId || hash(body) !== contentHash || state.libraryItemId !== original.libraryItemId ||
        state.importedObjectVersion !== original.version || !isDeepStrictEqual(state.remote.scope, original.scope) ||
        (state.remote.status !== 'not_found' && (state.remote.item.key !== state.source.attachmentKey ||
          state.remote.item.data.itemType !== 'attachment' || state.remote.item.data.parentItem !== original.itemKey))) {
        throw new Error('zotero_attachment_inspection_integrity_invalid');
      }
      return state;
    } catch (cause) {throw new Error('zotero_attachment_inspection_storage_invalid', {cause});}
  }
}
