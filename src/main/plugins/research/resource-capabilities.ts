import type {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {
  resourceCaptureSchema, resourceCancelSchema, resourceCancelResultSchema, resourceSummarySchema,
  resourceHistorySchema, resourceHistoryResultSchema, resourceReadSchema, resourceReadResultSchema
} from '../../../shared/schemas/research-resources';
import {RocDomainError} from '../../services/errors';
import type {ResearchResourceService} from './resource-service';
import type {ResearchResourceRepository} from './resource-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  capture: descriptor('research.resource.capture', resourceCaptureSchema, resourceSummarySchema),
  cancel: descriptor('research.resource.cancel', resourceCancelSchema, resourceCancelResultSchema),
  history: descriptor('research.resource.history', resourceHistorySchema, resourceHistoryResultSchema),
  read: descriptor('research.resource.read', resourceReadSchema, resourceReadResultSchema)
};
export const researchResourceCapabilities = Object.values(capabilities);
const failures: Record<string, {message: string; category: 'conflict' | 'validation' | 'degraded' | 'not_found'}> = {
  research_resource_request_conflict: {message: '资源查询请求标识已用于其他参数。', category: 'conflict'},
  research_resource_not_found: {message: '资源观察不存在。', category: 'not_found'},
  research_resource_snapshot_invalid: {message: '资源观察校验失败。', category: 'degraded'},
  research_resource_capture_cancelled: {message: '资源查询已取消。', category: 'conflict'},
  research_resource_service_closed: {message: '资源查询服务已关闭。', category: 'degraded'},
  research_project_archived: {message: '归档项目不能执行新查询。', category: 'conflict'},
  research_doi_invalid: {message: '请输入有效的资源 DOI。', category: 'validation'}
};
export function registerResearchResourceCapabilities(context: RocPluginContext, service: ResearchResourceService,
  repository: ResearchResourceRepository): void {
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
