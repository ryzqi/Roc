import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {grobidFieldsSchema, scholarlyParserLimits, type GrobidFields} from '../../../shared/schemas/research-scholarly-parser';
import type {ScholarlyParserAdapter} from './scholarly-parser-adapter';

type Node = {name: string; attributes: Record<string, string>; children: Node[]; value: string};
const invalid = (): never => {throw new Error('research_grobid_output_invalid');};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : invalid();
function nodes(input: unknown, depth = 0): Node[] {
  if (!Array.isArray(input) || depth > 100) return invalid();
  return input.flatMap(value => {
    const row = object(value), names = Object.keys(row).filter(k => k !== ':@');
    if (names.length !== 1) return invalid();
    const name = names[0]!;
    if (name.startsWith('?') || name === '#comment') return [];
    if (name === '#text') return [{name, attributes: {}, children: [], value: String(row[name])}];
    const attributes: Record<string, string> = {};
    if (row[':@']) for (const [k, v] of Object.entries(object(row[':@']))) attributes[k.replace(/^@_/u, '')] = String(v);
    return [{name: name.split(':').at(-1)!, attributes, children: nodes(row[name], depth + 1), value: ''}];
  });
}
const allText = (n: Node): string => n.name === '#text' ? n.value : n.children.map(allText).join('');
const clean = (n: Node | undefined): string | null => n ? allText(n).replace(/\s+/gu, ' ').trim() || null : null;
const children = (n: Node | undefined, name: string): Node[] => n?.children.filter(c => c.name === name) ?? [];
const walk = (n: Node | undefined, name: string): Node[] => !n ? [] : [...(n.name === name ? [n] : []), ...n.children.flatMap(c => walk(c, name))];

/** Raw GROBID coordinates remain in their own measured TEI frame, never assigned Roc raster units. */
export function parseGrobidTei(xml: string): {fields: GrobidFields; warnings: string[]} {
  if (Buffer.byteLength(xml) > scholarlyParserLimits.maxTeiBytes || /<!DOCTYPE|<!ENTITY/iu.test(xml) ||
      XMLValidator.validate(xml) !== true) return invalid();
  const roots = nodes(new XMLParser({preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false}).parse(xml));
  if (roots.length === 1 && ['tei', 'teiCorpus'].includes(roots[0]!.name)) throw new Error('research_grobid_output_unsupported');
  if (roots.length !== 1 || roots[0]!.name !== 'TEI') return invalid();
  const root = roots[0]!, warnings = new Set<string>(), dimensions = new Map<number, {width: number; height: number}>();
  for (const s of walk(root, 'surface')) {
    const page = Number(s.attributes.n), width = Number(s.attributes.lrx), height = Number(s.attributes.lry);
    if (!Number.isInteger(page) || page <= 0 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
        Number(s.attributes.ulx ?? 0) !== 0 || Number(s.attributes.uly ?? 0) !== 0 || dimensions.has(page)) return invalid();
    dimensions.set(page, {width, height});
  }
  const location = (n: Node): GrobidFields['sections'][number]['location'] => {
    const raw = n.attributes.coords ?? null;
    const result: GrobidFields['sections'][number]['location'] = {raw, status: 'missing', coordinateSystem: 'grobid-pdf-point-top-left', boxes: []};
    if (raw === null) return result;
    const boxes = raw.split(';').map(part => {
      const [page, x, y, width, height, ...extra] = part.split(',').map(Number);
      const frame = dimensions.get(page!);
      if (extra.length || [page, x, y, width, height].some(n => n === undefined || !Number.isFinite(n)) ||
          !frame || x! < 0 || y! < 0 || width! <= 0 || height! <= 0 ||
          x! + width! > frame.width + .01 || y! + height! > frame.height + .01) return null;
      return {page: page!, x: x!, y: y!, width: width!, height: height!, pageWidth: frame.width, pageHeight: frame.height};
    });
    if (boxes.length > 1000 || boxes.some(b => b === null)) {
      result.status = 'invalid'; warnings.add('research_grobid_coordinates_invalid'); return result;
    }
    result.status = 'valid'; result.boxes = boxes as typeof result.boxes;
    return result;
  };
  const header = children(root, 'teiHeader')[0], source = walk(header, 'sourceDesc')[0], bibl = walk(source, 'biblStruct')[0];
  const analytic = children(bibl, 'analytic')[0], titles = walk(analytic, 'title');
  const ids = new Set<string>();
  const identity = (n: Node, fallback: string): string => {
    const id = n.attributes['xml:id'] ?? fallback;
    if (ids.has(id)) return invalid(); ids.add(id); return id;
  };
  const fields: GrobidFields = {
    metadata: {title: clean(titles.find(n => n.attributes.level === 'a') ?? titles[0] ?? walk(header, 'titleStmt')[0]?.children.find(n => n.name === 'title')),
      authors: walk(analytic, 'author').map(n => walk(n, 'persName')[0]).filter(n => n !== undefined)
        .map(n => n.children.map(clean).filter(Boolean).join(' ')).filter(Boolean),
      doi: clean(walk(bibl, 'idno').find(n => n.attributes.type?.toLowerCase() === 'doi')),
      year: walk(bibl, 'date').find(n => n.attributes.when)?.attributes.when ?? null},
    sections: [], references: [], citationMarkers: []
  };
  const body = walk(children(root, 'text')[0], 'body')[0];
  const addSections = (n: Node, parentId: string | null): void => {
    const heads = children(n, 'head'), head = heads[0]; let parent = parentId;
    if (head && clean(head)) {
      const id = identity(head, `section:${fields.sections.length}`);
      fields.sections.push({id, parentId, title: clean(head)!, number: head.attributes.n ?? null, location: location(head)});
      parent = id;
    }
    for (const div of children(n, 'div')) addSections(div, parent);
  };
  if (body) addSections(body, null);
  const back = walk(children(root, 'text')[0], 'back')[0];
  for (const n of walk(back, 'biblStruct')) {
    fields.references.push({id: identity(n, `reference:${fields.references.length}`), title: clean(walk(n, 'title')[0]),
      rawCitation: clean(walk(n, 'note').find(c => c.attributes.type === 'raw_reference')),
      doi: clean(walk(n, 'idno').find(c => c.attributes.type?.toLowerCase() === 'doi')), location: location(n)});
  }
  const referenceIds = new Set(fields.references.map(r => r.id));
  const addMarkers = (n: Node, context: Node | null, offset: number): void => {
    const parent = n.name === 'p' ? n : context;
    if (n.name === 'ref' && n.attributes.type === 'bibr') {
      const targets = (n.attributes.target ?? '').trim().split(/\s+/u).filter(Boolean);
      const resolved = targets.filter(t => t.startsWith('#') && referenceIds.has(t.slice(1)));
      fields.citationMarkers.push({id: identity(n, `citation:${fields.citationMarkers.length}`), text: allText(n), targets,
        referenceIds: resolved.map(t => t.slice(1)), unresolvedTargets: targets.filter(t => !resolved.includes(t)),
        context: parent ? allText(parent) : null, contextOffset: parent ? offset : null, location: location(n)});
      return;
    }
    let start = n.name === 'p' ? 0 : offset;
    for (const child of n.children) {addMarkers(child, parent, start); start += allText(child).length;}
  };
  if (body) addMarkers(body, null, 0);
  if (fields.citationMarkers.some(m => m.unresolvedTargets.length)) warnings.add('research_grobid_reference_target_missing');
  return {fields: grobidFieldsSchema.parse(fields), warnings: [...warnings]};
}

