import type {z} from 'zod';
import type {researchParsedDocumentSchema} from '../../../shared/schemas/research-production';
import {boundsOfPoints, type NativeTextItem, type PdfBox} from './pdf-native-text';
import {orderPdfBlocks} from './pdf-reading-order';
import {startsScientificCaption} from './pdf-document-reading';

type Block = z.infer<typeof researchParsedDocumentSchema>['blocks'][number];
export type FusionRegion = {block: Block; score: number | null};
export type RecognitionProvenance = {
  blockId: string;
  source: 'native' | 'ocr' | 'merged';
  confidence: number | null;
  overlapGroupId: string | null;
  nativeItemIds: string[];
  alternatives: {source: 'native' | 'ocr'; text: string}[];
  status: 'selected' | 'duplicate' | 'disputed';
};
type NativeGroup = {id: string; text: string; bbox: PdfBox | null; items: NativeTextItem[]};
const clean = (text: string): string => text.replace(/\u0000/gu, '').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
const area = (box: PdfBox): number => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
const intersection = (a: PdfBox, b: PdfBox): number => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
export function pdfBoxIou(a: PdfBox, b: PdfBox): number {
  const overlap = intersection(a, b), union = area(a) + area(b) - overlap;
  return union > 0 ? overlap / union : 0;
}
/** Case/whitespace normalized bigram Dice; a similarity measure, not a probability. */
export function recognitionTextSimilarity(a: string, b: string): number {
  const normalize = (text: string): string => text.normalize('NFC').toLowerCase().replace(/\s+/gu, '');
  a = normalize(a); b = normalize(b);
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 1; i < a.length; i++) {const key = a.slice(i - 1, i + 1); pairs.set(key, (pairs.get(key) ?? 0) + 1);}
  let matches = 0;
  for (let i = 1; i < b.length; i++) {
    const key = b.slice(i - 1, i + 1), count = pairs.get(key) ?? 0;
    if (count > 0) {matches++; pairs.set(key, count - 1);}
  }
  return 2 * matches / (a.length + b.length - 2);
}

function unionBoxes(boxes: PdfBox[]): PdfBox | null {
  return boxes.length ? boundsOfPoints(boxes.flatMap(box => [[box[0], box[1]], [box[2], box[3]]])) : null;
}

