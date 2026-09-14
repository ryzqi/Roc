import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { researchExportExecutionSchema, type ResearchExportExecution, type ResearchExportPrepare } from '../../../shared/schemas/research-exports';
import type { ResearchArtifact } from '../../../shared/types';
import type { ResearchRepository } from './repository';

type Row = { snapshot_json: string; root_path: string };

export class ResearchExportRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  create(request: ResearchExportPrepare, storage: string): ResearchExportExecution {
    return this.db.transaction(() => {
      const project = this.research.getProject(request.projectId);
      if (project.status === 'archived') throw new Error('research_project_archived');
      const existing = this.db.prepare('SELECT id FROM research_export_executions WHERE project_id = ? AND request_id = ?')
        .get(project.id, request.requestId) as { id: string } | undefined;
      if (existing !== undefined) {
        const record = this.get(project.id, existing.id);
        if (JSON.stringify(record.request) !== JSON.stringify(request) || record.ownerRunId !== (request.ownerRunId ?? null)) {
          throw new Error('research_export_request_conflict');
        }
        return record;
      }
      this.requireCurrent(request);
      const ownerRunId = request.ownerRunId ?? null;
      if (ownerRunId !== null) this.research.runs.requireActive(ownerRunId, project.id);
      const id = `export_${randomUUID()}`;
      const record = researchExportExecutionSchema.parse({ id, projectId: project.id, request, ownerRunId, status: 'preparing', sources: null, sourceHash: null,
        toolchainHash: null, files: [], archive: null, artifactId: null, approval: 'unpublished', replacesExportId: null,
        error: null, createdAt: this.now(), endedAt: null });
      this.db.prepare(`INSERT INTO research_export_executions (id,project_id,request_id,status,artifact_id,snapshot_json,root_path,created_at)
        VALUES (?,?,?,'preparing',NULL,?,?,?)`).run(id, project.id, request.requestId, JSON.stringify(record), join(storage, id), record.createdAt);
      this.event(record, 'export_preparing', '正在冻结批准的正文、图稿和来源，生成交付文件。');
      return record;
    })();
  }

  get(projectId: string, id: string): ResearchExportExecution {
    const row = this.row(id);
    const record = researchExportExecutionSchema.parse(JSON.parse(row.snapshot_json));
    if (record.projectId !== projectId) throw new Error('research_export_project_mismatch');
    return { ...record, approval: record.artifactId === null ? 'unpublished' : this.research.getArtifact(record.artifactId).status };
  }

  list(projectId: string, limit: number): ResearchExportExecution[] {
    this.research.getProject(projectId);
    return (this.db.prepare('SELECT id FROM research_export_executions WHERE project_id = ? ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(projectId, limit) as Array<{ id: string }>).map((row) => this.get(projectId, row.id));
  }
  ownedPreparing(projectId: string, ownerRunId: string): ResearchExportExecution[] {
    this.research.getProject(projectId);
    return (this.db.prepare("SELECT id FROM research_export_executions WHERE project_id = ? AND json_extract(snapshot_json, '$.ownerRunId') = ? AND status = 'preparing'")
      .all(projectId, ownerRunId) as Array<{ id: string }>).map((row) => this.get(projectId, row.id));
  }

  root(projectId: string, id: string): string { this.get(projectId, id); return this.row(id).root_path; }
  hasArtifact(id: string): boolean { return this.db.prepare('SELECT 1 FROM research_export_executions WHERE artifact_id = ?').get(id) !== undefined; }

  finish(projectId: string, id: string, result: Pick<ResearchExportExecution, 'status' | 'sources' | 'sourceHash' | 'toolchainHash' | 'files' | 'archive' | 'error'>): ResearchExportExecution {
    return this.db.transaction(() => {
      const record = this.get(projectId, id);
      if (record.status !== 'preparing') return record;
      if (result.status === 'preparing') throw new Error('research_export_terminal_status_required');
      let next = result;
      if (next.status === 'ready' && record.ownerRunId !== null) {
        try { this.research.runs.requireActive(record.ownerRunId, projectId); }
        catch { next = { ...next, status: 'cancelled', error: 'research_export_cancelled' }; }
      }
      if (next.status === 'ready') {
        this.requireCurrent(record.request);
        if (next.sources === null || next.sourceHash === null || next.toolchainHash === null || next.archive === null || next.error !== null
          || !next.files.some((file) => file.path === 'paper.pdf') || !next.files.some((file) => file.path === 'manifest.json')) throw new Error('research_export_result_invalid');
      }
      const value = { ...record, ...next, endedAt: this.now() };
      this.save(value);
      this.event(value, `export_${value.status}`, value.status === 'ready' ? '交付文件已生成，等待预览与最终审核。' : '导出准备已结束，详情见日志。');
      return value;
    })();
  }

  publish(projectId: string, id: string, replacesExportId: string | null): ResearchExportExecution {
    return this.db.transaction(() => {
      const record = this.get(projectId, id);
      if (record.status !== 'ready') throw new Error('research_export_ready_required');
      if (record.ownerRunId !== null) this.research.runs.requireActive(record.ownerRunId, projectId);
      if (record.artifactId !== null) {
        if (record.replacesExportId !== replacesExportId) throw new Error('research_export_publish_conflict');
        return record;
      }
      this.requireCurrent(record.request);
      const previous = replacesExportId === null ? null : this.get(projectId, replacesExportId);
      if (previous !== null && (previous.approval !== 'draft' || previous.artifactId === null)) throw new Error('research_export_replacement_invalid');
      const artifact = this.research.createArtifact({ projectId, stage: 'export', kind: 'export_package', title: record.request.title,
        path: join(this.root(projectId, id), 'bundle/manifest.json') });
      const value = { ...record, artifactId: artifact.id, approval: 'draft' as const, replacesExportId };
      this.save(value);
      if (previous?.artifactId !== null && previous?.artifactId !== undefined) this.research.supersedeArtifact(previous.artifactId, artifact.id);
      this.research.addProvenance({ projectId, artifactId: artifact.id, subjectType: 'artifact', subjectId: artifact.id, sourceType: 'file',
        sourceId: 'manifest.json', locator: `sources:${record.sourceHash}`, excerpt: record.request.title });
      this.event(value, 'export_published', '交付文件已关联最终审核闸门。');
      return value;
    })();
  }

  forArtifact(artifact: ResearchArtifact): ResearchExportExecution {
    const row = this.db.prepare('SELECT id FROM research_export_executions WHERE artifact_id = ?').get(artifact.id) as { id: string } | undefined;
    if (row === undefined) throw new Error('research_export_preparation_required');
    const record = this.get(artifact.projectId, row.id);
    if (record.status !== 'ready' || artifact.stage !== 'export' || artifact.kind !== 'export_package'
      || artifact.path !== join(this.root(record.projectId, record.id), 'bundle/manifest.json')) throw new Error('research_export_artifact_invalid');
    return record;
  }

  recover(): void {
    const records = this.db.prepare("SELECT id,project_id FROM research_export_executions WHERE status = 'preparing'").all() as Array<{ id: string; project_id: string }>;
    for (const row of records) {
      const record = this.get(row.project_id, row.id);
      this.finish(row.project_id, row.id, { ...record, status: 'interrupted', error: 'research_export_interrupted' });
    }
  }

  requireCurrent(request: ResearchExportPrepare): void {
    const project = this.research.getProject(request.projectId);
    if (project.status === 'archived') throw new Error('research_project_archived');
    if (project.currentStage !== 'export') throw new Error('research_export_stage_inactive');
    const cycle = this.research.reviews.requireForStage(project.id, 'export');
    if (cycle === null || cycle.manuscriptArtifactId !== request.manuscriptArtifactId) throw new Error('research_export_manuscript_changed');
  }

  private row(id: string): Row {
    const row = this.db.prepare('SELECT snapshot_json,root_path FROM research_export_executions WHERE id = ?').get(id) as Row | undefined;
    if (row === undefined) throw new Error('research_export_not_found');
    return row;
  }
  private save(record: ResearchExportExecution): void {
    const value = researchExportExecutionSchema.parse(record);
    this.db.prepare('UPDATE research_export_executions SET status = ?,artifact_id = ?,snapshot_json = ? WHERE id = ?')
      .run(value.status, value.artifactId, JSON.stringify(value), value.id);
  }
  private event(record: ResearchExportExecution, type: string, message: string): void {
    this.db.prepare(`INSERT INTO research_workflow_events (id,project_id,stage,type,message,payload_json,created_at)
      VALUES (?,?,'export',?,?,?,?)`).run(randomUUID(), record.projectId, type, message, JSON.stringify({ exportId: record.id, replacesExportId: record.replacesExportId }), this.now());
  }
}
