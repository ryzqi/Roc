import {createHash} from 'node:crypto';
import {grobidAdapterVersion, scholarlyEnrichmentSchema, scholarlyParserLimits, scholarlyParserVersion,
  type GrobidFields, type ScholarlyEnrichment} from '../../../shared/schemas/research-scholarly-parser';
import type {PaperBlock} from './paper-ir';
import {parseGrobidTei} from './grobid-adapter';
import type {ResearchProcessingTrace} from './processing-trace';

export interface ScholarlyParserAdapter {
  /** Includes implementation/service identity in the project cache key. */
  readonly identity: string;
  parse(pdf: Uint8Array, signal: AbortSignal): Promise<string>;
}
type SourceBlock = Pick<PaperBlock, 'id' | 'kind' | 'text' | 'locator'>;
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const sourceDigest = (blocks: readonly SourceBlock[]): string => hash(JSON.stringify(blocks.filter(b => b.text.trim())
  .map(({id, kind, text, locator}) => ({id, kind, text, locator}))));
const missing = (fields: GrobidFields | null): ScholarlyEnrichment['missingFields'] => {
  const values: ScholarlyEnrichment['missingFields'] = [];
  if (!fields?.metadata.title) values.push('metadata');
  if (!fields?.sections.length) values.push('sections');
  if (!fields?.references.length) values.push('references');
  if (!fields?.citationMarkers.length) values.push('citation_markers');
  if (!fields || ![...fields.sections, ...fields.references, ...fields.citationMarkers].some(r => r.location.status === 'valid')) values.push('coordinates');
  return values;
};
// Only whitespace is normalized; preserve exact original UTF-16 intervals and text.
function whitespace(value: string): {text: string; starts: number[]; ends: number[]} {
  let text = ''; const starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < value.length;) {
    const start = i, space = /\s/u.test(value[i]!);
    if (space) {while (i < value.length && /\s/u.test(value[i]!)) i++;} else i++;
    text += space ? ' ' : value[start]; starts.push(start); ends.push(i);
  }
  return {text, starts, ends};
}
export function crossValidateGrobid(fields: GrobidFields, blocks: readonly SourceBlock[]): ScholarlyEnrichment['resolutions'] {
  const rows = blocks.filter(b => b.text.trim()).map(block => ({block, ...whitespace(block.text)}));
  const resolve = (kind: ScholarlyEnrichment['resolutions'][number]['kind'], id: string, value: string | null,
    context: string | null = null, contextOffset: number | null = null): ScholarlyEnrichment['resolutions'][number] => {
    const empty = {kind, id, status: 'unmatched' as const, blockId: null, locator: null, start: null, end: null, originalText: null};
    if (!value?.trim()) return empty;
    const needle = whitespace(value.trim()).text;
    const scope = context === null ? needle : whitespace(context.trim()).text;
    if (context !== null && (contextOffset === null || context.slice(contextOffset, contextOffset + value.length) !== value)) return empty;
    const relative = context === null ? 0 : whitespace(context.slice(0, contextOffset! + value.length - value.trimStart().length)).text.length -
      whitespace(context.slice(0, context.length - context.trimStart().length)).text.length;
    const hits: {block: SourceBlock; start: number; end: number}[] = [];
    for (const row of rows) {
      for (let at = row.text.indexOf(scope); at !== -1; at = row.text.indexOf(scope, at + 1)) {
        const startIndex = at + relative, endIndex = startIndex + needle.length - 1;
        if (row.text.slice(startIndex, endIndex + 1) !== needle) continue;
        hits.push({block: row.block, start: row.starts[startIndex]!, end: row.ends[endIndex]!});
        if (hits.length > 1) return {...empty, status: 'ambiguous'};
      }
    }
    const hit = hits[0];
    return hit ? {kind, id, status: 'matched', blockId: hit.block.id, locator: hit.block.locator,
      start: hit.start, end: hit.end, originalText: hit.block.text.slice(hit.start, hit.end)} : empty;
  };
  return [
    resolve('title', 'metadata:title', fields.metadata.title),
    ...fields.sections.map(s => resolve('section', s.id, s.title)),
    ...fields.references.map(r => resolve('reference', r.id, r.rawCitation ?? r.title)),
    ...fields.citationMarkers.map(m => resolve('citation_marker', m.id, m.text, m.context, m.contextOffset))
  ];
}
export function assertScholarlyEnrichment(input: ScholarlyEnrichment, sourceHash: string, blocks: readonly SourceBlock[]): void {
  const value = scholarlyEnrichmentSchema.parse(input);
  if (value.sourceHash !== sourceHash || value.sourceBlocksDigest !== sourceDigest(blocks)) throw new Error('research_scholarly_source_changed');
  if (value.status === 'parsed') {
    const parsed = parseGrobidTei(value.rawTei!);
    if (value.teiHash !== hash(value.rawTei!) || JSON.stringify(value.fields) !== JSON.stringify(parsed.fields) ||
        JSON.stringify(value.resolutions) !== JSON.stringify(crossValidateGrobid(parsed.fields, blocks)) ||
        JSON.stringify(value.warnings) !== JSON.stringify(parsed.warnings)) throw new Error('research_scholarly_source_changed');
  }
  if (JSON.stringify(value.missingFields) !== JSON.stringify(missing(value.fields))) throw new Error('research_scholarly_source_changed');
}
export async function enrichScholarlyFields(pdf: Uint8Array, sourceHash: string, blocks: readonly PaperBlock[],
  adapter: ScholarlyParserAdapter | null, signal: AbortSignal, trace?: ResearchProcessingTrace): Promise<ScholarlyEnrichment> {
  signal.throwIfAborted();
  if (Buffer.from(pdf.subarray(0, 5)).toString() !== '%PDF-' || hash(pdf) !== sourceHash) {
    throw new Error('research_scholarly_source_changed');
  }
  const start = performance.now();
  const result: ScholarlyEnrichment = {version: scholarlyParserVersion, adapterVersion: grobidAdapterVersion,
    sourceHash, sourceBlocksDigest: sourceDigest(blocks), status: 'disabled', failureCode: null,
    rawTei: null, teiHash: null, fields: null, resolutions: [], missingFields: missing(null), warnings: [], durationMs: 0};
  if (adapter && pdf.byteLength > scholarlyParserLimits.maxPdfBytes) {
    result.status = 'failed'; result.failureCode = 'research_grobid_input_too_large';
  } else if (adapter) {
    const controller = new AbortController(), cancel = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(() => controller.abort(new Error('research_grobid_timeout')), scholarlyParserLimits.timeoutMs);
    let stop: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      stop = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', stop, {once: true});
    });
    try {
      const run = async (): Promise<void> => {
        const raw = await Promise.race([adapter.parse(Uint8Array.from(pdf), controller.signal), aborted]);
        signal.throwIfAborted(); controller.signal.throwIfAborted();
        const parsed = parseGrobidTei(raw);
        result.rawTei = raw; result.teiHash = hash(raw); result.fields = parsed.fields;
        result.resolutions = crossValidateGrobid(parsed.fields, blocks); result.warnings = parsed.warnings;
        result.missingFields = missing(parsed.fields); result.status = 'parsed';
      };
      if (trace) await trace.run('scholarly_parse', run, {inputCount: blocks.length, unit: 'blocks'}, () => result.resolutions.length);
      else await run();
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : '';
      const allowed = ['research_grobid_unavailable', 'research_grobid_http_failed', 'research_grobid_empty',
        'research_grobid_response_too_large', 'research_grobid_output_invalid', 'research_grobid_output_unsupported'] as const;
      result.failureCode = controller.signal.aborted ? 'research_grobid_timeout'
        : allowed.find(code => code === message) ?? 'research_grobid_output_invalid';
      result.status = controller.signal.aborted ? 'timed_out' : message === 'research_grobid_unavailable' ? 'unavailable' : 'failed';
      result.rawTei = null; result.teiHash = null; result.fields = null; result.resolutions = [];
      result.missingFields = missing(null); result.warnings = [];
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (stop) controller.signal.removeEventListener('abort', stop);
    }
  }
  result.durationMs = performance.now() - start;
  assertScholarlyEnrichment(result, sourceHash, blocks);
  return result;
}
