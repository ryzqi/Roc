import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from 'better-sqlite3';
import {zoteroAttachmentImportBodySchema, zoteroAttachmentImportSchema,
  type ZoteroAttachmentImport, type ZoteroAttachmentGrant, type ZoteroAttachmentInspection} from '../../../shared/schemas/research-zotero-attachment';
import type {ResearchDocument} from './document-repository';
import type {LiteratureExecutionContext} from '../../services/literature-context';
import type {ZoteroAttachmentGrantStore} from './zotero-attachment-grant-store';
import type {ZoteroAttachmentStore} from './zotero-attachment-store';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ZoteroAttachmentImportStore {
  constructor(private readonly db: Database, private readonly grants: ZoteroAttachmentGrantStore,
    private readonly inspections: ZoteroAttachmentStore, private readonly now: () => string) {}
  record(context: LiteratureExecutionContext, requestId: string, grant: ZoteroAttachmentGrant,
    inspection: ZoteroAttachmentInspection, destinationProjectId: string | null, document: ResearchDocument): ZoteroAttachmentImport {
    const body = zoteroAttachmentImportBodySchema.parse({operationId: `zotero_attachment_import_${randomUUID()}`, requestId,
      grantId: grant.grantId, grantHash: grant.contentHash, inspectionId: inspection.inspectionId, source: inspection.source,
      libraryItemId: inspection.libraryItemId, destinationProjectId, document, importedAt: this.now()});
    const result = {...body, contentHash: hash(body)};
    this.db.prepare(`INSERT INTO research_zotero_attachment_imports
      (id,owner,scope_project,request_id,grant_id,document_id,receipt_json,imported_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(result.operationId, context.owner, context.projectId ?? '', requestId, grant.grantId, document.id, JSON.stringify(result), result.importedAt);
    return result;
  }
  find(context: LiteratureExecutionContext, requestId: string): ZoteroAttachmentImport | null {
    const row = this.db.prepare(`SELECT id,grant_id,document_id,receipt_json FROM research_zotero_attachment_imports
      WHERE owner=? AND scope_project=? AND request_id=?`).get(context.owner, context.projectId ?? '', requestId) as
      {id: string; grant_id: string; document_id: string; receipt_json: string} | undefined;
    if (row === undefined) return null;
    try {
      const result = zoteroAttachmentImportSchema.parse(JSON.parse(row.receipt_json));
      const {contentHash, ...body} = result;
      const grant = this.grants.read(context, row.grant_id), inspection = this.inspections.read(context, grant.inspectionId);
      const document = this.db.prepare('SELECT library_item_id,source_hash,size FROM research_documents WHERE id=?').get(row.document_id) as
        {library_item_id: string; source_hash: string; size: number} | undefined;
      if (result.operationId !== row.id || result.requestId !== requestId || hash(body) !== contentHash ||
        result.grantId !== row.grant_id || result.grantHash !== grant.contentHash || result.inspectionId !== grant.inspectionId ||
        result.document.id !== row.document_id || result.libraryItemId !== inspection.libraryItemId ||
        !isDeepStrictEqual(result.source, inspection.source) || document === undefined ||
        grant.identity.size !== result.document.size ||
        document.library_item_id !== result.libraryItemId || result.document.libraryItemId !== result.libraryItemId ||
        document.source_hash !== result.document.sourceHash || document.size !== result.document.size) throw new Error('zotero_attachment_import_integrity_invalid');
      return result;
    } catch (cause) {throw new Error('zotero_attachment_import_storage_invalid', {cause});}
  }
}
