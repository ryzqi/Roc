import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { ResearchExperimentExecution } from '../../../shared/schemas/research-experiments';
import { researchFigurePublicationSchema, type ResearchFigurePublication } from '../../../shared/schemas/research-figures';
import { researchFigureValidationSchema, type ResearchFigureValidation } from '../../../shared/schemas/research-plotting';
import type { ResearchArtifact } from '../../../shared/types';
import { figureRendererPath } from './figure-runner';
import type { ResearchRepository } from './repository';

type Row = { snapshot_json: string };
export const figureManifestPath = 'figure-manifest.json';

export class ResearchFigureRepository {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  managed(id: string): boolean { return this.db.prepare('SELECT 1 FROM research_figure_publications WHERE figure_id = ?').get(id) !== undefined; }
  hasArtifact(id: string): boolean { return this.db.prepare('SELECT 1 FROM research_figure_publications WHERE artifact_id = ?').get(id) !== undefined; }

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
      const run = this.research.experiments.get(projectId, runId);
      assertFigureRun(run, validation);
      const existing = this.db.prepare('SELECT figure_id FROM research_figure_publications WHERE run_id = ?').get(runId) as { figure_id: string } | undefined;
      if (existing !== undefined) {
        const record = this.get(projectId, existing.figure_id);
        if (record.replacesFigureId !== replacesFigureId) throw new Error('research_figure_publish_conflict');
        return record;
      }
      const previous = replacesFigureId === null ? null : this.get(projectId, replacesFigureId);
      if (previous !== null && previous.status !== 'rendered') throw new Error('research_figure_replacement_invalid');
      const id = `figure_${randomUUID()}`;
      const figure = this.research.recordFigure({ id, projectId, title: run.request.label, codePath: `input/${run.request.sourcePath}`,
        dataPaths: run.request.inputPaths.map((path) => `input/${path}`), outputPaths: validation.files.map((file) => `output/${file.path}`), status: 'rendered', runId });
      const artifact = this.research.createArtifact({ projectId, stage: 'figure', kind: 'figure', title: figure.title,
        path: join(this.research.experiments.root(projectId, runId), figureManifestPath) });
      const record = researchFigurePublicationSchema.parse({ id, projectId, runId, artifactId: artifact.id, title: figure.title,
        sourcePath: run.request.sourcePath, inputPaths: run.request.inputPaths, replacesFigureId, validation, manifestHash, status: 'rendered', createdAt: this.now() });
      this.db.prepare(`INSERT INTO research_figure_publications (figure_id,project_id,run_id,artifact_id,snapshot_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(id, projectId, runId, artifact.id, JSON.stringify(record), record.createdAt);
      for (const subjectType of ['figure', 'artifact'] as const) this.research.addProvenance({ projectId, artifactId: artifact.id,
        subjectType, subjectId: subjectType === 'figure' ? id : artifact.id, sourceType: 'experiment', sourceId: runId,
        locator: `inputs:${run.inputHash}; manifest:${manifestHash}`, excerpt: figure.title });
      if (previous !== null) {
        const stage = this.research.getWorkflow(projectId).stages.find((entry) => entry.stage === 'figure');
        if (stage === undefined || !stage.artifactIds.includes(previous.artifactId)) throw new Error('research_figure_replacement_invalid');
        this.db.prepare("UPDATE research_artifacts SET status = 'superseded', updated_at = ? WHERE id = ?").run(record.createdAt, previous.artifactId);
        this.db.prepare("UPDATE research_stage_states SET artifact_ids_json = ? WHERE project_id = ? AND stage = 'figure'")
          .run(JSON.stringify(stage.artifactIds.filter((artifactId) => artifactId !== previous.artifactId)), projectId);
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
    const run = this.research.experiments.get(record.projectId, record.runId);
    assertFigureRun(run, record.validation);
    if (artifact.kind !== 'figure' || artifact.stage !== 'figure' || artifact.path !== join(this.research.experiments.root(record.projectId, run.id), figureManifestPath)) {
      throw new Error('research_figure_artifact_invalid');
    }
    return record;
  }
}

export function assertFigureRun(run: ResearchExperimentExecution, input: ResearchFigureValidation): void {
  const validation = researchFigureValidationSchema.parse(input);
  if (run.status !== 'completed' || run.request.engine !== 'matplotlib' || run.request.figure === undefined || run.inputHash === null || run.environment === null) {
    throw new Error('research_figure_render_required');
  }
  if (JSON.stringify(run.request.figure) !== JSON.stringify(validation.options)) throw new Error('research_figure_options_changed');
  if (!run.files.some((file) => file.area === 'input' && file.path === figureRendererPath && file.sha256 === validation.rendererHash)) throw new Error('research_figure_renderer_changed');
  for (const expected of validation.files) {
    if (!run.files.some((file) => file.area === 'output' && file.path === expected.path && file.sha256 === expected.sha256 && file.size === expected.size)) {
      throw new Error('research_figure_output_changed');
    }
  }
}

export function figureManifest(run: ResearchExperimentExecution, validation: ResearchFigureValidation): string {
  const { artifactId: _artifactId, ...execution } = run;
  return JSON.stringify({ version: 1, execution, validation }, null, 2);
}
