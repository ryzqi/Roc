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
      catch (error) {throwSystematicReviewError(error);}
    });
  }
  register(capabilities.save, request => repository.save(request, requireResearchHuman('research.reviewProtocol.save', request.projectId)));
  register(capabilities.freeze, request => repository.freeze(request, requireResearchHuman('research.reviewProtocol.freeze', request.projectId)));
  register(capabilities.get, request => repository.get(request));
  register(capabilities.history, request => repository.history(request));
  register(capabilities.list, request => repository.list(request));
}

export function throwSystematicReviewError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const code = error.message.split(':')[0];
  if (['research_human_required', 'research_sender_required', 'research_human_project_mismatch',
    'research_review_project_mismatch', 'research_project_archived', 'research_review_screening_tool_context_required',
    'research_document_project_mismatch', 'research_library_item_archived', 'research_evidence_project_mismatch'].includes(code)) {
    throw new RocDomainError({code, message: '当前窗口身份或项目不能执行这项综述操作。', category: 'permission', retryable: false});
  }
  if (['research_review_version_conflict', 'research_review_request_conflict', 'research_review_already_frozen',
    'research_review_protocol_not_frozen', 'research_review_search_retry_conflict', 'research_review_search_not_active',
    'research_review_search_pool_unavailable', 'research_review_corpus_source_changed',
    'research_review_corpus_source_not_terminal', 'research_review_corpus_query_set_incomplete',
    'research_review_duplicate_version_conflict', 'research_review_duplicate_already_frozen', 'research_review_duplicate_not_frozen',
    'research_review_duplicate_decision_set_changed', 'research_review_duplicate_cycle', 'research_review_duplicate_ambiguous_removal',
    'research_review_duplicate_distinct_conflict', 'research_review_screening_version_conflict',
    'research_review_screening_plan_exists', 'research_review_screening_reviewer_count_mismatch',
    'research_review_screening_reviewer_not_declared', 'research_review_screening_criterion_not_declared', 'research_review_screening_hit_not_screenable', 'research_review_screening_adjudicator_not_declared',
    'research_review_screening_arbitration_incomplete', 'research_review_screening_arbitration_not_needed',
    'research_review_screening_arbitration_decisions_changed', 'research_review_screening_already_frozen',
    'research_review_screening_not_frozen', 'research_review_screening_incomplete',
    'research_review_fulltext_version_conflict', 'research_review_fulltext_source_changed', 'research_review_fulltext_hit_not_included',
    'research_review_fulltext_not_retrieved', 'research_document_source_changed', 'research_document_preview_parse_changed',
    'research_review_extraction_version_conflict', 'research_review_extraction_source_changed', 'research_review_extraction_hit_not_included',
    'research_review_extraction_required_field_missing', 'research_review_extraction_field_not_declared', 'research_review_extraction_unit_mismatch',
    'research_review_extraction_source_unlocated', 'research_review_extraction_source_mismatch', 'research_evidence_reference_superseded',
    'research_evidence_source_parse_stale'].includes(code)) {
    throw new RocDomainError({code, message: '协议、请求或检索状态已变化，请读取当前内容后明确操作。', category: 'conflict', retryable: false});
  }
  if (['research_review_protocol_not_found', 'research_project_not_found', 'research_review_search_not_found',
    'research_review_query_not_declared', 'research_review_corpus_not_found', 'research_review_corpus_hit_not_found', 'research_review_duplicate_not_found', 'research_review_screening_plan_not_found', 'research_review_screening_decision_not_found', 'research_review_screening_suggestion_not_found', 'research_review_screening_arbitration_not_found', 'research_review_fulltext_binding_not_found',
    'research_document_not_found', 'research_document_parse_not_found', 'research_library_item_not_found',
    'research_review_extraction_not_found', 'research_evidence_not_found', 'research_evidence_chunk_not_found'].includes(code)) {
    throw new RocDomainError({code, message: '综述协议、已声明查询或检索记录不存在。', category: 'not_found', retryable: false});
  }
  if (['research_review_snapshot_invalid', 'research_review_search_snapshot_invalid', 'research_review_search_state_lost',
    'research_review_search_pool_invalid', 'research_review_search_ledger_conflict', 'research_review_search_ledger_missing',
    'research_review_search_pool_missing', 'research_review_search_closed', 'research_review_corpus_snapshot_invalid', 'research_review_duplicate_snapshot_invalid', 'research_review_screening_snapshot_invalid', 'research_review_fulltext_snapshot_invalid', 'research_document_coordinate_artifact_changed',
    'research_review_extraction_snapshot_invalid', 'research_evidence_integrity_invalid', 'research_evidence_source_identity_invalid',
    'research_evidence_source_hash_invalid', 'research_evidence_source_block_invalid', 'research_evidence_source_page_invalid',
    'research_evidence_source_region_invalid', 'research_evidence_source_locator_conflict'].includes(code)) {
    throw new RocDomainError({code, message: '保存的综述版本、检索账本或结果校验失败。', category: 'degraded', retryable: false});
  }
  throw error;
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
