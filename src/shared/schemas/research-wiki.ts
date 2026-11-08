import {z} from 'zod';
import {researchClaimSchema} from './research-evidence';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema} from './research-evidence-relations';

export const researchWikiReadSchema = z.object({projectId: z.string().trim().min(1)}).strict();
export const researchWikiSnapshotSchema = z.object({
  claims: researchClaimSchema.array(),
  sources: researchInspectedEvidenceSchema.array(),
  relations: researchEvidenceRelationSchema.array()
}).strict();
export type ResearchWikiSnapshot = z.infer<typeof researchWikiSnapshotSchema>;
