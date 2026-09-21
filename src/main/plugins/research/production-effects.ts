import type { ResearchExperimentExecution, ResearchScriptExperimentStart, ResearchWorkspaceFileContent, ResearchWorkspaceFileSaveRequest } from '../../../shared/schemas/research-experiments';
import type { ResearchExportExecution, ResearchExportPrepare } from '../../../shared/schemas/research-exports';
import type { ResearchFigurePublication, ResearchFigureStart } from '../../../shared/schemas/research-figures';
import type { ResearchTemplate, ResearchTemplateFileContent } from '../../../shared/types';
import type { ResearchExperimentService } from './experiment-service';
import type { ResearchExportService } from './export-service';
import type { ResearchFigureService } from './figure-service';
import type { ResearchRepository } from './repository';
import type { ResearchTemplateService } from './template-service';
import type { ResearchWorkspaceFileService } from './workspace-files';

type TemplateSave = Parameters<ResearchTemplateService['saveFile']>[0];
type TemplateRead = Parameters<ResearchTemplateService['readFile']>[0];

export class ResearchProductionEffectService {
  constructor(
    private readonly repository: ResearchRepository,
    private readonly files: ResearchWorkspaceFileService,
    private readonly experiments: ResearchExperimentService,
    private readonly figures: ResearchFigureService,
    private readonly templates: ResearchTemplateService,
    private readonly exports: ResearchExportService
  ) {}

  async readWorkspaceFile(ownerRunId: string, projectId: string, path: string): Promise<ResearchWorkspaceFileContent> {
    this.requireOwner(ownerRunId, projectId);
    const result = await this.files.read(projectId, path);
    this.requireOwner(ownerRunId, projectId);
    return result;
  }

  async saveWorkspaceFile(ownerRunId: string, projectId: string, request: Omit<ResearchWorkspaceFileSaveRequest, 'projectId'>): Promise<ResearchWorkspaceFileContent> {
    this.requireOwner(ownerRunId, projectId);
    const result = await this.files.save({ ...request, projectId }, ownerRunId);
    this.requireOwner(ownerRunId, projectId);
    return result;
  }

  async readTemplateFile(ownerRunId: string, projectId: string, request: Omit<TemplateRead, 'projectId'>): Promise<ResearchTemplateFileContent> {
    this.requireOwner(ownerRunId, projectId);
    const result = await this.templates.readFile({ ...request, projectId });
    this.requireOwner(ownerRunId, projectId);
    return result;
  }

  async saveTemplateFile(ownerRunId: string, projectId: string, request: Omit<TemplateSave, 'projectId'>): Promise<ResearchTemplateFileContent> {
    this.requireOwner(ownerRunId, projectId);
    const result = await this.templates.saveFile({ ...request, projectId }, ownerRunId);
    this.requireOwner(ownerRunId, projectId);
    return result;
  }

  async compileTemplate(ownerRunId: string, projectId: string, templateId: string): Promise<ResearchTemplate> {
    this.requireOwner(ownerRunId, projectId);
    const result = await this.templates.compile({ projectId, templateId }, ownerRunId);
    try { this.requireOwner(ownerRunId, projectId); return result; }
    catch (error) {
      await this.templates.cancel({ projectId, templateId });
      throw error;
    }
  }

  async startExperiment(ownerRunId: string, projectId: string, request: Omit<ResearchScriptExperimentStart, 'projectId' | 'ownerRunId'>): Promise<ResearchExperimentExecution> {
    this.requireOwner(ownerRunId, projectId);
    const started = await this.experiments.start({ ...request, projectId, ownerRunId });
    try { this.requireOwner(ownerRunId, projectId); return started; }
    catch (error) {
      if (['preparing', 'running'].includes(started.status)) await this.experiments.cancel(projectId, started.id);
      throw error;
    }
  }

