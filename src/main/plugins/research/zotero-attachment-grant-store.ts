import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from 'better-sqlite3';
import {zoteroAttachmentGrantBodySchema, zoteroAttachmentGrantSchema,
  type ZoteroAttachmentGrant, type ZoteroAttachmentInspection} from '../../../shared/schemas/research-zotero-attachment';
import type {LiteratureExecutionContext} from '../../services/literature-context';
import type {ZoteroAttachmentStore} from './zotero-attachment-store';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type ZoteroAttachmentPicker = (context: LiteratureExecutionContext, path: string, signal: AbortSignal) => Promise<string | null>;

export class ZoteroAttachmentGrantStore {
  constructor(private readonly db: Database, private readonly inspections: ZoteroAttachmentStore, private readonly now: () => string) {}

  find(context: LiteratureExecutionContext, requestId: string): ZoteroAttachmentGrant | null {
    const row = this.db.prepare('SELECT id FROM research_zotero_attachment_grants WHERE owner=? AND scope_project=? AND request_id=?')
      .get(context.owner, context.projectId ?? '', requestId) as {id: string} | undefined;
    return row === undefined ? null : this.read(context, row.id);
  }

  record(context: LiteratureExecutionContext, requestId: string, inspection: ZoteroAttachmentInspection): ZoteroAttachmentGrant {
    if (inspection.file.status !== 'ready') throw new Error('zotero_attachment_file_not_ready');
    const body = zoteroAttachmentGrantBodySchema.parse({grantId: `zotero_grant_${randomUUID()}`, inspectionId: inspection.inspectionId,
      requestId, permission: 'read_one_file', selectedPath: inspection.file.resolvedPath, identity: inspection.file.identity,
      inspectionHash: inspection.contentHash, grantedAt: this.now()});
    const grant = {...body, contentHash: hash(body)};
    this.db.prepare(`INSERT INTO research_zotero_attachment_grants
      (id,owner,scope_project,request_id,inspection_id,grant_json,granted_at) VALUES (?,?,?,?,?,?,?)`)
      .run(grant.grantId, context.owner, context.projectId ?? '', requestId, inspection.inspectionId, JSON.stringify(grant), grant.grantedAt);
    return grant;
  }

  read(context: LiteratureExecutionContext, grantId: string): ZoteroAttachmentGrant {
    const row = this.db.prepare('SELECT id,request_id,inspection_id,grant_json FROM research_zotero_attachment_grants WHERE id=? AND owner=? AND scope_project=?')
      .get(grantId, context.owner, context.projectId ?? '') as {id: string; request_id: string; inspection_id: string; grant_json: string} | undefined;
    if (row === undefined) throw new Error('zotero_attachment_grant_not_found');
    try {
      const grant = zoteroAttachmentGrantSchema.parse(JSON.parse(row.grant_json));
      const inspection = this.inspections.read(context, row.inspection_id);
      const {contentHash, ...body} = grant;
      if (grant.grantId !== row.id || grant.inspectionId !== row.inspection_id || grant.requestId !== row.request_id ||
        hash(body) !== contentHash || inspection.contentHash !== grant.inspectionHash || inspection.file.status !== 'ready' ||
        grant.selectedPath !== inspection.file.resolvedPath || !isDeepStrictEqual(grant.identity, inspection.file.identity)) {
        throw new Error('zotero_attachment_grant_integrity_invalid');
      }
      return grant;
    } catch (cause) {throw new Error('zotero_attachment_grant_storage_invalid', {cause});}
  }
}
