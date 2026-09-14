import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import {
  researchIdeaCanvasSaveRequestSchema,
  researchIdeaCanvasSchema
} from '../../../shared/schemas/research-ideas';
import type {
  ResearchArtifact,
  ResearchIdeaCanvas,
  ResearchIdeaCanvasSaveRequest,
  ResearchIdeaPromoteRequest,
  ResearchIdeaPromotion
} from '../../../shared/types';
import type { ResearchRepository } from './repository';

const ideaFieldKeys = [
  'problem',
  'hypothesis',
  'novelty',
  'supportingEvidence',
  'counterevidence',
  'experiment',
  'risks'
] as const;

export class ResearchIdeaRepository {
  constructor(
    private readonly db: Database,
    private readonly research: ResearchRepository,
    private readonly now: () => string
  ) {}

  save(input: ResearchIdeaCanvasSaveRequest): ResearchIdeaCanvas {
    const request = researchIdeaCanvasSaveRequestSchema.parse(input);
    const artifact = this.research.requireEditableArtifact(request.artifactId);
    if (artifact.kind !== 'idea_canvas') throw new Error('research_idea_canvas_artifact_required');
    this.validateFields(request, artifact.projectId);
    const current = this.get(request.artifactId);
    if (current === null) {
      if (request.expectedVersion !== null) throw new Error('research_idea_canvas_version_conflict');
    } else if (request.expectedVersion !== current.version) {
      throw new Error('research_idea_canvas_version_conflict');
    }
    const timestamp = this.now();
    const canvas: ResearchIdeaCanvas = {
      artifactId: artifact.id,
      projectId: artifact.projectId,
      version: current === null ? 1 : current.version + 1,
      problem: request.problem,
      hypothesis: request.hypothesis,
      novelty: request.novelty,
      supportingEvidence: request.supportingEvidence,
      counterevidence: request.counterevidence,
      experiment: request.experiment,
      risks: request.risks,
      priority: request.priority,
      rationale: request.rationale,
      fields: request.fields,
      contentHash: hashCanvas(request),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO research_idea_canvases (artifact_id, project_id, version, snapshot_json, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(artifact_id) DO UPDATE SET
         version = excluded.version, snapshot_json = excluded.snapshot_json, content_hash = excluded.content_hash, updated_at = excluded.updated_at`
      ).run(canvas.artifactId, canvas.projectId, canvas.version, JSON.stringify(canvas), canvas.contentHash, canvas.createdAt, canvas.updatedAt);
      this.db.prepare('INSERT INTO research_idea_canvas_revisions (artifact_id, version, snapshot_json) VALUES (?, ?, ?)')
        .run(canvas.artifactId, canvas.version, JSON.stringify(canvas));
      this.db.prepare('UPDATE research_artifacts SET updated_at = ? WHERE id = ?').run(timestamp, artifact.id);
      this.db.prepare(
        `INSERT INTO research_workflow_events (id, project_id, stage, type, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), artifact.projectId, artifact.stage, 'idea_canvas_saved', artifact.title,
        JSON.stringify({ artifactId: artifact.id, version: canvas.version }), timestamp);
    })();
    return canvas;
  }

  get(artifactId: string): ResearchIdeaCanvas | null {
    this.research.getArtifact(artifactId);
    const row = this.db.prepare('SELECT snapshot_json FROM research_idea_canvases WHERE artifact_id = ?').get(artifactId) as { snapshot_json: string } | undefined;
    if (row === undefined) return null;
    return researchIdeaCanvasSchema.parse(JSON.parse(row.snapshot_json));
  }

  history(artifactId: string): ResearchIdeaCanvas[] {
    this.getRequired(artifactId);
    return this.db.prepare('SELECT snapshot_json FROM research_idea_canvas_revisions WHERE artifact_id = ? ORDER BY version DESC')
      .all(artifactId).map((row) => researchIdeaCanvasSchema.parse(JSON.parse((row as { snapshot_json: string }).snapshot_json)));
  }

  assertPublishable(artifact: ResearchArtifact): void {
    if (artifact.kind !== 'idea_canvas') throw new Error('research_idea_canvas_artifact_required');
    const canvas = this.getRequired(artifact.id);
    if (canvas.projectId !== artifact.projectId) throw new Error('research_idea_canvas_project_mismatch');
    if (canvas.contentHash !== hashCanvas(canvas)) throw new Error('research_idea_canvas_stale');
    this.validateFields(canvas, artifact.projectId);
  }

  promote(input: ResearchIdeaPromoteRequest): ResearchIdeaPromotion {
    const artifact = this.research.getArtifact(input.artifactId);
    if (artifact.kind !== 'idea_canvas') throw new Error('research_idea_canvas_artifact_required');
    if (artifact.status !== 'approved') throw new Error('research_idea_canvas_approval_required');
    const canvas = this.getRequired(artifact.id);
    if (input.expectedVersion !== canvas.version) throw new Error('research_idea_canvas_version_conflict');
    this.assertPublishable(artifact);
    const source = this.research.getProject(artifact.projectId);
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id FROM research_projects WHERE origin_artifact_id = ? AND origin_version = ?'
      ).get(artifact.id, canvas.version) as { id: string } | undefined;
      if (existing !== undefined) return { canvas, project: this.research.getProject(existing.id) };
      const origin = { projectId: artifact.projectId, artifactId: artifact.id, version: canvas.version };
      const project = this.research.createProject({
        title: input.title ?? artifact.title,
        description: input.description ?? canvas.problem,
        workspacePath: input.workspacePath === undefined ? source.workspacePath : input.workspacePath,
        language: input.language ?? source.language
      }, origin);
      this.db.prepare(
        `INSERT INTO research_workflow_events (id, project_id, stage, type, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), artifact.projectId, artifact.stage, 'idea_canvas_promoted', artifact.title,
        JSON.stringify({ artifactId: artifact.id, version: canvas.version, projectId: project.id }), this.now());
      return { canvas, project };
    })();
  }

  private getRequired(artifactId: string): ResearchIdeaCanvas {
    const canvas = this.get(artifactId);
    if (canvas === null) throw new Error('research_idea_canvas_required');
    return canvas;
  }

  private validateFields(canvas: Pick<ResearchIdeaCanvas, 'fields' | 'problem' | 'hypothesis' | 'novelty' | 'supportingEvidence' | 'counterevidence' | 'experiment' | 'risks'>, projectId: string): void {
    const expected = {
      problem: canvas.problem,
      hypothesis: canvas.hypothesis,
      novelty: canvas.novelty,
      supportingEvidence: canvas.supportingEvidence,
      counterevidence: canvas.counterevidence,
      experiment: canvas.experiment,
      risks: canvas.risks
    };
    if (canvas.fields.length !== ideaFieldKeys.length) throw new Error('research_idea_canvas_fields_invalid');
    const seen = new Set<string>();
    for (const field of canvas.fields) {
      if (seen.has(field.key) || field.content !== expected[field.key]) throw new Error('research_idea_canvas_fields_invalid');
      seen.add(field.key);
      if (field.status === 'supported' && field.evidenceIds.length === 0) throw new Error('research_claim_evidence_required');
      for (const evidenceId of field.evidenceIds) this.research.evidence.getEvidence(evidenceId, projectId);
    }
    for (const key of ideaFieldKeys) {
      if (!seen.has(key)) throw new Error('research_idea_canvas_fields_invalid');
    }
  }
}

function hashCanvas(canvas: Pick<ResearchIdeaCanvas, 'problem' | 'hypothesis' | 'novelty' | 'supportingEvidence' | 'counterevidence' | 'experiment' | 'risks' | 'priority' | 'rationale' | 'fields'>): string {
  return createHash('sha256').update(JSON.stringify({
    problem: canvas.problem,
    hypothesis: canvas.hypothesis,
    novelty: canvas.novelty,
    supportingEvidence: canvas.supportingEvidence,
    counterevidence: canvas.counterevidence,
    experiment: canvas.experiment,
    risks: canvas.risks,
    priority: canvas.priority,
    rationale: canvas.rationale,
    fields: canvas.fields
  })).digest('hex');
}
