import {z} from 'zod';
import {scientificSearchResultSchema} from './research-scientific-search';
import {scientificContextResultSchema} from './research-scientific-context';
import {researchSourceLocatorSchema} from './research-source-locator';

const id = z.string().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(32_000);
const base = {id, text};
export const scientificEvidenceVersion = 'roc-scientific-evidence/1';
/** A model proposes statements. It cannot supply a successful validation status. */
export const scientificStatementSchema = z.discriminatedUnion('kind', [
  z.object({...base, kind: z.literal('quote'), evidenceId: id, sourceLocator: researchSourceLocatorSchema,
    start: z.number().int().nonnegative(), end: z.number().int().positive()}).strict(),
  z.object({...base, kind: z.literal('table_value'), evidenceId: id, objectId: id, cellId: id}).strict(),
  z.object({...base, kind: z.literal('equation'), evidenceId: id, objectId: id}).strict(),
  z.object({...base, kind: z.literal('claim'), evidenceIds: z.array(id).max(50)}).strict(),
  z.object({...base, kind: z.literal('inference'), evidenceIds: z.array(id).max(50)}).strict(),
  z.object({...base, kind: z.literal('comparison'), evidenceIds: z.array(id).min(2).max(50)}).strict()
]);
export const scientificEvidenceRequestSchema = z.object({
  search: scientificSearchResultSchema, context: scientificContextResultSchema,
  statements: z.array(scientificStatementSchema).max(100).default([])
}).strict().refine(value => new Set(value.statements.map(s => s.id)).size === value.statements.length,
  'research_scientific_statement_ids_invalid');
export const scientificStatementValidationSchema = z.object({
  statementId: id, kind: z.enum(['quote', 'table_value', 'equation', 'claim', 'inference', 'comparison']),
  text, evidenceIds: z.array(id).max(50),
  sourceStatus: z.enum(['valid', 'missing', 'mismatch']),
  supportStatus: z.enum(['supported', 'inference', 'insufficient_evidence']),
  reasons: z.array(z.string().min(1))
}).strict();
export const scientificEvidenceResultSchema = z.object({
  version: z.literal(scientificEvidenceVersion), id: hash, projectId: id.nullable(),
  snapshotId: hash, contextId: hash, sourceStatus: z.literal('valid'),
  statements: z.array(scientificStatementValidationSchema).max(100),
  answerStatus: z.enum(['supported', 'inference', 'insufficient_evidence']),
  canAnswerAsFacts: z.boolean()
}).strict();
export type ScientificStatement = z.infer<typeof scientificStatementSchema>;
export type ScientificStatementValidation = z.infer<typeof scientificStatementValidationSchema>;
export type ScientificEvidenceRequest = z.infer<typeof scientificEvidenceRequestSchema>;
export type ScientificEvidenceResult = z.infer<typeof scientificEvidenceResultSchema>;
