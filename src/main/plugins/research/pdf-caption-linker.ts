import {isPageMargin} from '../../../shared/schemas/research-document-reading';
import {paperVisualSchema, paperVisualVersion, assertPaperVisualEvidence, assertPaperVisualBlock,
  type PaperVisual} from '../../../shared/schemas/research-paper-visual';
import {equationEvidence} from './pdf-equation-extractor';
import type {EquationEvidence} from '../../../shared/schemas/research-paper-equation';
import type {PaperBlock} from './paper-ir';

type Block = PaperBlock & {locations: EquationEvidence['locations']; imagePath?: string | null};
const number = '[A-Z]?\\d+(?:[.-]\\d+)*';
const prefix = new RegExp(`^(fig(?:ure)?\\.?|table|tab\\.?|图|表)\\s*(${number})(?![A-Za-z\\d]|[.-]\\d)`, 'iu');
const margin = (block: Block): boolean => isPageMargin(block.reading?.role);
function caption(block: Block): {kind: 'figure' | 'table'; number: string | null} | null {
  if (block.kind !== 'paragraph' || margin(block)) return null;
  const text = block.text.trim(), match = prefix.exec(text);
  const labelled = block.reading?.role === 'caption' || /^(?:figure|fig|table|chart)_caption$|^caption$/iu.test(block.label ?? '');
  if (!labelled && (!match || !/^\s*[:.：)\-–—]\s*\S/u.test(text.slice(match[0].length)))) return null;
  const kind = match ? /^(?:table|tab|表)/iu.test(match[1]!) ? 'table' : 'figure'
    : /table/iu.test(block.label ?? '') ? 'table' : /figure|fig|chart/iu.test(block.label ?? '') ? 'figure' : null;
  return kind ? {kind, number: match?.[2]?.toUpperCase() ?? null} : null;
}
const overlap = (a: number[], b: number[]): number => Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!)) /
  Math.max(1, Math.min(a[2]! - a[0]!, b[2]! - b[0]!));

/** Explicit rule strength is not a calibrated confidence. Cross-page/ambiguous associations stay candidates. */
export function attachPaperVisuals<T extends Block>(blocks: readonly T[]): (T & {visual?: PaperVisual})[] {
  const captions = blocks.flatMap((block, index) => {
    const value = caption(block); return value ? [{block, index, ...value}] : [];
  });
  const objects = blocks.flatMap((block, index) => block.kind === 'figure' || block.kind === 'table'
    ? [{block, index, kind: block.kind}] : []);
  const proposals = objects.flatMap(object => captions.flatMap(cap => {
    if (cap.kind !== object.kind || Math.abs(cap.index - object.index) > 4) return [];
    const a = object.block.locations[0], b = cap.block.locations[0];
    if (!a?.bbox || !b?.bbox || a.coordinateOrigin !== 'TOPLEFT' || b.coordinateOrigin !== 'TOPLEFT') return [];
    const crossPage = a.page !== b.page;
    if (crossPage && (Math.abs(a.page - b.page) !== 1 || Math.abs(cap.index - object.index) > 2)) return [];
    const horizontal = overlap(a.bbox, b.bbox);
    const gap = Math.max(0, b.bbox[1] - a.bbox[3], a.bbox[1] - b.bbox[3]);
    const width = Math.min(a.bbox[2] - a.bbox[0], b.bbox[2] - b.bbox[0]);
    if (horizontal < .5 || !crossPage && gap > Math.max(50, width * .5)) return [];
    const side = object.kind === 'figure' ? b.bbox[1] >= a.bbox[3] : b.bbox[3] <= a.bbox[1];
    const intervening = blocks.slice(Math.min(cap.index, object.index) + 1, Math.max(cap.index, object.index))
      .some(block => !margin(block) && block.text.trim() && !caption(block));
    const strong = !crossPage && horizontal >= .8 && gap <= Math.max(24, width * .15) &&
      side && !intervening && cap.number !== null;
    return [{object, cap, crossPage, strong}];
  }));
  const visuals = new Map<string, PaperVisual>();
  for (const object of objects) {
    const location = object.block.locations[0];
    if (!location) throw new Error('research_visual_binding_invalid');
    const links = proposals.filter(p => p.object === object);
    const value: PaperVisual = {version: paperVisualVersion, id: `${object.kind}:${object.block.id}`,
      blockId: object.block.id, kind: object.kind, objectNumber: object.block.table?.tableNumber ?? null,
      source: {...location, locator: object.block.locator}, imagePath: object.block.imagePath ?? null, assetId: null,
      captions: links.map(p => {
        const unique = links.length === 1 && proposals.filter(other => other.cap === p.cap).length === 1;
        const linked = p.strong && unique;
        return {status: linked ? 'linked' : 'candidate', number: p.cap.number, crossPage: p.crossPage,
          ruleScore: linked ? .9 : p.crossPage ? .25 : .5,
          signals: [p.crossPage ? 'adjacent_page_candidate' : 'same_page_proximity', ...(unique ? ['unique_neighborhood'] : ['ambiguous_neighborhood'])],
          evidence: equationEvidence(p.cap.block)};
      }), references: [], warnings: []};
    const linked = value.captions.filter(c => c.status === 'linked');
    if (linked.length === 1) {
      if (value.objectNumber && value.objectNumber !== linked[0]!.number) {
        value.captions[0]!.status = 'candidate'; value.warnings.push('research_visual_number_conflict');
      } else value.objectNumber = linked[0]!.number;
    }
    if (!value.captions.length) value.warnings.push('research_visual_caption_missing');
    if (value.captions.some(c => c.status === 'candidate')) value.warnings.push('research_visual_caption_candidate');
    visuals.set(object.block.id, value);
  }
  for (const value of visuals.values()) {
    // A caption candidate may expose a numbered reference, but cannot make it a linked object.
    const numbers = new Set([value.objectNumber, ...value.captions.map(c => c.number)].filter((n): n is string => n !== null));
    for (const num of numbers) {
      const unique = [...visuals.values()].filter(v => v.kind === value.kind &&
        (v.objectNumber === num || v.captions.some(c => c.number === num))).length === 1;
      const literal = num.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const pattern = new RegExp(`(?:\\b${value.kind === 'figure' ? 'Fig(?:ure)?s?\\.?' : 'Tables?|Tab\\.?'}|${value.kind === 'figure' ? '图' : '表'})\\s*${literal}(?![A-Za-z\\d]|[.-]\\d)`, 'giu');
      for (const block of blocks) if (block.kind === 'paragraph' && !margin(block) && !caption(block)) {
        for (const match of block.text.matchAll(pattern)) {
          if (value.references.length === 10_000) throw new Error('research_visual_reference_limit');
          value.references.push({status: unique && value.objectNumber === num ? 'linked' : 'candidate', number: num,
            evidence: equationEvidence(block, match.index!, match.index! + match[0].length)});
        }
      }
    }
    visuals.set(value.blockId, paperVisualSchema.parse(value));
  }
  const result = blocks.map(block => visuals.has(block.id) ? {...block, visual: visuals.get(block.id)!} : {...block});
  result.forEach(assertPaperVisualBlock); assertPaperVisualEvidence(result);
  return result;
}
