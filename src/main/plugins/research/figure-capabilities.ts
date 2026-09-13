import { z } from 'zod';
import { researchFigureIdRequestSchema, researchFigureListRequestSchema, researchFigurePublicationSchema,
  researchFigurePublishRequestSchema, researchFigureSourceRequestSchema } from '../../../shared/schemas/research-figures';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchFigureRepository } from './figure-repository';
import type { ResearchFigureService } from './figure-service';

const capabilities = {
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
