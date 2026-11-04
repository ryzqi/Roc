import {z} from 'zod';
import {
  researchReviewProtocolSaveRequestSchema, researchReviewProtocolFreezeRequestSchema,
  researchReviewProtocolInspectionSchema, researchReviewProtocolGetRequestSchema,
  researchReviewProtocolHistoryRequestSchema, researchReviewProtocolListRequestSchema
} from '../../../shared/schemas/research-systematic-review';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {RocDomainError} from '../../services/errors';
import type {ResearchSystematicReviewRepository} from './systematic-review-repository';

const capabilities = {
  save: descriptor('research.reviewProtocol.save', researchReviewProtocolSaveRequestSchema, researchReviewProtocolInspectionSchema),
  freeze: descriptor('research.reviewProtocol.freeze', researchReviewProtocolFreezeRequestSchema, researchReviewProtocolInspectionSchema),
  get: descriptor('research.reviewProtocol.get', researchReviewProtocolGetRequestSchema, researchReviewProtocolInspectionSchema),
  history: descriptor('research.reviewProtocol.history', researchReviewProtocolHistoryRequestSchema, researchReviewProtocolInspectionSchema.array()),
  list: descriptor('research.reviewProtocol.list', researchReviewProtocolListRequestSchema, researchReviewProtocolInspectionSchema.array())
};
export const researchSystematicReviewCapabilities = Object.values(capabilities);

export function registerResearchSystematicReviewCapabilities(context: RocPluginContext, repository: ResearchSystematicReviewRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return run(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = error.message.split(':')[0];
        if (['research_human_required', 'research_sender_required', 'research_human_project_mismatch',
          'research_review_project_mismatch', 'research_project_archived'].includes(code)) {
          throw new RocDomainError({code, message: '当前窗口身份或项目不能修改这份综述协议。', category: 'permission', retryable: false});
        }
        if (['research_review_version_conflict', 'research_review_request_conflict', 'research_review_already_frozen',
          'research_review_protocol_not_frozen'].includes(code)) {
          throw new RocDomainError({code, message: '协议版本或请求已变化，请读取当前内容后明确确认。', category: 'conflict', retryable: false});
        }
        if (['research_review_protocol_not_found', 'research_project_not_found'].includes(code)) {
          throw new RocDomainError({code, message: '综述协议版本或项目不存在。', category: 'not_found', retryable: false});
        }
        if (code === 'research_review_snapshot_invalid') {
          throw new RocDomainError({code, message: '保存的综述协议或人工确认收据校验失败。', category: 'degraded', retryable: false});
        }
        throw error;
      }
    });
  }
  register(capabilities.save, request => repository.save(request, requireResearchHuman('research.reviewProtocol.save', request.projectId)));
  register(capabilities.freeze, request => repository.freeze(request, requireResearchHuman('research.reviewProtocol.freeze', request.projectId)));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.history, request => repository.history(request));
  register(capabilities.list, request => repository.list(request));
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
