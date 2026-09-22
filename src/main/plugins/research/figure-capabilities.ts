import { basename, extname } from 'node:path';
import { z } from 'zod';
import { researchExperimentEnvironmentRequestSchema, researchExperimentEnvironmentSchema, researchExperimentFileContentSchema,
  researchExperimentFileRequestSchema, researchExperimentIdRequestSchema, researchExperimentSourceRequestSchema } from '../../../shared/schemas/research-experiments';
import { researchFigureIdRequestSchema, researchFigureListRequestSchema, researchFigurePublicationSchema,
  researchFigurePublishRequestSchema, researchFigureRunSchema, researchFigureSourceRequestSchema, researchFigureStartSchema } from '../../../shared/schemas/research-figures';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchFigureRepository } from './figure-repository';
import type { ResearchFigureService } from './figure-service';

const capabilities = {
  environment: descriptor('research.figure.environment', researchExperimentEnvironmentRequestSchema, researchExperimentEnvironmentSchema),
  start: descriptor('research.figure.start', researchFigureStartSchema, researchFigureRunSchema),
  getRun: descriptor('research.figure.getRun', researchExperimentIdRequestSchema, researchFigureRunSchema),
  listRuns: descriptor('research.figure.listRuns', researchFigureListRequestSchema, researchFigureRunSchema.array()),
  cancel: descriptor('research.figure.cancel', researchExperimentIdRequestSchema, researchFigureRunSchema),
  read: descriptor('research.figure.read', researchExperimentFileRequestSchema, researchExperimentFileContentSchema),
  runSource: descriptor('research.figure.runSource', researchExperimentSourceRequestSchema, z.unknown()),
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
  register(capabilities.listRuns, (input) => service.list(input.projectId, input.limit));
  register(capabilities.cancel, (input) => service.cancel(input.projectId, input.runId));
  register(capabilities.read, (input) => service.read(input));
  register(capabilities.runSource, async (input) => {
    const loaded = await service.read(input);
    if (loaded.file.sha256 !== input.sha256) throw new Error('research_figure_snapshot_changed');
    const bytes = loaded.encoding === 'base64' ? Buffer.from(loaded.content, 'base64') : Buffer.from(loaded.content, 'utf8');
    const mediaTypes: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml' };
    const mediaType = mediaTypes[extname(loaded.file.path).toLowerCase()];
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': mediaType ?? 'application/octet-stream', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      'content-disposition': `${mediaType === undefined ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(loaded.file.path))}` } });
  });
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
