import {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {
  scholarlyCaptureSchema, scholarlyCancelSchema, scholarlyCancelResultSchema, scholarlySnapshotSummarySchema,
  scholarlyHistorySchema, scholarlyHistoryResultSchema, scholarlyReadSchema, scholarlyReadResultSchema
} from '../../../shared/schemas/research-scholarly-relations';
import {RocDomainError} from '../../services/errors';
import type {ScholarlyRelationsService} from './scholarly-relations-service';
import type {ScholarlyRelationsRepository} from './scholarly-relations-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  capture: descriptor('research.scholarly.capture', scholarlyCaptureSchema, scholarlySnapshotSummarySchema),
  cancel: descriptor('research.scholarly.cancel', scholarlyCancelSchema, scholarlyCancelResultSchema),
  history: descriptor('research.scholarly.history', scholarlyHistorySchema, scholarlyHistoryResultSchema),
  read: descriptor('research.scholarly.read', scholarlyReadSchema, scholarlyReadResultSchema)
};
export const researchScholarlyCapabilities = Object.values(capabilities);
const failures: Record<string, {message: string; category: 'conflict' | 'validation' | 'permission' | 'degraded' | 'not_found'}> = {
  scholarly_request_conflict: {message: '关系查询请求标识已用于其他参数。', category: 'conflict'},
  scholarly_item_project_mismatch: {message: '文献不属于指定的项目。', category: 'permission'},
  scholarly_doi_required: {message: '关系查询需要文献 DOI。', category: 'validation'},
  scholarly_source_changed: {message: '文献来源已改变，请重新查询。', category: 'conflict'},
  scholarly_snapshot_not_found: {message: '关系快照不存在。', category: 'not_found'},
  scholarly_source_not_captured: {message: '此快照未查询该来源。', category: 'validation'},
  scholarly_snapshot_invalid: {message: '关系快照校验失败。', category: 'degraded'},
  scholarly_capture_cancelled: {message: '关系查询已取消。', category: 'conflict'},
  scholarly_service_closed: {message: '关系查询服务已关闭。', category: 'degraded'},
  research_project_archived: {message: '归档项目不能执行新查询。', category: 'conflict'},
  research_library_item_archived: {message: '归档文献不能执行新查询。', category: 'conflict'},
  research_library_revision_conflict: {message: '文献版本已改变，请刷新后查询。', category: 'conflict'}
};
export function registerResearchScholarlyCapabilities(context: RocPluginContext, service: ScholarlyRelationsService,
  repository: ScholarlyRelationsRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await run(capability.inputSchema.parse(input));}
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        const failure = failures[code];
        if (failure === undefined) throw error;
        throw new RocDomainError({code, ...failure, retryable: false});
      }
    });
  }
  register(capabilities.capture, input => service.capture(input));
  register(capabilities.cancel, input => service.cancel(input));
  register(capabilities.history, input => repository.history(input));
  register(capabilities.read, input => repository.read(input));
}
