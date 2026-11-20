import {z} from 'zod';
import {paperChunkSchema} from './research-paper-ir';

export const paperCardRoles = ['problem', 'contribution', 'method', 'experimental_setup', 'results', 'limitations'] as const;
export const paperCardDerivationSchema = z.object({
  extractorVersion: z.string().min(1), promptVersion: z.string().min(1),
  modelRevision: z.string().min(1).nullable(), outputSchemaVersion: z.number().int().positive()
}).strict();
/** Old parsed sources may have no published IR or original-byte hash; never substitute a prose hash. */
export const paperCardFingerprintSchema = paperCardDerivationSchema.extend({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), parseId: z.string().min(1),
  paperIrHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), chunkVersion: z.string().min(1)
}).strict();
export const paperSourceSchema = paperChunkSchema.extend({
  documentId: z.string().min(1), knowledgeDocumentId: z.string().min(1), chunkId: z.string().min(1),
  indexedVersion: z.string().regex(/^[a-f0-9]{64}$/u), locator: z.string().min(1)
}).strict();
export const paperCardExtractionSchema = z.object({
  sections: z.array(z.object({
    role: z.enum(paperCardRoles), body: z.string().trim().min(1).max(2000),
    chunkIds: z.array(z.string().min(1)).max(4)
  }).strict()).length(6)
}).strict().refine(value => new Set(value.sections.map(section => section.role)).size === 6, 'All six roles required');
export type PaperSource = z.infer<typeof paperSourceSchema>;
export type PaperCardExtraction = z.infer<typeof paperCardExtractionSchema>;
export type PaperCardDerivation = z.infer<typeof paperCardDerivationSchema>;
export type PaperCardFingerprint = z.infer<typeof paperCardFingerprintSchema>;
