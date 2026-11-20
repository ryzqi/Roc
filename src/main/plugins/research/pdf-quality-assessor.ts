import {z} from 'zod';
import {researchDocumentCoordinateFrameSchema} from '../../../shared/schemas/research-document-coordinates';
import {paperParseQualitySchema, paperQualityVersion, type PaperParseQuality} from '../../../shared/schemas/research-paper-quality';
import type {PaperBlock} from './paper-ir';

type Box = [number, number, number, number];
const boxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const pageSchema = z.object({
  page: z.number().int().positive(), coordinateFrame: researchDocumentCoordinateFrameSchema.nullable(),
  regions: z.array(z.unknown()).max(100_000),
  nativeTextItems: z.array(z.unknown()).max(100_000).optional(), fusion: z.unknown().optional()
});
export type QualityPage = z.input<typeof pageSchema>;

/** Exact rectangle union using sweep-line and compressed-y segment tree: O(n log n). */
export function rectangleUnionArea(boxes: readonly Box[], width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('research_quality_frame_invalid');
  }
  const clipped = boxes.map(raw => {
    const box = boxSchema.parse(raw);
    if (box[2] < box[0] || box[3] < box[1]) throw new Error('research_quality_box_invalid');
    return [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(width, box[2]), Math.min(height, box[3])] as Box;
  }).filter(box => box[2] > box[0] && box[3] > box[1]);
  if (!clipped.length) return 0;
  const ys = [...new Set(clipped.flatMap(box => [box[1], box[3]]))].sort((a, b) => a - b);
  const positions = new Map(ys.map((value, index) => [value, index]));
  const events = clipped.flatMap(box => [{x: box[0], low: positions.get(box[1])!, high: positions.get(box[3])! - 1, delta: 1},
    {x: box[2], low: positions.get(box[1])!, high: positions.get(box[3])! - 1, delta: -1}]).sort((a, b) => a.x - b.x);
  const counts = new Int32Array(ys.length * 4), lengths = new Float64Array(ys.length * 4);
  const update = (node: number, low: number, high: number, start: number, end: number, delta: number): void => {
    if (start <= low && high <= end) counts[node] = counts[node]! + delta;
    else {
      const middle = (low + high) >> 1;
      if (start <= middle) update(node * 2, low, middle, start, end, delta);
      if (end > middle) update(node * 2 + 1, middle + 1, high, start, end, delta);
    }
    lengths[node] = counts[node]! > 0 ? ys[high + 1]! - ys[low]! :
      low === high ? 0 : lengths[node * 2]! + lengths[node * 2 + 1]!;
  };
  let area = 0, x = events[0]!.x;
  for (const event of events) {
    area += (event.x - x) * lengths[1]!;
    update(1, 0, ys.length - 2, event.low, event.high, event.delta);
    x = event.x;
  }
  return Math.min(width * height, area);
}

const nativeSchema = z.object({page: z.number().int().positive(), text: z.string(), bbox: boxSchema.nullable()});
const regionSchema = z.object({id: z.string(), text: z.string().optional(), bbox: boxSchema,
  status: z.string().optional(), formula: z.string().nullable().optional()});
const fusionSchema = z.object({version: z.literal(1), duplicatedRegionCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()), provenance: z.array(z.unknown())});

/** Coverage measures captured text-bearing area, never text accuracy or recall. Missing observations stay null. */
export function assessPdfQuality(input: {
  pages: readonly QualityPage[]; blocks: readonly PaperBlock[]; failure?: string | null
}): PaperParseQuality {
  const failure = input.failure ?? null;
  const pages = input.pages.map(raw => {
    const page = pageSchema.parse(raw), frame = page.coordinateFrame, warnings: string[] = [];
    if (frame && frame.page !== page.page) throw new Error('research_quality_page_invalid');
    const htmlIds = frame === null ? new Set(page.regions.map(region => z.object({id: z.string()}).parse(region).id)) : null;
    const blocks = input.blocks.filter(block => block.locations?.some(loc => loc.page === page.page) || htmlIds?.has(block.id));
    const regions = frame === null ? [] : page.regions.map(region => regionSchema.parse(region));
    const native = page.nativeTextItems?.map(item => nativeSchema.parse(item));
    if (native?.some(item => item.page !== page.page)) throw new Error('research_quality_page_invalid');
    const fusion = page.fusion === undefined ? null : fusionSchema.parse(page.fusion);
    const ratio = (boxes: Box[]): number | null => frame ? rectangleUnionArea(boxes, frame.width, frame.height) / (frame.width * frame.height) : null;
    const missingNativeGeometry = native?.some(item => item.text.trim() && item.bbox === null) ?? false;
    const nativeTextCoverage = frame?.kind === 'image' ? 0 : native && !missingNativeGeometry
      ? ratio(native.flatMap(item => item.text.trim() && item.bbox ? [item.bbox] : [])) : null;
    const recognized = regions.filter(region => !/failed|error|unsupported/iu.test(region.status ?? '') &&
      (region.text?.trim() || region.formula?.trim()));
    const ocrCoverage = ratio(recognized.map(region => region.bbox));
    const readingOrderWarnings = fusion ? fusion.warnings.filter(w => /geometry|reading|order|column/iu.test(w)).length :
      frame?.kind === 'image' ? 0 : null;
    const duplicatedRegionCount = fusion?.duplicatedRegionCount ?? null;
    const tableWarnings = blocks.filter(block => block.kind === 'table').reduce((sum, block) =>
      sum + (block.table?.warnings.length ?? 1), 0);
    const formulaWarnings = blocks.filter(block => block.kind === 'formula').reduce((sum, block) =>
      sum + (block.equation?.warnings.length ?? 1), 0);
    if (frame === null) warnings.push('quality_area_not_available');
    if (nativeTextCoverage === null) warnings.push(missingNativeGeometry ? 'quality_native_geometry_missing' : 'quality_native_observation_missing');
    if (duplicatedRegionCount === null) warnings.push('quality_duplicate_observation_missing');
    if (readingOrderWarnings === null) warnings.push('quality_reading_observation_missing');
    if (duplicatedRegionCount) warnings.push('quality_duplicate_regions');
    if (readingOrderWarnings) warnings.push('quality_reading_warnings');
    if (tableWarnings) warnings.push('quality_table_warnings');
    if (formulaWarnings) warnings.push('quality_formula_warnings');
    if (fusion?.warnings.some(w => w.startsWith('recognition_disagreement:'))) warnings.push('quality_recognition_disagreement');
    if (regions.some(region => /failed|error|unsupported/iu.test(region.status ?? ''))) warnings.push('quality_region_recognition_failed');
    if (!blocks.some(block => block.text.trim() || block.table || block.equation || block.visual)) warnings.push('quality_page_content_empty');
    return {page: page.page, pageArea: frame ? frame.width * frame.height : null, nativeTextCoverage, ocrCoverage,
      blockCount: blocks.length, duplicatedRegionCount, readingOrderWarnings, tableWarnings, formulaWarnings,
      status: failure ? 'failed' as const : warnings.length ? 'review' as const : 'good' as const, warnings, failure};
  });
  return paperParseQualitySchema.parse({version: paperQualityVersion,
    coverageDefinition: 'clipped-rectangle-union/measured-page-area', pages,
    status: failure ? 'failed' : pages.length && pages.every(page => page.status === 'good') ? 'good' : 'review', failure});
}
