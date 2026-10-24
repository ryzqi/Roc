import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import {
  defaultResearchIndexOptions, researchIndexedFileSchema, researchIndexedSourceSchema, researchIndexJobSchema,
  researchIndexOptionsSchema, researchIndexSettingsSchema, researchIndexStatusSchema
} from '../../../shared/schemas/research-index';
import type { ResearchRepository } from './repository';
import type { ResearchEmbeddingReceipt } from './embedding-service';
import type { IndexFileKind, ScannedIndexFile } from './index-files';

type Options = z.infer<typeof researchIndexOptionsSchema>;
type ScopeRow = { project_id: string; options_json: string; revision: number; generation: number; workspace_path: string | null;
  root_path: string | null; archived: number; phase: string; error: string | null; scan_id: string | null; last_scan_at: string | null; embedding_key: string;
  scan_requested: number; scan_force: number; active_scan_force: number };
type FileRow = { id: string; project_id: string; path: string; kind: string; size: number; signature: string; status: string;
  source_hash: string | null; indexed_hash: string | null; indexed_chunks: number; parser_key: string | null; embedding_key: string;
  payload_json: string | null; error: string | null; active_job_id: string | null; force_needed: number; updated_at: string };
type JobRow = { id: string; project_id: string; file_id: string; path: string; generation: number; status: string; error: string | null;
  snapshot_json: string; created_at: string; started_at: string | null; finished_at: string | null };
const jobInputSchema = z.object({ path: z.string(), kind: researchIndexedFileSchema.shape.kind, size: z.number().int().nonnegative(), signature: z.string(),
  root: z.string(), force: z.boolean(), parserKey: z.string().min(1), embeddingConfigId: z.string().nullable(),
  embedding: z.object({ configId: z.string(), revision: z.number().int().positive() }).strict().nullable() }).strict();
export type IndexJob = z.infer<typeof researchIndexJobSchema> & { input: z.infer<typeof jobInputSchema> };
const indexPayloadSchema = z.object({ content: z.string(), chunks: z.array(z.object({ content: z.string().min(1), locator: z.string().min(1) }).strict()),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), parserKey: z.string().min(1), parserVersion: z.string().min(1),
  // 解析工件（提案 §8「工件发布与恢复」）：索引链取完文本**不能**删掉中间产物，
  // 否则阅读器与索引就不再共享同一份不可变工件。非文档输入（纯文本）为 null。
  parseArtifactId: z.string().min(1).nullable().default(null),
  artifactPath: z.string().min(1).nullable().default(null),
  parserFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable().default(null) }).strict();
export type IndexPayload = z.infer<typeof indexPayloadSchema>;

