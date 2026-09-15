import type { z } from 'zod';
import type { ResearchFigurePublication, researchFigureSourceRequestSchema } from '../../../shared/schemas/research-figures';
import { researchFigureValidationSchema } from '../../../shared/schemas/research-plotting';
import { experimentFileLimit } from './experiment-files';
import type { ResearchExperimentService } from './experiment-service';
import { assertFigureRun, figureManifest, figureManifestPath } from './figure-repository';
import { figureValidationPath } from './figure-runner';
import { writeFrozenManifest } from './research-frozen-manifest';
import { ResearchJobSession } from './research-job-session';
import { readResearchFile, researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';

export class ResearchFigureService {
  private readonly session = new ResearchJobSession('research_figure_service_closed');
  constructor(private readonly repository: ResearchRepository, private readonly experiments: ResearchExperimentService) {}

  async publish(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    return await this.session.guard(async () => this.publishRun(projectId, runId, replacesFigureId));
  }

  private async publishRun(projectId: string, runId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    this.session.requireOpen();
    const run = await this.experiments.snapshot(projectId, runId);
    const validation = await this.validation(projectId, runId);
    assertFigureRun(run, validation);
    const content = figureManifest(run, validation);
    const hash = await writeFrozenManifest({
      root: this.repository.experiments.root(projectId, runId),
      path: figureManifestPath,
      content,
      limit: experimentFileLimit,
      changedCode: 'research_figure_manifest_changed'
    });
    this.session.requireOpen();
    return this.repository.figures.publish(projectId, runId, replacesFigureId, validation, hash);
  }

  async verify(projectId: string, figureId: string): Promise<ResearchFigurePublication> {
    this.session.requireOpen();
    const record = this.repository.figures.get(projectId, figureId);
    const run = await this.experiments.snapshot(projectId, record.runId);
    const validation = await this.validation(projectId, record.runId);
    assertFigureRun(run, validation);
    const bytes = await readResearchFile(this.repository.experiments.root(projectId, record.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(bytes) !== record.manifestHash || researchContentHash(figureManifest(run, validation)) !== record.manifestHash) throw new Error('research_figure_manifest_changed');
    return record;
  }

  async verifyStage(projectId: string): Promise<void> {
    await this.session.guard(async () => {
      const stage = this.repository.getWorkflow(projectId).stages.find((entry) => entry.stage === 'figure');
      if (stage === undefined) throw new Error('research_stage_not_found');
      for (const id of stage.artifactIds) {
        const record = this.repository.figures.forArtifact(this.repository.getArtifact(id));
        await this.verify(projectId, record.id);
      }
      this.session.requireOpen();
    });
  }

  async source(input: z.infer<typeof researchFigureSourceRequestSchema>): Promise<Buffer> {
    this.session.requireOpen();
    const figure = this.repository.figures.get(input.projectId, input.figureId);
    const expected = figure.validation.files.find((file) => file.path === `figure.${input.format}`);
    if (expected === undefined || expected.sha256 !== input.sha256) throw new Error('research_figure_output_changed');
    const manifest = await readResearchFile(this.repository.experiments.root(input.projectId, figure.runId), figureManifestPath, experimentFileLimit);
    if (researchContentHash(manifest) !== figure.manifestHash) throw new Error('research_figure_manifest_changed');
    const { bytes, file } = await this.experiments.source({ projectId: input.projectId, runId: figure.runId, area: 'output', path: expected.path });
    if (file.sha256 !== expected.sha256 || file.size !== expected.size) throw new Error('research_figure_output_changed');
    return bytes;
  }

  async shutdown(): Promise<void> { await this.session.shutdown(); }

  private async validation(projectId: string, runId: string) {
    const { bytes } = await this.experiments.source({ projectId, runId, area: 'output', path: figureValidationPath });
    return researchFigureValidationSchema.parse(JSON.parse(bytes.toString('utf8')));
  }
}
