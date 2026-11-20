import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  notebookLimits, researchNotebookFileRequestSchema, researchNotebookImportRequestSchema,
  researchNotebookGetRequestSchema, researchNotebookListRequestSchema, researchNotebookSnapshotSchema,
  researchNotebookReceiptSchema,
  type ResearchNotebookFileRequest, type ResearchNotebookImportRequest, type ResearchNotebookGetRequest,
  type ResearchNotebookListRequest, type ResearchNotebookReceipt, type ResearchNotebookImported,
  type ResearchNotebookPreview, type ResearchNotebook
} from '../../../shared/schemas/research-notebooks';
import { requireResearchHuman } from '../../services/research-human-context';
import type { ResearchRepository } from './repository';
import { readResearchFile, researchRelativePath, researchWorkspace, researchContentHash } from './research-files';
import { parseResearchNotebook } from './notebook-parser';

type Row = {
  id: string; project_id: string; request_id: string; snapshot_json: string; snapshot_hash: string;
  source_bytes: Buffer; created_at: string;
};
type ReceiptRow = Omit<Row, 'source_bytes'>;
const receiptColumns = 'id,project_id,request_id,snapshot_json,snapshot_hash,created_at';
const excluded = new Set(['.roc-research', '.roc-build', '.git', '.venv', 'node_modules', '__MACOSX']);

export class ResearchNotebookRepository {
  constructor(private readonly db: Database, private readonly repository: ResearchRepository,
    private readonly now: () => string) {}

  async preview(input: ResearchNotebookFileRequest): Promise<ResearchNotebookPreview> {
    const request = researchNotebookFileRequestSchema.parse(input);
    return (await this.readFile(request)).preview;
  }

  async import(input: ResearchNotebookImportRequest): Promise<ResearchNotebookImported> {
    const request = researchNotebookImportRequestSchema.parse(input);
    const actor = requireResearchHuman('research.notebooks.import', request.projectId);
    this.repository.getProject(request.projectId);
    const existing = this.findRequest(request.projectId, request.requestId);
    if (existing !== null) return this.replay(existing, request, actor.id);
    this.requireWritable(request.projectId);
    const { root, workspacePath, bytes, preview } = await this.readFile(request);
    if (preview.sha256 !== request.expectedSha256) throw new Error('research_notebook_source_changed');
    return this.db.transaction(() => {
      this.requireWritable(request.projectId);
      if (this.repository.getProject(request.projectId).workspacePath !== workspacePath) {
        throw new Error('research_notebook_workspace_changed');
      }
      const repeated = this.findRequest(request.projectId, request.requestId);
      if (repeated !== null) return this.replay(repeated, request, actor.id);
      const snapshot = researchNotebookSnapshotSchema.parse({
        schemaVersion: 1, id: `notebook_${randomUUID()}`, request, actor,
        workspacePath: root, sha256: preview.sha256, size: bytes.byteLength, recordedAt: this.now()
      });
      const json = JSON.stringify(snapshot), digest = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_notebooks
        (id,project_id,request_id,snapshot_json,snapshot_hash,source_bytes,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(snapshot.id, request.projectId, request.requestId, json, digest, bytes, snapshot.recordedAt);
      return this.get({ projectId: request.projectId, notebookId: snapshot.id, expectedHash: digest });
    })();
  }

  get(input: ResearchNotebookGetRequest): ResearchNotebookImported {
    const { receipt, preview } = this.source(input);
    return { receipt, preview };
  }

  /** Host-only full source. Callers must bind the exact imported receipt. */
  source(input: ResearchNotebookGetRequest): {
    receipt: ResearchNotebookReceipt; preview: ResearchNotebookPreview; notebook: ResearchNotebook; bytes: Buffer;
  } {
    const request = researchNotebookGetRequestSchema.parse(input);
    this.repository.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_notebooks WHERE id=?').get(request.notebookId) as Row | undefined;
    if (row === undefined) throw new Error('research_notebook_not_found');
    if (row.project_id !== request.projectId) throw new Error('research_notebook_project_mismatch');
    const receipt = this.inspectReceipt(row);
    if (receipt.snapshotHash !== request.expectedHash) throw new Error('research_notebook_hash_mismatch');
    const parsed = parseResearchNotebook(row.source_bytes);
    if (parsed.preview.sha256 !== receipt.snapshot.sha256 || parsed.preview.size !== receipt.snapshot.size) {
      throw new Error('research_notebook_bytes_invalid');
    }
    return { receipt, ...parsed, bytes: row.source_bytes };
  }

  list(input: ResearchNotebookListRequest): { items: ResearchNotebookReceipt[]; total: number } {
    const request = researchNotebookListRequestSchema.parse(input);
    this.repository.getProject(request.projectId);
    const rows = this.db.prepare(`SELECT ${receiptColumns} FROM research_notebooks
      WHERE project_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(request.projectId, request.limit, request.offset) as ReceiptRow[];
    const total = this.db.prepare('SELECT count(*) FROM research_notebooks WHERE project_id=?').pluck().get(request.projectId) as number;
    return { items: rows.map(row => this.inspectReceipt(row)), total };
  }

  private async readFile(request: ResearchNotebookFileRequest): Promise<{
    root: string; workspacePath: string; bytes: Buffer; preview: ResearchNotebookPreview;
  }> {
    const workspacePath = this.repository.getProject(request.projectId).workspacePath;
    const root = await researchWorkspace(workspacePath);
    if (workspacePath === null) throw new Error('research_project_workspace_required');
    if (researchRelativePath(request.path).split('/').some(part => excluded.has(part))) {
      throw new Error('research_notebook_path_excluded');
    }
    const bytes = await readResearchFile(root, request.path, notebookLimits.bytes);
    return { root, workspacePath, bytes, preview: parseResearchNotebook(bytes).preview };
  }

  private findRequest(projectId: string, requestId: string): ReceiptRow | null {
    return (this.db.prepare(`SELECT ${receiptColumns} FROM research_notebooks WHERE project_id=? AND request_id=?`)
      .get(projectId, requestId) as ReceiptRow | undefined) ?? null;
  }
  private replay(row: ReceiptRow, request: ResearchNotebookImportRequest, actorId: string): ResearchNotebookImported {
    const receipt = this.inspectReceipt(row);
    if (JSON.stringify(receipt.snapshot.request) !== JSON.stringify(request) || receipt.snapshot.actor.id !== actorId) {
      throw new Error('research_notebook_request_conflict');
    }
    return this.get({ projectId: request.projectId, notebookId: receipt.snapshot.id, expectedHash: receipt.snapshotHash });
  }
  private inspectReceipt(row: ReceiptRow): ResearchNotebookReceipt {
    const snapshot = researchNotebookSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
      snapshot.id !== row.id || snapshot.request.projectId !== row.project_id || snapshot.request.requestId !== row.request_id ||
      snapshot.sha256 !== snapshot.request.expectedSha256 || snapshot.recordedAt !== row.created_at) {
      throw new Error('research_notebook_snapshot_invalid');
    }
    researchRelativePath(snapshot.request.path);
    return researchNotebookReceiptSchema.parse({ snapshot, snapshotHash: row.snapshot_hash });
  }
  private requireWritable(projectId: string): void {
    if (this.repository.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
}
