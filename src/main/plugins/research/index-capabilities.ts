import { basename, extname } from 'node:path';
import { z } from 'zod';
import {
  researchIndexedFileSchema, researchIndexedSourceSchema, researchIndexControlRequestSchema, researchIndexEvidenceSourceRequestSchema,
  researchIndexFilesRequestSchema, researchIndexJobsRequestSchema, researchIndexJobSchema, researchIndexProjectRequestSchema,
  researchIndexSettingsSaveSchema, researchIndexSourceRequestSchema, researchIndexStatusSchema
} from '../../../shared/schemas/research-index';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import { documentMediaTypes } from './document-files';
import type { ResearchIndexRepository } from './index-repository';
import type { ResearchIndexService } from './index-service';

const capabilities = {
  status: descriptor('research.index.status', researchIndexProjectRequestSchema, researchIndexStatusSchema),
  settings: descriptor('research.index.configure', researchIndexSettingsSaveSchema, researchIndexStatusSchema),
  control: descriptor('research.index.control', researchIndexControlRequestSchema, researchIndexStatusSchema),
  files: descriptor('research.index.files', researchIndexFilesRequestSchema, researchIndexedFileSchema.array()),
  jobs: descriptor('research.index.jobs', researchIndexJobsRequestSchema, researchIndexJobSchema.array()),
  evidenceSource: descriptor('research.index.evidenceSource', researchIndexEvidenceSourceRequestSchema, researchIndexedSourceSchema.nullable()),
  source: descriptor('research.index.source', researchIndexSourceRequestSchema, z.unknown())
};
export const researchIndexCapabilities = Object.values(capabilities);

export function registerResearchIndexCapabilities(context: RocPluginContext, repository: ResearchIndexRepository, service: ResearchIndexService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) {
        if (error instanceof Error && error.message === 'research_index_settings_changed') {
          throw new RocDomainError({ code: error.message, message: '索引配置已变化，请刷新后重试。', category: 'conflict', retryable: false });
        }
        throw error;
      }
    });
  }
  register(capabilities.status, (input) => service.status(input.projectId));
  register(capabilities.settings, (input) => service.configure(input));
  register(capabilities.control, (input) => service.control(input));
  register(capabilities.files, (input) => repository.listFiles(input.projectId, input.query, input.includeMissing, input.limit));
  register(capabilities.jobs, (input) => repository.listJobs(input.projectId, input.limit));
  register(capabilities.evidenceSource, (input) => service.evidenceSource(input.projectId, input.evidenceId));
  register(capabilities.source, async (input) => {
    const source = await service.source(input.projectId, input.fileId, input.sourceHash);
    const inline = source.kind === 'pdf' || source.kind === 'image';
    const mediaType = inline ? documentMediaTypes[extname(source.path).toLowerCase()] : 'application/octet-stream';
    if (mediaType === undefined) throw new Error('research_index_source_format_invalid');
    return new Response(new Uint8Array(source.bytes), { headers: { 'content-type': mediaType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(source.path))}` } });
  });
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
