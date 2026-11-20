import { z } from 'zod';
import {researchArtifactVersionsSchema} from './research-artifact-version';

const identifierSchema = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.json());

export const hitlDecisionTypeSchema = z.enum(['approve', 'edit', 'reject', 'revise']);

export const hitlActionSchema = z
  .object({
    name: identifierSchema,
    args: jsonObjectSchema
  })
  .strict();

export const hitlActionRequestSchema = hitlActionSchema.extend({
  description: z.string().optional()
});

export const hitlReviewConfigSchema = z
  .object({
    actionName: identifierSchema,
    allowedDecisions: z.array(hitlDecisionTypeSchema),
    argsSchema: jsonObjectSchema.optional()
  })
  .strict();

export const hitlRequestSchema = z
  .object({
    actionRequests: z.array(hitlActionRequestSchema),
    reviewConfigs: z.array(hitlReviewConfigSchema)
  })
  .strict();

export const hitlResumeDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve'), reviewedSearchPlanHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    reviewedArtifactVersions: researchArtifactVersionsSchema.optional() }).strict(),
  z
    .object({
      type: z.literal('reject'),
      reviewedArtifactVersions: researchArtifactVersionsSchema.optional(),
      message: identifierSchema.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('edit'),
      editedAction: hitlActionSchema
    })
    .strict(),
  // 科研闸门的第三态：既不是全盘接受，也不是全盘退回，而是要求修订后重审。
  z
    .object({
      type: z.literal('revise'),
      reviewedArtifactVersions: researchArtifactVersionsSchema.optional(),
      message: identifierSchema.optional()
    })
    .strict()
]);
