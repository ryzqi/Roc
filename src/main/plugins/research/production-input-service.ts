import type { ResearchProductionInput, ResearchProductionInputContent, ResearchProductionInputRead } from '../../../shared/schemas/research-production-inputs';
import {researchProductionReviewRequestSchema, researchProductionReviewReadSchema,
  type ResearchProductionReviewRequest, type ResearchProductionReviewRead} from '../../../shared/schemas/research-production-review';
import type { ResearchExperimentService } from './experiment-service';
import type { ResearchFigureService } from './figure-service';
import type { ResearchExportService } from './export-service';
import { ResearchJobSession } from './research-job-session';
import type { ResearchRepository } from './repository';

export class ResearchProductionInputService {
  private readonly session = new ResearchJobSession('research_production_input_closed');
  constructor(private readonly repository: ResearchRepository, private readonly experiments: Pick<ResearchExperimentService, 'verifyPublication' | 'read'>,
    private readonly figures: Pick<ResearchFigureService, 'verify' | 'read'>, private readonly exports: Pick<ResearchExportService, 'inspect' | 'read'>) {}

  async inspect(projectId: string, artifactId: string): Promise<ResearchProductionInput> {
    return this.session.guard(() => this.inspectInput(projectId, artifactId, 'approved'));
  }

  async read(request: ResearchProductionInputRead): Promise<ResearchProductionInputContent> {
    return this.session.guard(() => this.readFile(request, 'approved', null));
  }

  async inspectReview(value: ResearchProductionReviewRequest): Promise<ResearchProductionInput> {
    const request = researchProductionReviewRequestSchema.parse(value);
    return this.session.guard(async () => {
      this.assertReview(request);
      const result = await this.inspectInput(request.projectId, request.artifactId, 'review');
      this.assertReview(request);
      return result;
    });
  }

  async readReview(value: ResearchProductionReviewRead): Promise<ResearchProductionInputContent> {
    const request = researchProductionReviewReadSchema.parse(value);
    return this.session.guard(async () => {
      this.assertReview(request);
      const result = await this.readFile(request, 'review', request.expectedFileHash);
      this.assertReview(request);
      return result;
    });
  }

  private assertReview(request: ResearchProductionReviewRequest): void {
    const result = this.repository.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId,
      expectedVersion: request.expectedVersion});
    if (result.snapshot.projectStatus === 'archived') throw new Error('research_project_archived');
    if (result.status !== 'current') throw new Error('research_production_review_changed');
    if (result.snapshot.artifact.status === 'superseded') throw new Error('research_production_artifact_superseded');
    if (result.snapshot.artifact.status !== 'approved' && !result.snapshot.availableActions.includes('review_gate')) {
      throw new Error('research_production_review_unavailable');
    }
    if (result.snapshot.production === null) throw new Error('research_production_artifact_required');
  }

  private async inspectInput(projectId: string, artifactId: string, access: 'approved' | 'review'): Promise<ResearchProductionInput> {
    const input = this.resolve(projectId, artifactId, access);
    if (input.source.kind === 'experiment') await this.experiments.verifyPublication(projectId, artifactId);
    else if (input.source.kind === 'figure') await this.figures.verify(projectId, input.source.figure.id);
    else await this.exports.inspect(projectId, input.source.execution.id);
    this.session.requireOpen();
    return this.resolve(projectId, artifactId, access);
  }

  private async readFile(request: ResearchProductionInputRead, access: 'approved' | 'review', expectedFileHash: string | null): Promise<ResearchProductionInputContent> {
    const input = this.resolve(request.projectId, request.artifactId, access);
    const file = input.files.find((entry) => entry.area === request.area && entry.path === request.path);
    if (file === undefined) throw new Error('research_production_file_not_found');
    if (expectedFileHash !== null && expectedFileHash !== file.sha256) throw new Error('research_production_snapshot_changed');
    if (file.size > 4 * 1024 * 1024) throw new Error('research_production_preview_limit');
    let content: { file: { sha256: string; size: number }; content: string; encoding: 'utf8' | 'base64' };
    if (input.source.kind === 'export') {
      if (request.area !== 'bundle') throw new Error('research_production_file_not_found');
      content = await this.exports.read(request.projectId, input.source.execution.id, request.path);
    } else {
      if (request.area === 'bundle') throw new Error('research_production_file_not_found');
      const fileRequest = {projectId: request.projectId, runId: input.source.execution.id, area: request.area, path: request.path};
      content = input.source.kind === 'figure' ? await this.figures.read(fileRequest) : await this.experiments.read(fileRequest);
    }
    this.session.requireOpen();
    const latest = this.resolve(request.projectId, request.artifactId, access).files.find(entry => entry.area === file.area && entry.path === file.path);
    if (latest === undefined || latest.sha256 !== file.sha256 || latest.size !== file.size ||
      content.file.sha256 !== file.sha256 || content.file.size !== file.size) throw new Error('research_production_snapshot_changed');
    return { file, content: content.content, encoding: content.encoding };
  }

  private resolve(projectId: string, artifactId: string, access: 'approved' | 'review'): ResearchProductionInput {
    const artifact = this.repository.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_production_project_mismatch');
    if (access === 'approved' && artifact.status !== 'approved') throw new Error('research_production_approval_required');
    if (artifact.kind === 'experiment_run') {
      const execution = this.repository.experiments.forArtifact(artifact);
      return { artifact, files: execution.files, source: { kind: 'experiment', execution } };
    }
    if (artifact.kind === 'figure') {
      const figure = this.repository.figures.forArtifact(artifact);
      const execution = this.repository.figureRuns.get(projectId, figure.runId);
      return { artifact, files: execution.files, source: { kind: 'figure', figure, execution } };
    }
    if (artifact.kind === 'export_package') {
      const execution = this.repository.exports.forArtifact(artifact);
      return { artifact, files: execution.files.map((file) => ({ ...file, area: 'bundle' })), source: { kind: 'export', execution } };
    }
    throw new Error('research_production_artifact_required');
  }

  async shutdown(): Promise<void> { await this.session.shutdown(); }
}
