import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {zenodoInputsRequestSchema, zenodoInputsSchema, zenodoListSchema, zenodoListResultSchema, zenodoPrepareSchema, zenodoPreparedSchema,
  type ZenodoInputsRequest, type ZenodoInputs, type ZenodoPrepare, type ZenodoPrepared} from '../../../shared/schemas/research-zenodo';
import type {z} from 'zod';
import type {ResearchRepository} from './repository';
import type {ResearchExportService} from './export-service';
import {researchContentHash} from './research-files';
import {requireResearchHuman} from '../../services/research-human-context';

export function sealZenodo<T extends object>(value: T): T & {contentHash: string} {
  return {...value, contentHash: researchContentHash(JSON.stringify(value))};
}
export class ZenodoPreparationService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository,
    private readonly exports: Pick<ResearchExportService, 'publicationInputs'>, private readonly now = () => new Date().toISOString()) {}

  async inputs(input: ZenodoInputsRequest): Promise<ZenodoInputs> {
    const request = zenodoInputsRequestSchema.parse(input);
    return zenodoInputsSchema.parse(await this.exports.publicationInputs(request));
  }

  async prepare(input: ZenodoPrepare): Promise<ZenodoPrepared> {
    const request = zenodoPrepareSchema.parse(input);
    const actor = requireResearchHuman('research.zenodo.prepare', request.projectId);
    this.writable(request.projectId);
    const previous = this.findRequest(request);
    if (previous !== null) return previous;
    const inputs = await this.inputs({projectId: request.projectId, exportId: request.exportId, files: request.files});
    if (inputs.contentHash !== request.expectedInputsHash) throw new Error('research_zenodo_inputs_changed');
    return this.db.transaction(() => {
      this.writable(request.projectId);
      const existing = this.findRequest(request);
      if (existing !== null) return existing;
      const current = this.research.exports.get(request.projectId, request.exportId);
      if (researchContentHash(JSON.stringify(current)) !== inputs.exportHash) throw new Error('research_zenodo_inputs_changed');
      const receipt = zenodoPreparedSchema.parse(sealZenodo({schemaVersion: 1, id: `zenodo_${randomUUID()}`,
        projectId: request.projectId, request, inputs, actor, createdAt: this.now()}));
      this.db.prepare(`INSERT INTO research_zenodo_preparations(id,project_id,request_id,snapshot_json,created_at)
        VALUES(?,?,?,?,?)`).run(receipt.id, receipt.projectId, request.requestId, JSON.stringify(receipt), receipt.createdAt);
      return this.get(receipt.projectId, receipt.id);
    })();
  }

  get(projectId: string, id: string): ZenodoPrepared {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_zenodo_preparations WHERE id=?').get(id) as
      {id: string; project_id: string; request_id: string; snapshot_json: string; created_at: string} | undefined;
    if (row === undefined) throw new Error('research_zenodo_preparation_not_found');
    if (row.project_id !== projectId) throw new Error('research_zenodo_project_mismatch');
    const receipt = zenodoPreparedSchema.parse(JSON.parse(row.snapshot_json));
    const {contentHash, ...body} = receipt;
    const {contentHash: inputsHash, ...inputsBody} = receipt.inputs;
    if (receipt.id !== row.id || receipt.projectId !== row.project_id || receipt.request.projectId !== projectId ||
      receipt.inputs.projectId !== projectId || receipt.request.exportId !== receipt.inputs.exportId ||
      JSON.stringify(receipt.request.files) !== JSON.stringify(receipt.inputs.files.map(({area, path, name}) => ({area, path, name}))) ||
      receipt.request.requestId !== row.request_id || receipt.createdAt !== row.created_at ||
      receipt.request.expectedInputsHash !== inputsHash || sealZenodo(body).contentHash !== contentHash ||
      sealZenodo(inputsBody).contentHash !== inputsHash) throw new Error('research_zenodo_receipt_invalid');
    return receipt;
  }

  list(input: {projectId: string; offset: number; limit: number}): z.infer<typeof zenodoListResultSchema> {
    const request = zenodoListSchema.parse(input);
    this.research.getProject(request.projectId);
    const total = this.db.prepare('SELECT COUNT(*) FROM research_zenodo_preparations WHERE project_id=?').pluck().get(request.projectId) as number;
    const rows = this.db.prepare(`SELECT id FROM research_zenodo_preparations WHERE project_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(request.projectId, request.limit, request.offset) as {id: string}[];
    return {records: rows.map(row => this.get(request.projectId, row.id)), total,
      nextOffset: request.offset + rows.length < total ? request.offset + rows.length : null};
  }

  async assertCurrent(receipt: ZenodoPrepared): Promise<void> {
    const stored = this.get(receipt.projectId, receipt.id);
    if (stored.contentHash !== receipt.contentHash) throw new Error('research_zenodo_receipt_invalid');
    this.writable(receipt.projectId);
    const current = await this.inputs({projectId: receipt.projectId, exportId: receipt.request.exportId, files: receipt.request.files});
    if (current.contentHash !== receipt.inputs.contentHash) throw new Error('research_zenodo_inputs_changed');
  }

  private findRequest(request: ZenodoPrepare): ZenodoPrepared | null {
    const row = this.db.prepare('SELECT id FROM research_zenodo_preparations WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as {id: string} | undefined;
    if (row === undefined) return null;
    const receipt = this.get(request.projectId, row.id);
    if (JSON.stringify(receipt.request) !== JSON.stringify(request)) throw new Error('research_zenodo_request_conflict');
    return receipt;
  }
  private writable(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
}
