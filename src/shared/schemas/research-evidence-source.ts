import {z} from 'zod';
import {researchEvidenceSchema} from './research-evidence';
import {researchSourceLocatorSchema} from './research-source-locator';

export const researchInspectedEvidenceSchema = z.object({
  evidence: researchEvidenceSchema,
  referenceStatus: z.enum(['recorded', 'superseded']),
  invalidatedAt: z.string().nullable(),
  sourceLocator: researchSourceLocatorSchema.nullable()
}).strict();

export type ResearchInspectedEvidence = z.infer<typeof researchInspectedEvidenceSchema>;
