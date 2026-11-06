import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {zenodoOperationSchema, zenodoPublicationApprovalSchema, zenodoOperationListSchema,
  zenodoOperationListResultSchema,
  type ZenodoOperation, type ZenodoPublicationApproval, type zenodoStartSchema,
  type zenodoPublicationApproveSchema} from '../../../shared/schemas/research-zenodo-remote';
import type {ZenodoPrepared} from '../../../shared/schemas/research-zenodo';
import {sealZenodo} from './zenodo-preparation';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ZenodoPreparationService} from './zenodo-preparation';

type Row = {id: string; project_id: string; preparation_id: string; request_id: string; revision: number;
  status: ZenodoOperation['status']; snapshot_json: string; created_at: string};
export class ZenodoOperationRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository,
    private readonly preparations: Pick<ZenodoPreparationService, 'get'>,
    private readonly now = () => new Date().toISOString()) {}
  get(projectId: string, id: string): ZenodoOperation {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_zenodo_operations WHERE id=?').get(id) as Row | undefined;
    if (row === undefined) throw new Error('research_zenodo_operation_not_found');
    if (row.project_id !== projectId) throw new Error('research_zenodo_project_mismatch');
    const operation = zenodoOperationSchema.parse(JSON.parse(row.snapshot_json));
    const preparation = this.preparations.get(projectId, row.preparation_id);
    const {contentHash, ...body} = operation;
    if (row.id !== operation.id || row.preparation_id !== operation.preparationId || row.request_id !== operation.request.requestId ||
      operation.request.projectId !== projectId || operation.request.preparationId !== row.preparation_id ||
      operation.projectId !== projectId || row.revision !== operation.revision || row.status !== operation.status ||
      row.created_at !== operation.createdAt || preparation.contentHash !== operation.request.expectedPreparationHash ||
      preparation.request.environment !== operation.environment ||
      operation.marker !== `urn:uuid:${operation.id}` || researchContentHash(JSON.stringify(body)) !== contentHash ||
      (operation.remote !== null && operation.remote.id !== operation.remoteId)) throw new Error('research_zenodo_operation_invalid');
    if (operation.remote !== null) {
      const {contentHash: remoteHash, ...remoteBody} = operation.remote;
      if (researchContentHash(JSON.stringify(remoteBody)) !== remoteHash) throw new Error('research_zenodo_operation_invalid');
    }
    if (operation.approval !== null) {
      const stored = this.approval(projectId, operation.id, operation.approval.id);
      if (stored.contentHash !== operation.approval.contentHash) throw new Error('research_zenodo_operation_invalid');
    }
    return operation;
  }
  find(request: z.infer<typeof zenodoStartSchema>): ZenodoOperation | null {
    const row = this.db.prepare('SELECT id FROM research_zenodo_operations WHERE project_id=? AND (request_id=? OR preparation_id=?)')
      .get(request.projectId, request.requestId, request.preparationId) as {id: string} | undefined;
    if (row === undefined) return null;
    const operation = this.get(request.projectId, row.id);
    if (JSON.stringify(operation.request) !== JSON.stringify(request)) throw new Error('research_zenodo_request_conflict');
    return operation;
  }
  create(request: z.infer<typeof zenodoStartSchema>, preparation: ZenodoPrepared): ZenodoOperation {
    const actor = requireResearchHuman('research.zenodo.start', request.projectId);
    return this.db.transaction(() => {
      const existing = this.find(request); if (existing !== null) return existing;
      const id = randomUUID(), timestamp = this.now();
      const body = zenodoOperationSchema.omit({contentHash: true}).parse({schemaVersion: 1, id, projectId: request.projectId,
        preparationId: preparation.id, request, environment: preparation.request.environment, marker: `urn:uuid:${id}`, actor,
        revision: 1, status: 'creating', remoteId: null, remote: null, approval: null, error: null,
        createdAt: timestamp, updatedAt: timestamp});
      const operation = zenodoOperationSchema.parse(sealZenodo(body));
      this.db.prepare(`INSERT INTO research_zenodo_operations(id,project_id,preparation_id,request_id,revision,status,snapshot_json,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, operation.projectId, operation.preparationId, request.requestId, operation.revision,
      operation.status, JSON.stringify(operation), timestamp);
      return this.get(operation.projectId, id);
    })();
  }
  update(operation: ZenodoOperation, patch: Partial<Pick<ZenodoOperation, 'status' | 'remoteId' | 'remote' | 'approval' | 'error'>>): ZenodoOperation {
    return this.db.transaction(() => {
      const current = this.get(operation.projectId, operation.id);
      if (current.revision !== operation.revision) throw new Error('research_zenodo_operation_changed');
      const {contentHash, ...body} = current;
      const parsed = zenodoOperationSchema.omit({contentHash: true}).parse({...body, ...patch,
        revision: current.revision + 1, updatedAt: this.now()});
      const next = zenodoOperationSchema.parse(sealZenodo(parsed));
      this.db.prepare('UPDATE research_zenodo_operations SET revision=?,status=?,snapshot_json=? WHERE id=? AND revision=?')
        .run(next.revision, next.status, JSON.stringify(next), next.id, current.revision);
      return this.get(next.projectId, next.id);
    })();
  }
  findApproval(request: z.infer<typeof zenodoPublicationApproveSchema>): ZenodoPublicationApproval | null {
    this.research.getProject(request.projectId);
    const row = this.db.prepare('SELECT id FROM research_zenodo_publication_approvals WHERE operation_id=? AND request_id=?')
      .get(request.operationId, request.requestId) as {id: string} | undefined;
    if (row === undefined) return null;
    const previous = this.approval(request.projectId, request.operationId, row.id);
    if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error('research_zenodo_request_conflict');
    return previous;
  }
  approve(request: z.infer<typeof zenodoPublicationApproveSchema>): ZenodoPublicationApproval {
    const actor = requireResearchHuman('research.zenodo.approvePublication', request.projectId);
    return this.db.transaction(() => {
      const operation = this.get(request.projectId, request.operationId);
      const previous = this.findApproval(request);
      if (previous !== null) return previous;
      if (operation.revision !== request.expectedRevision || operation.remote?.contentHash !== request.expectedRemoteHash ||
        operation.request.expectedPreparationHash !== request.expectedPreparationHash || operation.status !== 'ready') {
        throw new Error('research_zenodo_publication_review_changed');
      }
      const body = zenodoPublicationApprovalSchema.omit({contentHash: true}).parse({id: randomUUID(), request, actor, createdAt: this.now()});
      const approval = zenodoPublicationApprovalSchema.parse(sealZenodo(body));
      this.db.prepare(`INSERT INTO research_zenodo_publication_approvals(id,project_id,operation_id,request_id,snapshot_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(approval.id, request.projectId, operation.id, request.requestId, JSON.stringify(approval), approval.createdAt);
      this.update(operation, {approval});
      return this.approval(request.projectId, operation.id, approval.id);
    })();
  }
  approval(projectId: string, operationId: string, approvalId: string): ZenodoPublicationApproval {
    const row = this.db.prepare('SELECT * FROM research_zenodo_publication_approvals WHERE id=?').get(approvalId) as
      {id: string; project_id: string; operation_id: string; request_id: string; snapshot_json: string; created_at: string} | undefined;
    if (row === undefined) throw new Error('research_zenodo_publication_approval_required');
    const result = zenodoPublicationApprovalSchema.parse(JSON.parse(row.snapshot_json)), {contentHash, ...body} = result;
    if (row.id !== result.id || row.project_id !== projectId || row.operation_id !== operationId ||
      result.request.projectId !== projectId || result.request.operationId !== operationId || result.request.requestId !== row.request_id ||
      result.createdAt !== row.created_at ||
      researchContentHash(JSON.stringify(body)) !== contentHash) throw new Error('research_zenodo_publication_approval_invalid');
    return result;
  }
  list(input: z.infer<typeof zenodoOperationListSchema>): z.infer<typeof zenodoOperationListResultSchema> {
    const request = zenodoOperationListSchema.parse(input); this.research.getProject(request.projectId);
    const total = this.db.prepare('SELECT count(*) FROM research_zenodo_operations WHERE project_id=?').pluck().get(request.projectId) as number;
    const rows = this.db.prepare('SELECT id FROM research_zenodo_operations WHERE project_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(request.projectId, request.limit, request.offset) as {id: string}[];
    return {records: rows.map(row => this.get(request.projectId, row.id)), total,
      nextOffset: request.offset + rows.length < total ? request.offset + rows.length : null};
  }
  recover(): void {
    const rows = this.db.prepare("SELECT id,project_id FROM research_zenodo_operations WHERE status IN ('creating','uploading','publish_requested')")
      .all() as {id: string; project_id: string}[];
    for (const row of rows) {
      const record = this.get(row.project_id, row.id);
      this.update(record, {status: record.status === 'creating' ? 'create_unknown' : record.status === 'uploading' ?
        'upload_unknown' : 'publish_unknown', error: 'research_zenodo_interrupted'});
    }
  }
}
