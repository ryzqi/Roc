import {z} from 'zod';
import {researchSourceLocatorSchema} from './research-source-locator';
import {paperBlockSemanticSchema, paperStructureSchema} from './research-paper-structure';
import {paperTableSchema} from './research-paper-table';
import {paperEquationSchema} from './research-paper-equation';
import {paperVisualSchema} from './research-paper-visual';
import {paperParseQualitySchema} from './research-paper-quality';

export const paperIrV2Version = 'roc-paper-ir/2.2';
const id = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sourced = z.object({id, blockId: id, sourceLocator: researchSourceLocatorSchema}).strict();
export const paperIrIdentitySchema = z.object({
  paperId: id, documentId: id, knowledgeDocumentId: id, parseId: id,
  sourceHash: hash, parseHash: hash, parserFingerprint: hash
}).strict();
export const paperIrMetadataSchema = z.object({
  title: z.string().nullable(), authors: z.array(z.string()), doi: z.string().nullable(),
  year: z.number().int().nullable(), origin: z.enum(['library', 'unknown'])
}).strict();
export const paperIrArtifactSchema = z.object({
  version: z.literal(paperIrV2Version), path: id, sha256: hash, size: z.number().int().positive(),
  identity: paperIrIdentitySchema, metadata: paperIrMetadataSchema, indexedBlocksHash: hash
}).strict();
export const paperIrV2Schema = z.object({
  schemaVersion: z.literal(2), version: z.literal(paperIrV2Version), identity: paperIrIdentitySchema,
  metadata: paperIrMetadataSchema,
  /** Retain the source annotation contract as well as the parse-bound tree. */
  structure: paperStructureSchema,
  sections: z.array(sourced.extend({
    originalId: id, parentId: id.nullable(), title: z.string(), category: z.string(), level: z.number().int().positive()
  }).strict()),
  blocks: z.array(sourced.extend({
    originalId: id, kind: z.enum(['heading', 'paragraph', 'table', 'figure', 'formula']),
    text: z.string(), label: z.string(), sectionIds: z.array(id), semantic: paperBlockSemanticSchema
  }).strict()),
  tables: z.array(sourced.extend({
    data: paperTableSchema,
    cells: z.array(sourced.extend({originalId: id, row: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(), text: z.string(), geometry: z.enum(['cell', 'unknown'])
    }).strict()),
    visual: paperVisualSchema.optional()
  }).strict()),
  figures: z.array(sourced.extend({data: paperVisualSchema}).strict()),
  equations: z.array(sourced.extend({data: paperEquationSchema}).strict()),
  algorithms: z.array(sourced.extend({text: z.string(), steps: z.array(sourced.extend({text: z.string()}).strict())}).strict()),
  citations: z.array(sourced.extend({
    text: z.string(), targetIds: z.array(id), unresolvedTargets: z.array(z.string()),
    status: z.enum(['linked', 'candidate']), origin: z.enum(['original-numbered', 'grobid-matched'])
  }).strict()),
  references: z.array(sourced.extend({
    text: z.string(), number: z.string().nullable(), originalId: id, origin: z.enum(['original-numbered', 'grobid-matched'])
  }).strict()),
  relations: z.array(z.object({
    id, type: z.enum(['contains', 'caption_of', 'references', 'explains', 'defines', 'follows', 'belongs_to']),
    fromId: id, toId: id, sourceLocator: researchSourceLocatorSchema,
    status: z.enum(['linked', 'candidate'])
  }).strict()),
  quality: paperParseQualitySchema
}).strict();
export type PaperIRV2 = z.infer<typeof paperIrV2Schema>;
export type PaperIRIdentity = z.infer<typeof paperIrIdentitySchema>;
export type PaperIRArtifact = z.infer<typeof paperIrArtifactSchema>;
export type PaperIRMetadata = z.infer<typeof paperIrMetadataSchema>;

/** Encode components, so colons and separators in original IDs cannot alias another object. */
export function paperObjectId(kind: string, parseId: string, originalId: string): string {
  return `${kind}:${encodeURIComponent(parseId)}:${encodeURIComponent(originalId)}`;
}