/** One explicit local service request; consolidation is disabled to avoid secondary external lookups. */
export class GrobidAdapter implements ScholarlyParserAdapter {
  readonly identity: string;
  private readonly endpoint: URL;
  constructor(endpoint: string, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = new URL(endpoint);
    if (this.endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(this.endpoint.hostname) ||
        this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) {
      throw new Error('research_grobid_local_endpoint_required');
    }
    this.endpoint.pathname = `${this.endpoint.pathname.replace(/\/api\/?$/u, '').replace(/\/$/u, '')}/api/processFulltextDocument`;
    this.identity = `roc-grobid/1:${this.endpoint.origin}${this.endpoint.pathname}`;
  }
  async parse(pdf: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const body = new FormData();
    body.append('input', new Blob([Uint8Array.from(pdf)], {type: 'application/pdf'}), 'source.pdf');
    for (const [key, value] of Object.entries({consolidateHeader: '0', consolidateCitations: '0', consolidateFunders: '0',
      includeRawCitations: '1', generateIDs: '1'})) body.append(key, value);
    for (const name of ['head', 'ref', 'biblStruct', 'persName', 'figure', 'formula', 'p']) body.append('teiCoordinates', name);
    let response: Response;
    try {response = await this.fetcher(this.endpoint, {method: 'POST', body, signal, redirect: 'error', headers: {Accept: 'application/xml'}});}
    catch {signal.throwIfAborted(); throw new Error('research_grobid_unavailable');}
    if (response.status === 204 || !response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(response.status === 204 ? 'research_grobid_empty' : 'research_grobid_http_failed');
    }
    if (!response.body) throw new Error('research_grobid_empty');
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted(); const {done, value} = await reader.read();
        if (done) break; size += value.byteLength;
        if (size > scholarlyParserLimits.maxTeiBytes) throw new Error('research_grobid_response_too_large');
        parts.push(value);
      }
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    if (!size) throw new Error('research_grobid_empty');
    return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts));
  }
}
