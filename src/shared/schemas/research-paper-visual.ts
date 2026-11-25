import {z} from 'zod';
import {researchPageLocationSchema, sameResearchPageLocation} from './research-page-location';
import {equationEvidenceSchema, assertEquationEvidence, type EquationEvidence} from './research-paper-equation';
export const paperVisualVersion = 'roc-paper-visual/2';
export const paperVisualSchema = z.object({
  version: z.literal(paperVisualVersion), id: z.string().min(1), blockId: z.string().min(1),
  kind: z.enum(['figure', 'table']), objectNumber: z.string().nullable(),
  source: researchPageLocationSchema.safeExtend({locator: z.string().min(1)}).strict(),
  imagePath: z.string().nullable(), assetId: z.string().nullable(),
  captions: z.array(z.object({status: z.enum(['linked', 'candidate']), number: z.string().nullable(),
    crossPage: z.boolean(), ruleScore: z.number().min(0).max(1), signals: z.array(z.string()).max(8),
    evidence: equationEvidenceSchema}).strict()).max(100),
  references: z.array(z.object({status: z.enum(['linked', 'candidate']), number: z.string(),
    evidence: equationEvidenceSchema}).strict()).max(10_000),
  warnings: z.array(z.string()).max(100)
}).strict().refine(value => value.id === `${value.kind}:${value.blockId}` &&
  value.captions.every(caption => caption.status !== 'linked' || !caption.crossPage && caption.ruleScore >= .9),
  'research_visual_binding_invalid');
export type PaperVisual = z.infer<typeof paperVisualSchema>;
type VisualBlock = {id: string; kind: string; locator: string; visual?: PaperVisual;
  locations?: EquationEvidence['locations']; imagePath?: string | null; imageAssetId?: string | null};
export function assertPaperVisualBlock(block: VisualBlock): void {
  if (!block.visual) return;
  const value = paperVisualSchema.parse(block.visual);
  if (value.kind !== block.kind || value.blockId !== block.id || value.source.locator !== block.locator ||
      block.locations && !block.locations.some(l => sameResearchPageLocation(l, value.source)) ||
      block.imagePath !== undefined && (value.imagePath !== block.imagePath || value.assetId !== null) ||
      block.imageAssetId !== undefined && value.assetId !== block.imageAssetId) throw new Error('research_visual_binding_invalid');
}
export function assertPaperVisualEvidence(blocks: readonly (VisualBlock & {text: string; locations: EquationEvidence['locations']})[]): void {
  for (const block of blocks) if (block.visual) for (const link of [...block.visual.captions, ...block.visual.references]) {
    assertEquationEvidence(link.evidence, blocks);
  }
}
