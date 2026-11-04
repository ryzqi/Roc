import { z } from 'zod';
import {
  researchDocumentAssetRequestSchema, researchDocumentIdRequestSchema, researchDocumentImportRequestSchema,
  researchDocumentListRequestSchema, researchDocumentParseRequestSchema, researchDocumentParseSchema,
  researchDocumentStartParseRequestSchema, researchDocumentBatchParseRequestSchema, researchDocumentBatchParseSchema,
  researchDocumentRunSchema, researchDocumentSchema, researchDocumentSourceRequestSchema
} from '../../../shared/schemas/research-documents';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { ResearchDocumentRepository } from './document-repository';
import type { ResearchDocumentService } from './document-service';
import {researchDocumentPreviewRequestSchema, researchDocumentPreviewSchema, researchDocumentResolveParseRequestSchema} from '../../../shared/schemas/research-document-preview';

const capabilities = {
  import: descriptor('research.document.import', researchDocumentImportRequestSchema, researchDocumentSchema),
  list: descriptor('research.document.list', researchDocumentListRequestSchema, researchDocumentSchema.array()),
  get: descriptor('research.document.get', researchDocumentIdRequestSchema, researchDocumentSchema),
  parse: descriptor('research.document.parse', researchDocumentStartParseRequestSchema, researchDocumentSchema),
  parseMany: descriptor('research.document.parseMany', researchDocumentBatchParseRequestSchema, researchDocumentBatchParseSchema),
  cancel: descriptor('research.document.cancel', researchDocumentParseRequestSchema, researchDocumentSchema),
  runs: descriptor('research.document.runs', researchDocumentIdRequestSchema, researchDocumentRunSchema.array()),
  content: descriptor('research.document.content', researchDocumentPreviewRequestSchema, researchDocumentParseSchema),
  source: descriptor('research.document.source', researchDocumentSourceRequestSchema, z.unknown()),
  asset: descriptor('research.document.asset', researchDocumentAssetRequestSchema, z.unknown()),
  preview: descriptor('research.document.preview', researchDocumentPreviewRequestSchema, researchDocumentPreviewSchema),
  resolveParse: descriptor('research.document.resolveParse', researchDocumentResolveParseRequestSchema, researchDocumentSchema)
};
export const researchDocumentCapabilities = Object.values(capabilities);

export function registerResearchDocumentCapabilities(context: RocPluginContext, repository: ResearchDocumentRepository, service: ResearchDocumentService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) {
        if (capability === capabilities.preview || capability === capabilities.source || capability === capabilities.asset ||
            capability === capabilities.content || capability === capabilities.resolveParse) {
          if (error instanceof Error) {
            const failure = documentReadFailures[error.message] ?? documentReadFailures[(error as NodeJS.ErrnoException).code ?? ''];
            if (failure !== undefined) throw new RocDomainError({code: error.message in documentReadFailures ? error.message : failure.code,
              message: failure.message, category: failure.category, retryable: false});
          }
        }
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
  register(capabilities.parse, (input) => service.parse(input.documentId, input.tier));
  register(capabilities.parseMany, (input) => service.parseMany(input));
  register(capabilities.cancel, (input) => service.cancel(input.documentId, input.parseId));
  register(capabilities.runs, (input) => repository.runs(input.documentId));
  register(capabilities.preview, input => service.preview(input));
  register(capabilities.resolveParse, input => service.resolveParse(input.projectId, input.parseId));
  register(capabilities.content, input => service.content(input));
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

const documentReadFailures: Record<string, {code: string; message: string; category: 'permission' | 'conflict' | 'not_found' | 'degraded'}> = {
  research_document_project_mismatch: {code: 'research_document_project_mismatch', message: '该文档未关联当前项目。', category: 'permission'},
  research_document_source_changed: {code: 'research_document_source_changed', message: '原文件与记录的版本不一致，无法预览。', category: 'conflict'},
  research_document_preview_parse_changed: {code: 'research_document_preview_parse_changed', message: '解析内容与所选版本不一致，请重新读取。', category: 'conflict'},
  research_document_asset_changed: {code: 'research_document_asset_changed', message: '解析图像与记录的内容不一致。', category: 'conflict'},
  research_document_coordinate_artifact_changed: {code: 'research_document_coordinate_artifact_changed', message: '坐标工件内容已变化，无法使用区域定位。', category: 'conflict'},
  research_document_coordinate_binding_changed: {code: 'research_document_coordinate_binding_changed', message: '坐标快照与解析版本不一致。', category: 'conflict'},
  research_document_coordinate_snapshot_invalid: {code: 'research_document_coordinate_snapshot_invalid', message: '坐标快照校验失败。', category: 'degraded'},
  research_document_coordinate_snapshot_missing: {code: 'research_document_coordinate_snapshot_missing', message: '所选解析的坐标快照缺失。', category: 'not_found'},
  research_document_parse_not_found: {code: 'research_document_parse_not_found', message: '所选解析不存在。', category: 'not_found'},
  research_document_not_found: {code: 'research_document_not_found', message: '所选文档不存在。', category: 'not_found'},
  research_document_asset_not_found: {code: 'research_document_asset_not_found', message: '所选解析图像不存在或版本不符。', category: 'not_found'},
  research_document_parse_not_ready: {code: 'research_document_parse_not_ready', message: '所选解析尚未完成。', category: 'conflict'},
  research_document_parse_superseded: {code: 'research_document_parse_superseded', message: '该解析已失效，无法继续定位。', category: 'conflict'},
  research_path_symlink: {code: 'research_path_symlink', message: '文档资源路径包含符号链接，无法读取。', category: 'permission'},
  research_path_outside_project: {code: 'research_path_outside_project', message: '文档资源超出存储范围。', category: 'permission'},
  ENOENT: {code: 'research_document_file_missing', message: '原文件或解析资源已缺失。', category: 'not_found'},
  EACCES: {code: 'research_document_file_denied', message: '无法读取所选文档资源。', category: 'permission'}
};
