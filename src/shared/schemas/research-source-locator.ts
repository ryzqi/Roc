import {z} from 'zod';

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
  textSpan: z.object({start: z.number().int().nonnegative(), end: z.number().int().positive()}).strict().refine(span => span.end > span.start).optional(),
  locations: z.array(z.object({
    page: z.number().int().positive(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    coordinateOrigin: z.enum(['TOPLEFT', 'BOTTOMLEFT']).nullable()
  }).strict().refine(location => (location.bbox === null) === (location.coordinateOrigin === null),
    'A region and its coordinate origin must be present together.'))
}).strict();

export type ResearchSourceLocator = z.infer<typeof researchSourceLocatorSchema>;
