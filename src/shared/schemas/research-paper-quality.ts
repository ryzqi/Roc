import {z} from 'zod';

export const paperQualityVersion = 'roc-paper-quality/1';
const count = z.number().int().nonnegative();
const status = z.enum(['good', 'review', 'failed']);
export const pageParseQualitySchema = z.object({
  page: z.number().int().positive(),
  pageArea: z.number().positive().nullable(),
  nativeTextCoverage: z.number().min(0).max(1).nullable(),
  ocrCoverage: z.number().min(0).max(1).nullable(),
  blockCount: count, duplicatedRegionCount: count.nullable(),
  readingOrderWarnings: count.nullable(), tableWarnings: count, formulaWarnings: count,
  status, warnings: z.array(z.string().min(1)).max(100),
  failure: z.string().min(1).nullable()
}).strict().refine(value => (value.status === 'failed') === (value.failure !== null),
  'research_quality_failure_invalid');
export const paperParseQualitySchema = z.object({
  version: z.literal(paperQualityVersion),
  coverageDefinition: z.literal('clipped-rectangle-union/measured-page-area'),
  pages: z.array(pageParseQualitySchema).max(500),
  status, failure: z.string().min(1).nullable()
}).strict().refine(value => new Set(value.pages.map(page => page.page)).size === value.pages.length &&
  (value.status === 'failed') === (value.failure !== null) &&
  (!value.pages.some(page => page.status === 'failed') || value.status === 'failed') &&
  (value.status !== 'good' || value.pages.every(page => page.status === 'good')),
  'research_quality_status_invalid');
export type PageParseQuality = z.infer<typeof pageParseQualitySchema>;
export type PaperParseQuality = z.infer<typeof paperParseQualitySchema>;
