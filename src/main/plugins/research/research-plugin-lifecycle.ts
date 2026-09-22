import type { ResearchWorkflowTransitionRequest } from '../../../shared/types';
import type { ResearchExportService } from './export-service';

type ShutdownService = { shutdown(): Promise<void> } | null;

export async function applyResearchWorkflowTransition(input: {
  request: ResearchWorkflowTransitionRequest;
  gate: {
    complete(request: ResearchWorkflowTransitionRequest): Promise<unknown>;
    approve(request: ResearchWorkflowTransitionRequest): Promise<unknown>;
    reject(request: ResearchWorkflowTransitionRequest): Promise<unknown>;
  };
  runtime: { transition(request: ResearchWorkflowTransitionRequest): unknown };
  exports: Pick<ResearchExportService, 'projectChanged'>;
}): Promise<unknown> {
  const request = input.request;
  const snapshot = request.action === 'complete' || request.action === 'approve' || request.action === 'reject'
    ? await input.gate[request.action](request)
    : input.runtime.transition(request);
  input.exports.projectChanged(request.projectId);
  return snapshot;
}

export async function shutdownResearchPlugin(services: {
  productionInputs: ShutdownService;
  exports: ShutdownService;
  figures: ShutdownService;
  experiments: ShutdownService;
  indexer: ShutdownService;
  embeddings: ShutdownService;
  stageRuntime: ShutdownService;
  templates: ShutdownService;
  documents: ShutdownService;
  library: ShutdownService;
}): Promise<void> {
  const ordered = [
    services.productionInputs,
    services.exports,
    services.figures,
    services.experiments,
    services.indexer,
    services.embeddings,
    services.stageRuntime,
    services.templates,
    services.documents,
    services.library
  ];
  const results = await Promise.allSettled(ordered.map((service) => service?.shutdown()));
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, 'research_shutdown_failed');
}