/** Group same-baseline items first, then geometrically adjacent lines in the same column. */
function nativeGroups(items: NativeTextItem[], width: number): NativeGroup[] {
  const lines: NativeGroup[] = [];
  for (const item of [...items].sort((a, b) => (a.bbox?.[1] ?? Infinity) - (b.bbox?.[1] ?? Infinity) ||
      (a.bbox?.[0] ?? Infinity) - (b.bbox?.[0] ?? Infinity) || a.itemIndex - b.itemIndex)) {
    if (!clean(item.text)) continue;
    const box = item.bbox;
    const line = box === null ? undefined : lines.findLast(group => group.bbox !== null &&
      Math.abs((group.bbox[1] + group.bbox[3]) / 2 - (box[1] + box[3]) / 2) <= (box[3] - box[1]) * 0.4 &&
      box[0] - group.bbox[2] <= Math.max(item.fontSize * 2, width * 0.015) && box[0] >= group.bbox[0] &&
      group.items[0]?.direction === item.direction);
    if (line) {line.items.push(item); line.text = clean(line.items.map(i => i.text).join(' '));
      line.bbox = unionBoxes(line.items.flatMap(i => i.bbox === null ? [] : [i.bbox]));}
    else lines.push({id: item.id, text: clean(item.text), bbox: box, items: [item]});
  }
  const ordered = orderPdfBlocks(lines, width).blocks, groups: NativeGroup[] = [];
  for (const line of ordered) {
    const previous = groups.at(-1), box = line.bbox, prev = previous?.bbox;
    if (previous && prev && box && box[1] >= prev[3] &&
        box[1] - prev[3] <= Math.max(3, (box[3] - box[1]) * 0.7) &&
        Math.abs(box[0] - prev[0]) < width * 0.035 &&
        Math.abs((box[2] - box[0]) - (prev[2] - prev[0])) < width * 0.08 &&
        !startsScientificCaption(line.text) &&
        !(startsScientificCaption(previous.text) && /[.!?。！？][”"'’)\]]*$/u.test(previous.text.trim()))) {
      previous.text += `\n${line.text}`; previous.items.push(...line.items);
      previous.bbox = unionBoxes([prev, box]);
    } else groups.push({...line, items: [...line.items]});
  }
  return groups;
}

export function fusePdfPage(input: {page: number; width: number; nativeItems: NativeTextItem[]; regions: FusionRegion[]}):
  {blocks: Block[]; provenance: RecognitionProvenance[]; warnings: string[]; duplicatedRegionCount: number} {
  const assigned = new Map<string, NativeTextItem[]>(), uncovered: NativeTextItem[] = [];
  for (const item of input.nativeItems) {
    if (!clean(item.text)) continue;
    const candidates = item.bbox === null ? [] : input.regions.filter(region => {
      const box = region.block.locations[0]?.bbox;
      return box && intersection(item.bbox!, box) / Math.max(area(item.bbox!), 1) >= 0.65;
    }).sort((a, b) => area(a.block.locations[0]!.bbox) - area(b.block.locations[0]!.bbox));
    const owner = candidates[0];
    if (owner) assigned.set(owner.block.id, [...(assigned.get(owner.block.id) ?? []), item]);
    else uncovered.push(item);
  }
  const blocks: Block[] = [], provenance: RecognitionProvenance[] = [], warnings: string[] = [];
  if (input.nativeItems.some(item => item.viewportClipped)) warnings.push('native_text_viewport_clipped');
  let duplicatedRegionCount = 0;
  const appendNative = (items: NativeTextItem[], overlapGroupId: string | null, disputed = false): void => {
    for (const group of nativeGroups(items, input.width)) {
      const duplicate = group.bbox === null ? undefined : blocks.find(block => block.kind === 'paragraph' &&
        block.locations[0] && pdfBoxIou(group.bbox!, block.locations[0].bbox) >= 0.65 &&
        recognitionTextSimilarity(group.text, block.text) >= 0.9);
      if (duplicate) {duplicatedRegionCount++; provenance.push({blockId: duplicate.id, source: 'native', confidence: null,
        overlapGroupId, nativeItemIds: group.items.map(item => item.id), alternatives: [{source: 'native', text: group.text}],
        status: 'duplicate'}); continue;}
      blocks.push({id: group.id, kind: 'paragraph', label: 'Native text', text: group.text, locator: `page${input.page}`,
        imagePath: null, locations: group.bbox === null ? [] : [{page: input.page, bbox: group.bbox, coordinateOrigin: 'TOPLEFT'}]});
      provenance.push({blockId: group.id, source: 'native', confidence: null, overlapGroupId,
        nativeItemIds: group.items.map(item => item.id), alternatives: [], status: disputed ? 'disputed' : 'selected'});
    }
  };
  for (const region of input.regions) {
    const native = assigned.get(region.block.id) ?? [];
    const nativeText = nativeGroups(native, input.width).map(group => group.text).join('\n');
    const visual = ['table', 'figure', 'formula'].includes(region.block.kind);
    const similarity = recognitionTextSimilarity(nativeText, region.block.text);
    const agrees = similarity >= 0.75, emptyOcr = !region.block.text.trim();
    const useNative = nativeText.length > 0 && (emptyOcr || (!visual && agrees));
    const disputed = nativeText.length > 0 && !emptyOcr && !agrees;
    blocks.push({...region.block, text: useNative ? nativeText : region.block.text});
    provenance.push({blockId: region.block.id, source: useNative ? 'merged' : 'ocr', confidence: region.score,
      overlapGroupId: native.length ? `overlap:${region.block.id}` : null, nativeItemIds: native.map(item => item.id),
      alternatives: native.length ? [{source: 'native', text: nativeText}, {source: 'ocr', text: region.block.text}] : [],
      status: disputed ? 'disputed' : 'selected'});
    if (native.length && agrees) duplicatedRegionCount++;
    if (disputed) {
      warnings.push(`recognition_disagreement:${region.block.id}`);
      // Body disagreement cannot justify dropping either independent text source.
      if (!visual) appendNative(native, `overlap:${region.block.id}`, true);
    }
  }
  appendNative(uncovered, null);
  const ordered = orderPdfBlocks(blocks.map(block => ({...block, bbox: block.locations[0]?.bbox ?? null})), input.width);
  warnings.push(...ordered.warnings);
  return {blocks: ordered.blocks.map(({bbox: _bbox, ...block}) => block), provenance, warnings, duplicatedRegionCount};
}
