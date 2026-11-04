import {z} from 'zod';
import {researchPdfCoordinateFrameSchema, researchPdfRegionProjectionSchema} from './research-document-coordinates';

const identifier = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** A user-selected location in an exact parse; this never represents a scientific review. */
export const researchDocumentAnnotationTargetSchema = z.object({
  projectId: identifier,
  documentId: identifier,
  parseId: identifier,
  sourceHash: digest,
  parseHash: digest,
  parserFingerprint: digest,
  page: z.number().int().positive(),
  blockId: identifier.nullable(),
  coordinateBasis: z.object({
    snapshotHash: digest,
    frame: researchPdfCoordinateFrameSchema
  }).strict().nullable(),
  location: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('page')}).strict(),
    z.object({
      kind: z.literal('pdf-region'),
      unit: z.literal('pdf-user-space'),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()])
    }).strict()
  ])
}).strict().refine(target => target.coordinateBasis === null || target.coordinateBasis.frame.page === target.page,
  'The captured coordinate frame must belong to the selected page.')
  .refine(target => target.location.kind === 'page' ||
    (target.coordinateBasis !== null && researchPdfRegionProjectionSchema.safeParse({
      frame: target.coordinateBasis.frame, bbox: target.location.bbox
    }).success), 'A region requires its measured PDF basis and must lie inside the captured CropBox.');

export const researchDocumentAnnotationIssueSchema = z.enum(['note', 'number', 'unit', 'formula', 'table', 'recognition']);
export const researchDocumentAnnotationCreateRequestSchema = z.object({
  requestId: identifier,
  target: researchDocumentAnnotationTargetSchema,
  issue: researchDocumentAnnotationIssueSchema,
  note: z.string().trim().min(1).max(10000)
}).strict();

export type ResearchDocumentAnnotationTarget = z.infer<typeof researchDocumentAnnotationTargetSchema>;
export type ResearchDocumentAnnotationCreateRequest = z.infer<typeof researchDocumentAnnotationCreateRequestSchema>;
