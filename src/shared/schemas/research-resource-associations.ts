import {z} from 'zod';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(8192);
export const resourceTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('literature'), itemId: id, expectedRevision: z.number().int().positive(),
    expectedDoi: id.nullable(), expectedMetadataHash: hash}),
  z.strictObject({kind: z.literal('experiment'), runId: id, expectedInputHash: hash,
    expectedEnvironmentHash: hash, expectedExecutionHash: hash})
]);
export const resourceAssociationSaveSchema = z.strictObject({
  projectId: id, requestId: id, resourceId: id, resourceHash: hash,
  target: resourceTargetSchema, rationale: text
});
export const resourceAssociationSchema = z.strictObject({
  id, projectId: id, request: resourceAssociationSaveSchema,
  verification: z.literal('user_declared_context'), actor: researchRelationReviewerSchema,
  resourceTitle: text, targetTitle: text, createdAt: z.string().datetime(), contentHash: hash
});
export const resourceAssociationReadSchema = z.strictObject({projectId: id, associationId: id});
export const resourceAssociationResultSchema = z.strictObject({
  association: resourceAssociationSchema, currentState: z.enum(['current', 'target_changed', 'target_unavailable'])
});
const page = {offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)};
const pageResult = {total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable()};
export const resourceTargetsSchema = z.strictObject({projectId: id, kind: z.enum(['literature', 'experiment']), ...page});
export const resourceTargetsResultSchema = z.strictObject({
  records: z.array(z.strictObject({target: resourceTargetSchema, title: text})).max(50), ...pageResult
});
export const resourceAssociationHistorySchema = z.strictObject({
  projectId: id, resourceId: id.nullable(),
  target: z.strictObject({kind: z.enum(['literature', 'experiment']), id}).nullable(), ...page
});
export const resourceAssociationHistoryResultSchema = z.strictObject({
  records: z.array(resourceAssociationResultSchema).max(50), ...pageResult
});
export type ResourceTarget = z.infer<typeof resourceTargetSchema>;
export type ResourceAssociationSave = z.infer<typeof resourceAssociationSaveSchema>;
export type ResourceAssociation = z.infer<typeof resourceAssociationSchema>;
export type ResourceAssociationResult = z.infer<typeof resourceAssociationResultSchema>;
