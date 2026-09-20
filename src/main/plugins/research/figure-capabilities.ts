import { z } from 'zod';
import { researchExperimentEnvironmentRequestSchema, researchExperimentEnvironmentSchema, researchExperimentExecutionSchema,
  researchExperimentIdRequestSchema } from '../../../shared/schemas/research-experiments';
import { researchFigureIdRequestSchema, researchFigureListRequestSchema, researchFigurePublicationSchema,
  researchFigurePublishRequestSchema, researchFigureSourceRequestSchema, researchFigureStartSchema } from '../../../shared/schemas/research-figures';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchFigureRepository } from './figure-repository';
import type { ResearchFigureService } from './figure-service';

const capabilities = {
  environment: descriptor('research.figure.environment', researchExperimentEnvironmentRequestSchema, researchExperimentEnvironmentSchema),
  start: descriptor('research.figure.start', researchFigureStartSchema, researchExperimentExecutionSchema),
  getRun: descriptor('research.figure.getRun', researchExperimentIdRequestSchema, researchExperimentExecutionSchema),
  cancel: descriptor('research.figure.cancel', researchExperimentIdRequestSchema, researchExperimentExecutionSchema),
  get: descriptor('research.figure.get', researchFigureIdRequestSchema, researchFigurePublicationSchema),
  list: descriptor('research.figure.list', researchFigureListRequestSchema, researchFigurePublicationSchema.array()),
  publish: descriptor('research.figure.publish', researchFigurePublishRequestSchema, researchFigurePublicationSchema),
  source: descriptor('research.figure.source', researchFigureSourceRequestSchema, z.unknown())
};
export const researchFigureCapabilities = Object.values(capabilities);

export function registerResearchFigureCapabilities(context: RocPluginContext, repository: ResearchFigureRepository, service: ResearchFigureService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => await run(capability.inputSchema.parse(input)));
  }
  register(capabilities.environment, (input) => service.inspect(input.projectId, input.runtime));
  register(capabilities.start, (input) => service.start(input));
  register(capabilities.getRun, (input) => service.getRun(input.projectId, input.runId));
  register(capabilities.cancel, (input) => service.cancel(input.projectId, input.runId));
  register(capabilities.get, (input) => repository.get(input.projectId, input.figureId));
  register(capabilities.list, (input) => repository.list(input.projectId, input.limit));
  register(capabilities.publish, (input) => service.publish(input.projectId, input.runId, input.replacesFigureId));
  register(capabilities.source, async (input) => {
    const bytes = await service.source(input);
    const mediaTypes = { png: 'image/png', svg: 'image/svg+xml', pdf: 'application/pdf' };
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': mediaTypes[input.format], 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      'content-disposition': `inline; filename="figure.${input.format}"` } });
  });
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
