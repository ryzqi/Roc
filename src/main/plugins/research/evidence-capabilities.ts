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
    context.capabilities.register(context.pluginId, capability, async (input) => run(capability.inputSchema.parse(input)));
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
