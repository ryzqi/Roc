import {z} from 'zod';
import {paperBlockSemanticSchema} from './research-paper-structure';
import {paperTableSchema} from './research-paper-table';
import {paperEquationSchema} from './research-paper-equation';
import {paperVisualSchema} from './research-paper-visual';

export const paperSemanticRoleSchema = z.enum(['abstract', 'problem', 'contribution', 'method',
  'experimental_setup', 'results', 'ablation', 'limitations', 'unknown']);
export const paperChunkSchema = z.object({
  paperId: z.string().min(1), parseId: z.string().nullable(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), blockId: z.string().min(1),
  sectionPath: z.array(z.string()).max(12), semanticRole: paperSemanticRoleSchema,
  blockKind: z.enum(['heading', 'paragraph', 'table', 'figure', 'formula']),
  relatedBlockIds: z.array(z.string()).max(4),
  sectionIds: z.array(z.string().min(1)).max(12).optional(),
  scientific: paperBlockSemanticSchema.optional(),
  table: paperTableSchema.optional(), equation: paperEquationSchema.optional(), visual: paperVisualSchema.optional()
}).strict().refine(value => !value.table || value.blockKind === 'table' && value.table.blockId === value.blockId,
  'research_table_binding_invalid').refine(value => !value.equation || value.blockKind === 'formula' && value.equation.blockId === value.blockId,
  'research_equation_binding_invalid').refine(value => !value.visual || value.visual.kind === value.blockKind && value.visual.blockId === value.blockId,
  'research_visual_binding_invalid');
export type PaperChunk = z.infer<typeof paperChunkSchema>;
