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
import {zoteroAttachmentIpcSchema, zoteroAttachmentReadIpcSchema, zoteroAttachmentInspectionSchema,
  zoteroAttachmentGrantIpcSchema, zoteroAttachmentGrantReadIpcSchema, zoteroAttachmentGrantOutcomeSchema,
  zoteroAttachmentGrantSchema} from '../../../shared/schemas/research-zotero-attachment';
import type {ZoteroAttachmentPicker} from './zotero-attachment-grant-store';
import type {ResearchDocumentService} from './document-service';
import {zoteroAttachmentImportIpcSchema, zoteroAttachmentImportReadIpcSchema, zoteroAttachmentImportSchema,
  zoteroAttachmentImportCancelSchema, zoteroChildrenIpcSchema, zoteroChildrenPageSchema} from '../../../shared/schemas/research-zotero-attachment';

const descriptor = <I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> =>
  ({name, version: '1.0.0', inputSchema, outputSchema});
const capabilities = {
  children: descriptor('research.zotero.children', zoteroChildrenIpcSchema, zoteroChildrenPageSchema),
  attachmentImport: descriptor('research.zotero.attachmentImport', zoteroAttachmentImportIpcSchema, zoteroAttachmentImportSchema),
  attachmentImportRead: descriptor('research.zotero.attachmentImportRead', zoteroAttachmentImportReadIpcSchema, zoteroAttachmentImportSchema),
  attachmentImportCancel: descriptor('research.zotero.attachmentImportCancel', zoteroAttachmentImportReadIpcSchema, zoteroAttachmentImportCancelSchema),
  attachmentGrant: descriptor('research.zotero.attachmentGrant', zoteroAttachmentGrantIpcSchema, zoteroAttachmentGrantOutcomeSchema),
  attachmentGrantRead: descriptor('research.zotero.attachmentGrantRead', zoteroAttachmentGrantReadIpcSchema, zoteroAttachmentGrantSchema),
  attachmentInspect: descriptor('research.zotero.attachmentInspect', zoteroAttachmentIpcSchema, zoteroAttachmentInspectionSchema),
  attachmentRead: descriptor('research.zotero.attachmentRead', zoteroAttachmentReadIpcSchema, zoteroAttachmentInspectionSchema),
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
    'findZoteroSync' | 'readZoteroSyncPage' | 'observeZoteroSource' | 'readZoteroSourceState' |
    'inspectZoteroAttachment' | 'readZoteroAttachment' | 'grantZoteroAttachment' | 'readZoteroAttachmentGrant' |
    'importZoteroAttachment' | 'readZoteroAttachmentImport' | 'cancelZoteroAttachmentImport' | 'readZoteroChildren'>,
  pick: ZoteroAttachmentPicker, documents: Pick<ResearchDocumentService, 'importPrepared'>): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try { return await run(capability.inputSchema.parse(input)); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'zotero_attachment_source_missing' || code === 'zotero_attachment_source_denied') {
          throw new RocDomainError({code, message: code === 'zotero_attachment_source_missing' ? '授权的附件文件已缺失，请重新检查来源。' :
            '无法读取已授权的附件文件，请检查文件访问权限。', category: code === 'zotero_attachment_source_missing' ? 'not_found' : 'permission', retryable: false});
        }
        if (code === 'zotero_attachment_import_not_found') {
          throw new RocDomainError({code, message: '附件导入回执不存在，或不属于当前会话与项目。', category: 'not_found', retryable: false});
        }
        if (code === 'zotero_attachment_import_storage_invalid') {
          throw new RocDomainError({code, message: '附件导入回执损坏，无法读取。', category: 'degraded', retryable: false});
        }
        if (['zotero_attachment_import_active', 'zotero_attachment_import_request_conflict', 'zotero_attachment_import_cancelled'].includes(code)) {
          throw new RocDomainError({code, message: '附件导入请求正在执行、已取消或与原回执冲突，请核对当前作业。',
            category: 'conflict', retryable: false});
        }
        if (code === 'zotero_attachment_grant_not_found') {
          throw new RocDomainError({code, message: '附件输入授权不存在，或不属于当前会话与项目。', category: 'not_found', retryable: false});
        }
        if (code === 'zotero_attachment_grant_storage_invalid') {
          throw new RocDomainError({code, message: '附件输入授权记录损坏，无法使用。', category: 'degraded', retryable: false});
        }
        if (['zotero_attachment_file_not_ready', 'zotero_attachment_file_changed', 'zotero_attachment_selected_file_mismatch',
          'zotero_attachment_grant_request_conflict', 'zotero_attachment_grant_active'].includes(code)) {
          throw new RocDomainError({code, message: '所选附件、检查记录或授权请求不匹配，请重新核对该文件。',
            category: 'conflict', retryable: false});
        }
        if (code === 'zotero_attachment_window_required' || code === 'zotero_attachment_single_file_required') {
          throw new RocDomainError({code, message: '请在当前窗口的原生文件选择框中选择一个附件文件。',
            category: 'permission', retryable: false});
        }
        if (code === 'zotero_attachment_inspection_not_found') {
          throw new RocDomainError({code, message: '附件检查记录不存在，或不属于当前会话与项目。',
            category: 'not_found', retryable: false});
        }
        if (code === 'zotero_attachment_inspection_storage_invalid') {
          throw new RocDomainError({code, message: '附件检查记录损坏，无法读取。', category: 'degraded', retryable: false});
        }
        if (code === 'zotero_attachment_parent_mismatch' || code === 'zotero_attachment_changed_during_inspection' || code === 'zotero_children_parent_mismatch') {
          throw new RocDomainError({code, message: '附件对象关系或实际文件已改变，请重新核对。',
            category: 'conflict', retryable: false});
        }
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
  register(capabilities.attachmentInspect, ({projectId: _scope, ...input}) => imports.inspectZoteroAttachment(input, adapter));
  register(capabilities.attachmentRead, async input => imports.readZoteroAttachment(input.inspectionId));
  register(capabilities.attachmentGrant, ({projectId: _scope, ...input}) => imports.grantZoteroAttachment(input, pick));
  register(capabilities.attachmentGrantRead, async input => imports.readZoteroAttachmentGrant(input.grantId));
  register(capabilities.attachmentImport, ({projectId: _scope, ...input}) => imports.importZoteroAttachment(input, documents));
  register(capabilities.attachmentImportRead, async input => imports.readZoteroAttachmentImport(input.requestId));
  register(capabilities.attachmentImportCancel, async input => imports.cancelZoteroAttachmentImport(input.requestId));
  register(capabilities.children, ({projectId: _scope, ...input}) => imports.readZoteroChildren(input, adapter));
}
