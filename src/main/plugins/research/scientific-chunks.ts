import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ResearchSourceLocator} from '../../../shared/schemas/research-source-locator';
import type {PaperBlockSemantic} from '../../../shared/schemas/research-paper-structure';
import {researchContentHash} from './research-files';
import {chunkTokenCount} from './knowledge-chunks';
import {validatePaperIR} from './paper-ir-validation';
import {serializeScientificChunk, type ScientificChunkType, type ScientificSelection, type ScientificTextSource} from './scientific-text-serializer';

export const scientificChunkVersion = 'roc-scientific-chunks/1';
export const scientificChunkDefaults = {paragraphTokens: 450, tableTokens: 450, algorithmTokens: 450} as const;
export type ScientificChunkPolicy = {paragraphTokens: number; tableTokens: number; algorithmTokens: number};
export type ScientificChunk = {
  id: string; paperId: string; documentId: string; parseId: string; objectId: string; parentId: string | null;
  chunkType: ScientificChunkType; chunkVersion: string; policyHash: string; selection: ScientificSelection;
  sectionPath: string[]; semantic: PaperBlockSemantic; content: string; contentHash: string;
  embeddingText: string; inputVersion: string; embeddingTextHash: string;
  sourceLocator: ResearchSourceLocator; sources: ScientificTextSource[];
  relationIds: string[]; retrieval: boolean; oversized: boolean;
};
function safeEnd(text: string, end: number): number {
  return end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '') ? end - 1 : end;
}
/** Exact half-open UTF-16 intervals; no tokenizer decode or whitespace rewrite. */
export function scientificTextSpans(text: string, tokens: number): Array<{start: number; end: number}> {
  if (!Number.isSafeInteger(tokens) || tokens < 16) throw new Error('research_scientific_budget_invalid');
  const boundaries = [...text.matchAll(/\r?\n[ \t]*\r?\n/gu)].map(m => m.index + m[0].length);
  const spans = [];
  let boundary = 0;
  for (let start = 0; start < text.length;) {
    let end = safeEnd(text, Math.min(text.length, start + 2000));
    while (chunkTokenCount(text.slice(start, end)) > tokens) {
      end = safeEnd(text, start + Math.floor((end - start) * .75));
      if (end <= start) throw new Error('research_scientific_budget_invalid');
    }
    while (boundaries[boundary] !== undefined && boundaries[boundary]! <= start) boundary++;
    let preferred = end;
    for (let i = boundary; boundaries[i] !== undefined && boundaries[i]! <= end; i++) preferred = boundaries[i]!;
    if (preferred > start) end = preferred;
    spans.push({start, end}); start = end;
  }
  return spans;
}
function groups<T>(items: readonly T[], text: (items: T[]) => string, budget: number): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const next = [...current, item];
    if (current.length && chunkTokenCount(text(next)) > budget) {result.push(current); current = [item];}
    else current = next;
  }
  if (current.length) result.push(current);
  return result;
}
export function buildScientificChunks(input: PaperIRV2, overrides: Partial<ScientificChunkPolicy> = {}): ScientificChunk[] {
  const ir = validatePaperIR(input), policy = {...scientificChunkDefaults, ...overrides};
  for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value < 16 || value > 8192) {
    throw new Error('research_scientific_budget_invalid');
  }
  const policyHash = researchContentHash(JSON.stringify(policy)), result: ScientificChunk[] = [];
  const blockMap = new Map(ir.blocks.map(b => [b.blockId, b]));
  const sectionMap = new Map(ir.sections.map(s => [s.id, s]));
  const path = (ids: readonly string[]) => ids.map(id => sectionMap.get(id)!.title);
  const hierarchy = (id: string): string[] => {
    const section = sectionMap.get(id)!;
    return [...(section.parentId ? hierarchy(section.parentId) : []), section.id];
  };
  const add = (selection: ScientificSelection, locator: ResearchSourceLocator, parentId: string | null,
    sectionIds?: string[], retrieval = true): ScientificChunk => {
    const block = blockMap.get(locator.blockId)!;
    const sectionPath = path(sectionIds ?? block.sectionIds);
    const serialized = serializeScientificChunk(ir, selection, sectionPath);
    const id = `scientific:${researchContentHash(JSON.stringify({version: scientificChunkVersion, policyHash,
      identity: ir.identity, selection, parentId}))}`;
    const budget = selection.type === 'table_row_group' ? policy.tableTokens :
      selection.type === 'algorithm' ? policy.algorithmTokens : policy.paragraphTokens;
    const chunk: ScientificChunk = {id, ...ir.identity, objectId: selection.objectId, parentId, chunkType: selection.type,
      chunkVersion: scientificChunkVersion, policyHash, selection, sectionPath, semantic: block.semantic,
      ...serialized, contentHash: researchContentHash(serialized.content), embeddingTextHash: researchContentHash(serialized.embeddingText),
      sourceLocator: {...locator, ...(selection.span ? {textSpan: selection.span} : {})},
      relationIds: ir.relations.filter(r => r.fromId === selection.objectId || r.toId === selection.objectId).map(r => r.id),
      retrieval: retrieval && serialized.sources.some(s => s.text.trim()), oversized: chunkTokenCount(serialized.embeddingText) > budget};
    result.push(chunk); return chunk;
  };
  const algorithmBlocks = new Set(ir.algorithms.map(a => a.blockId));
  for (const block of ir.blocks) {
    if (!['paragraph', 'heading'].includes(block.kind) || algorithmBlocks.has(block.blockId) || !block.text.length) continue;
    // Native page blocks can contain multiple original headings. Keep separate parents at those exact boundaries.
    const headings = ir.sections.filter(s => s.blockId === block.blockId).sort((a, b) => a.sourceLocator.textSpan!.start - b.sourceLocator.textSpan!.start);
    const starts = [...new Set([0, ...headings.map(s => s.sourceLocator.textSpan!.start)])];
    for (const [index, start] of starts.entries()) {
      const end = starts[index + 1] ?? block.text.length;
      const heading = headings.findLast(s => s.sourceLocator.textSpan!.start <= start);
      const sectionIds = heading ? hierarchy(heading.id) : block.sectionIds;
      const parent = add({objectId: block.id, type: 'paragraph', span: {start, end}}, block.sourceLocator, null, sectionIds);
      const spans = scientificTextSpans(block.text.slice(start, end), policy.paragraphTokens);
      if (spans.length > 1) {
        parent.retrieval = false;
        for (const span of spans) add({objectId: block.id, type: 'paragraph', span: {start: start + span.start, end: start + span.end}},
          block.sourceLocator, parent.id, sectionIds);
      }
    }
  }
  for (const table of ir.tables) {
    const parent = add({objectId: table.id, type: 'table'}, table.sourceLocator, null);
    const rows = groups(table.data.rows.map(r => r.index), rows => serializeScientificChunk(ir,
      {objectId: table.id, type: 'table_row_group', rows}, parent.sectionPath).embeddingText, policy.tableTokens);
    if (rows.length) {
      parent.retrieval = false;
      for (const selected of rows) add({objectId: table.id, type: 'table_row_group', rows: selected}, table.sourceLocator, parent.id);
    } else if (blockMap.get(table.blockId)!.text) {
      // Missing/invalid structure still has original OCR text; retain it as a source-bound fallback.
      const text = add({objectId: blockMap.get(table.blockId)!.id, type: 'paragraph'}, table.sourceLocator, parent.id);
      text.sourceLocator = blockMap.get(table.blockId)!.sourceLocator;
    }
  }
  for (const figure of ir.figures) add({objectId: figure.id, type: 'figure'}, figure.sourceLocator, null);
  for (const equation of ir.equations) add({objectId: equation.id, type: 'equation'}, equation.sourceLocator, null);
  for (const algorithm of ir.algorithms) {
    const parent = add({objectId: algorithm.id, type: 'algorithm'}, algorithm.sourceLocator, null);
    const steps = groups(algorithm.steps, items => items.map(s => s.text).join('\n'), policy.algorithmTokens);
    if (steps.length > 1) {
      parent.retrieval = false;
      for (const group of steps) add({objectId: algorithm.id, type: 'algorithm', steps: group.map(s => s.id)}, algorithm.sourceLocator, parent.id);
    }
  }
  const seenCaptions = new Set<string>();
  for (const visual of [...ir.figures.map(f => f.data), ...ir.tables.flatMap(t => t.visual ? [t.visual] : [])]) {
    for (const caption of visual.captions) {
      const block = blockMap.get(caption.evidence.blockId)!;
      const selection = {objectId: block.id, type: 'caption' as const, span: caption.evidence.textSpan};
      const key = JSON.stringify(selection);
      if (!seenCaptions.has(key)) {seenCaptions.add(key); add(selection, block.sourceLocator, null);}
    }
  }
  return result;
}
