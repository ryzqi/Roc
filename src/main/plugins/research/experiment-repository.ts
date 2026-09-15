import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { researchExperimentExecutionSchema, type ResearchExperimentExecution, type ResearchExperimentEnvironment,
  type ResearchExperimentFile, type ResearchExperimentStart } from '../../../shared/schemas/research-experiments';
import type { ResearchRepository } from './repository';
import type { ResearchArtifact } from '../../../shared/types';

type ExecutionRow = { snapshot_json: string; root_path: string };
const activeStatuses = new Set<ResearchExperimentExecution['status']>(['preparing', 'running']);

export class ResearchExperimentRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  existing(projectId: string, requestId: string): ResearchExperimentExecution | null {
    this.research.getProject(projectId);
    const row = this.db.prepare('SELECT snapshot_json FROM research_experiment_executions WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as ExecutionRow | undefined;
    return row === undefined ? null : researchExperimentExecutionSchema.parse(JSON.parse(row.snapshot_json));
  }

  create(request: ResearchExperimentStart, workspace: string, workspaceRoot: string, storage: string): ResearchExperimentExecution {
    return this.db.transaction(() => {
      const project = this.research.getProject(request.projectId);
      if (project.status === 'archived') throw new Error('research_project_archived');
      if (project.workspacePath !== workspace) throw new Error('research_experiment_workspace_changed');
      const previous = this.existing(request.projectId, request.requestId);
      if (previous !== null) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request) || previous.ownerRunId !== (request.ownerRunId ?? null)) {
          throw new Error('research_experiment_request_conflict');
        }
        return previous;
      }
      const id = `experiment_${randomUUID()}`;
      const createdAt = this.now();
      const ownerRunId = request.ownerRunId ?? null;
      if (ownerRunId !== null) this.research.runs.requireActive(ownerRunId, request.projectId);
      const run = researchExperimentExecutionSchema.parse({ id, projectId: request.projectId, request, ownerRunId, workspacePath: workspace, workspaceRoot,
        status: 'preparing', environment: null, files: [], inputHash: null, exitCode: null, error: null, artifactId: null, createdAt, startedAt: null, endedAt: null });
      this.db.prepare(`INSERT INTO research_experiment_runs
        (id,project_id,label,command,parameters_json,environment_json,status,outputs_json,started_at,ended_at)
        VALUES (?,?,?,?,?,?,'running','[]',?,NULL)`).run(id, run.projectId, request.label, JSON.stringify([request.sourcePath, ...request.arguments]), JSON.stringify(request.parameters), '{}', createdAt);
      this.db.prepare(`INSERT INTO research_experiment_executions (run_id,project_id,request_id,status,snapshot_json,root_path,created_at)
        VALUES (?,?,?,'preparing',?,?,?)`).run(id, run.projectId, request.requestId, JSON.stringify(run), join(storage, id), createdAt);
      this.event(run, 'experiment_queued', '实验已创建，正在校验环境并冻结输入。');
      return run;
    })();
  }

  get(projectId: string, id: string): ResearchExperimentExecution {
    const row = this.row(id);
    const value = researchExperimentExecutionSchema.parse(JSON.parse(row.snapshot_json));
    if (value.projectId !== projectId) throw new Error('research_experiment_project_mismatch');
    return value;
  }

  root(projectId: string, id: string): string { this.get(projectId, id); return this.row(id).root_path; }
  managed(id: string): boolean { return this.db.prepare('SELECT 1 FROM research_experiment_executions WHERE run_id = ?').get(id) !== undefined; }
  hasArtifact(id: string): boolean { return this.db.prepare("SELECT 1 FROM research_experiment_executions WHERE json_extract(snapshot_json, '$.artifactId') = ?").get(id) !== undefined; }
  forArtifact(artifact: ResearchArtifact): ResearchExperimentExecution {
    const row = this.db.prepare("SELECT run_id FROM research_experiment_executions WHERE json_extract(snapshot_json, '$.artifactId') = ? AND project_id = ?")
      .get(artifact.id, artifact.projectId) as { run_id: string } | undefined;
    if (row === undefined) throw new Error('research_experiment_execution_required');
    const run = this.get(artifact.projectId, row.run_id);
    if (artifact.kind !== 'experiment_run' || run.status !== 'completed' || run.artifactId !== artifact.id
      || artifact.path !== join(this.root(artifact.projectId, run.id), 'manifest.json')) throw new Error('research_experiment_artifact_invalid');
    return run;
  }
  list(projectId: string, limit: number): ResearchExperimentExecution[] {
    this.research.getProject(projectId);
    return (this.db.prepare('SELECT snapshot_json FROM research_experiment_executions WHERE project_id = ? ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(projectId, limit) as ExecutionRow[]).map((row) => researchExperimentExecutionSchema.parse(JSON.parse(row.snapshot_json)));
  }
  ownedActive(projectId: string, ownerRunId: string): ResearchExperimentExecution[] {
    this.research.getProject(projectId);
    return (this.db.prepare("SELECT snapshot_json FROM research_experiment_executions WHERE project_id = ? AND json_extract(snapshot_json, '$.ownerRunId') = ? AND status IN ('preparing','running')")
      .all(projectId, ownerRunId) as ExecutionRow[]).map((row) => researchExperimentExecutionSchema.parse(JSON.parse(row.snapshot_json)));
  }

  start(projectId: string, id: string, environment: ResearchExperimentEnvironment, files: ResearchExperimentFile[], inputHash: string): ResearchExperimentExecution {
    return this.db.transaction(() => {
      const run = this.requireActive(projectId, id);
      if (run.status !== 'preparing') throw new Error('research_experiment_already_started');
      const value = { ...run, status: 'running' as const, environment, files, inputHash, startedAt: this.now() };
      this.save(value);
      this.db.prepare('UPDATE research_experiment_runs SET command = ?,environment_json = ? WHERE id = ?').run(
        JSON.stringify([environment.executable, run.request.sourcePath, ...run.request.arguments]),
        JSON.stringify({ kind: environment.runtime.kind, version: environment.version, hash: environment.hash, toolchainHash: environment.toolchainHash }), id);
      for (const file of files) this.research.addProvenance({ projectId, artifactId: null, subjectType: 'experiment', subjectId: id,
        sourceType: 'file', sourceId: file.path, locator: `sha256:${file.sha256}`, excerpt: null });
      this.event(value, 'experiment_started', '环境已校验，实验正在使用冻结的输入运行。');
      return value;
    })();
  }

  finish(projectId: string, id: string, result: Pick<ResearchExperimentExecution, 'status' | 'files' | 'exitCode' | 'error'>,
    documents: Array<{ id: string; title: string; content: string; chunks: Array<{ content: string; locator: string }>; metadata: Record<string, unknown> }> = []): ResearchExperimentExecution {
    return this.db.transaction(() => {
      const run = this.get(projectId, id);
      if (!activeStatuses.has(run.status)) return run;
      if (activeStatuses.has(result.status)) throw new Error('research_experiment_terminal_status_required');
      let next = result;
      if (next.status === 'completed' && run.ownerRunId !== null) {
        try { this.research.runs.requireActive(run.ownerRunId, projectId); }
        catch { next = { status: 'cancelled', files: next.files, exitCode: next.exitCode, error: 'research_experiment_cancelled' }; }
      }
      if (next.status === 'completed') {
        this.requireActive(projectId, id);
        if (run.status !== 'running' || run.environment === null || run.inputHash === null || next.exitCode !== 0 || next.error !== null) throw new Error('research_experiment_result_invalid');
        for (const { metadata, ...document } of documents) this.research.knowledge.upsertKnowledgeDocument({ ...document, projectId, sourceType: 'experiment', sourceId: id, embeddingConfigId: null }, metadata);
      }
      const value = { ...run, ...next, endedAt: this.now() };
      this.save(value);
      this.db.prepare('UPDATE research_experiment_runs SET status = ?,outputs_json = ?,ended_at = ? WHERE id = ?')
        .run(next.status === 'interrupted' ? 'failed' : next.status, JSON.stringify(next.files.filter((file) => file.area === 'output' || file.area === 'notebook').map((file) => `${file.area}/${file.path}`)), value.endedAt, id);
      this.event(value, `experiment_${next.status}`, next.status === 'completed' ? '实验完成，输出与日志已保存。' : '实验已结束，详情见运行记录。');
      return value;
    })();
  }

  publish(projectId: string, id: string): ResearchExperimentExecution {
    return this.db.transaction(() => {
      const run = this.get(projectId, id);
      if (run.status !== 'completed') throw new Error('research_experiment_completed_required');
      if (run.ownerRunId !== null) this.research.runs.requireActive(run.ownerRunId, projectId);
      if (run.artifactId !== null) return run;
      const artifact = this.research.createArtifact({ projectId, stage: 'experiment', kind: 'experiment_run', title: run.request.label, path: join(this.root(projectId, id), 'manifest.json') });
      this.research.addProvenance({ projectId, artifactId: artifact.id, subjectType: 'artifact', subjectId: artifact.id, sourceType: 'experiment', sourceId: id,
        locator: `inputs:${run.inputHash}`, excerpt: run.request.label });
      const value = { ...run, artifactId: artifact.id };
      this.save(value);
      return value;
    })();
  }

  recover(): void {
    const rows = this.db.prepare("SELECT run_id,project_id FROM research_experiment_executions WHERE status IN ('preparing','running')").all() as Array<{ run_id: string; project_id: string }>;
    for (const row of rows) {
      const run = this.get(row.project_id, row.run_id);
      this.finish(row.project_id, row.run_id, { status: 'interrupted', files: run.files, exitCode: null, error: 'research_experiment_interrupted' });
    }
  }

  requireActive(projectId: string, id: string): ResearchExperimentExecution {
    const run = this.get(projectId, id);
    if (!activeStatuses.has(run.status)) throw new Error('research_experiment_not_active');
    const project = this.research.getProject(projectId);
    if (project.status === 'archived') throw new Error('research_project_archived');
    if (project.workspacePath === null) throw new Error('research_project_workspace_required');
    if (project.workspacePath !== run.workspacePath) throw new Error('research_experiment_workspace_changed');
    return run;
  }

  private row(id: string): ExecutionRow {
    const row = this.db.prepare('SELECT snapshot_json,root_path FROM research_experiment_executions WHERE run_id = ?').get(id) as ExecutionRow | undefined;
    if (row === undefined) throw new Error('research_experiment_not_found');
    return row;
  }
  private save(run: ResearchExperimentExecution): void {
    const value = researchExperimentExecutionSchema.parse(run);
    this.db.prepare('UPDATE research_experiment_executions SET status = ?,snapshot_json = ? WHERE run_id = ?')
      .run(value.status, JSON.stringify(value), value.id);
  }
  private event(run: ResearchExperimentExecution, type: string, message: string): void {
    const project = this.research.getProject(run.projectId);
    this.db.prepare('INSERT INTO research_workflow_events (id,project_id,stage,type,message,payload_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), run.projectId, project.currentStage, type, message, JSON.stringify({ runId: run.id }), this.now());
  }
}
