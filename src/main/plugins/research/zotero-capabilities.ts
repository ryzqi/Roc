import type {z} from 'zod';
import {
  zoteroProbeRequestSchema, zoteroProbeSchema, zoteroGroupsRequestSchema, zoteroGroupsPageSchema,
  zoteroPageRequestSchema, zoteroCollectionsPageSchema, zoteroItemsRequestSchema, zoteroItemsPageSchema
} from '../../../shared/schemas/research-zotero';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ZoteroAdapter} from './zotero-adapter';

const descriptor = <I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> =>
  ({name, version: '1.0.0', inputSchema, outputSchema});
const capabilities = {
  probe: descriptor('research.zotero.probe', zoteroProbeRequestSchema, zoteroProbeSchema),
  groups: descriptor('research.zotero.groups', zoteroGroupsRequestSchema, zoteroGroupsPageSchema),
  collections: descriptor('research.zotero.collections', zoteroPageRequestSchema, zoteroCollectionsPageSchema),
  items: descriptor('research.zotero.items', zoteroItemsRequestSchema, zoteroItemsPageSchema)
};
export const zoteroCapabilities = Object.values(capabilities);

export function registerZoteroCapabilities(context: RocPluginContext, adapter: ZoteroAdapter): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'zotero_server_changed' || code === 'zotero_library_version_changed') {
          throw new RocDomainError({code, message: 'Zotero 实例或文库版本已改变，请重新读取并核对导入范围。',
            category: 'conflict', retryable: false});
        }
        if (code === 'zotero_api_disabled') {
          throw new RocDomainError({code, message: '请在 Zotero 高级设置中允许其他应用通信。',
            category: 'external', retryable: false});
        }
        if (code.startsWith('zotero_')) {
          throw new RocDomainError({code, message: 'Zotero 本地读取失败，请检查连接与来源数据。',
            category: 'external', retryable: ['zotero_unreachable', 'zotero_timeout'].includes(code)});
        }
        throw error;
      }
    });
  }
  register(capabilities.probe, () => adapter.probe());
  register(capabilities.groups, input => adapter.groups(input));
  register(capabilities.collections, input => adapter.collections(input));
  register(capabilities.items, input => adapter.items(input));
}
