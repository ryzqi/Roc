import type {z} from 'zod';
import {
  zoteroProbeRequestSchema, zoteroProbeSchema, zoteroGroupsRequestSchema, zoteroGroupsPageSchema,
  zoteroPageRequestSchema, zoteroCollectionsPageSchema, zoteroItemsRequestSchema, zoteroItemsPageSchema,
  zoteroPreviewPageSchema, zoteroSourcesPageSchema,
  zoteroStatusSchema, zoteroPreviewIpcSchema, zoteroPreviewReadIpcSchema, zoteroSourcesIpcSchema,
  zoteroReviewIpcSchema, zoteroReviewSchema
} from '../../../shared/schemas/research-zotero';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ZoteroAdapter} from './zotero-adapter';
import type {LiteratureImportService} from './literature-import-service';
import {detectZoteroInstallation} from './zotero-installation';
import {
  zoteroSyncStartIpcSchema, zoteroSyncReadIpcSchema, zoteroSyncPageIpcSchema,
  zoteroSyncControlIpcSchema, zoteroSyncAcknowledgeIpcSchema, zoteroSyncSchema, zoteroSyncCapturedPageSchema, zoteroSyncFindIpcSchema
} from '../../../shared/schemas/research-zotero-sync';
import {zoteroSourceStateIpcSchema, zoteroSourceStateSchema} from '../../../shared/schemas/research-zotero-source-state';

const descriptor = <I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> =>
  ({name, version: '1.0.0', inputSchema, outputSchema});
const capabilities = {
  sourceObserve: descriptor('research.zotero.sourceObserve', zoteroSourceStateIpcSchema, zoteroSourceStateSchema),
  sourceState: descriptor('research.zotero.sourceState', zoteroSourceStateIpcSchema, zoteroSourceStateSchema.nullable()),
  syncStart: descriptor('research.zotero.syncStart', zoteroSyncStartIpcSchema, zoteroSyncSchema),
  syncRead: descriptor('research.zotero.syncRead', zoteroSyncReadIpcSchema, zoteroSyncSchema),
  syncFind: descriptor('research.zotero.syncFind', zoteroSyncFindIpcSchema, zoteroSyncSchema.nullable()),
  syncReadPage: descriptor('research.zotero.syncReadPage', zoteroSyncReadIpcSchema, zoteroSyncCapturedPageSchema),
  syncPage: descriptor('research.zotero.syncPage', zoteroSyncPageIpcSchema, zoteroSyncCapturedPageSchema),
  syncControl: descriptor('research.zotero.syncControl', zoteroSyncControlIpcSchema, zoteroSyncSchema),
  syncAcknowledge: descriptor('research.zotero.syncAcknowledge', zoteroSyncAcknowledgeIpcSchema, zoteroSyncSchema),
  probe: descriptor('research.zotero.probe', zoteroProbeRequestSchema, zoteroProbeSchema),
  status: descriptor('research.zotero.status', zoteroProbeRequestSchema, zoteroStatusSchema),
  review: descriptor('research.zotero.review', zoteroReviewIpcSchema, zoteroReviewSchema),
  groups: descriptor('research.zotero.groups', zoteroGroupsRequestSchema, zoteroGroupsPageSchema),
  collections: descriptor('research.zotero.collections', zoteroPageRequestSchema, zoteroCollectionsPageSchema),
  items: descriptor('research.zotero.items', zoteroItemsRequestSchema, zoteroItemsPageSchema),
  preview: descriptor('research.zotero.preview', zoteroPreviewIpcSchema, zoteroPreviewPageSchema),
  readPreview: descriptor('research.zotero.getPreview', zoteroPreviewReadIpcSchema, zoteroPreviewPageSchema),
  sources: descriptor('research.zotero.sources', zoteroSourcesIpcSchema, zoteroSourcesPageSchema)
};
export const zoteroCapabilities = Object.values(capabilities);

