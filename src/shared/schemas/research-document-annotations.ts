import {z} from 'zod';
import {researchPdfCoordinateFrameSchema, researchPdfRegionProjectionSchema} from './research-document-coordinates';
import {researchDocumentContentSchema} from './research-documents';
import {researchRelationReviewerSchema} from './research-evidence-relations';
import {researchInspectedEvidenceSchema} from './research-evidence-source';

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

export const researchDocumentAnnotationSchema = z.object({
  id: identifier,
  request: researchDocumentAnnotationCreateRequestSchema,
  requestHash: digest,
  block: researchDocumentContentSchema.shape.blocks.element.nullable(),
  actor: researchRelationReviewerSchema,
  recordedAt: identifier
}).strict().refine(value => (value.block === null) === (value.request.target.blockId === null) &&
  (value.block === null || (value.block.id === value.request.target.blockId &&
    value.block.locations.some(location => location.page === value.request.target.page))),
  'The captured block must match the selected block and page.');
export const researchDocumentAnnotationListRequestSchema = z.object({
  projectId: identifier, documentId: identifier, parseId: identifier
}).strict();
export const researchDocumentAnnotationGetRequestSchema = z.object({
  projectId: identifier, annotationId: identifier
}).strict();
export const researchDocumentAnnotationCaptureRequestSchema = researchDocumentAnnotationGetRequestSchema.extend({
  requestId: identifier, expectedAnnotationHash: digest
}).strict();
export const researchDocumentAnnotationCaptureSchema = z.object({
  id: identifier,
  request: researchDocumentAnnotationCaptureRequestSchema,
  requestHash: digest,
  actor: researchRelationReviewerSchema,
  source: researchInspectedEvidenceSchema,
  sourceDigest: digest,
  recordedAt: identifier
}).strict();
export const researchDocumentAnnotationInspectionSchema = z.object({
  annotation: researchDocumentAnnotationSchema,
  annotationHash: digest,
  capture: researchDocumentAnnotationCaptureSchema.nullable(),
  capturedReferenceStatus: z.enum(['recorded', 'superseded']).nullable()
}).strict();
export type ResearchDocumentAnnotation = z.infer<typeof researchDocumentAnnotationSchema>;
export type ResearchDocumentAnnotationInspection = z.infer<typeof researchDocumentAnnotationInspectionSchema>;
export type ResearchDocumentAnnotationCapture = z.infer<typeof researchDocumentAnnotationCaptureSchema>;
export type ResearchDocumentAnnotationCaptureRequest = z.infer<typeof researchDocumentAnnotationCaptureRequestSchema>;
