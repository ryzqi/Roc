import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {
  hfDownloadStartSchema, hfDownloadReceiptSchema, hfDownloadHistorySchema,
  type HfDownloadStart, type HfDownloadReceipt, type hfDownloadHistoryResultSchema
} from '../../../shared/schemas/research-huggingface-downloads';
import {requireResearchHuman} from '../../services/research-human-context';
import {resourceContentHash} from './resource-repository';
import {HuggingFaceRepository, huggingFaceSummary} from './huggingface-repository';

type Row = {
  id: string; project_id: string; request_id: string; observation_id: string; authorization_json: string;
  revision: number; state: string; snapshot_json: string
};
function authorization(value: HfDownloadReceipt): string {
  return JSON.stringify({id: value.id, projectId: value.projectId, request: value.request,
    observation: value.observation, selectedFiles: value.selectedFiles, actor: value.actor,
    authorization: value.authorization, createdAt: value.createdAt});
}
function seal(value: HfDownloadReceipt): HfDownloadReceipt {
  const parsed = hfDownloadReceiptSchema.parse(value);
  const {contentHash: _hash, ...body} = parsed;
  return {...parsed, contentHash: resourceContentHash(body)};
}

export class HuggingFaceDownloadRepository {
  constructor(private readonly db: Database, private readonly observations: HuggingFaceRepository,
    private readonly now: () => string = () => new Date().toISOString()) {}

