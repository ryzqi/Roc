import {z} from 'zod';

export const paperSectionCategorySchema = z.enum(['title', 'abstract', 'introduction', 'method', 'experiments',
  'results', 'discussion', 'conclusion', 'appendix', 'references', 'unknown']);
export const scientificBlockRoleSchema = z.enum(['problem', 'contribution', 'method', 'dataset', 'metric',
  'experimental_setup', 'result', 'ablation', 'limitation']);
export const paperBlockSemanticSchema = z.object({
  version: z.literal(1),
  classifierVersion: z.string().min(1),
  status: z.enum(['classified', 'unknown', 'not_applicable']),
  roles: z.array(z.object({
    role: scientificBlockRoleSchema,
    // Classifier strength, not a calibrated probability or scientific approval.
    confidence: z.number().min(0).max(1),
    source: z.enum(['rule', 'model']),
    signals: z.array(z.string().min(1)).max(8)
  }).strict()).max(9)
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'classified') !== (value.roles.length > 0) ||
      new Set(value.roles.map(item => item.role)).size !== value.roles.length) {
    ctx.addIssue({code: 'custom', message: 'paper_block_roles_invalid'});
  }
});
export const paperSectionSchema = z.object({
  id: z.string().min(1), parentId: z.string().min(1).nullable(),
  level: z.number().int().min(1).max(12), blockId: z.string().min(1),
  // Exact half-open UTF-16 source interval, including original title spelling.
  start: z.number().int().nonnegative(), end: z.number().int().positive(), title: z.string().min(1),
  category: paperSectionCategorySchema, confidence: z.number().min(0).max(1), source: z.literal('rule')
}).strict();
export const paperStructureSchema = z.object({
  version: z.literal(1), ruleVersion: z.string().min(1),
  sections: z.array(paperSectionSchema).max(50_000),
  blocks: z.array(z.object({
    blockId: z.string().min(1), sectionIds: z.array(z.string().min(1)).max(12),
    semantic: paperBlockSemanticSchema
  }).strict()).max(50_000)
}).strict();
export type PaperStructure = z.infer<typeof paperStructureSchema>;
export type PaperBlockSemantic = z.infer<typeof paperBlockSemanticSchema>;
export type PaperSection = z.infer<typeof paperSectionSchema>;

/** Source and tree references are verified before derived annotations can be published. */
export function assertPaperStructure(input: PaperStructure, blocks: readonly {id: string; text: string}[]): void {
  const value = paperStructureSchema.parse(input), byBlock = new Map(blocks.map(block => [block.id, block]));
  const bySection = new Map<string, PaperSection>();
  if (byBlock.size !== blocks.length || value.blocks.length !== blocks.length ||
      new Set(value.blocks.map(block => block.blockId)).size !== blocks.length) {
    throw new Error('research_paper_structure_blocks_invalid');
  }
  for (const section of value.sections) {
    const block = byBlock.get(section.blockId), parent = section.parentId === null ? null : bySection.get(section.parentId);
    if (!block || bySection.has(section.id) || section.end <= section.start ||
        block.text.slice(section.start, section.end) !== section.title || section.end > block.text.length ||
        (section.parentId !== null && (!parent || parent.level >= section.level))) {
      throw new Error('research_paper_section_source_invalid');
    }
    bySection.set(section.id, section);
  }
  for (const block of value.blocks) {
    if (!byBlock.has(block.blockId)) throw new Error('research_paper_structure_blocks_invalid');
    let parentId: string | null = null;
    for (const id of block.sectionIds) {
      const section = bySection.get(id);
      if (!section || section.parentId !== parentId) throw new Error('research_paper_section_path_invalid');
      parentId = id;
    }
  }
}
