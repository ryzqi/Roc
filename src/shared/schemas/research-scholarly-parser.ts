import {z} from 'zod';

export const scholarlyParserVersion = 'roc-scholarly-parser/1';
export const grobidAdapterVersion = 'roc-grobid/1';
export const scholarlyParserLimits = {maxPdfBytes: 128 * 1024 * 1024, maxTeiBytes: 8 * 1024 * 1024, timeoutMs: 30_000} as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().max(scholarlyParserLimits.maxTeiBytes);
const id = z.string().min(1).max(500);
const location = z.object({
  raw: text.nullable(), status: z.enum(['missing', 'valid', 'invalid']),
  coordinateSystem: z.literal('grobid-pdf-point-top-left'),
  boxes: z.array(z.object({page: z.number().int().positive(), x: z.number().nonnegative(), y: z.number().nonnegative(),
    width: z.number().positive(), height: z.number().positive(), pageWidth: z.number().positive(), pageHeight: z.number().positive()
  }).strict().refine(b => b.x + b.width <= b.pageWidth + .01 && b.y + b.height <= b.pageHeight + .01)).max(1000)
}).strict();
export const grobidFieldsSchema = z.object({
  metadata: z.object({title: text.nullable(), authors: z.array(text).max(1000), doi: text.nullable(), year: text.nullable()}).strict(),
  sections: z.array(z.object({id, parentId: id.nullable(), title: text, number: text.nullable(), location}).strict()).max(20_000),
  references: z.array(z.object({id, title: text.nullable(), rawCitation: text.nullable(), doi: text.nullable(), location}).strict()).max(20_000),
  citationMarkers: z.array(z.object({id, text, targets: z.array(text).max(1000), referenceIds: z.array(id).max(1000),
    unresolvedTargets: z.array(text).max(1000), context: text.nullable(), contextOffset: z.number().int().nonnegative().nullable(),
    location}).strict()).max(50_000)
}).strict();
const resolution = z.object({
  kind: z.enum(['title', 'section', 'reference', 'citation_marker']), id,
  status: z.enum(['matched', 'unmatched', 'ambiguous']),
  blockId: id.nullable(), locator: text.nullable(), start: z.number().int().nonnegative().nullable(),
  end: z.number().int().positive().nullable(), originalText: text.nullable()
}).strict();
export const scholarlyEnrichmentSchema = z.object({
  version: z.literal(scholarlyParserVersion), adapterVersion: z.literal(grobidAdapterVersion),
  sourceHash: digest, sourceBlocksDigest: digest,
  status: z.enum(['disabled', 'unavailable', 'failed', 'timed_out', 'parsed']),
  failureCode: z.enum(['research_grobid_unavailable', 'research_grobid_http_failed', 'research_grobid_empty',
    'research_grobid_response_too_large', 'research_grobid_input_too_large', 'research_grobid_output_invalid', 'research_grobid_output_unsupported', 'research_grobid_timeout']).nullable(),
  rawTei: text.nullable(), teiHash: digest.nullable(), fields: grobidFieldsSchema.nullable(),
  resolutions: z.array(resolution).max(90_000),
  missingFields: z.array(z.enum(['metadata', 'sections', 'references', 'citation_markers', 'coordinates'])).max(5),
  warnings: z.array(z.string().max(500)).max(1000), durationMs: z.number().nonnegative()
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'parsed') !== (value.rawTei !== null && value.teiHash !== null && value.fields !== null) ||
      (value.status === 'disabled' || value.status === 'parsed') !== (value.failureCode === null) ||
      value.status !== 'parsed' && (value.rawTei !== null || value.teiHash !== null || value.fields !== null || value.resolutions.length) ||
      new Set(value.missingFields).size !== value.missingFields.length ||
      value.resolutions.some(r => r.status === 'matched'
        ? !r.blockId || r.locator === null || r.start === null || r.end === null || r.end <= r.start || r.originalText === null
        : r.blockId !== null || r.locator !== null || r.start !== null || r.end !== null || r.originalText !== null)) {
    ctx.addIssue({code: 'custom', message: 'research_scholarly_enrichment_invalid'});
  }
});
export type GrobidFields = z.infer<typeof grobidFieldsSchema>;
export type ScholarlyEnrichment = z.infer<typeof scholarlyEnrichmentSchema>;
