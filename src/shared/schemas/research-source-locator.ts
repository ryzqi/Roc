import {z} from 'zod';
import {researchPageLocationSchema} from './research-page-location';

const identifier = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

/** Coordinates describe the captured parse, never a guessed region in a later parse. */
export const researchSourceLocatorSchema = z.object({
  documentId: identifier,
  parseId: identifier,
  knowledgeDocumentId: identifier,
  blockId: identifier,
  sourceHash: hash,
  parseHash: hash,
  parserFingerprint: hash,
  rawLocator: identifier,
  /** A parse-bound scientific object may refine the original block without changing its identity. */
  objectId: identifier.optional(),
  parentBlockId: identifier.optional(),
  textSpan: z.object({start: z.number().int().nonnegative(), end: z.number().int().positive()}).strict().refine(span => span.end > span.start).optional(),
  locations: z.array(researchPageLocationSchema)
}).strict();

export type ResearchSourceLocator = z.infer<typeof researchSourceLocatorSchema>;
