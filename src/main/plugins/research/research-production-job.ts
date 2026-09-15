import type { ResearchExportService } from './export-service';
import type { ResearchExperimentService } from './experiment-service';
import type { ResearchFigureService } from './figure-service';
import type { ResearchRepository } from './repository';

export type ResearchProductionJob = {
  recover(): void;
  verifyStage(projectId: string): Promise<void>;
  shutdown(): Promise<void>;
};

export function createResearchProductionJob(input: {
  repository: ResearchRepository;
  experiments: Pick<ResearchExperimentService, 'recover' | 'shutdown'>;
  figures: Pick<ResearchFigureService, 'verifyStage' | 'shutdown'>;
  exports: Pick<ResearchExportService, 'recover' | 'verifyStage' | 'shutdown'>;
}): ResearchProductionJob {
  return {
    recover() {
      input.experiments.recover();
      input.exports.recover();
    },
    async verifyStage(projectId) {
      const current = input.repository.getWorkflow(projectId).currentStage;
      if (current === 'figure') {
        await input.figures.verifyStage(projectId);
        return;
      }
      if (current === 'export') {
        await input.exports.verifyStage(projectId);
        return;
      }
      throw new Error('research_production_verify_unavailable');
    },
    async shutdown() {
      const results = await Promise.allSettled([
        input.figures.shutdown(),
        input.exports.shutdown(),
        input.experiments.shutdown()
      ]);
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'research_production_shutdown_failed');
    }
  };
}
