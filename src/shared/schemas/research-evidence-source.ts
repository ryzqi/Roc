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

export const researchEvidenceInspectRequestSchema = z.object({
  projectId: z.string().trim().min(1), evidenceId: z.string().trim().min(1)
}).strict();
export const researchEvidenceInspectionSchema = z.object({
  source: researchInspectedEvidenceSchema,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
