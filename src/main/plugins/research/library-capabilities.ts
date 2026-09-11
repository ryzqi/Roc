import type { z } from 'zod';
import {
  researchLibraryArchiveRequestSchema, researchLibraryCitationKeyRequestSchema, researchLibraryDoiImportRequestSchema,
  researchLibraryExportRequestSchema, researchLibraryExportSchema, researchLibraryFileImportRequestSchema,
  researchLibraryIdRequestSchema, researchLibraryImportResultSchema, researchLibraryItemSchema, researchLibraryLinkRequestSchema,
  researchLibraryListRequestSchema, researchLibraryRecordImportRequestSchema
} from '../../../shared/schemas/research-library';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { RocErrorCategory } from '../../../shared/types';
import type { ResearchLibraryRepository } from './library-repository';
import type { ResearchLibraryService } from './library-service';

const capabilities = {
  list: descriptor('research.library.list', researchLibraryListRequestSchema, researchLibraryItemSchema.array()),
  get: descriptor('research.library.get', researchLibraryIdRequestSchema, researchLibraryItemSchema),
  record: descriptor('research.library.importRecord', researchLibraryRecordImportRequestSchema, researchLibraryImportResultSchema),
  doi: descriptor('research.library.importDoi', researchLibraryDoiImportRequestSchema, researchLibraryImportResultSchema),
  file: descriptor('research.library.importFile', researchLibraryFileImportRequestSchema, researchLibraryImportResultSchema),
  export: descriptor('research.library.export', researchLibraryExportRequestSchema, researchLibraryExportSchema),
  link: descriptor('research.library.linkProject', researchLibraryLinkRequestSchema, researchLibraryItemSchema),
  archive: descriptor('research.library.archive', researchLibraryArchiveRequestSchema, researchLibraryItemSchema),
  citationKey: descriptor('research.library.setCitationKey', researchLibraryCitationKeyRequestSchema, researchLibraryItemSchema)
};
export const researchLibraryCapabilities = Object.values(capabilities);

const libraryFailures: Record<string, { message: string; category: RocErrorCategory }> = {
  research_library_item_not_found: { message: '文献不存在。', category: 'not_found' },
  research_project_not_found: { message: '研究项目不存在。', category: 'not_found' },
  research_library_version_conflict: { message: '文献已被修改，请刷新后重试。', category: 'conflict' },
  research_citation_key_duplicate: { message: '选中文献的引用键重复，请修改引用键后导出。', category: 'conflict' },
  research_library_selection_duplicate: { message: '同一文献不能重复选择。', category: 'validation' },
  research_library_item_archived: { message: '请先恢复已归档文献。', category: 'conflict' },
  research_project_archived: { message: '请先恢复已归档的研究项目。', category: 'conflict' },
  research_doi_invalid: { message: 'DOI 格式无效。', category: 'validation' },
  research_doi_response_mismatch: { message: 'DOI 服务返回了其他文献，导入已取消。', category: 'external' },
  research_doi_response_too_large: { message: 'DOI 服务响应超出大小限制。', category: 'external' },
  research_doi_response_invalid: { message: 'DOI 服务响应格式无效。', category: 'external' },
  research_bibliography_parse_failed: { message: '参考文献文件包含语法错误，请修正后重新导入。', category: 'validation' },
  research_bibliography_title_required: { message: '参考文献缺少标题。', category: 'validation' },
  research_bibliography_type_unsupported: { message: '文献类型无法转换为指定格式。', category: 'validation' },
  research_bibliography_journal_conflict: { message: '文献中的期刊名称字段冲突，请修正来源后重新导入。', category: 'conflict' },
  research_csl_type_unsupported: { message: 'CSL JSON 中包含不支持的文献类型。', category: 'validation' },
  research_csl_date_invalid: { message: 'CSL JSON 中包含无效日期。', category: 'validation' },
  research_toolchain_unavailable: { message: '科研工具链不可用，请检查应用资源。', category: 'degraded' },
  research_toolchain_source_mismatch: { message: '科研工具链与当前应用版本不匹配。', category: 'degraded' }
};

export function registerResearchLibraryCapabilities(context: RocPluginContext, repository: ResearchLibraryRepository, service: ResearchLibraryService): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (input: TInput) => TOutput | Promise<TOutput>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) {
        const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
        const failure = libraryFailures[code];
        if (failure === undefined) throw error;
        throw new RocDomainError({ code, ...failure, retryable: false });
      }
    });
  }
  register(capabilities.list, (input) => repository.list(input));
  register(capabilities.get, (input) => repository.get(input.id));
  register(capabilities.record, (input) => service.importRecord(input));
  register(capabilities.doi, (input) => service.importDoi(input));
  register(capabilities.file, (input) => service.importFile(input));
  register(capabilities.export, (input) => service.export(input));
  register(capabilities.link, (input) => repository.link(input.id, input.projectId, input.linked));
  register(capabilities.archive, (input) => repository.archive(input.id, input.expectedRevision, input.archived));
  register(capabilities.citationKey, (input) => repository.setCitationKey(input.id, input.expectedRevision, input.citationKey));
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