export function registerZoteroCapabilities(context: RocPluginContext, adapter: ZoteroAdapter,
  imports: Pick<LiteratureImportService, 'previewZotero' | 'readZoteroPreview' | 'readZoteroSources' | 'reviewZotero' |
    'startZoteroSync' | 'readZoteroSync' | 'captureZoteroSyncPage' | 'controlZoteroSync' | 'acknowledgeZoteroSync' |
    'findZoteroSync' | 'readZoteroSyncPage' | 'observeZoteroSource' | 'readZoteroSourceState'>): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'zotero_source_observation_not_found') {
          throw new RocDomainError({code, message: '来源收录回执不存在，或不属于当前会话与项目。',
            category: 'not_found', retryable: false});
        }
        if (code === 'zotero_source_state_storage_invalid') {
          throw new RocDomainError({code, message: '已保存的来源状态观察损坏，无法读取。',
            category: 'degraded', retryable: false});
        }
        if (code === 'zotero_sync_not_found') {
          throw new RocDomainError({code, message: '同步记录不存在，或不属于当前会话与项目。',
            category: 'not_found', retryable: false});
        }
        if (code === 'zotero_sync_storage_invalid') {
          throw new RocDomainError({code, message: '同步检查点损坏，无法继续。',
            category: 'degraded', retryable: false});
        }
        if (code.startsWith('zotero_sync_')) {
          throw new RocDomainError({code, message: '同步状态或页回执不匹配，请重新读取检查点并核对本页。',
            category: 'conflict', retryable: false});
        }
        if (code === 'zotero_server_changed' || code === 'zotero_library_version_changed') {
          throw new RocDomainError({code, message: 'Zotero 实例或文库版本已改变，请重新读取并核对导入范围。',
            category: 'conflict', retryable: false});
        }
        if (code === 'zotero_api_disabled') {
          throw new RocDomainError({code, message: '请在 Zotero 高级设置中允许其他应用通信。',
            category: 'external', retryable: false});
        }
        if (code === 'zotero_preview_not_found') {
          throw new RocDomainError({code, message: 'Zotero 预览不存在，或不属于当前会话与项目。',
            category: 'not_found', retryable: false});
        }
        if (code === 'research_literature_identity_ambiguous') {
          throw new RocDomainError({code, message: '同一文献身份对应多个文库条目，请先人工核对。',
            category: 'conflict', retryable: false});
        }
        if (code === 'zotero_object_storage_invalid') {
          throw new RocDomainError({code, message: '已保存的 Zotero 来源记录损坏，无法审查原始版本。',
            category: 'degraded', retryable: false});
        }
        if (['zotero_preview_storage_invalid', 'zotero_preview_integrity_invalid'].includes(code)) {
          throw new RocDomainError({code, message: 'Zotero 预览内容损坏，请重新读取来源。',
            category: 'degraded', retryable: false});
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
  register(capabilities.status, async () => {
    const [installation, connection] = await Promise.all([detectZoteroInstallation(), adapter.probe()]);
    return {installation, connection};
  });
  register(capabilities.groups, input => adapter.groups(input));
  register(capabilities.collections, input => adapter.collections(input));
  register(capabilities.items, input => adapter.items(input));
  register(capabilities.preview, ({projectId: _scope, ...input}) => imports.previewZotero(input, adapter));
  register(capabilities.readPreview, async ({projectId: _scope, ...input}) => imports.readZoteroPreview(input));
  register(capabilities.sources, async ({projectId: _scope, ...input}) => imports.readZoteroSources(input));
  register(capabilities.review, async ({projectId: _scope, ...input}) => imports.reviewZotero(input));
  register(capabilities.syncStart, async ({projectId: _scope, ...input}) => imports.startZoteroSync(input));
  register(capabilities.syncRead, async ({projectId: _scope, ...input}) => imports.readZoteroSync(input));
  register(capabilities.syncFind, async ({projectId: _scope, ...input}) => imports.findZoteroSync(input));
  register(capabilities.syncReadPage, async ({projectId: _scope, ...input}) => imports.readZoteroSyncPage(input));
  register(capabilities.syncPage, ({projectId: _scope, ...input}) => imports.captureZoteroSyncPage(input, adapter));
  register(capabilities.syncControl, async ({projectId: _scope, ...input}) => imports.controlZoteroSync(input));
  register(capabilities.syncAcknowledge, async ({projectId: _scope, ...input}) => imports.acknowledgeZoteroSync(input));
  register(capabilities.sourceObserve, ({projectId: _scope, ...input}) => imports.observeZoteroSource(input, adapter));
  register(capabilities.sourceState, async ({projectId: _scope, ...input}) => imports.readZoteroSourceState(input));
}
