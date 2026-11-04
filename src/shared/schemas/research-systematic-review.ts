import {z} from 'zod';
import {literatureNetworkSourceSchema} from './literature-import';
import {researchRelationReviewerSchema} from './research-evidence-relations';

const id = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const note = z.string().trim().min(1).max(10000);
const criterion = z.object({id, text: note}).strict();
const year = z.number().int().min(1000).max(9999);

/** A review protocol states its scope and methods before any search or screening. */
export const researchReviewProtocolBodySchema = z.object({
  question: note,
  pico: z.object({population: note, intervention: note, comparator: note, outcome: note}).strict().nullable(),
  inclusionCriteria: z.array(criterion).min(1).max(50),
  exclusionCriteria: z.array(criterion).min(1).max(50),
  publicationYears: z.object({from: year.nullable(), to: year.nullable()}).strict()
    .refine(value => value.from === null || value.to === null || value.from <= value.to, 'review_publication_window_invalid'),
  databases: z.array(z.object({
    source: literatureNetworkSourceSchema,
    queries: z.array(z.string().trim().min(1).max(1000)).min(1).max(3),
    pageSize: z.number().int().min(1).max(30),
    maxPages: z.number().int().min(1).max(3)
  }).strict()).min(1).max(6),
  screening: z.object({
    titleAbstractReviewers: z.union([z.literal(1), z.literal(2)]),
    fullTextReviewers: z.union([z.literal(1), z.literal(2)]),
    conflictResolution: z.literal('human_adjudication')
  }).strict(),
  qualityAssessment: z.array(z.object({
    studyDesign: note, framework: note, version: id
  }).strict()).min(1).max(20),
  extractionFields: z.array(z.object({
    id, label: id, unit: id.nullable(), required: z.boolean()
  }).strict()).min(1).max(50)
}).strict().superRefine((body, context) => {
  const criteria = [...body.inclusionCriteria, ...body.exclusionCriteria].map(value => value.id);
  if (new Set(criteria).size !== criteria.length) context.addIssue({code: 'custom', message: 'review_criterion_ids_duplicate'});
  const sources = body.databases.map(value => value.source);
  if (new Set(sources).size !== sources.length) context.addIssue({code: 'custom', message: 'review_database_duplicate'});
  for (const database of body.databases) {
    if (new Set(database.queries).size !== database.queries.length) {
      context.addIssue({code: 'custom', message: 'review_query_duplicate'});
    }
  }
  if (new Set(body.extractionFields.map(value => value.id)).size !== body.extractionFields.length) {
    context.addIssue({code: 'custom', message: 'review_extraction_field_duplicate'});
  }
});

export const researchReviewProtocolSaveRequestSchema = z.object({
  projectId: id, requestId: id, protocolId: id.nullable(),
  expectedVersionId: id.nullable(), expectedVersionHash: hash.nullable(),
  body: researchReviewProtocolBodySchema, deviationReason: note.nullable()
}).strict().refine(value => value.protocolId === null ?
  value.expectedVersionId === null && value.expectedVersionHash === null && value.deviationReason === null :
  value.expectedVersionId !== null && value.expectedVersionHash !== null && value.deviationReason !== null,
  'review_revision_requires_parent_hash_and_reason');

export const researchReviewProtocolVersionSchema = z.object({
  id, protocolId: id, projectId: id, version: z.number().int().positive(),
  parentVersionId: id.nullable(), parentVersionHash: hash.nullable(),
  body: researchReviewProtocolBodySchema, deviationReason: note.nullable(),
  requestId: id, requestHash: hash, actor: researchRelationReviewerSchema, recordedAt: z.iso.datetime()
}).strict().refine(value => value.version === 1 ?
  value.parentVersionId === null && value.parentVersionHash === null && value.deviationReason === null :
  value.parentVersionId !== null && value.parentVersionHash !== null && value.deviationReason !== null,
  'review_version_lineage_invalid');

export const researchReviewProtocolFreezeRequestSchema = z.object({
  projectId: id, requestId: id, versionId: id, expectedVersionHash: hash, reviewNote: note
}).strict();
export const researchReviewProtocolFreezeSchema = z.object({
  request: researchReviewProtocolFreezeRequestSchema, requestHash: hash,
  actor: researchRelationReviewerSchema, frozenAt: z.iso.datetime()
}).strict();
export const researchReviewProtocolInspectionSchema = z.object({
  version: researchReviewProtocolVersionSchema, versionHash: hash,
  freeze: researchReviewProtocolFreezeSchema.nullable(), freezeHash: hash.nullable(), isLatest: z.boolean()
}).strict().refine(value => (value.freeze === null) === (value.freezeHash === null), 'review_freeze_receipt_required');
export const researchReviewProtocolGetRequestSchema = z.object({projectId: id, versionId: id}).strict();
export const researchReviewProtocolHistoryRequestSchema = z.object({projectId: id, protocolId: id}).strict();
export const researchReviewProtocolListRequestSchema = z.object({
  projectId: id, limit: z.number().int().min(1).max(100)
}).strict();

export type ResearchReviewProtocolSaveRequest = z.infer<typeof researchReviewProtocolSaveRequestSchema>;
export type ResearchReviewProtocolFreezeRequest = z.infer<typeof researchReviewProtocolFreezeRequestSchema>;
export type ResearchReviewProtocolVersion = z.infer<typeof researchReviewProtocolVersionSchema>;
export type ResearchReviewProtocolInspection = z.infer<typeof researchReviewProtocolInspectionSchema>;
