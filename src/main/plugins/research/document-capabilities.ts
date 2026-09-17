import { z } from 'zod';
import {
  researchDocumentAssetRequestSchema, researchDocumentIdRequestSchema, researchDocumentImportRequestSchema,
  researchDocumentListRequestSchema, researchDocumentParseRequestSchema, researchDocumentParseSchema,
  researchDocumentRunSchema, researchDocumentSchema, researchDocumentSourceRequestSchema
} from '../../../shared/schemas/research-documents';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { ResearchDocumentRepository } from './document-repository';
import type { ResearchDocumentService } from './document-service';

const capabilities = {
  import: descriptor('research.document.import', researchDocumentImportRequestSchema, researchDocumentSchema),
  list: descriptor('research.document.list', researchDocumentListRequestSchema, researchDocumentSchema.array()),
  get: descriptor('research.document.get', researchDocumentIdRequestSchema, researchDocumentSchema),
  parse: descriptor('research.document.parse', researchDocumentIdRequestSchema, researchDocumentSchema),
  cancel: descriptor('research.document.cancel', researchDocumentParseRequestSchema, researchDocumentSchema),
  runs: descriptor('research.document.runs', researchDocumentIdRequestSchema, researchDocumentRunSchema.array()),
  content: descriptor('research.document.content', researchDocumentParseRequestSchema, researchDocumentParseSchema),
  source: descriptor('research.document.source', researchDocumentSourceRequestSchema, z.unknown()),
  asset: descriptor('research.document.asset', researchDocumentAssetRequestSchema, z.unknown())
};
export const researchDocumentCapabilities = Object.values(capabilities);

export function registerResearchDocumentCapabilities(context: RocPluginContext, repository: ResearchDocumentRepository, service: ResearchDocumentService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) {
        if (error instanceof Error && error.message === 'research_document_parse_stale') {
          throw new RocDomainError({ code: error.message, message: '文档解析状态已变化，请刷新后重试。', category: 'conflict', retryable: false });
        }
        const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
        if (code === 'research_models_unavailable') {
          throw new RocDomainError({
            code,
            message: '解析模型尚未下载，请先在科研工作台下载。',
            category: 'degraded',
            retryable: false
          });
        }
        throw error;
      }
    });
  }
  register(capabilities.import, (input) => service.import(input));
  register(capabilities.list, (input) => repository.list(input.libraryItemId));
  register(capabilities.get, (input) => repository.get(input.documentId));
  register(capabilities.parse, (input) => service.parse(input.documentId));
  register(capabilities.cancel, (input) => service.cancel(input.documentId, input.parseId));
  register(capabilities.runs, (input) => repository.runs(input.documentId));
  register(capabilities.content, (input) => service.parsed(input.documentId, input.parseId));
  register(capabilities.source, async (input) => {
    const resource = await service.source(input);
    const html = resource.mediaType === 'text/html';
    return new Response(new Uint8Array(resource.bytes), { headers: {
      'content-type': html ? 'application/octet-stream' : resource.mediaType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${html ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(resource.filename)}`
    } });
  });
  register(capabilities.asset, async (input) => new Response(new Uint8Array(await service.asset(input)), {
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  }));
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
