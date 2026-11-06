import type {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {
  openReviewCaptureSchema, openReviewCancelSchema, openReviewCancelResultSchema, openReviewSummarySchema,
  openReviewHistorySchema, openReviewHistoryResultSchema, openReviewReadSchema, openReviewReadResultSchema
} from '../../../shared/schemas/research-openreview';
import {RocDomainError} from '../../services/errors';
import type {OpenReviewService} from './openreview-service';
import type {OpenReviewRepository} from './openreview-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  capture: descriptor('research.openreview.capture', openReviewCaptureSchema, openReviewSummarySchema),
  cancel: descriptor('research.openreview.cancel', openReviewCancelSchema, openReviewCancelResultSchema),
  history: descriptor('research.openreview.history', openReviewHistorySchema, openReviewHistoryResultSchema),
  read: descriptor('research.openreview.read', openReviewReadSchema, openReviewReadResultSchema)
};
export const researchOpenReviewCapabilities = Object.values(capabilities);
const failures: Record<string, {message: string; category: 'conflict' | 'degraded' | 'not_found'}> = {
  research_openreview_request_conflict: {message: 'OpenReview 查询标识已用于其他参数。', category: 'conflict'},
  research_openreview_not_found: {message: 'OpenReview 观察不存在。', category: 'not_found'},
  research_openreview_snapshot_invalid: {message: 'OpenReview 观察校验失败。', category: 'degraded'},
  research_openreview_capture_cancelled: {message: 'OpenReview 查询已取消。', category: 'conflict'},
  research_openreview_service_closed: {message: 'OpenReview 查询服务已关闭。', category: 'degraded'},
  research_project_archived: {message: '归档项目不能执行新查询。', category: 'conflict'}
};
export function registerResearchOpenReviewCapabilities(context: RocPluginContext, service: OpenReviewService,
  repository: OpenReviewRepository): void {
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
