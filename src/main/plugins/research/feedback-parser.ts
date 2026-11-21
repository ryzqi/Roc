import {crc32} from 'node:zlib';
import * as yauzl from 'yauzl';
import {XMLParser, XMLValidator} from 'fast-xml-parser';
import type {ResearchFeedbackItem} from '../../../shared/schemas/research-feedback';
import {ArchivePolicy} from './archive-policy';
import {withResearchPdf} from './pdf-render';
import {captureNativeTextItems, nativeItemsText, type PdfBox} from './pdf-native-text';

export type ParsedFeedbackItem = Omit<ResearchFeedbackItem, 'mapping'>;
type ParsedFeedback = {items: ParsedFeedbackItem[]; issues: string[]};
type WordNode = {name: string; attributes: Record<string, string>; children: WordNode[]; text: string};
const namespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);

/** Inspect a bounded ZIP in memory; no office entry or external relationship is executed or extracted to disk. */
export async function parseFeedbackDocx(bytes: Buffer): Promise<ParsedFeedback> {
  const zip = await yauzl.fromBufferPromise(bytes, {lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true});
  const policy = new ArchivePolicy({members: 2000, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024});
  const parts = new Map<string, string>();
  try {
    for await (const entry of zip.eachEntry()) {
      const item = policy.add({name: entry.fileName, uncompressedSize: entry.uncompressedSize, directory: entry.fileName.endsWith('/'),
        unixMode: entry.externalFileAttributes >>> 16});
      if (!['word/document.xml', 'word/comments.xml'].includes(item.path)) continue;
      const stream = await zip.openReadStreamPromise(entry), chunks: Buffer[] = [];
      let size = 0, checksum = 0;
      for await (const chunk of stream) {
        const content = Buffer.from(chunk); size += content.length;
        if (size > 16 * 1024 * 1024) throw new Error('research_feedback_file_limit');
        policy.addOutputBytes(content.length); checksum = crc32(content, checksum); chunks.push(content);
      }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error('research_feedback_docx_invalid');
      parts.set(item.path, new TextDecoder('utf8', {fatal: true}).decode(Buffer.concat(chunks)));
    }
  } finally {zip.close();}
  const document = parts.get('word/document.xml');
  if (document === undefined) throw new Error('research_feedback_docx_document_required');
  const tree = parseWordXml(document);
  if (!tree.some(node => node.name === 'document')) throw new Error('research_feedback_docx_invalid');
  const comments = parts.get('word/comments.xml');
  const originals = new Map<string, WordNode>();
  const commentTree = comments === undefined ? null : parseWordXml(comments);
  if (commentTree !== null && !commentTree.some(node => node.name === 'comments')) throw new Error('research_feedback_docx_invalid');
  if (commentTree !== null) walkWord(commentTree, node => {
    if (node.name === 'comment') {
      if (originals.has(node.attributes.id)) throw new Error('research_feedback_duplicate_id');
      originals.set(node.attributes.id, node);
    }
  });
  const items: ParsedFeedbackItem[] = [], issues: string[] = [];
  const starts = new Map<string, number>(), ranges = new Map<string, {start: number; end: number}>();
  let text = '';
  const visit = (node: WordNode): void => {
    if (node.name === 'commentRangeStart') {
      if (starts.has(node.attributes.id)) throw new Error('research_feedback_duplicate_anchor');
      starts.set(node.attributes.id, text.length);
    }
    if (node.name === 'commentRangeEnd') {
      const start = starts.get(node.attributes.id);
      if (start !== undefined) {ranges.set(node.attributes.id, {start, end: text.length}); starts.delete(node.attributes.id);}
      else if (issues.length < 100) issues.push('word_comment_anchor_incomplete');
    }
    const start = text.length;
    if (['t', 'delText'].includes(node.name)) text += node.text;
    else if (node.name === 'tab') text += '\t';
    else if (node.name === 'br') text += '\n';
    for (const child of node.children) visit(child);
    if (node.name === 'ins' || node.name === 'del') {
      const value = text.slice(start);
      if (value.trim()) items.push(baseItem(`revision:${node.name}:${node.attributes.id ?? items.length}`, node.attributes.id ?? String(items.length),
        node.name === 'ins' ? 'insertion' : 'deletion', value, node.name === 'del' ? value : '', node.attributes.author ?? '', node.attributes.date ?? null,
        {sourceStart: start, sourceEnd: text.length}));
    }
    if (['moveFrom', 'moveTo', 'rPrChange', 'pPrChange'].includes(node.name) && issues.length < 100) issues.push('word_revision_type_not_imported');
    if (node.name === 'p') text += '\n';
    if (text.length > 5_000_000 || items.length > 500) throw new Error('research_feedback_file_limit');
  };
  for (const root of tree) visit(root);
  for (const [id, node] of originals) {
    const value = wordText(node).trimEnd();
    if (!value.trim()) {if (issues.length < 100) issues.push('word_empty_comment'); continue;}
    const range = ranges.get(id);
    items.push(baseItem(`comment:${id}`, id, 'comment', value, range === undefined ? '' : text.slice(range.start, range.end),
      node.attributes.author ?? '', node.attributes.date ?? null, {sourceStart: range?.start ?? null, sourceEnd: range?.end ?? null}));
  }
  if (starts.size && issues.length < 100) issues.push('word_comment_anchor_incomplete');
  if (items.length > 500 || items.some(item => item.text.length > 12000 || item.quote.length > 12000)) throw new Error('research_feedback_file_limit');
  return {items, issues: [...new Set(issues)]};
}

