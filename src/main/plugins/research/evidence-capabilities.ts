import {researchWikiReadSchema, researchWikiSnapshotSchema} from '../../../shared/schemas/research-wiki';
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
import {
  researchSourceReplacementRequestSchema, researchSourceReplacementListSchema, researchSourceReplacementGetSchema,
  researchSourceReplacementSchema, researchSourceReplacementInspectionSchema
} from '../../../shared/schemas/research-source-replacements';

const capabilities = {
  wikiSnapshot: descriptor('research.wiki.snapshot', researchWikiReadSchema, researchWikiSnapshotSchema),
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
  rejectSourceMigration: descriptor('research.sourceMigrations.reject', researchSourceMigrationRejectSchema, researchSourceMigrationDecisionSchema),
  replaceSource: descriptor('research.sourceReplacements.replace', researchSourceReplacementRequestSchema, researchSourceReplacementSchema),
  listSourceReplacements: descriptor('research.sourceReplacements.list', researchSourceReplacementListSchema, researchSourceReplacementInspectionSchema.array()),
  getSourceReplacement: descriptor('research.sourceReplacements.get', researchSourceReplacementGetSchema, researchSourceReplacementInspectionSchema)
};

export const researchEvidenceCapabilities = Object.values(capabilities);

export function registerResearchEvidenceCapabilities(context: RocPluginContext, repository: ResearchEvidenceRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async (input) => {
      try { return run(capability.inputSchema.parse(input)); }
      catch (error) {
        // 旧证据与原文仍保存；重解析或明确来源替代会撤销它作为当前支持的资格。
        if (error instanceof Error && error.message === 'research_evidence_reference_superseded') {
          throw new RocDomainError({
            code: 'research_evidence_reference_superseded',
            message: '该证据引用的来源版本已失效；核对来源变更、捕获新版本并重新审核相关主张。',
            category: 'conflict', retryable: false
          });
        }
        if (error instanceof Error && capability.name.startsWith('research.relations.')) throwRelationError(error);
        if (error instanceof Error && (capability.name === 'research.evidence.inspect' || capability.name === 'research.wiki.snapshot')) throwRelationError(error);
        if (error instanceof Error && capability.name.startsWith('research.sourceMigrations.')) throwSourceMigrationError(error);
        if (error instanceof Error && capability.name.startsWith('research.sourceReplacements.')) throwSourceReplacementError(error);
        throw error;
      }
    });
  }
  register(capabilities.wikiSnapshot, request => repository.wikiSnapshot(request.projectId));
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
  register(capabilities.replaceSource, request =>
    repository.sourceReplacements.replace(request, requireResearchHuman('research.sourceReplacements.replace', request.projectId)));
  register(capabilities.listSourceReplacements, request => repository.sourceReplacements.list(request));
  register(capabilities.getSourceReplacement, request => repository.sourceReplacements.get(request));
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

function throwSourceReplacementError(error: Error): never {
  const code = error.message.split(':')[0];
  if (['research_human_required', 'research_sender_required', 'research_human_project_mismatch',
    'research_source_replacement_project_mismatch', 'research_evidence_project_mismatch', 'research_project_archived'].includes(code)) {
    throw new RocDomainError({code, message: '当前窗口身份或项目不能替代该证据来源。', category: 'permission', retryable: false});
  }
  if (['research_source_replacement_request_conflict', 'research_source_replacement_same_source',
    'research_source_replacement_source_changed', 'research_source_replacement_target_changed', 'research_source_replacement_target_stale',
    'research_source_replacement_already_linked', 'research_source_replacement_documents_required',
    'research_source_replacement_executions_required', 'research_source_replacement_execution_not_completed'].includes(code)) {
    throw new RocDomainError({code, message: '必须明确选择当前的真实文档或已完成实验版本，重新核对两端后再替代。', category: 'conflict', retryable: false});
  }
  if (['research_source_replacement_not_found', 'research_evidence_not_found', 'research_project_not_found'].includes(code)) {
    throw new RocDomainError({code, message: '来源替代记录、证据或项目不存在。', category: 'not_found', retryable: false});
  }
  if (['research_source_replacement_snapshot_invalid', 'research_evidence_integrity_invalid'].includes(code)) {
    throw new RocDomainError({code, message: '保存的来源或替代记录校验失败。', category: 'degraded', retryable: false});
  }
  throw error;
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