  async startFigure(ownerRunId: string, projectId: string, request: Omit<ResearchFigureStart, 'projectId' | 'ownerRunId'>): Promise<ResearchExperimentExecution> {
    this.requireOwner(ownerRunId, projectId);
    const started = await this.figures.start({ ...request, projectId, ownerRunId });
    try { this.requireOwner(ownerRunId, projectId); return started; }
    catch (error) {
      if (['preparing', 'running'].includes(started.status)) await this.figures.cancel(projectId, started.id);
      throw error;
    }
  }

  getExperiment(ownerRunId: string, projectId: string, experimentId: string): ResearchExperimentExecution {
    return this.requireOwnedExperiment(ownerRunId, projectId, experimentId);
  }

  async publishExperiment(ownerRunId: string, projectId: string, experimentId: string): Promise<ResearchExperimentExecution> {
    this.requireOwnedExperiment(ownerRunId, projectId, experimentId);
    const published = await this.experiments.publish(projectId, experimentId);
    this.requireOwner(ownerRunId, projectId);
    if (published.ownerRunId !== ownerRunId) throw new Error('research_production_owner_mismatch');
    return published;
  }

  async publishFigure(ownerRunId: string, projectId: string, experimentId: string, replacesFigureId: string | null): Promise<ResearchFigurePublication> {
    this.requireOwnedExperiment(ownerRunId, projectId, experimentId);
    const published = await this.figures.publish(projectId, experimentId, replacesFigureId);
    this.requireOwner(ownerRunId, projectId);
    return published;
  }

  async prepareExport(ownerRunId: string, projectId: string, request: Omit<ResearchExportPrepare, 'projectId' | 'ownerRunId'>): Promise<ResearchExportExecution> {
    this.requireOwner(ownerRunId, projectId);
    const started = await this.exports.prepare({ ...request, projectId, ownerRunId });
    try { this.requireOwner(ownerRunId, projectId); return started; }
    catch (error) {
      if (started.status === 'preparing') await this.exports.cancel(projectId, started.id);
      throw error;
    }
  }

  getExport(ownerRunId: string, projectId: string, exportId: string): ResearchExportExecution {
    this.requireOwner(ownerRunId, projectId);
    const record = this.repository.exports.get(projectId, exportId);
    if (record.ownerRunId !== ownerRunId) throw new Error('research_production_owner_mismatch');
    return record;
  }

  async publishExport(ownerRunId: string, projectId: string, exportId: string, replacesExportId: string | null): Promise<ResearchExportExecution> {
    this.requireOwner(ownerRunId, projectId);
    const record = this.repository.exports.get(projectId, exportId);
    if (record.ownerRunId !== ownerRunId) throw new Error('research_production_owner_mismatch');
    const published = await this.exports.publish(projectId, exportId, replacesExportId);
    this.requireOwner(ownerRunId, projectId);
    return published;
  }

  async cancelOwned(projectId: string, ownerRunId: string): Promise<void> {
    const experiments = this.repository.experiments.ownedActive(projectId, ownerRunId);
    const exports = this.repository.exports.ownedPreparing(projectId, ownerRunId);
    for (const run of experiments) this.experiments.abort(run.id);
    for (const record of exports) this.exports.abort(record.id);
    this.templates.abortOwned(ownerRunId);
    await Promise.all([
      ...experiments.map((run) => this.experiments.cancel(projectId, run.id)),
      ...exports.map((record) => this.exports.cancel(projectId, record.id))
    ]);
  }

  private requireOwnedExperiment(ownerRunId: string, projectId: string, experimentId: string): ResearchExperimentExecution {
    this.requireOwner(ownerRunId, projectId);
    const execution = this.repository.experiments.get(projectId, experimentId);
    if (execution.ownerRunId !== ownerRunId) throw new Error('research_production_owner_mismatch');
    return execution;
  }

  private requireOwner(ownerRunId: string, projectId: string) {
    const run = this.repository.runs.requireActive(ownerRunId, projectId);
    if (run.status !== 'running') throw new Error('research_run_not_current');
    return run;
  }
}