export async function parseFeedbackPdf(bytes: Buffer): Promise<ParsedFeedback> {
  return withResearchPdf(Uint8Array.from(bytes), async document => {
    if (document.numPages > 500) throw new Error('research_feedback_file_limit');
    const items: ParsedFeedbackItem[] = [], issues: string[] = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const annotations: unknown[] = await page.getAnnotations();
      let native: ReturnType<typeof captureNativeTextItems> | null = null;
      for (const raw of annotations) {
        if (typeof raw !== 'object' || raw === null) continue;
        const annotation = raw as Record<string, unknown>;
        const subtype = string(annotation.subtype);
        if (!['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Caret', 'Stamp'].includes(subtype)) continue;
        const text = propertyText(annotation, 'contentsObj', 'contents');
        if (!text.trim()) continue;
        const rect = numbers(annotation.rect, 4), quads = numbers(annotation.quadPoints);
        let quote = '';
        if (quads !== null && quads.length >= 8 && quads.length % 8 === 0) {
          native ??= captureNativeTextItems(await page.getTextContent(), index);
          const boxes: PdfBox[] = [];
          for (let offset = 0; offset < quads.length; offset += 8) {
            const points = quads.slice(offset, offset + 8);
            boxes.push([Math.min(points[0], points[2], points[4], points[6]), Math.min(points[1], points[3], points[5], points[7]),
              Math.max(points[0], points[2], points[4], points[6]), Math.max(points[1], points[3], points[5], points[7])]);
          }
          const selected = native.filter(item => item.pdfBbox !== null && boxes.some(box => contains(box, item.pdfBbox!)));
          const partial = native.some(item => item.pdfBbox !== null && boxes.some(box => intersects(box, item.pdfBbox!)) && !selected.includes(item));
          // Font-metric item bounds cannot recover a partially selected word or glyph range.
          if (!partial && selected.length > 0) quote = nativeItemsText(selected);
          else if (issues.length < 100) issues.push('pdf_annotation_quote_unresolved');
        }
        const originalId = string(annotation.id) || `page-${index}-annotation-${items.length + 1}`;
        items.push({...baseItem(`pdf:${index}:${originalId}`, originalId, 'comment', text, quote,
          propertyText(annotation, 'titleObj', 'title'), string(annotation.modificationDate) || null), page: index, rect, quadPoints: quads});
        if (items.length > 500 || text.length > 12000 || quote.length > 12000) throw new Error('research_feedback_file_limit');
      }
      page.cleanup();
    }
    return {items, issues: [...new Set(issues)]};
  });
}

