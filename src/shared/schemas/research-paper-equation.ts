import {z} from 'zod';
import {researchPageLocationSchema, sameResearchPageLocation} from './research-page-location';

export const paperEquationVersion = 'roc-paper-equation/2';
export const latexNormalizationVersion = 'roc-latex-whitespace/1';
export const equationLatexLimit = 128 * 1024;
const location = researchPageLocationSchema;
export const equationEvidenceSchema = z.object({
  blockId: z.string().min(1), locator: z.string().min(1), text: z.string(),
  textSpan: z.object({start: z.number().int().nonnegative(), end: z.number().int().nonnegative()}).strict(),
  locations: z.array(location)
}).strict().refine(value => value.textSpan.end - value.textSpan.start === value.text.length, 'research_equation_evidence_invalid');
export type EquationEvidence = z.infer<typeof equationEvidenceSchema>;
const shape = z.object({
  version: z.literal(paperEquationVersion), id: z.string().min(1), blockId: z.string().min(1),
  status: z.enum(['parsed', 'missing', 'invalid']),
  rawLatex: z.string().max(equationLatexLimit).nullable(), normalizedLatex: z.string().max(equationLatexLimit).nullable(),
  normalizationVersion: z.literal(latexNormalizationVersion),
  equationNumber: z.string().nullable(),
  numberEvidence: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('latex'), text: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative()}).strict(),
    z.object({kind: z.literal('block'), evidence: equationEvidenceSchema}).strict()
  ]).nullable(),
  contexts: z.array(equationEvidenceSchema).max(4),
  references: z.array(z.object({status: z.enum(['linked', 'candidate']), evidence: equationEvidenceSchema}).strict()).max(10_000),
  variables: z.array(z.object({symbol: z.string().min(1), definition: z.string().min(1),
    evidence: equationEvidenceSchema}).strict()).max(100),
  source: location.safeExtend({locator: z.string().min(1)}).strict(),
  imagePath: z.string().nullable(), assetId: z.string().nullable(), warnings: z.array(z.string()).max(100)
}).strict();
export type PaperEquation = z.infer<typeof shape>;

/** Keep mathematical tokens and spaces, including \text{} content, unchanged. */
export function normalizePaperLatex(raw: string): string {
  return raw.replace(/\r\n?/gu, '\n').trim();
}
export function latexHasBalancedBraces(raw: string): boolean {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {i++; continue;}
    if (raw[i] === '{') depth++;
    if (raw[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}
export const paperEquationSchema = shape.superRefine((value, context) => {
  if (value.id !== `equation:${value.blockId}` ||
      value.normalizedLatex !== (value.rawLatex === null ? null : normalizePaperLatex(value.rawLatex)) ||
      (value.status === 'missing') !== (value.rawLatex === null) ||
      value.status === 'parsed' && (!value.normalizedLatex || !latexHasBalancedBraces(value.rawLatex!) || value.rawLatex!.includes('\u0000')) ||
      (value.equationNumber === null) !== (value.numberEvidence === null)) {
    context.addIssue({code: 'custom', message: 'research_equation_binding_invalid'});
  }
  if (value.numberEvidence?.kind === 'latex' &&
      value.rawLatex?.slice(value.numberEvidence.start, value.numberEvidence.end) !== value.numberEvidence.text) {
    context.addIssue({code: 'custom', message: 'research_equation_evidence_invalid'});
  }
  if (value.numberEvidence) {
    const number = value.numberEvidence.kind === 'latex'
      ? value.numberEvidence.text.match(/^\\tag\*?\s*\{\s*((?:[A-Z][.-]?)?\d+(?:[.-]\d+)*)\s*\}$/u)?.[1]
      : value.numberEvidence.evidence.text.match(/^\s*\(((?:[A-Z][.-]?)?\d+(?:[.-]\d+)*)\)\s*$/u)?.[1];
    if (number !== value.equationNumber) context.addIssue({code: 'custom', message: 'research_equation_evidence_invalid'});
  }
});

export function assertEquationEvidence(evidence: EquationEvidence, blocks: readonly {
  id: string; text: string; locator: string; locations: EquationEvidence['locations']}[]): void {
  const block = blocks.find(b => b.id === evidence.blockId);
  if (!block || block.locator !== evidence.locator ||
      block.text.slice(evidence.textSpan.start, evidence.textSpan.end) !== evidence.text ||
      JSON.stringify(block.locations) !== JSON.stringify(evidence.locations)) throw new Error('research_equation_evidence_invalid');
}
export function assertPaperEquationBlock(block: {id: string; kind: string; locator: string; equation?: PaperEquation;
  locations?: EquationEvidence['locations']; imagePath?: string | null; imageAssetId?: string | null}): void {
  if (!block.equation) return;
  const value = paperEquationSchema.parse(block.equation);
  if (block.kind !== 'formula' || value.blockId !== block.id || value.source.locator !== block.locator ||
      block.locations && !block.locations.some(l => sameResearchPageLocation(l, value.source)) ||
      block.imagePath !== undefined && (value.imagePath !== block.imagePath || value.assetId !== null) ||
      block.imageAssetId !== undefined && value.assetId !== block.imageAssetId) throw new Error('research_equation_binding_invalid');
}
