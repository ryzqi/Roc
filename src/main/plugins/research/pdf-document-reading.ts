import type {z} from 'zod';
import type {researchParsedDocumentSchema} from '../../../shared/schemas/research-production';
import {assertDocumentReadingLinks, type ResearchBlockReading} from '../../../shared/schemas/research-document-reading';
import type {ResearchDocumentCoordinateFrame} from '../../../shared/schemas/research-document-coordinates';
import {paperHeading} from './paper-ir';

type Block = z.infer<typeof researchParsedDocumentSchema>['blocks'][number];
type Page = {page: number; coordinateFrame: ResearchDocumentCoordinateFrame | null};
export const pdfDocumentReadingVersion = 'roc-pdf-document-reading/1';

// Anchored starts distinguish a caption from a body sentence referring to Figure 1.
export function startsScientificCaption(text: string): boolean {
  return /^(?:fig(?:ure)?\.?|table|图|表)\s*(?:\d+(?:[.-]\d+)*|[A-Z]\d*)\s*[:.：)\-–—]\s*\S/iu.test(text.trim()) ||
    /^(?:fig(?:ure)?\.?|table|图|表)\s*\d+\s+[A-Z\p{Script=Han}]/u.test(text.trim());
}

const terminal = (text: string): boolean => /[.!?。！？][”"'’)\]]*$/u.test(text.trim());
const labelKey = (text: string): string => text.trim().toLowerCase().replace(/[\s-]+/gu, '_');
const normalized = (text: string): string => text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
const headerLabels = new Set(['header', 'page_header', 'running_header']);
const footerLabels = new Set(['footer', 'page_footer', 'running_footer']);
const captionLabels = new Set(['caption', 'figure_caption', 'fig_caption', 'table_caption', 'chart_caption']);

/** Annotate rather than concatenate: each text, block ID, locator and source rectangle remains exact. */
export function annotatePdfDocumentReading(blocks: readonly Block[], pages: readonly Page[]): Block[] {
  const frames = new Map(pages.flatMap(page => page.coordinateFrame?.kind === 'pdf' ? [[page.page, page.coordinateFrame] as const] : []));
  const margin = (block: Block): 'top' | 'bottom' | null => {
    const location = block.locations.length === 1 ? block.locations[0] : undefined, frame = location && frames.get(location.page);
    if (!location || !frame || location.coordinateOrigin !== 'TOPLEFT') return null;
    const box = location.bbox, height = frame.height;
    if (box[3] - box[1] > height * .06) return null;
    return box[3] <= height * .1 ? 'top' : box[1] >= height * .9 ? 'bottom' : null;
  };
  const repeats = new Map<string, Set<number>>();
  const repeatKey = (block: Block, side: string): string => `${side}:${normalized(block.text)}`;
  for (const block of blocks) {
    const side = margin(block), page = block.locations[0]?.page;
    if (!side || page === undefined || !block.text.trim()) continue;
    const key = repeatKey(block, side), seen = repeats.get(key) ?? new Set<number>();
    seen.add(page); repeats.set(key, seen);
  }
  const annotate = (block: Block): ResearchBlockReading => {
    const base = {version: 1 as const, source: 'rule' as const, continuesFrom: null, continuesTo: null};
    const side = margin(block), label = labelKey(block.label);
    if (side && /^(?:[-–—]\s*)?(?:\d{1,5}|[ivxlcdm]{1,8})(?:\s*[-–—])?$/iu.test(block.text.trim())) {
      return {...base, role: 'page_number', ruleScore: .95, signals: ['isolated_margin_counter']};
    }
    const repeated = side && (repeats.get(repeatKey(block, side))?.size ?? 0) >= Math.max(2, Math.ceil(frames.size * .4));
    if (side && (repeated || (side === 'top' ? headerLabels : footerLabels).has(label))) {
      return {...base, role: side === 'top' ? 'page_header' : 'page_footer', ruleScore: repeated ? .9 : .7,
        signals: [repeated ? 'repeated_margin_text' : 'layout_margin_label']};
    }
    if (['table', 'figure', 'formula'].includes(block.kind)) return {...base, role: 'object', ruleScore: 1, signals: ['layout_object']};
    if (captionLabels.has(label) || startsScientificCaption(block.text)) {
      return {...base, role: 'caption', ruleScore: captionLabels.has(label) ? .9 : .8,
        signals: [captionLabels.has(label) ? 'layout_caption_label' : 'caption_prefix']};
    }
    if (block.kind === 'heading' || (!block.text.includes('\n') && (paperHeading(block.text) ||
        /^(?:references|bibliography|appendix(?:\s+[A-Z])?|discussion|conclusions?|参考文献|附录|讨论|结论)$/iu.test(block.text.trim())))) {
      return {...base, role: 'heading', ruleScore: .85, signals: ['heading_structure']};
    }
    if (block.text.trim()) return {...base, role: 'body', ruleScore: null, signals: ['unclassified_text']};
    return {...base, role: 'unknown', ruleScore: null, signals: []};
  };
  const result = blocks.map(block => ({...block, reading: annotate(block)}));
  const byPage = new Map<number, typeof result>();
  for (const block of result) {
    const page = block.locations.length === 1 ? block.locations[0]?.page : undefined;
    if (page !== undefined) {const list = byPage.get(page) ?? []; list.push(block); byPage.set(page, list);}
  }
  for (const page of [...frames.keys()].sort((a, b) => a - b)) {
    // A skipped selected page is not a continuation. Headings/objects/captions are barriers.
    const narrative = (list: typeof result): typeof result => list.filter(block =>
      !['page_header', 'page_footer', 'page_number'].includes(block.reading.role) && block.text.trim());
    const left = narrative(byPage.get(page) ?? []).at(-1), right = narrative(byPage.get(page + 1) ?? [])[0];
    const leftFrame = frames.get(page), rightFrame = frames.get(page + 1);
    if (!left || !right || !leftFrame || !rightFrame || left.reading.role !== 'body' || right.reading.role !== 'body') continue;
    const a = left.locations[0]!.bbox, b = right.locations[0]!.bbox;
    const startsLowercase = /^[\p{Ll}\p{Script=Han}]/u.test(right.text.trim());
    const endsWord = /[\p{L}\p{N},;:，；：\-–]$/u.test(left.text.trim());
    // Last reading column may differ from the first next-page column; compare column widths.
    const widthDifference = Math.abs((a[2] - a[0]) / leftFrame.width - (b[2] - b[0]) / rightFrame.width);
    if (terminal(left.text) || !startsLowercase || !endsWord || a[3] < leftFrame.height * .78 ||
        b[1] > rightFrame.height * .22 || widthDifference > .12) continue;
    left.reading.continuesTo = right.id; right.reading.continuesFrom = left.id;
    left.reading.signals.push('adjacent_page_open_sentence'); right.reading.signals.push('adjacent_page_open_sentence');
  }
  assertDocumentReadingLinks(result);
  return result;
}
