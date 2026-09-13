import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { ResearchFigurePublication, researchFigureSourceRequestSchema } from '../../../shared/schemas/research-figures';
import { researchFigureValidationSchema } from '../../../shared/schemas/research-plotting';
import type { ResearchWorkflowSnapshot, ResearchWorkflowTransitionRequest } from '../../../shared/types';
import { experimentFileLimit } from './experiment-files';
import type { ResearchExperimentService } from './experiment-service';
import { assertFigureRun, figureManifest, figureManifestPath } from './figure-repository';
import { figureValidationPath } from './figure-runner';
import { readResearchFile, researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';

export class ResearchFigureService {
  private closed = false;
  private readonly operations = new Set<Promise<unknown>>();
  constructor(private readonly repository: ResearchRepository, private readonly experiments: ResearchExperimentService) {}

  async publish(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    return await this.task(() => this.publishRun(projectId, runId, replacesFigureId));
  }

  private async publishRun(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    this.requireOpen();
    const run = await this.experiments.snapshot(projectId, runId);
    const validation = await this.validation(projectId, runId);
    assertFigureRun(run, validation);
    const content = figureManifest(run, validation);
    const root = this.repository.experiments.root(projectId, runId);
    try { await writeFile(join(root, figureManifestPath), content, { flag: 'wx', mode: 0o400 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (researchContentHash(await readResearchFile(root, figureManifestPath, experimentFileLimit)) !== researchContentHash(content)) throw new Error('research_figure_manifest_changed');
    }
    this.requireOpen();
    return this.repository.figures.publish(projectId, runId, replacesFigureId, validation, researchContentHash(content));
  }

  async verify(projectId: string, figureId: string): Promise<ResearchFigurePublication> {
    this.requireOpen();
    const record = this.repository.figures.get(projectId, figureId);
    const run = await this.experiments.snapshot(projectId, record.runId);
    const validation = await this.validation(projectId, record.runId);
    assertFigureRun(run, validation);
    const bytes = await readResearchFile(this.repository.experiments.root(projectId, record.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(bytes) !== record.manifestHash || researchContentHash(figureManifest(run, validation)) !== record.manifestHash) throw new Error('research_figure_manifest_changed');
    return record;
  }

  async verifyStage(projectId: string): Promise<void> {
    this.requireOpen();
    const stage = this.repository.getWorkflow(projectId).stages.find((entry) => entry.stage === 'figure');
    if (stage === undefined) throw new Error('research_stage_not_found');
    for (const id of stage.artifactIds) {
      const record = this.repository.figures.forArtifact(this.repository.getArtifact(id));
      await this.verify(projectId, record.id);
    }
  }

  async transition(request: ResearchWorkflowTransitionRequest): Promise<ResearchWorkflowSnapshot> {
    if (request.expectedStage !== 'figure' || (request.action !== 'complete' && request.action !== 'approve')) throw new Error('research_figure_transition_invalid');
    return await this.task(async () => {
      const signature = this.reviewSignature(request.projectId);
      await this.verifyStage(request.projectId);
      this.requireOpen();
      if (signature !== this.reviewSignature(request.projectId)) throw new Error('research_figure_review_changed');
      return this.repository.transitionWorkflow(request);
    });
  }

  async source(input: z.infer<typeof researchFigureSourceRequestSchema>): Promise<Buffer> {
    this.requireOpen();
    const figure = this.repository.figures.get(input.projectId, input.figureId);
    const expected = figure.validation.files.find((file) => file.path === `figure.${input.format}`);
    if (expected === undefined || expected.sha256 !== input.sha256) throw new Error('research_figure_output_changed');
    const manifest = await readResearchFile(this.repository.experiments.root(input.projectId, figure.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(manifest) !== figure.manifestHash) throw new Error('research_figure_manifest_changed');
    const { bytes, file } = await this.experiments.source({ projectId: input.projectId, runId: figure.runId, area: 'output', path: expected.path });
    if (file.sha256 !== expected.sha256 || file.size !== expected.size) throw new Error('research_figure_output_changed');
    return bytes;
  }

  async shutdown(): Promise<void> { this.closed = true; await Promise.allSettled([...this.operations]); }
  private requireOpen(): void { if (this.closed) throw new Error('research_figure_service_closed'); }

  private async task<T>(operation: () => Promise<T>): Promise<T> {
    this.requireOpen();
    const pending = Promise.resolve().then(() => { this.requireOpen(); return operation(); });
    this.operations.add(pending);
    try { return await pending; }
    finally { this.operations.delete(pending); }
  }

  private reviewSignature(projectId: string): string {
    const workflow = this.repository.getWorkflow(projectId);
    const stage = workflow.stages.find((entry) => entry.stage === 'figure');
    if (stage === undefined) throw new Error('research_stage_not_found');
    const artifacts = stage.artifactIds.map((id) => ({ artifact: this.repository.getArtifact(id),
      claims: this.repository.evidence.listClaims({ projectId, artifactId: id }) }));
    return researchContentHash(JSON.stringify({ currentStage: workflow.currentStage, projectStatus: workflow.projectStatus, stage, artifacts }));
  }
  private async validation(projectId: string, runId: string) {
    const { bytes } = await this.experiments.source({ projectId, runId, area: 'output', path: figureValidationPath });
    return researchFigureValidationSchema.parse(JSON.parse(bytes.toString('utf8')));
  }
}
