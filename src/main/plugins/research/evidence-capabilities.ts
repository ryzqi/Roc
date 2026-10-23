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

const capabilities = {
  capture: descriptor('research.evidence.capture', researchEvidenceCaptureRequestSchema, researchEvidenceSchema),
  list: descriptor('research.evidence.list', researchEvidenceListRequestSchema, researchEvidenceSchema.array()),
  createClaim: descriptor('research.claims.create', researchClaimCreateRequestSchema, researchClaimSchema),
  updateClaim: descriptor('research.claims.update', researchClaimUpdateRequestSchema, researchClaimSchema),
  listClaims: descriptor('research.claims.list', researchClaimListRequestSchema, researchClaimSchema.array()),
  claimHistory: descriptor('research.claims.history', researchClaimHistoryRequestSchema, researchClaimSchema.array())
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
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
