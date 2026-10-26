import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { ResearchExperimentFile } from '../../../shared/schemas/research-experiments';
import type { ResearchFigureRendererEnvironment, ResearchFigureStart } from '../../../shared/schemas/research-figures';
import { researchFigureRunSchema, researchFigureStartSchema, type ResearchFigureRun } from '../../../shared/schemas/research-figures';
import type { ResearchRepository } from './repository';

type RunRow = { snapshot_json: string; root_path: string };
function parseFigureRunSnapshot(snapshot: string): ResearchFigureRun {
  try {
    const result = researchFigureRunSchema.safeParse(JSON.parse(snapshot) as unknown);
    if (!result.success) throw new Error('research_figure_snapshot_corrupt');
    return result.data;
  } catch {
    throw new Error('research_figure_snapshot_corrupt');
  }
}

const activeStatuses = new Set<ResearchFigureRun['status']>(['preparing', 'running']);

export class ResearchFigureRunRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  existing(projectId: string, requestId: string): ResearchFigureRun | null {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT snapshot_json FROM research_figure_runs WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as RunRow | undefined;
    return row === undefined ? null : parseFigureRunSnapshot(row.snapshot_json);
  }

  create(request: ResearchFigureStart, workspace: string, workspaceRoot: string, storage: string): ResearchFigureRun {
    return this.db.transaction(() => {
      const project = this.research.getProject(request.projectId);
      if (project.status === 'archived') throw new Error('research_project_archived');
      if (project.workspacePath !== workspace) throw new Error('research_figure_workspace_changed');
      const previous = this.existing(request.projectId, request.requestId);
      if (previous !== null) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request) || previous.ownerRunId !== (request.ownerRunId ?? null)) {
          throw new Error('research_figure_request_conflict');
        }
        return previous;
      }
      const id = `figure_run_${randomUUID()}`;
      const createdAt = this.now();
      const ownerRunId = request.ownerRunId ?? null;
      if (ownerRunId !== null) this.research.runs.requireActive(ownerRunId, request.projectId);
      const run = researchFigureRunSchema.parse({
        id, projectId: request.projectId, request, ownerRunId, workspacePath: workspace, workspaceRoot,
        status: 'preparing', environment: null, files: [], inputHash: null, exitCode: null, error: null, artifactId: null,
        createdAt, startedAt: null, endedAt: null
      });
      const command = [request.engine, request.sourcePath];
      const parameters = { sourceVersion: request.sourceVersion, figure: request.figure };
      this.db.prepare(`INSERT INTO research_experiment_runs
        (id,project_id,label,command,parameters_json,environment_json,status,outputs_json,started_at,ended_at)
        VALUES (?,?,?,?,?,?,'running','[]',?,NULL)`).run(id, run.projectId, request.label, JSON.stringify(command), JSON.stringify(parameters), '{}', createdAt);
      this.db.prepare(`INSERT INTO research_figure_runs (run_id,project_id,request_id,status,snapshot_json,root_path,created_at)
        VALUES (?,?,?,'preparing',?,?,?)`).run(id, run.projectId, request.requestId, JSON.stringify(run), join(storage, id), createdAt);
      this.event(run, 'figure_queued', '图稿已创建，正在校验渲染器并冻结输入。');
      return run;
    })();
  }

  get(projectId: string, id: string): ResearchFigureRun {
    const row = this.row(id);
    const value = parseFigureRunSnapshot(row.snapshot_json);
    if (value.projectId !== projectId) throw new Error('research_figure_project_mismatch');
    return value;
  }

  root(projectId: string, id: string): string { this.get(projectId, id); return this.row(id).root_path; }

  list(projectId: string, limit: number): ResearchFigureRun[] {
    this.research.getProject(projectId);
    return (this.db.prepare('SELECT snapshot_json FROM research_figure_runs WHERE project_id = ? ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(projectId, limit) as RunRow[]).map((row) => parseFigureRunSnapshot(row.snapshot_json));
  }

  ownedActive(projectId: string, ownerRunId: string): ResearchFigureRun[] {
    this.research.getProject(projectId);
    return (this.db.prepare("SELECT snapshot_json FROM research_figure_runs WHERE project_id = ? AND json_extract(snapshot_json, '$.ownerRunId') = ? AND status IN ('preparing','running')")
      .all(projectId, ownerRunId) as RunRow[]).map((row) => parseFigureRunSnapshot(row.snapshot_json));
  }

  start(projectId: string, id: string, environment: ResearchFigureRendererEnvironment, files: ResearchExperimentFile[], inputHash: string): ResearchFigureRun {
    return this.db.transaction(() => {
      const run = this.requireActive(projectId, id);
      if (run.status !== 'preparing') throw new Error('research_figure_already_started');
      const request = researchFigureStartSchema.parse(run.request);
      const value = { ...run, status: 'running' as const, environment, files, inputHash, startedAt: this.now() };
      this.save(value);
      this.db.prepare('UPDATE research_experiment_runs SET command = ?,environment_json = ? WHERE id = ?').run(
        JSON.stringify([request.engine, request.sourcePath]), JSON.stringify(environment), id);
      for (const file of files) this.research.addProvenance({ projectId, artifactId: null, subjectType: 'experiment', subjectId: id,
        sourceType: 'file', sourceId: file.path, locator: `sha256:${file.sha256}`, excerpt: null });
      this.event(value, 'figure_started', '渲染器已校验，图稿正在使用冻结的输入渲染。');
      return value;
    })();
  }

  finish(projectId: string, id: string, result: Pick<ResearchFigureRun, 'status' | 'files' | 'exitCode' | 'error'>): ResearchFigureRun {
    return this.db.transaction(() => {
      const run = this.get(projectId, id);
      if (!activeStatuses.has(run.status)) return run;
      if (activeStatuses.has(result.status)) throw new Error('research_figure_terminal_status_required');
      let next = result;
      if (next.status === 'completed' && run.ownerRunId !== null) {
        try { this.research.runs.requireActive(run.ownerRunId, projectId); }
        catch { next = { status: 'cancelled', files: next.files, exitCode: next.exitCode, error: 'research_figure_cancelled' }; }
      }
      if (next.status === 'completed') {
        this.requireActive(projectId, id);
        if (run.status !== 'running' || run.environment === null || run.inputHash === null || next.exitCode !== 0 || next.error !== null) throw new Error('research_figure_result_invalid');
      }
      const value = { ...run, ...next, endedAt: this.now() };
      this.save(value);
      this.db.prepare('UPDATE research_experiment_runs SET status = ?,outputs_json = ?,ended_at = ? WHERE id = ?')
        .run(next.status === 'interrupted' ? 'failed' : next.status, JSON.stringify(next.files.filter((file) => file.area === 'output').map((file) => `${file.area}/${file.path}`)), value.endedAt, id);
      this.event(value, `figure_${next.status}`, next.status === 'completed' ? '图稿完成，输出与日志已保存。' : '图稿已结束，详情见运行记录。');
      return value;
    })();
  }

  recover(): void {
    const rows = this.db.prepare("SELECT run_id,project_id FROM research_figure_runs WHERE status IN ('preparing','running')").all() as Array<{ run_id: string; project_id: string }>;
    for (const row of rows) {
      const run = this.get(row.project_id, row.run_id);
      this.finish(row.project_id, row.run_id, { status: 'interrupted', files: run.files, exitCode: null, error: 'research_figure_interrupted' });
    }
  }

  requireActive(projectId: string, id: string): ResearchFigureRun {
    const run = this.get(projectId, id);
    if (!activeStatuses.has(run.status)) throw new Error('research_figure_not_active');
    const project = this.research.getProject(projectId);
    if (project.status === 'archived') throw new Error('research_project_archived');
    if (project.workspacePath === null) throw new Error('research_project_workspace_required');
    if (project.workspacePath !== run.workspacePath) throw new Error('research_figure_workspace_changed');
    return run;
  }

  private row(id: string): RunRow {
    const row = this.db.prepare('SELECT snapshot_json,root_path FROM research_figure_runs WHERE run_id = ?').get(id) as RunRow | undefined;
    if (row === undefined) throw new Error('research_figure_run_not_found');
    return row;
  }

  private save(run: ResearchFigureRun): void {
    const value = researchFigureRunSchema.parse(run);
    this.db.prepare('UPDATE research_figure_runs SET status = ?,snapshot_json = ? WHERE run_id = ?')
      .run(value.status, JSON.stringify(value), value.id);
  }

  private event(run: ResearchFigureRun, type: string, message: string): void {
    const project = this.research.getProject(run.projectId);
    this.db.prepare('INSERT INTO research_workflow_events (id,project_id,stage,type,message,payload_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), run.projectId, project.currentStage, type, message, JSON.stringify({ runId: run.id }), this.now());
  }
}
