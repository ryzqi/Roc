import {z} from 'zod';

export const paperSemanticRoleSchema = z.enum(['abstract', 'problem', 'contribution', 'method',
  'experimental_setup', 'results', 'ablation', 'limitations', 'unknown']);
export const paperChunkSchema = z.object({
  paperId: z.string().min(1), parseId: z.string().nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), blockId: z.string().min(1),
  sectionPath: z.array(z.string()).max(12), semanticRole: paperSemanticRoleSchema,
  blockKind: z.enum(['heading', 'paragraph', 'table', 'figure', 'formula']),
  relatedBlockIds: z.array(z.string()).max(4)
}).strict();
export type PaperChunk = z.infer<typeof paperChunkSchema>;
