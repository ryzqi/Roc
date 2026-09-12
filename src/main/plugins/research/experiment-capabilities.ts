import { basename, extname } from 'node:path';
import { z } from 'zod';
import { researchExperimentEnvironmentRequestSchema, researchExperimentEnvironmentSchema, researchExperimentEvidenceRequestSchema,
  researchExperimentExecutionSchema, researchExperimentFileContentSchema, researchExperimentFileRequestSchema, researchExperimentIdRequestSchema,
  researchExperimentListRequestSchema, researchExperimentSourceRequestSchema, researchExperimentStartSchema } from '../../../shared/schemas/research-experiments';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchExperimentRepository } from './experiment-repository';
import type { ResearchExperimentService } from './experiment-service';

const capabilities = {
  environment: descriptor('research.experiment.environment', researchExperimentEnvironmentRequestSchema, researchExperimentEnvironmentSchema),
  start: descriptor('research.experiment.start', researchExperimentStartSchema, researchExperimentExecutionSchema),
  get: descriptor('research.experiment.get', researchExperimentIdRequestSchema, researchExperimentExecutionSchema),
  list: descriptor('research.experiment.list', researchExperimentListRequestSchema, researchExperimentExecutionSchema.array()),
  cancel: descriptor('research.experiment.cancel', researchExperimentIdRequestSchema, researchExperimentExecutionSchema),
  read: descriptor('research.experiment.read', researchExperimentFileRequestSchema, researchExperimentFileContentSchema),
  publish: descriptor('research.experiment.publish', researchExperimentIdRequestSchema, researchExperimentExecutionSchema),
  evidence: descriptor('research.experiment.evidenceSource', researchExperimentEvidenceRequestSchema, researchExperimentFileRequestSchema.nullable()),
  source: descriptor('research.experiment.source', researchExperimentSourceRequestSchema, z.unknown())
};
export const researchExperimentCapabilities = Object.values(capabilities);

export function registerResearchExperimentCapabilities(context: RocPluginContext, repository: ResearchExperimentRepository, service: ResearchExperimentService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => await run(capability.inputSchema.parse(input)));
  }
  register(capabilities.environment, (input) => service.inspect(input.projectId, input.runtime));
  register(capabilities.start, (input) => service.start(input));
  register(capabilities.get, (input) => repository.get(input.projectId, input.runId));
  register(capabilities.list, (input) => repository.list(input.projectId, input.limit));
  register(capabilities.cancel, (input) => service.cancel(input.projectId, input.runId));
  register(capabilities.read, (input) => service.read(input));
  register(capabilities.publish, (input) => service.publish(input.projectId, input.runId));
  register(capabilities.evidence, (input) => service.evidenceSource(input.projectId, input.evidenceId));
  register(capabilities.source, async (input) => {
    const { bytes, file } = await service.source(input);
    if (file.sha256 !== input.sha256) throw new Error('research_experiment_snapshot_changed');
    const mediaTypes: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
    const mediaType = mediaTypes[extname(file.path).toLowerCase()];
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': mediaType ?? 'application/octet-stream', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'content-disposition': `${mediaType === undefined ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(file.path))}` } });
  });
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