function parseWordXml(xml: string): WordNode[] {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('research_feedback_docx_invalid');
  const parsed: unknown = new XMLParser({ignoreAttributes: false, processEntities: false, preserveOrder: true, trimValues: false, parseTagValue: false}).parse(xml);
  let nodes = 0;
  const convert = (value: unknown, scope: Record<string, string>, depth: number): WordNode[] => {
    if (++nodes > 1_000_000 || depth > 128) throw new Error('research_feedback_file_limit');
    if (!Array.isArray(value)) return [];
    return value.flatMap(raw => {
      if (typeof raw !== 'object' || raw === null) return [];
      const object = raw as Record<string, unknown>, inherited = {...scope};
      const attrs = object[':@'] as Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(attrs ?? {})) {
        if (key === '@_xmlns') inherited[''] = String(value);
        else if (key.startsWith('@_xmlns:')) inherited[key.slice(8)] = String(value);
      }
      return Object.entries(object).flatMap(([qualified, children]) => {
        if (qualified === ':@' || qualified === '#text') return [];
        const parts = qualified.split(':'), name = parts.at(-1)!, prefix = parts.length > 1 ? parts[0] : '';
        const descendants = convert(children, inherited, depth + 1);
        if (!namespaces.has(inherited[prefix])) return descendants;
        const attributes: Record<string, string> = {};
        for (const [key, value] of Object.entries(attrs ?? {})) {
          const qualified = key.replace(/^@_/u, ''), parts = qualified.split(':');
          if (parts.length > 1 && namespaces.has(inherited[parts[0]])) attributes[parts.at(-1)!] = xmlText(String(value));
        }
        const text = ['t', 'delText'].includes(name) && Array.isArray(children) ? children.flatMap(child => typeof child === 'object' && child !== null && '#text' in child
          ? [xmlText(String((child as {'#text': unknown})['#text']))] : []).join('') : '';
        return [{name, attributes, children: descendants, text}];
      });
    });
  };
  return convert(parsed, {}, 0);
}

function baseItem(id: string, originalId: string, kind: ParsedFeedbackItem['kind'], text: string, quote: string,
  author: string, date: string | null, positions = {sourceStart: null as number | null, sourceEnd: null as number | null}): ParsedFeedbackItem {
  return {id, originalId, kind, author, date, text, quote, page: null, rect: null, quadPoints: null, ...positions};
}
function wordText(node: WordNode): string {return node.text + node.children.map(wordText).join('') + (node.name === 'p' ? '\n' : '');}
function walkWord(nodes: WordNode[], action: (node: WordNode) => void): void {for (const node of nodes) {action(node); walkWord(node.children, action);}}
function xmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/giu, (whole, name: string) => {
    if (name.startsWith('#')) {const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (value > 0x10ffff || value === 0 || value >= 0xd800 && value <= 0xdfff) throw new Error('research_feedback_docx_invalid');
      return String.fromCodePoint(value);}
    return ({lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"} as Record<string, string>)[name] ?? whole;
  });
}
function string(value: unknown): string {return typeof value === 'string' ? value : '';}
function propertyText(item: Record<string, unknown>, structured: string, legacy: string): string {
  const value = item[structured];
  return typeof value === 'object' && value !== null && 'str' in value ? string(value.str) : string(item[legacy]);
}
function numbers(value: unknown, length?: number): number[] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const array = Array.from(value as ArrayLike<unknown>, Number);
  return array.length > 0 && array.length <= 800 && (length === undefined || array.length === length) && array.every(Number.isFinite) ? array : null;
}
function contains(outer: number[], inner: number[]): boolean {return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];}
function intersects(a: number[], b: number[]): boolean {return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];}
