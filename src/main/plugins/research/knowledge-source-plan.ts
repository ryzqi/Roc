import {paperChunkSchema, type PaperChunk} from '../../../shared/schemas/research-paper-ir';
import {assertPaperTable} from '../../../shared/schemas/research-paper-table';
import {assertPaperEquationBlock} from '../../../shared/schemas/research-paper-equation';
import {assertPaperVisualBlock} from '../../../shared/schemas/research-paper-visual';
import {structuredSpans, spanLocator, knowledgeChunkVersion, chunkTokenCount} from './knowledge-chunks';
import {scientificRole} from './paper-ir';
import {researchContentHash} from './research-files';
import type {KnowledgeSourceWrite} from './knowledge-repository';

export type KnowledgeEmbeddingInput = {
  id: string; content: string; contentHash: string; embeddingInput: string; inputVersion: string;
};
type PlannedChunk = {
  id: string; index: number; content: string; locator: string | null; semantic: PaperChunk;
  structure: {parentId: string | null; start: number; end: number; section: string | null} | null;
};

/** Plan the existing generic index without changing its live SQLite rows. */
export function planKnowledgeSource(input: Pick<KnowledgeSourceWrite, 'id' | 'content' | 'chunks'>,
  metadata: Record<string, unknown>, publicationHash?: string): PlannedChunk[] {
  const parents: PlannedChunk[] = [], children: PlannedChunk[] = [];
  const sourceHash = typeof metadata.sourceHash === 'string' ? metadata.sourceHash : publicationHash ?? researchContentHash(input.content);
  let childIndex = input.chunks.length;
  for (const [index, chunk] of input.chunks.entries()) {
    const id = `${input.id}:chunk:${index}`, spans = structuredSpans(chunk.content, chunk.section ?? null);
    const section = chunk.section ?? spans[0]?.section ?? null;
    const semantic = paperChunkSchema.parse(chunk.semantic ?? {paperId: input.id,
      parseId: typeof metadata.parseId === 'string' ? metadata.parseId : null,
      sourceHash,
      blockId: id, sectionPath: section?.split(' / ') ?? [], semanticRole: scientificRole(section),
      blockKind: 'paragraph', relatedBlockIds: []});
    if (semantic.table) assertPaperTable(semantic.table, semantic.blockId, chunk.locator ?? '');
    if (semantic.equation) assertPaperEquationBlock({id: semantic.blockId, kind: semantic.blockKind,
      locator: chunk.locator ?? '', equation: semantic.equation});
    if (semantic.visual) assertPaperVisualBlock({id: semantic.blockId, kind: semantic.blockKind,
      locator: chunk.locator ?? '', visual: semantic.visual});
    // Empty scientific objects have metadata/geometry, but no original text interval.
    parents.push({id, index, content: chunk.content, locator: chunk.locator, semantic,
      structure: chunk.content.length ? {parentId: null, start: 0, end: chunk.content.length, section} : null});
    if (spans.length > 1) for (const span of spans) {
      const content = chunk.content.slice(span.start, span.end);
      if (!content.trim()) continue;
      const index = childIndex++;
      children.push({id: `${input.id}:chunk:${index}`, index, content, locator: spanLocator(chunk.locator, span),
        structure: {parentId: id, start: span.start, end: span.end, section: span.section},
        semantic: {...semantic, sectionPath: span.section?.split(' / ') ?? semantic.sectionPath,
          semanticRole: scientificRole(span.section) === 'unknown' ? semantic.semanticRole : scientificRole(span.section)}});
    }
  }
  // Preserve original parent IDs for annotation and historical evidence; only children are retrieved.
  return [...parents, ...children];
}

export function knowledgeEmbeddingInput(title: string, section: string | null, role: string, content: string,
  budgets = new Map<string, string>()): string {
  const budget = (text: string): string => {
    const cached = budgets.get(text);
    if (cached !== undefined) return cached;
    let value = [...text].slice(0, 400).join('');
    while (chunkTokenCount(value) > 128) value = [...value].slice(0, Math.floor([...value].length * 0.75)).join('');
    budgets.set(text, value);
    return value;
  };
  return `Document: ${budget(title)}\nRole: ${role}\n${section ? `Section: ${budget(section)}\n` : ''}Text:\n${content}`;
}

export function knowledgeSourceEmbeddingInputs(input: KnowledgeSourceWrite,
  metadata: Record<string, unknown>): KnowledgeEmbeddingInput[] {
  const plan = planKnowledgeSource(input, metadata);
  const parents = new Set(plan.flatMap(chunk => chunk.structure?.parentId ? [chunk.structure.parentId] : []));
  const budgets = new Map<string, string>();
  return plan.filter(chunk => !parents.has(chunk.id) && chunk.content.trim()).map(chunk => ({
    id: chunk.id, content: chunk.content, contentHash: researchContentHash(chunk.content), inputVersion: knowledgeChunkVersion,
    embeddingInput: knowledgeEmbeddingInput(input.title, chunk.structure?.section ?? null, chunk.semantic.semanticRole, chunk.content, budgets)
  }));
}
