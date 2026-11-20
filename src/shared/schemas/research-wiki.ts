import {z} from 'zod';
import {researchClaimSchema} from './research-evidence';
import {researchInspectedEvidenceSchema} from './research-evidence-source';
import {researchEvidenceRelationSchema} from './research-evidence-relations';

export const researchWikiReadSchema = z.object({projectId: z.string().trim().min(1)}).strict();
export const researchWikiSnapshotSchema = z.object({
  claims: researchClaimSchema.array(),
  papers: z.array(z.object({evidenceId: z.string().min(1), libraryItemId: z.string().min(1),
    title: z.string(), year: z.number().int().nullable()}).strict()),
  sources: researchInspectedEvidenceSchema.array(),
  relations: researchEvidenceRelationSchema.array()
}).strict();
export type ResearchWikiSnapshot = z.infer<typeof researchWikiSnapshotSchema>;
