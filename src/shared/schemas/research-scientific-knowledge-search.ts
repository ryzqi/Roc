import {z} from 'zod';
import {scientificIdSchema, scientificFactSchema} from './research-scientific-facts';
import {scientificEntitySchema, scientificEntityTypeSchema} from './research-scientific-entities';
import {scientificRelationSchema, scientificRelationTypeSchema} from './research-scientific-relations';
import {wikiPaperKnowledgeSourceSchema} from './research-wiki-pages';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ids = z.array(scientificIdSchema).max(100)
  .refine(value => new Set(value).size === value.length, 'Duplicate identifiers');
const base = {
  projectId: scientificIdSchema, documentIds: ids.default([]),
  query: z.string().trim().max(300).default(''),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(20).default(10),
  basisDigest: digest.nullable().default(null)
};
export const scientificEntitySearchSchema = z.object({...base, kind: z.literal('entity'),
  entityTypes: z.array(scientificEntityTypeSchema).max(11).default([])}).strict();
export const scientificFactSearchSchema = z.object({...base, kind: z.literal('fact'),
  factTypes: z.array(scientificFactSchema.shape.factType).max(7).default([]),
  methodId: scientificIdSchema.nullable().default(null),
  datasetId: scientificIdSchema.nullable().default(null),
  metricId: scientificIdSchema.nullable().default(null),
  baselineId: scientificIdSchema.nullable().default(null),
  datasetVersion: z.string().min(1).max(16000).nullable().default(null),
  split: z.string().min(1).max(16000).nullable().default(null)
}).strict();
export const scientificRelationSearchSchema = z.object({...base, kind: z.literal('relation'),
  relationTypes: z.array(scientificRelationTypeSchema).max(4).default([]),
  entityId: scientificIdSchema.nullable().default(null),
  fromEntityId: scientificIdSchema.nullable().default(null),
  toEntityId: scientificIdSchema.nullable().default(null)
}).strict();
export const scientificKnowledgeSearchSchema = z.discriminatedUnion('kind', [
  scientificEntitySearchSchema, scientificFactSearchSchema, scientificRelationSearchSchema
]);
const hit = {source: wikiPaperKnowledgeSourceSchema, exactMatch: z.boolean()};
export const scientificKnowledgeSearchHitSchema = z.discriminatedUnion('kind', [
  z.object({...hit, kind: z.literal('entity'), value: scientificEntitySchema}).strict(),
  z.object({...hit, kind: z.literal('fact'), value: scientificFactSchema,
    entities: z.array(scientificEntitySchema).max(5)}).strict(),
  z.object({...hit, kind: z.literal('relation'), value: scientificRelationSchema,
    entities: z.array(scientificEntitySchema).max(2)}).strict()
]);
export const scientificKnowledgeSearchResultSchema = z.object({
  projectId: scientificIdSchema, kind: z.enum(['entity', 'fact', 'relation']), basisDigest: digest,
  hits: z.array(scientificKnowledgeSearchHitSchema).max(20),
  unavailable: z.array(z.object({documentId: scientificIdSchema, state: z.enum(['missing', 'stale']),
    configurationError: z.string().nullable()}).strict()).max(100),
  nextOffset: z.number().int().nonnegative().nullable(),
  scientificApproval: z.literal('unreviewed')
}).strict();
export type ScientificKnowledgeSearchRequest = z.infer<typeof scientificKnowledgeSearchSchema>;
export type ScientificKnowledgeSearchHit = z.infer<typeof scientificKnowledgeSearchHitSchema>;
export type ScientificKnowledgeSearchResult = z.infer<typeof scientificKnowledgeSearchResultSchema>;
