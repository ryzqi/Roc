import {paperIrV2Version, paperObjectId, type PaperIRV2, type PaperIRIdentity, type PaperIRMetadata} from '../../../shared/schemas/research-paper-ir-v2';
import type {ResearchSourceLocator} from '../../../shared/schemas/research-source-locator';
import {assertPaperStructure, type PaperStructure} from '../../../shared/schemas/research-paper-structure';
import {assertPaperTableBlock} from '../../../shared/schemas/research-paper-table';
import {assertPaperEquationBlock, assertEquationEvidence, type EquationEvidence} from '../../../shared/schemas/research-paper-equation';
import {assertPaperVisualBlock, assertPaperVisualEvidence} from '../../../shared/schemas/research-paper-visual';
import type {PaperParseQuality} from '../../../shared/schemas/research-paper-quality';
import type {ScholarlyEnrichment} from '../../../shared/schemas/research-scholarly-parser';
import {buildPaperStructure} from './paper-structure';
import {assertScholarlyEnrichment} from './scholarly-parser-adapter';
import type {PaperBlock} from './paper-ir';
import {researchContentHash} from './research-files';
import {validatePaperIR} from './paper-ir-validation';

export type PaperIRBuildInput = {
  identity: Omit<PaperIRIdentity, 'parseHash'>;
  /** Exactly the captured raw parser payload or the library's published content; never chunk text. */
  content: {sourceHash: string; parserFingerprint: string; blocks: readonly PaperBlock[];
    structure?: PaperStructure; quality?: PaperParseQuality};
  structure?: PaperStructure;
  metadata?: PaperIRMetadata;
  scholarlyEnrichment?: ScholarlyEnrichment;
};
export function buildPaperIR(input: PaperIRBuildInput): PaperIRV2 {
  const {content} = input, raw = content.blocks, byBlock = new Map(raw.map(b => [b.id, b]));
  if (input.identity.sourceHash !== content.sourceHash || input.identity.parserFingerprint !== content.parserFingerprint ||
      !content.quality) throw new Error('research_paper_ir_source_invalid');
  raw.forEach(assertPaperTableBlock); raw.forEach(assertPaperEquationBlock); raw.forEach(assertPaperVisualBlock);
  assertPaperVisualEvidence(raw.map(b => ({...b, locations: b.locations ?? []})));
  for (const b of raw) if (b.equation) for (const e of [
    ...b.equation.contexts, ...b.equation.references.map(r => r.evidence), ...b.equation.variables.map(v => v.evidence),
    ...(b.equation.numberEvidence?.kind === 'block' ? [b.equation.numberEvidence.evidence] : [])
  ]) assertEquationEvidence(e, raw.map(b => ({...b, locations: b.locations ?? []})));
  const structure = input.structure ?? content.structure ?? buildPaperStructure(raw);
  assertPaperStructure(structure, raw);
  if (input.scholarlyEnrichment) assertScholarlyEnrichment(input.scholarlyEnrichment, content.sourceHash, raw);
  const identity = {...input.identity, parseHash: researchContentHash(JSON.stringify(content))};
  const objectId = (kind: string, sourceId: string) => paperObjectId(kind, identity.parseId, sourceId);
  const locator = (blockId: string, id: string, span?: {start: number; end: number}): ResearchSourceLocator => {
    const b = byBlock.get(blockId);
    if (!b) throw new Error('research_paper_ir_block_missing');
    return {documentId: identity.documentId, parseId: identity.parseId, knowledgeDocumentId: identity.knowledgeDocumentId,
      sourceHash: identity.sourceHash, parseHash: identity.parseHash, parserFingerprint: identity.parserFingerprint,
      blockId, parentBlockId: blockId, objectId: id, rawLocator: b.locator,
      locations: b.locations ?? [], ...(span && span.end > span.start ? {textSpan: span} : {})};
  };
  const sourced = (kind: string, blockId: string, sourceId = blockId, span?: {start: number; end: number}) => {
    const id = objectId(kind, sourceId);
    return {id, blockId, sourceLocator: locator(blockId, id, span)};
  };
  const annotations = new Map(structure.blocks.map(b => [b.blockId, b]));
  const ir: PaperIRV2 = {schemaVersion: 2, version: paperIrV2Version, identity,
    metadata: input.metadata ?? {title: null, authors: [], doi: null, year: null, origin: 'unknown'},
    structure,
    sections: structure.sections.map(s => ({...sourced('section', s.blockId, s.id, {start: s.start, end: s.end}),
      originalId: s.id, parentId: s.parentId === null ? null : objectId('section', s.parentId),
      title: s.title, category: s.category, level: s.level})),
    blocks: raw.map(b => ({...sourced('block', b.id), originalId: b.id, kind: b.kind,
      text: b.text, label: b.label ?? b.kind, sectionIds: annotations.get(b.id)!.sectionIds.map(id => objectId('section', id)),
      semantic: annotations.get(b.id)!.semantic})),
    tables: raw.flatMap(b => b.table ? [{...sourced('table', b.id), data: b.table,
      cells: b.table.rows.flatMap(r => r.cells.map(c => {
        const result = sourced('cell', b.id, c.id);
        // A missing cell box is not the table's box. Retain a page-only locator.
        result.sourceLocator.locations = [{page: b.table!.source.page, bbox: c.bbox,
          coordinateOrigin: c.bbox === null ? null : b.table!.source.coordinateOrigin}];
        return {...result, originalId: c.id, row: r.index, column: c.column, text: c.text,
          geometry: c.bbox === null ? 'unknown' as const : 'cell' as const};
      })), ...(b.visual ? {visual: b.visual} : {})}] : []),
    figures: raw.flatMap(b => b.visual?.kind === 'figure' ? [{...sourced('figure', b.id), data: b.visual}] : []),
    equations: raw.flatMap(b => b.equation ? [{...sourced('equation', b.id), data: b.equation}] : []),
    algorithms: raw.filter(b => /^\s*(?:Algorithm|算法)\s*\d+\b/iu.test(b.text) || b.label === 'algorithm').map(b => {
      const steps = [...b.text.matchAll(/(?:^|\n)([^\n]+)/gu)].flatMap(m => {
        const start = m.index + m[0].length - m[1]!.length, end = start + m[1]!.length;
        return m[1]!.trim() ? [{...sourced('algorithm-step', b.id, `${b.id}:${start}`, {start, end}), text: m[1]!}] : [];
      });
      return {...sourced('algorithm', b.id), text: b.text, steps};
    }),
    citations: [], references: [], relations: [], quality: content.quality};
  const addRelation = (type: PaperIRV2['relations'][number]['type'], fromId: string, toId: string,
    sourceLocator: ResearchSourceLocator, status: 'linked' | 'candidate' = 'linked') => {
    const id = objectId('relation', `${type}:${fromId}:${toId}:${sourceLocator.textSpan?.start ?? ''}`);
    if (!ir.relations.some(r => r.id === id)) ir.relations.push({id, type, fromId, toId, sourceLocator, status});
  };
  for (const [i, s] of ir.sections.entries()) {
    if (s.parentId) addRelation('contains', s.parentId, s.id, s.sourceLocator);
    const next = ir.sections[i + 1];
    if (next) addRelation('follows', s.id, next.id, s.sourceLocator);
  }
  for (const b of ir.blocks) {
    const section = b.sectionIds.at(-1);
    if (section) {addRelation('contains', section, b.id, b.sourceLocator); addRelation('belongs_to', b.id, section, b.sourceLocator);}
  }
  for (const obj of [...ir.tables, ...ir.figures, ...ir.equations, ...ir.algorithms]) {
    addRelation('contains', objectId('block', obj.blockId), obj.id, obj.sourceLocator);
    const section = annotations.get(obj.blockId)!.sectionIds.at(-1);
    if (section) addRelation('belongs_to', obj.id, objectId('section', section), obj.sourceLocator);
  }
  for (const t of ir.tables) for (const c of t.cells) addRelation('contains', t.id, c.id, c.sourceLocator);
  for (const a of ir.algorithms) for (const [i, s] of a.steps.entries()) {
    addRelation('contains', a.id, s.id, s.sourceLocator);
    const next = a.steps[i + 1];
    if (next) addRelation('follows', s.id, next.id, s.sourceLocator);
  }
  const evidenceLocator = (e: EquationEvidence) => locator(e.blockId, objectId('block', e.blockId), e.textSpan);
  for (const b of raw) {
    if (b.visual) {
      const target = objectId(b.visual.kind, b.id);
      for (const c of b.visual.captions) addRelation('caption_of', objectId('block', c.evidence.blockId), target,
        evidenceLocator(c.evidence), c.status);
      for (const r of b.visual.references) addRelation('references', objectId('block', r.evidence.blockId), target,
        evidenceLocator(r.evidence), r.status);
    }
    if (b.equation) {
      const target = objectId('equation', b.id);
      for (const c of b.equation.contexts) addRelation('explains', objectId('block', c.blockId), target, evidenceLocator(c), 'candidate');
      for (const v of b.equation.variables) addRelation('defines', objectId('block', v.evidence.blockId), target, evidenceLocator(v.evidence));
      for (const r of b.equation.references) addRelation('references', objectId('block', r.evidence.blockId), target,
        evidenceLocator(r.evidence), r.status);
    }
  }
  // Original numbered bibliography lines. Repeated numbers are preserved and never auto-resolved.
  const referenceBlocks = new Set(ir.blocks.filter(b => b.sectionIds.some(id =>
    ir.sections.find(s => s.id === id)?.category === 'references')).map(b => b.blockId));
  for (const b of raw) if (referenceBlocks.has(b.id)) for (const m of b.text.matchAll(/(?:^|\n)(\s*\[(\d{1,5})\][^\n]*)/gu)) {
    const start = m.index + m[0].length - m[1]!.length, end = start + m[1]!.length, originalId = `${b.id}:${start}`;
    ir.references.push({...sourced('reference', b.id, originalId, {start, end}), originalId,
      text: m[1]!, number: m[2]!, origin: 'original-numbered'});
  }
  const supplement = input.scholarlyEnrichment;
  const grobidReferences = new Map<string, string>();
  if (supplement?.fields) {
    for (const r of supplement.fields.references) {
      const match = supplement.resolutions.find(v => v.kind === 'reference' && v.id === r.id && v.status === 'matched');
      if (!match) continue;
      const item = {...sourced('reference', match.blockId!, `grobid:${r.id}`, {start: match.start!, end: match.end!}),
        originalId: r.id, text: match.originalText!, number: null, origin: 'grobid-matched' as const};
      ir.references.push(item); grobidReferences.set(r.id, item.id);
    }
    for (const c of supplement.fields.citationMarkers) {
      const match = supplement.resolutions.find(v => v.kind === 'citation_marker' && v.id === c.id && v.status === 'matched');
      if (!match) continue;
      const targetIds = c.referenceIds.flatMap(id => grobidReferences.has(id) ? [grobidReferences.get(id)!] : []);
      const unresolvedTargets = [...c.unresolvedTargets, ...c.referenceIds.filter(id => !grobidReferences.has(id))];
      ir.citations.push({...sourced('citation', match.blockId!, `grobid:${c.id}`, {start: match.start!, end: match.end!}),
        text: match.originalText!, targetIds, unresolvedTargets,
        status: targetIds.length && !unresolvedTargets.length ? 'linked' : 'candidate', origin: 'grobid-matched'});
    }
  }
  for (const b of raw) if (!referenceBlocks.has(b.id) && ['heading', 'paragraph'].includes(b.kind)) {
    for (const m of b.text.matchAll(/\[(\d{1,5}(?:\s*,\s*\d{1,5})*)\]/gu)) {
      const start = m.index, end = start + m[0].length;
      if (ir.citations.some(c => c.blockId === b.id && c.sourceLocator.textSpan?.start === start &&
          c.sourceLocator.textSpan?.end === end)) continue;
      const numbers = m[1]!.split(',').map(s => s.trim()), targetIds: string[] = [], unresolvedTargets: string[] = [];
      for (const number of numbers) {
        const targets = ir.references.filter(r => r.number === number);
        if (targets.length === 1) targetIds.push(targets[0]!.id);
        else {targetIds.push(...targets.map(r => r.id)); unresolvedTargets.push(number);}
      }
      ir.citations.push({...sourced('citation', b.id, `${b.id}:${start}`, {start, end}), text: m[0],
        targetIds: [...new Set(targetIds)], unresolvedTargets,
        status: unresolvedTargets.length ? 'candidate' : 'linked', origin: 'original-numbered'});
    }
  }
  for (const c of ir.citations) {
    addRelation('contains', objectId('block', c.blockId), c.id, c.sourceLocator);
    for (const target of c.targetIds) addRelation('references', c.id, target, c.sourceLocator, c.status);
  }
  return validatePaperIR(ir);
}