export class ResearchIndexRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  initializeProject(projectId: string): void {
    const project = this.research.getProject(projectId);
    this.db.prepare(`INSERT INTO research_index_projects (project_id,options_json,revision,generation,workspace_path,root_path,archived,phase,error,scan_id,last_scan_at,embedding_key,scan_requested,scan_force,active_scan_force)
      VALUES (?,?,1,1,?,NULL,?,'idle',NULL,NULL,NULL,'none',0,0,0)`).run(projectId, JSON.stringify(defaultResearchIndexOptions), project.workspacePath, project.status === 'archived' ? 1 : 0);
  }

  scope(projectId: string): ScopeRow {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT * FROM research_index_projects WHERE project_id = ?').get(projectId) as ScopeRow | undefined;
    if (row === undefined) throw new Error('research_index_settings_not_found');
    return row;
  }

  settings(projectId: string): z.infer<typeof researchIndexSettingsSchema> {
    const row = this.scope(projectId);
    // 设置损坏时要报“索引设置已损坏”，而不是让一个 SyntaxError 从 UI 里溢出来。
    return researchIndexSettingsSchema.parse({ ...decodeObject(row.options_json, 'research_index_settings_corrupt'), projectId, revision: row.revision });
  }

  saveSettings(projectId: string, revision: number, options: Options): void {
    const parsed = researchIndexOptionsSchema.parse(options);
    this.db.transaction(() => {
      const result = this.db.prepare('UPDATE research_index_projects SET options_json = ?,revision = revision + 1 WHERE project_id = ? AND revision = ?')
        .run(JSON.stringify(parsed), projectId, revision);
      if (result.changes !== 1) throw new Error('research_index_settings_changed');
      this.invalidate(projectId);
    })();
  }

  syncProject(projectId: string): boolean {
    const project = this.research.getProject(projectId);
    const scope = this.scope(projectId);
    const archived = project.status === 'archived';
    if (scope.workspace_path === project.workspacePath && Boolean(scope.archived) === archived) return false;
    this.db.transaction(() => {
      this.invalidate(projectId);
      this.db.prepare('UPDATE research_index_projects SET workspace_path = ?,root_path = NULL,archived = ? WHERE project_id = ?').run(project.workspacePath, archived ? 1 : 0, projectId);
      if (archived || scope.workspace_path !== project.workspacePath) this.removeProjectText(projectId);
    })();
    return true;
  }

  bindRoot(projectId: string, root: string): void {
    const previous = this.scope(projectId).root_path;
    if (previous === root) return;
    this.db.transaction(() => {
      this.invalidate(projectId);
      this.db.prepare('UPDATE research_index_projects SET root_path = ? WHERE project_id = ?').run(root, projectId);
      if (previous !== null) this.removeProjectText(projectId);
    })();
  }

  invalidate(projectId: string): void {
    this.db.transaction(() => {
      this.scope(projectId);
      this.db.prepare("UPDATE research_index_projects SET generation = generation + 1,phase = 'idle',error = NULL,scan_id = NULL,scan_force = MAX(scan_force,active_scan_force),active_scan_force = 0 WHERE project_id = ?").run(projectId);
      this.db.prepare("UPDATE research_index_jobs SET status = 'cancelled',error = 'research_index_invalidated',finished_at = ? WHERE project_id = ? AND status IN ('queued','running')").run(this.now(), projectId);
      this.db.prepare("UPDATE research_index_files SET status = 'queued',active_job_id = NULL,error = NULL WHERE project_id = ? AND status <> 'missing'").run(projectId);
    })();
  }

  requestScan(projectId: string, force: boolean): void {
    this.scope(projectId);
    this.db.prepare('UPDATE research_index_projects SET scan_requested = 1,scan_force = MAX(scan_force,?) WHERE project_id = ?').run(force ? 1 : 0, projectId);
  }

  beginScan(projectId: string): { scanId: string; generation: number; force: boolean } {
    const scope = this.scope(projectId);
    this.requireActive(projectId, scope.generation);
    const scanId = `scan_${randomUUID()}`;
    this.db.prepare("UPDATE research_index_projects SET phase = 'scanning',scan_id = ?,error = NULL,scan_requested = 0,active_scan_force = scan_force,scan_force = 0 WHERE project_id = ?").run(scanId, projectId);
    return { scanId, generation: scope.generation, force: scope.scan_force === 1 };
  }

  failScan(projectId: string, scanId: string, error: string): void {
    this.db.prepare("UPDATE research_index_projects SET phase = 'failed',scan_id = NULL,error = ?,scan_force = MAX(scan_force,active_scan_force),active_scan_force = 0 WHERE project_id = ? AND scan_id = ?").run(error, projectId, scanId);
  }

  error(projectId: string, message: string, consumeScan = false): void {
    this.db.prepare("UPDATE research_index_projects SET phase = 'failed',error = ?,scan_requested = CASE WHEN ? THEN 0 ELSE scan_requested END WHERE project_id = ?")
      .run(message, consumeScan ? 1 : 0, projectId);
  }

  reconcile(projectId: string, scan: { scanId: string; generation: number }, files: readonly ScannedIndexFile[], force: boolean, embedding: ResearchEmbeddingReceipt, parserKeys: ReadonlyMap<IndexFileKind, string>, changedPaths?: ReadonlySet<string>): void {
    this.db.transaction(() => {
      const scope = this.requireActive(projectId, scan.generation);
      if (scope.scan_id !== scan.scanId || scope.root_path === null) throw new Error('research_index_scan_stale');
      const options = this.settings(projectId);
      const seen = new Set<string>();
      const wanted = embeddingKey(embedding);
      for (const file of files) {
        const parserKey = parserKeys.get(file.kind);
        if (parserKey === undefined) throw new Error('research_index_parser_key_required');
        const id = fileIdentity(projectId, file.path);
        seen.add(id);
        const existing = this.db.prepare('SELECT * FROM research_index_files WHERE id = ?').get(id) as FileRow | undefined;
        if (existing === undefined) {
          this.db.prepare(`INSERT INTO research_index_files
            (id,project_id,path,kind,size,signature,status,source_hash,indexed_hash,indexed_chunks,parser_key,embedding_key,payload_json,error,active_job_id,force_needed,updated_at)
            VALUES (?,?,?,?,?,?,'queued',NULL,NULL,0,NULL,'none',NULL,NULL,NULL,0,?)`).run(id, projectId, file.path, file.kind, file.size, file.signature, this.now());
        }
        const changed = existing === undefined || existing.signature !== file.signature || existing.kind !== file.kind;
        const parserChanged = existing !== undefined && (existing.status === 'ready'
          ? existing.parser_key !== parserKey : this.latestParserKey(id) !== parserKey);
        const mustQueue = force || changed || existing?.status === 'missing' || (existing?.status === 'queued' && existing.active_job_id === null)
          || parserChanged || (existing?.status === 'ready' && (existing.embedding_key !== wanted || !this.hasPublishedText(existing)));
        if (mustQueue) {
          this.cancelFileJobs(id);
          this.db.prepare('UPDATE research_index_files SET kind = ?,size = ?,signature = ?,source_hash = CASE WHEN signature = ? THEN source_hash ELSE NULL END WHERE id = ?')
            .run(file.kind, file.size, file.signature, file.signature, id);
          this.enqueue(projectId, id, scan.generation, { ...file, root: scope.root_path, force: force || existing?.force_needed === 1, parserKey, embeddingConfigId: options.embeddingConfigId, embedding });
        }
      }
      if (changedPaths !== undefined && (this.db.prepare("SELECT count(*) AS count FROM research_index_files WHERE project_id = ? AND status <> 'missing'").get(projectId) as { count: number }).count > 10_000) {
        throw new Error('research_index_file_limit');
      }
      const previous = changedPaths === undefined
        ? this.db.prepare("SELECT id FROM research_index_files WHERE project_id = ? AND status <> 'missing'").all(projectId) as Array<{ id: string }>
        : [...changedPaths].map((path) => ({ id: fileIdentity(projectId, path) }));
      for (const file of previous) {
        if (seen.has(file.id)) continue;
        this.cancelFileJobs(file.id);
        this.db.prepare("UPDATE research_index_files SET status = 'missing',active_job_id = NULL,error = NULL,updated_at = ? WHERE id = ?").run(this.now(), file.id);
        this.removeText(projectId, file.id);
      }
      this.db.prepare("UPDATE research_index_projects SET phase = 'idle',scan_id = NULL,active_scan_force = 0,error = NULL,last_scan_at = ?,embedding_key = ? WHERE project_id = ?").run(this.now(), wanted, projectId);
    })();
  }

  retry(projectId: string, fileId: string | null): void {
    this.db.transaction(() => {
      const scope = this.scope(projectId);
      this.requireActive(projectId, scope.generation);
      if (fileId !== null && this.fileRow(fileId).project_id !== projectId) throw new Error('research_index_project_mismatch');
      this.db.prepare("UPDATE research_index_files SET status = 'queued',active_job_id = NULL,error = NULL WHERE project_id = ? AND status = 'failed' AND (? IS NULL OR id = ?)").run(projectId, fileId, fileId);
    })();
  }

  nextJob(): IndexJob | null {
    const row = this.db.prepare(`SELECT j.* FROM research_index_jobs j JOIN research_index_projects p ON p.project_id = j.project_id
      WHERE j.status = 'queued' AND j.generation = p.generation AND p.archived = 0 AND p.scan_requested = 0 AND p.scan_id IS NULL AND json_extract(p.options_json,'$.paused') = 0
      ORDER BY j.created_at,j.rowid LIMIT 1`).get() as JobRow | undefined;
    return row === undefined ? null : this.job(row.id);
  }

  job(id: string): IndexJob {
    const row = this.db.prepare('SELECT * FROM research_index_jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (row === undefined) throw new Error('research_index_job_not_found');
    return { ...jobView(row), input: decodeJobInput(row.snapshot_json) };
  }

  beginJob(id: string): IndexJob {
    const job = this.job(id);
    this.db.transaction(() => {
      this.requireJob(job, 'queued');
      this.db.prepare("UPDATE research_index_jobs SET status = 'running',started_at = ? WHERE id = ?").run(this.now(), id);
      this.db.prepare("UPDATE research_index_files SET status = 'running',error = NULL,updated_at = ? WHERE id = ?").run(this.now(), job.fileId);
    })();
    return this.job(id);
  }

  cached(fileId: string): { payload: IndexPayload | null; embeddingKey: string; published: boolean } {
    const row = this.fileRow(fileId);
    return { payload: parseIndexPayload(row.payload_json), embeddingKey: row.embedding_key, published: this.hasPublishedText(row) };
  }

  publishText(job: IndexJob, input: IndexPayload, cachePath: string): boolean {
    const payload = indexPayloadSchema.parse(input);
    if (payload.parserKey !== job.input.parserKey) throw new Error('research_index_parser_changed');
    return this.db.transaction(() => {
      this.requireJob(job, 'running');
      const metadata = { type: 'project-index', fileId: job.fileId, sourceHash: payload.sourceHash, parserKey: payload.parserKey };
      const current = this.fileRow(job.fileId);
      const changed = job.input.force || current.indexed_hash !== payload.sourceHash || current.parser_key !== payload.parserKey || current.payload_json !== JSON.stringify(payload) || !this.hasPublishedText(current);
      if (changed) {
        this.research.knowledge.upsertFromSource({ id: knowledgeId(job.fileId), projectId: job.projectId, sourceType: 'file', sourceId: job.path,
          title: job.path, content: payload.content, chunks: payload.chunks, embeddingPolicy: 'none' }, metadata);
      }
      this.db.prepare(`INSERT INTO research_index_sources (file_id,source_hash,cache_path,size,kind,created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(file_id,source_hash) DO NOTHING`).run(job.fileId, payload.sourceHash, cachePath, job.input.size, job.input.kind, this.now());
      this.db.prepare('UPDATE research_index_files SET source_hash = ?,indexed_hash = ?,indexed_chunks = ?,parser_key = ?,payload_json = ?,updated_at = ? WHERE id = ?')
        .run(payload.sourceHash, payload.sourceHash, payload.chunks.length, payload.parserKey, JSON.stringify(payload), this.now(), job.fileId);
      return changed;
    })();
  }

  finishJob(job: IndexJob, embedding: ResearchEmbeddingReceipt): void {
    this.db.transaction(() => {
      this.requireJob(job, 'running');
      if (embeddingKey(embedding) !== embeddingKey(job.input.embedding)) throw new Error('research_index_embedding_changed');
      if (!this.hasPublishedText(this.fileRow(job.fileId))) throw new Error('research_index_text_changed');
      const timestamp = this.now();
      this.db.prepare("UPDATE research_index_jobs SET status = 'ready',finished_at = ? WHERE id = ?").run(timestamp, job.id);
      this.db.prepare("UPDATE research_index_files SET status = 'ready',active_job_id = NULL,force_needed = 0,embedding_key = ?,updated_at = ? WHERE id = ?")
        .run(embeddingKey(embedding), timestamp, job.fileId);
    })();
  }

  failJob(job: IndexJob, message: string, cancelled: boolean): void {
    this.db.transaction(() => {
      const timestamp = this.now();
      this.db.prepare("UPDATE research_index_jobs SET status = ?,error = ?,finished_at = ? WHERE id = ? AND status IN ('queued','running')")
        .run(cancelled ? 'cancelled' : 'failed', message, timestamp, job.id);
      this.db.prepare('UPDATE research_index_files SET status = ?,active_job_id = NULL,error = ?,updated_at = ? WHERE id = ? AND active_job_id = ?')
        .run(cancelled ? 'queued' : 'failed', message, timestamp, job.fileId, job.id);
    })();
  }

  requireJob(job: IndexJob, status: 'queued' | 'running'): void {
    const scope = this.requireActive(job.projectId, job.generation);
    const file = this.fileRow(job.fileId);
    if (scope.root_path !== job.input.root || scope.embedding_key !== embeddingKey(job.input.embedding) || file.active_job_id !== job.id || file.signature !== job.input.signature || this.job(job.id).status !== status) {
      throw new Error('research_index_job_stale');
    }
  }

  listFiles(projectId: string, query: string, includeMissing: boolean, limit: number): z.infer<typeof researchIndexedFileSchema>[] {
    this.scope(projectId);
    const pattern = `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
    return (this.db.prepare("SELECT * FROM research_index_files WHERE project_id = ? AND (? = 1 OR status <> 'missing') AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT ?")
      .all(projectId, includeMissing ? 1 : 0, pattern, limit) as FileRow[]).map((row) => fileView(row, this.hasPublishedText(row)));
  }

  listJobs(projectId: string, limit: number): z.infer<typeof researchIndexJobSchema>[] {
    this.scope(projectId);
    return (this.db.prepare('SELECT * FROM research_index_jobs WHERE project_id = ? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(projectId, limit) as JobRow[]).map(jobView);
  }

  status(projectId: string, available: boolean): z.infer<typeof researchIndexStatusSchema> {
    const row = this.scope(projectId);
    const settings = this.settings(projectId);
    const counts = { total: 0, queued: 0, running: 0, ready: 0, failed: 0 };
    for (const entry of this.db.prepare("SELECT status,count(*) AS count FROM research_index_files WHERE project_id = ? AND status <> 'missing' GROUP BY status").all(projectId) as Array<{ status: 'queued' | 'running' | 'ready' | 'failed'; count: number }>) {
      counts[entry.status] = entry.count; counts.total += entry.count;
    }
    const unavailable = !available ? 'research_index_storage_unavailable' : row.workspace_path === null ? 'research_project_workspace_required' : null;
    const phase = unavailable !== null ? 'unavailable' : settings.paused || row.archived ? 'paused' : row.scan_id !== null ? 'scanning' : row.scan_requested ? 'queued'
      : counts.running > 0 ? 'indexing' : row.error !== null ? 'failed' : counts.queued > 0 ? 'indexing' : counts.failed > 0 ? 'failed' : 'idle';
    return researchIndexStatusSchema.parse({ settings, generation: row.generation, workspacePath: row.workspace_path, phase,
      error: unavailable ?? row.error, lastScanAt: row.last_scan_at, counts });
  }

  /**
   * 仍被索引文件引用的工件 id 集合（提案 §8「工件发布与恢复」）：垃圾回收只动无人引用的目录。
   * 读全部 payload_json；数量级是项目数×文件数，一次启动扫一遍完全可接受。
   */
  referencedArtifacts(): Set<string> {
    const referenced = new Set<string>();
    for (const row of this.db.prepare('SELECT payload_json FROM research_index_files WHERE payload_json LIKE ?').all('%parseArtifactId%') as Array<{ payload_json: string }>) {
      const payload = parseIndexPayload(row.payload_json);
      if (payload?.parseArtifactId !== null && payload?.parseArtifactId !== undefined) referenced.add(payload.parseArtifactId);
    }
    return referenced;
  }

  source(projectId: string, fileId: string, sourceHash: string): { source: z.infer<typeof researchIndexedSourceSchema>; cachePath: string } {
    const file = this.fileRow(fileId);
    if (file.project_id !== projectId) throw new Error('research_index_project_mismatch');
    const row = this.db.prepare('SELECT * FROM research_index_sources WHERE file_id = ? AND source_hash = ?').get(fileId, sourceHash) as { cache_path: string; size: number; kind: string } | undefined;
    if (row === undefined) throw new Error('research_index_source_not_found');
    return { source: researchIndexedSourceSchema.parse({ projectId, fileId, path: file.path, kind: row.kind, sourceHash, size: row.size }), cachePath: row.cache_path };
  }

  recover(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE research_index_projects SET scan_requested = 1 WHERE project_id IN (SELECT project_id FROM research_index_jobs WHERE status IN ('queued','running'))").run();
      this.db.prepare("UPDATE research_index_files SET status = 'queued',active_job_id = NULL,error = 'research_index_interrupted' WHERE status = 'running'").run();
      this.db.prepare("UPDATE research_index_jobs SET status = 'cancelled',error = 'research_index_interrupted',finished_at = ? WHERE status = 'running'").run(this.now());
      this.db.prepare("UPDATE research_index_projects SET phase = 'idle',scan_id = NULL,scan_requested = 1,scan_force = MAX(scan_force,active_scan_force),active_scan_force = 0,error = 'research_index_scan_interrupted' WHERE scan_id IS NOT NULL").run();
    })();
  }

  private requireActive(projectId: string, generation: number): ScopeRow {
    const scope = this.scope(projectId);
    if (scope.generation !== generation) throw new Error('research_index_scope_changed');
    if (this.settings(projectId).paused) throw new Error('research_index_paused');
    const project = this.research.getProject(projectId);
    if (project.status === 'archived') throw new Error('research_project_archived');
    if (project.workspacePath !== scope.workspace_path) throw new Error('research_index_workspace_changed');
    return scope;
  }

  private fileRow(id: string): FileRow {
    const row = this.db.prepare('SELECT * FROM research_index_files WHERE id = ?').get(id) as FileRow | undefined;
    if (row === undefined) throw new Error('research_index_file_not_found');
    return row;
  }

  private latestParserKey(fileId: string): string | null {
    const row = this.db.prepare('SELECT snapshot_json FROM research_index_jobs WHERE file_id = ? ORDER BY rowid DESC LIMIT 1').get(fileId) as { snapshot_json: string } | undefined;
    if (row === undefined) return null;
    try { return decodeJobInput(row.snapshot_json).parserKey; }
    catch { return null; }
  }

  private enqueue(projectId: string, fileId: string, generation: number, input: IndexJob['input']): void {
    const id = `index_job_${randomUUID()}`;
    const timestamp = this.now();
    this.db.prepare(`INSERT INTO research_index_jobs (id,project_id,file_id,path,generation,status,error,snapshot_json,created_at,started_at,finished_at)
      VALUES (?,?,?,?,?,'queued',NULL,?,?,NULL,NULL)`).run(id, projectId, fileId, input.path, generation, JSON.stringify(input), timestamp);
    this.db.prepare("UPDATE research_index_files SET status = 'queued',active_job_id = ?,error = NULL,force_needed = ?,updated_at = ? WHERE id = ?")
      .run(id, input.force ? 1 : 0, timestamp, fileId);
  }

  private cancelFileJobs(fileId: string): void {
    this.db.prepare("UPDATE research_index_jobs SET status = 'cancelled',error = 'research_index_superseded',finished_at = ? WHERE file_id = ? AND status IN ('queued','running')").run(this.now(), fileId);
  }

  private hasPublishedText(file: FileRow): boolean {
    const row = this.db.prepare('SELECT project_id,source_type,source_id,metadata_json FROM research_knowledge_documents WHERE id = ?').get(knowledgeId(file.id)) as
      { project_id: string | null; source_type: string; source_id: string; metadata_json: string } | undefined;
    if (row === undefined || row.project_id !== file.project_id || row.source_type !== 'file' || row.source_id !== file.path) return false;
    const metadata = decodeObject(row.metadata_json, 'research_index_metadata_corrupt') as Record<string, unknown>;
    return metadata.type === 'project-index' && metadata.fileId === file.id && metadata.sourceHash === file.indexed_hash && metadata.parserKey === file.parser_key;
  }

  private removeProjectText(projectId: string): void {
    for (const row of this.db.prepare('SELECT id FROM research_index_files WHERE project_id = ?').all(projectId) as Array<{ id: string }>) this.removeText(projectId, row.id);
  }

  private removeText(projectId: string, fileId: string): void {
    // 同样是“删块前先失效引用”：索引文件被移除时，指向它块的证据不能再指着一个不存在的块。
    this.research.evidence.invalidateChunksOf(knowledgeId(fileId));
    this.db.prepare('DELETE FROM research_knowledge_documents WHERE id = ? AND project_id = ?').run(knowledgeId(fileId), projectId);
  }
}

export function knowledgeId(fileId: string): string { return `project-index:${fileId}`; }

/**
 * 读回缓存的索引 payload。库文件可能被外部改坏，此时应当当作“没有缓存、重新索引一次”，
 * 而不是把 SyntaxError 抛进索引泵把整个项目卡在 failed。
 */
function parseIndexPayload(json: string | null): IndexPayload | null {
  if (json === null) return null;
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { return null; }
  const parsed = indexPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 解析一段 Roc 自己写入的 JSON 对象；损坏时报显式错误，不让 SyntaxError 穿过边界。 */
function decodeObject(json: string, code: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error(code); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function decodeJobInput(json: string): IndexJob['input'] {
  try { return jobInputSchema.parse(JSON.parse(json)); }
  catch { throw new Error('research_index_job_corrupt'); }
}
export function embeddingKey(receipt: ResearchEmbeddingReceipt): string { return receipt === null ? 'none' : JSON.stringify([receipt.configId, receipt.revision]); }
function fileIdentity(projectId: string, path: string): string { return `index_file_${createHash('sha256').update(JSON.stringify([projectId, path])).digest('hex')}`; }
function fileView(row: FileRow, published: boolean): z.infer<typeof researchIndexedFileSchema> {
  return researchIndexedFileSchema.parse({ id: row.id, projectId: row.project_id, path: row.path, kind: row.kind, size: row.size, status: row.status,
    sourceHash: row.source_hash, indexedHash: row.indexed_hash, textIndexed: published && row.status !== 'missing' && row.indexed_hash !== null && row.indexed_hash === row.source_hash && row.indexed_chunks > 0,
    error: row.error, activeJobId: row.active_job_id, updatedAt: row.updated_at });
}
function jobView(row: JobRow): z.infer<typeof researchIndexJobSchema> {
  return researchIndexJobSchema.parse({ id: row.id, projectId: row.project_id, fileId: row.file_id, path: row.path, generation: row.generation,
    status: row.status, error: row.error, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at });
}