  findRequest(request: HfDownloadStart): HfDownloadReceipt | null {
    this.observations.requireReadScope(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_hf_downloads WHERE project_id=? AND request_id=?')
      .get(request.projectId, request.requestId) as Row | undefined;
    if (row === undefined) return null;
    const saved = this.parse(row);
    if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw new Error('research_hf_download_request_conflict');
    return saved;
  }

  create(input: HfDownloadStart): {created: boolean; receipt: HfDownloadReceipt} {
    const request = hfDownloadStartSchema.parse(input);
    const actor = requireResearchHuman('research.huggingfaceDownloads.start', request.projectId);
    return this.db.transaction(() => {
      const replay = this.findRequest(request);
      if (replay !== null) return {created: false, receipt: replay};
      this.observations.requireCaptureScope(request.projectId);
      const observed = this.observations.get(request.projectId, request.observationId);
      if (observed.status !== 'ok' || observed.contentHash !== request.expectedContentHash) throw new Error('research_hf_download_source_changed');
      if (observed.metadata.private !== false || observed.metadata.gated !== false || observed.metadata.disabled === true) {
        throw new Error('research_hf_download_access_restricted');
      }
      const selectedFiles = request.paths.map(path => {
        const file = observed.metadata.files.find(file => file.path === path);
        if (file === undefined) throw new Error('research_hf_download_file_missing');
        return file;
      });
      if (selectedFiles.some(file => file.size > 256 * 1024 * 1024) ||
        selectedFiles.reduce((sum, file) => sum + file.size, 0) > request.maxBytes) throw new Error('research_hf_download_byte_limit');
      const timestamp = this.now();
      const receipt = seal({
        id: `hfdownload_${randomUUID()}`, projectId: request.projectId, request, observation: huggingFaceSummary(observed), selectedFiles,
        authorization: 'human_reviewed_download', actor, state: 'running', revision: 1,
        createdAt: timestamp, updatedAt: timestamp, finishedAt: null, errorCode: null,
        lastRecordedTransferredBytes: 0, verifiedBytes: 0, files: [], requests: [], contentHash: '0'.repeat(64)
      });
      this.db.prepare(`INSERT INTO research_hf_downloads
        (id,project_id,request_id,observation_id,authorization_json,revision,state,snapshot_json) VALUES (?,?,?,?,?,?,?,?)`)
        .run(receipt.id, receipt.projectId, request.requestId, request.observationId, authorization(receipt), 1, 'running', JSON.stringify(receipt));
      this.observations.requireCaptureScope(request.projectId);
      if (this.observations.get(request.projectId, request.observationId).contentHash !== request.expectedContentHash) {
        throw new Error('research_hf_download_source_changed');
      }
      this.get(receipt.projectId, receipt.id);
      return {created: true, receipt};
    })();
  }

  get(projectId: string, downloadId: string): HfDownloadReceipt {
    this.observations.requireReadScope(projectId);
    const row = this.db.prepare('SELECT * FROM research_hf_downloads WHERE project_id=? AND id=?')
      .get(projectId, downloadId) as Row | undefined;
    if (row === undefined) throw new Error('research_hf_download_not_found');
    return this.parse(row);
  }

  update(receipt: HfDownloadReceipt): HfDownloadReceipt {
    return this.db.transaction(() => {
      const current = this.get(receipt.projectId, receipt.id);
      if (current.state !== 'running' || current.revision !== receipt.revision || authorization(current) !== authorization(receipt)) {
        throw new Error('research_hf_download_state_conflict');
      }
      if (receipt.lastRecordedTransferredBytes < current.lastRecordedTransferredBytes ||
        receipt.files.length < current.files.length || receipt.requests.length < current.requests.length ||
        current.files.some((file, index) => JSON.stringify(file) !== JSON.stringify(receipt.files[index]))) {
        throw new Error('research_hf_download_state_conflict');
      }
      const next = seal({...receipt, revision: current.revision + 1, updatedAt: this.now()});
      this.validate(next);
      const changed = this.db.prepare('UPDATE research_hf_downloads SET revision=?,state=?,snapshot_json=? WHERE id=? AND project_id=? AND revision=?')
        .run(next.revision, next.state, JSON.stringify(next), next.id, next.projectId, current.revision);
      if (changed.changes !== 1) throw new Error('research_hf_download_state_conflict');
      this.get(next.projectId, next.id);
      return next;
    })();
  }

  history(input: z.infer<typeof hfDownloadHistorySchema>): z.infer<typeof hfDownloadHistoryResultSchema> {
    const request = hfDownloadHistorySchema.parse(input);
    this.observations.requireReadScope(request.projectId);
    if (request.observationId !== null) this.observations.get(request.projectId, request.observationId);
    const where = request.observationId === null ? 'project_id=?' : 'project_id=? AND observation_id=?';
    const args = request.observationId === null ? [request.projectId] : [request.projectId, request.observationId];
    const total = this.db.prepare(`SELECT COUNT(*) FROM research_hf_downloads WHERE ${where}`).pluck().get(...args) as number;
    const records = (this.db.prepare(`SELECT * FROM research_hf_downloads WHERE ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, request.limit, request.offset) as Row[]).map(row => this.parse(row));
    return {records, total, nextOffset: request.offset + records.length < total ? request.offset + records.length : null};
  }

  running(): HfDownloadReceipt[] {
    return (this.db.prepare("SELECT * FROM research_hf_downloads WHERE state='running'").all() as Row[]).map(row => this.parse(row));
  }

  recoverInterrupted(): void {
    this.db.transaction(() => {
      for (const current of this.running()) {
        this.update({...current, state: 'interrupted', errorCode: 'research_hf_download_interrupted', finishedAt: this.now()});
      }
    })();
  }

  private parse(row: Row): HfDownloadReceipt {
    const value = hfDownloadReceiptSchema.parse(JSON.parse(row.snapshot_json));
    const {contentHash, ...body} = value;
    if (contentHash !== resourceContentHash(body) || value.id !== row.id || value.projectId !== row.project_id ||
      value.request.requestId !== row.request_id || value.request.observationId !== row.observation_id ||
      value.state !== row.state || value.revision !== row.revision || authorization(value) !== row.authorization_json) {
      throw new Error('research_hf_download_snapshot_invalid');
    }
    this.validate(value);
    return value;
  }

  private validate(value: HfDownloadReceipt): void {
    const request = value.request;
    if (value.projectId !== request.projectId || value.observation.projectId !== value.projectId ||
      value.observation.id !== request.observationId || value.observation.contentHash !== request.expectedContentHash ||
      value.observation.status !== 'ok' || value.observation.metadata === null ||
      value.observation.metadata.private !== false || value.observation.metadata.gated !== false ||
      value.observation.metadata.disabled === true ||
      value.selectedFiles.length !== request.paths.length || value.selectedFiles.some((file, index) => file.path !== request.paths[index]) ||
      value.selectedFiles.some(file => file.size > 256 * 1024 * 1024) ||
      value.selectedFiles.reduce((sum, file) => sum + file.size, 0) > request.maxBytes ||
      value.lastRecordedTransferredBytes < value.verifiedBytes ||
      value.files.length > value.selectedFiles.length ||
      value.verifiedBytes !== value.files.reduce((sum, file) => sum + file.source.size, 0) ||
      value.files.some((file, index) => file.storageName !== `file-${index}` ||
        JSON.stringify(file.source) !== JSON.stringify(value.selectedFiles[index]) ||
        file.source.lfs !== null && file.sha256 !== file.source.lfs.sha256) ||
      (value.state === 'running') !== (value.finishedAt === null) ||
      (value.state === 'running' || value.state === 'completed') !== (value.errorCode === null) ||
      value.requests.some(receipt => !request.paths.includes(receipt.filePath) ||
        !/^(huggingface\.co|[a-z0-9.-]+\.huggingface\.co|[a-z0-9.-]+\.hf\.co|[a-z0-9.-]+\.xethub\.hf\.co)$/u.test(receipt.host)) ||
      value.state === 'completed' && (value.files.length !== value.selectedFiles.length ||
        value.lastRecordedTransferredBytes !== value.verifiedBytes)) throw new Error('research_hf_download_snapshot_invalid');
  }
}
