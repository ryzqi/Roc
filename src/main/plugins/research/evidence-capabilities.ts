import type { z } from 'zod';

import {
  researchClaimCreateRequestSchema,
  researchClaimHistoryRequestSchema,
  researchClaimListRequestSchema,
  researchClaimSchema,
  researchClaimUpdateRequestSchema,
  researchEvidenceCaptureRequestSchema,
  researchEvidenceListRequestSchema,
  researchEvidenceSchema
} from '../../../shared/schemas/research-evidence';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { ResearchEvidenceRepository } from './evidence-repository';
import {researchEvidenceInspectionSchema, researchEvidenceInspectRequestSchema} from '../../../shared/schemas/research-evidence-source';
import {
  researchEvidenceRelationProposalSchema, researchEvidenceRelationReviewSchema,
  researchEvidenceRelationSchema, researchEvidenceRelationListSchema,
  researchEvidenceRelationHistorySchema, researchEvidenceRelationRevisionSchema
} from '../../../shared/schemas/research-evidence-relations';
import {requireResearchHuman} from '../../services/research-human-context';
import {relationSourceDigest} from './evidence-relation-repository';
import {
  researchSourceMigrationListSchema, researchSourceMigrationGetSchema, researchSourceMigrationInspectionSchema,
  researchSourceMigrationCaptureSchema, researchSourceMigrationRejectSchema, researchSourceMigrationDecisionSchema
} from '../../../shared/schemas/research-source-migrations';

const capabilities = {
  capture: descriptor('research.evidence.capture', researchEvidenceCaptureRequestSchema, researchEvidenceSchema),
  list: descriptor('research.evidence.list', researchEvidenceListRequestSchema, researchEvidenceSchema.array()),
  createClaim: descriptor('research.claims.create', researchClaimCreateRequestSchema, researchClaimSchema),
  updateClaim: descriptor('research.claims.update', researchClaimUpdateRequestSchema, researchClaimSchema),
  listClaims: descriptor('research.claims.list', researchClaimListRequestSchema, researchClaimSchema.array()),
  claimHistory: descriptor('research.claims.history', researchClaimHistoryRequestSchema, researchClaimSchema.array()),
  inspectEvidence: descriptor('research.evidence.inspect', researchEvidenceInspectRequestSchema, researchEvidenceInspectionSchema),
  proposeRelation: descriptor('research.relations.propose', researchEvidenceRelationProposalSchema, researchEvidenceRelationSchema),
  reviewRelation: descriptor('research.relations.review', researchEvidenceRelationReviewSchema, researchEvidenceRelationSchema),
  listRelations: descriptor('research.relations.list', researchEvidenceRelationListSchema, researchEvidenceRelationSchema.array()),
  relationHistory: descriptor('research.relations.history', researchEvidenceRelationHistorySchema, researchEvidenceRelationRevisionSchema.array()),
  listSourceMigrations: descriptor('research.sourceMigrations.list', researchSourceMigrationListSchema, researchSourceMigrationInspectionSchema.array()),
  getSourceMigration: descriptor('research.sourceMigrations.get', researchSourceMigrationGetSchema, researchSourceMigrationInspectionSchema),
  captureSourceMigration: descriptor('research.sourceMigrations.capture', researchSourceMigrationCaptureSchema, researchSourceMigrationDecisionSchema),
  rejectSourceMigration: descriptor('research.sourceMigrations.reject', researchSourceMigrationRejectSchema, researchSourceMigrationDecisionSchema)
};

export const researchEvidenceCapabilities = Object.values(capabilities);

