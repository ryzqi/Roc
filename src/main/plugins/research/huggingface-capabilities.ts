import type {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {
  hfCaptureSchema, hfCancelSchema, hfCancelResultSchema, hfSummarySchema,
  hfHistorySchema, hfHistoryResultSchema, hfReadSchema, hfReadResultSchema
} from '../../../shared/schemas/research-huggingface';
import {RocDomainError} from '../../services/errors';
import type {HuggingFaceService} from './huggingface-service';
import type {HuggingFaceRepository} from './huggingface-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  capture: descriptor('research.huggingface.capture', hfCaptureSchema, hfSummarySchema),
  cancel: descriptor('research.huggingface.cancel', hfCancelSchema, hfCancelResultSchema),
  history: descriptor('research.huggingface.history', hfHistorySchema, hfHistoryResultSchema),
  read: descriptor('research.huggingface.read', hfReadSchema, hfReadResultSchema)
};
export const researchHuggingFaceCapabilities = Object.values(capabilities);
const failures: Record<string, {message: string; category: 'conflict' | 'degraded' | 'not_found'}> = {
  research_hf_request_conflict: {message: 'Hugging Face 查询标识已用于其他参数。', category: 'conflict'},
  research_hf_not_found: {message: 'Hugging Face 观察不存在。', category: 'not_found'},
  research_hf_snapshot_invalid: {message: 'Hugging Face 观察校验失败。', category: 'degraded'},
  research_hf_capture_cancelled: {message: 'Hugging Face 查询已取消。', category: 'conflict'},
  research_hf_service_closed: {message: 'Hugging Face 查询服务已关闭。', category: 'degraded'},
  research_project_archived: {message: '归档项目不能执行新查询。', category: 'conflict'}
};
export function registerResearchHuggingFaceCapabilities(context: RocPluginContext, service: HuggingFaceService,
  repository: HuggingFaceRepository): void {
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
