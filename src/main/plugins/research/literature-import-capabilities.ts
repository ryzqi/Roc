import { literatureAddSchema, literatureCancelImportSchema, literatureGetImportSchema, literatureImportResultSchema,
  literatureReadSearchSchema, literatureSearchInputSchema, literatureSearchResultSchema } from '../../../shared/schemas/literature-import';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { z } from 'zod';
import type { LiteratureImportService } from './literature-import-service';
const descriptor = <I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> => ({ name, version: '2.0.0', inputSchema, outputSchema });
const capabilities = {
  search: descriptor('research.literature.search', literatureSearchInputSchema, literatureSearchResultSchema),
  read: descriptor('research.literature.getSearch', literatureReadSearchSchema, literatureSearchResultSchema),
  add: descriptor('research.library.addLiterature', literatureAddSchema, literatureImportResultSchema),
  get: descriptor('research.library.getImportOperation', literatureGetImportSchema, literatureImportResultSchema),
  cancel: descriptor('research.library.cancelImportOperation', literatureCancelImportSchema, literatureImportResultSchema)
};
export const literatureImportCapabilities = Object.values(capabilities);
export function registerLiteratureImportCapabilities(context: RocPluginContext, service: LiteratureImportService): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, handler: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return await handler(capability.inputSchema.parse(input)); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'import_request_conflict') throw new RocDomainError({ code, message: '请求标识已用于其他导入，请使用新的请求标识。', category: 'conflict', retryable: false });
        if (/^literature_(search|candidate|import)_not_found$/u.test(code)) throw new RocDomainError({ code, message: '候选或导入操作不存在，或不属于当前会话与项目。', category: 'not_found', retryable: false });
        if (code === 'literature_search_expired') throw new RocDomainError({ code, message: '检索候选已过期，请重新检索。', category: 'validation', retryable: false });
        throw error;
      }
    });
  }
  register(capabilities.search, (input) => service.search(input));
  register(capabilities.read, (input) => service.readSearch(input));
  register(capabilities.add, (input) => service.add(input));
  register(capabilities.get, (input) => service.get(input));
  register(capabilities.cancel, (input) => service.cancel(input.operationId));
}