export function registerResearchEvidenceCapabilities(context: RocPluginContext, repository: ResearchEvidenceRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return run(capability.inputSchema.parse(input)); }
      catch (error) {
        // 引用失效不是普通错误：原文和证据都还在，只是块定位随重新解析失效（提案 §8.4）。
        if (error instanceof Error && error.message === 'research_evidence_reference_superseded') {
          throw new RocDomainError({
            code: 'research_evidence_reference_superseded',
            message: '该证据引用的解析块已随重新解析失效；原文仍可打开，重新采集一次即可恢复定位。',
            category: 'conflict', retryable: false
          });
        }
        if (error instanceof Error && capability.name.startsWith('research.relations.')) throwRelationError(error);
        if (error instanceof Error && capability.name === 'research.evidence.inspect') throwRelationError(error);
        if (error instanceof Error && capability.name.startsWith('research.sourceMigrations.')) throwSourceMigrationError(error);
        throw error;
      }
    });
  }
  register(capabilities.capture, (request) => repository.capture(request));
  register(capabilities.list, (request) => repository.list(request.projectId));
  register(capabilities.createClaim, (request) => repository.createClaim(request));
  register(capabilities.updateClaim, (request) => repository.updateClaim(request));
  register(capabilities.listClaims, (request) => repository.listClaims(request));
  register(capabilities.claimHistory, (request) => repository.claimHistory(request.id));
  register(capabilities.inspectEvidence, request => {
    const source = repository.inspectEvidence(request.evidenceId, request.projectId);
    return {source, sourceDigest: relationSourceDigest(source)};
  });
  register(capabilities.proposeRelation, request =>
    repository.relations.propose(request, requireResearchHuman('research.relations.propose', request.projectId)));
  register(capabilities.reviewRelation, request =>
    repository.relations.review(request, requireResearchHuman('research.relations.review', request.projectId)));
  register(capabilities.listRelations, request => repository.relations.list(request));
  register(capabilities.relationHistory, request => repository.relations.history(request.relationId, request.projectId));
  register(capabilities.listSourceMigrations, request => repository.sourceMigrations.list(request));
  register(capabilities.getSourceMigration, request => repository.sourceMigrations.get(request));
  register(capabilities.captureSourceMigration, request =>
    repository.sourceMigrations.decide(request, requireResearchHuman('research.sourceMigrations.capture', request.projectId)));
  register(capabilities.rejectSourceMigration, request =>
    repository.sourceMigrations.decide(request, requireResearchHuman('research.sourceMigrations.reject', request.projectId)));
}

function throwRelationError(error: Error): never {
  const code = error.message.split(':')[0];
  if ([
    'research_human_required', 'research_sender_required', 'research_human_project_mismatch', 'research_relation_project_mismatch',
    'research_evidence_project_mismatch', 'research_artifact_immutable', 'research_project_archived',
    'research_artifact_stage_inactive', 'research_relation_artifact_inactive', 'research_relation_stage_not_reviewable'
  ].includes(code)) {
    throw new RocDomainError({code, message: '当前调用身份、项目或工件状态不能审核这条关系。', category: 'permission', retryable: false});
  }
  if (['research_relation_version_conflict', 'research_relation_not_proposed', 'research_relation_claim_changed',
    'research_relation_source_changed', 'research_relation_source_invalidated', 'research_relation_supersedes_invalid'
  ].includes(code)) {
    throw new RocDomainError({code, message: '关系、主张或来源已改变。重新读取后再明确审核。', category: 'conflict', retryable: false});
  }
  if (['research_relation_not_found', 'research_evidence_not_found', 'research_claim_not_found',
    'research_project_not_found', 'research_artifact_not_found'].includes(code)) {
    throw new RocDomainError({code, message: '关系、主张、证据或项目不存在。', category: 'not_found', retryable: false});
  }
  if (['research_relation_snapshot_invalid', 'research_evidence_integrity_invalid'].includes(code)) {
    throw new RocDomainError({code, message: '保存的关系或来源校验失败。', category: 'degraded', retryable: false});
  }
  throw error;
}

function throwSourceMigrationError(error: Error): never {
  const code = error.message.split(':')[0];
  if (['research_human_required', 'research_sender_required', 'research_human_project_mismatch',
    'research_source_migration_project_mismatch', 'research_evidence_project_mismatch', 'research_project_archived'].includes(code)) {
    throw new RocDomainError({code, message: '当前窗口身份或项目不能决定这条定位候选。', category: 'permission', retryable: false});
  }
  if (['research_source_migration_request_conflict', 'research_source_migration_already_decided',
    'research_source_migration_proposal_changed', 'research_source_migration_source_changed',
    'research_source_migration_target_stale', 'research_source_migration_target_changed',
    'research_source_migration_target_not_proposed', 'research_source_migration_capture_changed'].includes(code)) {
    throw new RocDomainError({code, message: '候选、请求或来源已改变。重新读取后明确选择目标。', category: 'conflict', retryable: false});
  }
  if (['research_source_migration_not_found', 'research_source_migration_target_not_found',
    'research_evidence_not_found', 'research_evidence_chunk_not_found', 'research_project_not_found'].includes(code)) {
    throw new RocDomainError({code, message: '定位候选、解析、证据或项目不存在。', category: 'not_found', retryable: false});
  }
  if (['research_source_migration_snapshot_invalid', 'research_source_migration_target_invalid',
    'research_source_migration_index_changed', 'research_evidence_integrity_invalid',
    'research_evidence_source_identity_invalid', 'research_evidence_source_hash_invalid',
    'research_evidence_source_block_invalid', 'research_evidence_source_page_invalid',
    'research_evidence_source_region_invalid', 'research_evidence_source_locator_conflict',
    'research_evidence_source_parse_stale'].includes(code)) {
    throw new RocDomainError({code, message: '保存的候选、捕获或目标块校验失败。', category: 'degraded', retryable: false});
  }
  throw error;
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
