import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { researchFigurePublicationSchema, type ResearchFigurePublication, type ResearchFigureRun } from '../../../shared/schemas/research-figures';
import { researchFigureValidationSchema, type ResearchFigureValidation } from '../../../shared/schemas/research-plotting';
import type { ResearchArtifact, ResearchFigure, ResearchFigureRecordRequest } from '../../../shared/types';
import { researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';

const historicalPythonSourcePath = '.roc/figure.py';

type Row = { snapshot_json: string };
export const figureManifestPath = 'figure-manifest.json';

export class ResearchFigureRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  managed(id: string): boolean { return this.db.prepare('SELECT 1 FROM research_figure_publications WHERE figure_id = ?').get(id) !== undefined; }
  hasArtifact(id: string): boolean { return this.db.prepare('SELECT 1 FROM research_figure_publications WHERE artifact_id = ?').get(id) !== undefined; }

  record(request: ResearchFigureRecordRequest): ResearchFigure {
    this.research.getProject(request.projectId);
    if (this.managed(request.id)) throw new Error('research_figure_publication_immutable');
    const previous = this.db.prepare('SELECT project_id,created_at FROM research_figures WHERE id = ?').get(request.id) as { project_id: string; created_at: string } | undefined;
    if (previous !== undefined && previous.project_id !== request.projectId) throw new Error('research_figure_project_mismatch');
    if (request.runId !== null) {
      const run = this.db.prepare('SELECT project_id FROM research_experiment_runs WHERE id = ?').get(request.runId) as { project_id: string } | undefined;
      if (run === undefined || run.project_id !== request.projectId) throw new Error('research_figure_run_invalid');
    }
    const timestamp = this.now();
    this.db.prepare(`INSERT INTO research_figures
      (id, project_id, title, code_path, data_paths_json, output_paths_json, status, run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        code_path = excluded.code_path,
        data_paths_json = excluded.data_paths_json,
        output_paths_json = excluded.output_paths_json,
        status = excluded.status,
        run_id = excluded.run_id,
        updated_at = excluded.updated_at`)
      .run(request.id, request.projectId, request.title, request.codePath, JSON.stringify(request.dataPaths), JSON.stringify(request.outputPaths), request.status, request.runId, timestamp, timestamp);
    return { ...request, createdAt: previous?.created_at ?? timestamp, updatedAt: timestamp };
  }

  get(projectId: string, id: string): ResearchFigurePublication {
    const row = this.db.prepare('SELECT snapshot_json FROM research_figure_publications WHERE figure_id = ?').get(id) as Row | undefined;
    if (row === undefined) throw new Error('research_figure_not_found');
    const value = researchFigurePublicationSchema.parse(JSON.parse(row.snapshot_json));
    if (value.projectId !== projectId) throw new Error('research_figure_project_mismatch');
    const artifact = this.research.getArtifact(value.artifactId);
    return { ...value, status: artifact.status === 'draft' ? 'rendered' : artifact.status };
  }

  list(projectId: string, limit: number): ResearchFigurePublication[] {
    this.research.getProject(projectId);
    const rows = this.db.prepare('SELECT figure_id FROM research_figure_publications WHERE project_id = ? ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(projectId, limit) as Array<{ figure_id: string }>;
    return rows.map((row) => this.get(projectId, row.figure_id));
  }

  publish(projectId: string, runId: string, replacesFigureId: string | null, validation: ResearchFigureValidation, manifestHash: string): ResearchFigurePublication {
    return this.db.transaction(() => {
      const run = this.research.figureRuns.get(projectId, runId);
      assertFigureRun(run, validation);
      if (run.ownerRunId !== null) this.research.runs.requireActive(run.ownerRunId, projectId);
      const existing = this.db.prepare('SELECT figure_id FROM research_figure_publications WHERE run_id = ?').get(runId) as { figure_id: string } | undefined;
      if (existing !== undefined) {
        const record = this.get(projectId, existing.figure_id);
        if (record.replacesFigureId !== replacesFigureId) throw new Error('research_figure_publish_conflict');
        return record;
      }
      const previous = replacesFigureId === null ? null : this.get(projectId, replacesFigureId);
      if (previous !== null && previous.status !== 'rendered') throw new Error('research_figure_replacement_invalid');
      const id = `figure_${randomUUID()}`;
      const figure = this.record({ id, projectId, title: run.request.label, codePath: `input/${run.request.sourcePath}`,
        dataPaths: run.request.inputPaths.map((path) => `input/${path}`), outputPaths: validation.files.map((file) => `output/${file.path}`), status: 'rendered', runId });
      const artifact = this.research.createArtifact({ projectId, stage: 'figure', kind: 'figure', title: figure.title,
        path: join(this.research.figureRuns.root(projectId, runId), figureManifestPath) });
      const record = researchFigurePublicationSchema.parse({ id, projectId, runId, artifactId: artifact.id, title: figure.title,
        sourcePath: run.request.sourcePath, inputPaths: run.request.inputPaths, replacesFigureId, validation, manifestHash, status: 'rendered', createdAt: this.now() });
      this.db.prepare(`INSERT INTO research_figure_publications (figure_id,project_id,run_id,artifact_id,snapshot_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(id, projectId, runId, artifact.id, JSON.stringify(record), record.createdAt);
      for (const subjectType of ['figure', 'artifact'] as const) this.research.addProvenance({ projectId, artifactId: artifact.id,
        subjectType, subjectId: subjectType === 'figure' ? id : artifact.id, sourceType: 'experiment', sourceId: runId,
        locator: `inputs:${run.inputHash}; manifest:${manifestHash}`, excerpt: figure.title });
      if (previous !== null) {
        this.research.supersedeArtifact(previous.artifactId, artifact.id);
        this.db.prepare(`INSERT INTO research_workflow_events (id,project_id,stage,type,message,payload_json,created_at)
          VALUES (?,?,'figure','figure_replaced',?,?,?)`).run(randomUUID(), projectId, '图稿已更新，旧图稿及其证据保留在历史中。',
          JSON.stringify({ previousFigureId: previous.id, figureId: id, artifactId: artifact.id }), record.createdAt);
      }
      return record;
    })();
  }

  forArtifact(artifact: ResearchArtifact): ResearchFigurePublication {
    const row = this.db.prepare('SELECT figure_id FROM research_figure_publications WHERE artifact_id = ?').get(artifact.id) as { figure_id: string } | undefined;
    if (row === undefined) throw new Error('research_figure_render_required');
    const record = this.get(artifact.projectId, row.figure_id);
    const run = this.research.figureRuns.get(record.projectId, record.runId);
    assertFigureRun(run, record.validation);
    if (artifact.kind !== 'figure' || artifact.stage !== 'figure' || artifact.path !== join(this.research.figureRuns.root(record.projectId, run.id), figureManifestPath)) {
      throw new Error('research_figure_artifact_invalid');
    }
    return record;
  }

  reviewSignature(projectId: string): string {
    const workflow = this.research.getWorkflow(projectId);
    const stage = workflow.stages.find((entry) => entry.stage === 'figure');
    if (stage === undefined) throw new Error('research_stage_not_found');
    const figures = stage.artifactIds.map((id) => {
      const artifact = this.research.getArtifact(id);
      const record = this.forArtifact(artifact);
      const claims = this.research.evidence.listClaims({ projectId, artifactId: id }).map((claim) => ({
        id: claim.id, subjectType: claim.subjectType, content: claim.content, status: claim.status, evidenceIds: claim.evidenceIds, version: claim.version
      }));
      return { artifactId: artifact.id, status: artifact.status, path: artifact.path, figureId: record.id, manifestHash: record.manifestHash, claims };
    });
    return researchContentHash(JSON.stringify({
      stage: workflow.currentStage, projectStatus: workflow.projectStatus, stageStatus: stage.status,
      gateRequired: stage.gateRequired, artifactIds: stage.artifactIds, figures
    }));
  }
}

export function assertFigureRun(run: ResearchFigureRun, input: ResearchFigureValidation): void {
  const parsedValidation = researchFigureValidationSchema.safeParse(input);
  if (!parsedValidation.success) throw new Error('research_figure_validation_invalid');
  const validation = parsedValidation.data;
  if (run.status !== 'completed' || run.inputHash === null || run.environment === null) {
    throw new Error('research_figure_render_required');
  }
  if (JSON.stringify(run.request.figure) !== JSON.stringify(validation.options)) throw new Error('research_figure_options_changed');
  const isVegaRun = 'engine' in run.request && run.request.engine === 'vega-lite';
  const environment = run.environment;
  const rendererMatches = environment !== null && (isVegaRun
    ? 'engine' in environment && environment.engine === 'vega-lite' && environment.hash === validation.rendererHash
    : run.files.some((file) => file.area === 'input' && file.path === historicalPythonSourcePath && file.sha256 === validation.rendererHash));
  if (!rendererMatches) throw new Error('research_figure_renderer_changed');
  for (const expected of validation.files) {
    if (!run.files.some((file) => file.area === 'output' && file.path === expected.path && file.sha256 === expected.sha256 && file.size === expected.size)) {
      throw new Error('research_figure_output_changed');
    }
  }
}

export function figureManifest(run: ResearchFigureRun, validation: ResearchFigureValidation): string {
  const { artifactId: _artifactId, ...execution } = run;
  return JSON.stringify({ version: 1, execution, validation }, null, 2);
}
