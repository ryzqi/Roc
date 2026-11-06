import type {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {
  hfDownloadStartSchema, hfDownloadReceiptSchema, hfDownloadCancelSchema, hfDownloadCancelResultSchema,
  hfDownloadReadSchema, hfDownloadHistorySchema, hfDownloadHistoryResultSchema
} from '../../../shared/schemas/research-huggingface-downloads';
import {RocDomainError} from '../../services/errors';
import type {HuggingFaceDownloadService} from './huggingface-download-service';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  start: descriptor('research.huggingfaceDownloads.start', hfDownloadStartSchema, hfDownloadReceiptSchema),
  cancel: descriptor('research.huggingfaceDownloads.cancel', hfDownloadCancelSchema, hfDownloadCancelResultSchema),
  read: descriptor('research.huggingfaceDownloads.read', hfDownloadReadSchema, hfDownloadReceiptSchema),
  history: descriptor('research.huggingfaceDownloads.history', hfDownloadHistorySchema, hfDownloadHistoryResultSchema)
};
export const researchHuggingFaceDownloadCapabilities = Object.values(capabilities);
const failures: Record<string, {message: string; category: 'permission' | 'conflict' | 'degraded' | 'not_found'}> = {
  research_human_required: {message: '下载需要独立的人工审核。', category: 'permission'},
  research_human_project_mismatch: {message: '下载审核身份与项目不匹配。', category: 'permission'},
  research_project_archived: {message: '归档项目不能开始下载。', category: 'conflict'},
  research_hf_download_request_conflict: {message: '下载请求标识已用于其他参数。', category: 'conflict'},
  research_hf_download_source_changed: {message: '批准的资源观察版本已改变。', category: 'conflict'},
  research_hf_download_access_restricted: {message: '当前访问条件不允许匿名下载。', category: 'permission'},
  research_hf_download_file_missing: {message: '选定文件不存在于批准的资源观察中。', category: 'not_found'},
  research_hf_download_byte_limit: {message: '选定文件超过下载限额。', category: 'conflict'},
  research_hf_download_not_found: {message: '下载记录不存在。', category: 'not_found'},
  research_hf_download_snapshot_invalid: {message: '下载记录校验失败。', category: 'degraded'},
  research_hf_download_state_conflict: {message: '下载状态或版本冲突。', category: 'conflict'},
  research_hf_download_persistence_failed: {message: '下载状态持久化失败，记录需要核查。', category: 'degraded'},
  research_hf_download_service_closed: {message: '下载服务尚未启动或已关闭。', category: 'degraded'}
};
export function registerResearchHuggingFaceDownloadCapabilities(context: RocPluginContext, service: HuggingFaceDownloadService): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await run(capability.inputSchema.parse(input));}
      catch (error) {
        const failure = error instanceof Error ? failures[error.message] : undefined;
        if (failure === undefined) throw error;
        throw new RocDomainError({code: (error as Error).message, ...failure, retryable: false});
      }
    });
  }
  register(capabilities.start, input => service.start(input));
  register(capabilities.cancel, input => service.cancel(input));
  register(capabilities.read, input => service.read(input));
  register(capabilities.history, input => service.history(input));
}
