import type { ResearchProductionInput, ResearchProductionInputContent, ResearchProductionInputRead } from '../../../shared/schemas/research-production-inputs';
import type { ResearchExperimentService } from './experiment-service';
import type { ResearchFigureService } from './figure-service';
import type { ResearchExportService } from './export-service';
import { ResearchJobSession } from './research-job-session';
import type { ResearchRepository } from './repository';

export class ResearchProductionInputService {
  private readonly session = new ResearchJobSession('research_production_input_closed');
  constructor(private readonly repository: ResearchRepository, private readonly experiments: Pick<ResearchExperimentService, 'snapshot' | 'read'>,
    private readonly figures: Pick<ResearchFigureService, 'verify'>, private readonly exports: Pick<ResearchExportService, 'inspect' | 'read'>) {}

  async inspect(projectId: string, artifactId: string): Promise<ResearchProductionInput> {
    return await this.session.guard(async () => {
      const input = this.resolve(projectId, artifactId);
      if (input.source.kind === 'experiment') await this.experiments.snapshot(projectId, input.source.execution.id);
      else if (input.source.kind === 'figure') await this.figures.verify(projectId, input.source.figure.id);
      else await this.exports.inspect(projectId, input.source.execution.id);
      this.session.requireOpen();
      return this.resolve(projectId, artifactId);
    });
  }

  async read(request: ResearchProductionInputRead): Promise<ResearchProductionInputContent> {
    return await this.session.guard(async () => this.readFile(request));
  }

  private async readFile(request: ResearchProductionInputRead): Promise<ResearchProductionInputContent> {
    const input = this.resolve(request.projectId, request.artifactId);
    const file = input.files.find((entry) => entry.area === request.area && entry.path === request.path);
    if (file === undefined) throw new Error('research_production_file_not_found');
    if (file.size > 4 * 1024 * 1024) throw new Error('research_production_preview_limit');
    let content: { file: { sha256: string; size: number }; content: string; encoding: 'utf8' | 'base64' };
    if (input.source.kind === 'export') {
      if (request.area !== 'bundle') throw new Error('research_production_file_not_found');
      content = await this.exports.read(request.projectId, input.source.execution.id, request.path);
    } else {
      if (request.area === 'bundle') throw new Error('research_production_file_not_found');
      content = await this.experiments.read({ projectId: request.projectId, runId: input.source.execution.id, area: request.area, path: request.path });
    }
    this.session.requireOpen();
    this.resolve(request.projectId, request.artifactId);
    if (content.file.sha256 !== file.sha256 || content.file.size !== file.size) throw new Error('research_production_snapshot_changed');
    return { file, content: content.content, encoding: content.encoding };
  }

  private resolve(projectId: string, artifactId: string): ResearchProductionInput {
    const artifact = this.repository.getArtifact(artifactId);
    if (artifact.projectId !== projectId) throw new Error('research_production_project_mismatch');
    if (artifact.status !== 'approved') throw new Error('research_production_approval_required');
    if (artifact.kind === 'experiment_run') {
      const execution = this.repository.experiments.forArtifact(artifact);
      return { artifact, files: execution.files, source: { kind: 'experiment', execution } };
    }
    if (artifact.kind === 'figure') {
      const figure = this.repository.figures.forArtifact(artifact);
      const execution = this.repository.experiments.get(projectId, figure.runId);
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
