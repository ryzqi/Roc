import {scientificContextRequestSchema, scientificContextResultSchema, scientificContextVersion,
  type ScientificContextRequest, type ScientificContextResult, type ScientificContextEvidence,
  type ScientificContextPassage, type ScientificContextImage} from '../../../shared/schemas/research-scientific-context';
import {scientificCandidateSchema, type ScientificCandidate} from '../../../shared/schemas/research-scientific-search';
import type {ScientificQueryPlan} from '../../../shared/schemas/research-scientific-query-plan';
import type {ScientificSearchPaper} from './scientific-search-snapshot';
import {scientificChunkCandidate} from './scientific-search-candidate';
import {serializeParagraph} from './scientific-text-serializer';
import {chunkTokenCount} from './knowledge-chunks';
import {researchContentHash} from './research-files';

const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
const sourceCandidateSchema = scientificCandidateSchema.omit({signals: true, score: true});
type EvidenceBody = Omit<ScientificContextEvidence, 'id'>;
type Block = ScientificSearchPaper['ir']['blocks'][number];
export type ScientificContextImageReader = (paper: ScientificSearchPaper, objectId: string,
  maxDimension: number, signal: AbortSignal) => Promise<{image: ScientificContextImage | null; reason: string | null}>;

/** Count the complete serialized evidence payload, including cells, definitions and provenance. */
export const scientificContextTokens = (evidence: readonly ScientificContextEvidence[]): number =>
  chunkTokenCount(JSON.stringify(evidence));

/** A caller may select saved candidates; it may not replace a chunk's source projection. */
export function assertScientificChunkCandidate(candidate: ScientificCandidate, paper: ScientificSearchPaper): void {
  const chunk = paper.chunks.find(c => c.id === candidate.chunkId && c.retrieval);
  if (!chunk) throw new Error('research_scientific_context_candidate_invalid');
  const {signals: _signals, score: _score, ...source} = candidate;
  if (digest(source) !== digest(sourceCandidateSchema.parse(scientificChunkCandidate(paper, chunk)))) {
    throw new Error('research_scientific_context_candidate_invalid');
  }
}
function mergeObject(candidates: ScientificCandidate[]): ScientificCandidate['object'] {
  const first = candidates[0]!.object;
  if (first.kind === 'algorithm') return {...first,
    stepIds: [...new Set(candidates.flatMap(c => c.object.kind === 'algorithm' ? c.object.stepIds : []))]};
  if (first.kind !== 'table') return first;
  const tables = candidates.map(c => c.object).filter(o => o.kind === 'table');
  return {...first, rows: [...new Set(tables.flatMap(t => t.rows))].sort((a, b) => a - b),
    cells: [...new Map(tables.flatMap(t => t.cells).map(c => [c.id, c])).values()]
      .sort((a, b) => a.row - b.row || a.column - b.column || a.id.localeCompare(b.id))};
}
function expansions(paper: ScientificSearchPaper, candidates: ScientificCandidate[], plan: ScientificQueryPlan): ScientificContextPassage[] {
  const {ir, chunks} = paper, first = candidates[0]!, proposed: ScientificContextPassage[] = [];
  const seen = new Set(candidates.flatMap(c => c.sources.map(s => digest({text: s.text, locator: s.locator}))));
  const add = (role: ScientificContextPassage['role'], text: string, sourceLocator: ScientificContextPassage['sourceLocator']) => {
    const key = digest({text, locator: sourceLocator});
    if (text && !seen.has(key)) {seen.add(key); proposed.push({role, text, sourceLocator});}
  };
  const block = (value: Block, role: ScientificContextPassage['role']) =>
    add(role, value.text, value.sourceLocator);
  const original = ir.blocks.find(b => b.blockId === first.sourceLocator?.blockId)!;
  const sameSection = (b: Block) => original && b.sectionIds.at(-1) === original.sectionIds.at(-1);
  const nearby = ir.blocks.filter(b => b.kind === 'paragraph' && sameSection(b));
  const nearest = (items: Block[], count = 2) => items
    .map(b => ({b, distance: Math.abs(ir.blocks.indexOf(b) - ir.blocks.indexOf(original))}))
    .sort((a, b) => a.distance - b.distance || ir.blocks.indexOf(a.b) - ir.blocks.indexOf(b.b))
    .slice(0, count).map(row => row.b);
  const needsConditions = plan.intents.some(intent => ['comparison', 'cross_paper', 'experiment', 'results'].includes(intent));
  if (needsConditions) {
    // Conditions often live in a separate experimental section; only source-backed role labels qualify.
    const conditions = ir.blocks.filter(b => b.kind === 'paragraph' && b.semantic.roles.some(role =>
      ['dataset', 'metric', 'experimental_setup'].includes(role.role)));
    for (const setup of nearest(conditions, 3)) block(setup, 'experimental_setup');
  }
  if (plan.intents.includes('limitations')) {
    for (const limitation of nearest(ir.blocks.filter(b => b.semantic.roles.some(role => role.role === 'limitation')), 2)) {
      block(limitation, 'explanation');
    }
  }
  if (first.object.kind === 'algorithm') {
    const algorithm = ir.algorithms.find(value => value.id === first.objectId)!;
    add('explanation', algorithm.text, algorithm.sourceLocator);
    const relatedIds = new Set(ir.relations.filter(relation => relation.status === 'linked' &&
      (relation.fromId === first.objectId || relation.toId === first.objectId))
      .map(relation => relation.fromId === first.objectId ? relation.toId : relation.fromId));
    for (const equation of ir.equations.filter(value => relatedIds.has(value.id))) {
      const source = ir.blocks.find(value => value.blockId === equation.blockId)!;
      block(source, 'explanation');
    }
  }
  if (first.object.kind === 'text' || first.object.kind === 'algorithm') {
    const parents = chunks.filter(c => c.chunkType === 'paragraph' && c.parentId === null);
    for (const candidate of candidates) {
      const hit = chunks.find(c => c.id === candidate.chunkId)!;
      const parent = chunks.find(c => c.id === hit.parentId) ?? hit;
      if (parent.chunkType === 'paragraph') {
        const source = serializeParagraph(ir, parent.selection).sources[0];
        if (source) add('parent', source.text, source.locator);
        const index = parents.findIndex(c => c.id === parent.id);
        if (index >= 0) for (const neighbor of [parents[index - 1], parents[index + 1]]) {
          if (neighbor && digest(neighbor.sectionPath) === digest(parent.sectionPath)) {
            const adjacent = serializeParagraph(ir, neighbor.selection).sources[0];
            if (adjacent) add('adjacent', adjacent.text, adjacent.locator);
          }
        }
      }
    }
  } else if (first.object.kind === 'table') {
    for (const setup of nearest(nearby.filter(b => b.semantic.roles.some(r =>
      ['method', 'dataset', 'metric', 'experimental_setup'].includes(r.role))))) block(setup, 'experimental_setup');
    for (const explanation of nearest(nearby.filter(b => !b.semantic.roles.some(r =>
      ['method', 'dataset', 'metric', 'experimental_setup'].includes(r.role))))) block(explanation, 'explanation');
  } else if (first.object.kind === 'equation') {
    const evidence = (value: {blockId: string; text: string; textSpan: {start: number; end: number}},
      role: ScientificContextPassage['role']) => {
      const source = ir.blocks.find(b => b.blockId === value.blockId)!;
      add(role, value.text, {...source.sourceLocator, textSpan: value.textSpan});
    };
    for (const variable of first.object.data.variables) evidence(variable.evidence, 'symbol_definition');
    for (const context of first.object.data.contexts) evidence(context, 'explanation');
    for (const context of nearest(nearby, 2)) block(context, 'explanation');
  } else if (first.object.kind === 'figure') {
    for (const link of [...first.object.data.captions, ...first.object.data.references]) {
      // Ambiguous caption/reference proposals remain proposals in the raw object.
      if (link.status !== 'linked') continue;
      const source = ir.blocks.find(b => b.blockId === link.evidence.blockId)!;
      add('number' in link && 'crossPage' in link ? 'caption' : 'reference', link.evidence.text,
        {...source.sourceLocator, textSpan: link.evidence.textSpan});
    }
    for (const related of nearest(nearby, 1)) block(related, 'explanation');
  }
  const selected = candidates.flatMap(c => {
    const hit = chunks.find(h => h.id === c.chunkId)!;
    const originalBlock = ir.blocks.find(b => b.blockId === hit.sourceLocator.blockId)!;
    const preceding = ir.sections.filter(s => s.blockId === originalBlock.blockId &&
      (s.sourceLocator.textSpan?.start ?? 0) <= (hit.selection.span?.start ?? 0));
    const last = preceding.at(-1);
    const chain: string[] = last ? [last.id] : [...originalBlock.sectionIds];
    for (let current = last; current?.parentId;) {
      current = ir.sections.find(s => s.id === current!.parentId);
      if (current) chain.unshift(current.id);
    }
    return chain;
  });
  for (const sectionId of new Set(selected)) {
    const section = ir.sections.find(s => s.id === sectionId)!;
    const source = ir.blocks.find(b => b.blockId === section.blockId)!;
    const span = section.sourceLocator.textSpan;
    add('section_heading', span ? source.text.slice(span.start, span.end) : section.title, section.sourceLocator);
  }
  return proposed;
}

/** Fit whole source objects first, then whole exact-source passages. Never cut a value or formula. */
export async function assembleScientificContext(input: ScientificContextRequest, papers: readonly ScientificSearchPaper[],
  imageReader: ScientificContextImageReader | null = null,
  signal: AbortSignal = new AbortController().signal): Promise<ScientificContextResult> {
  const request = scientificContextRequestSchema.parse(input), {search, budget} = request;
  signal.throwIfAborted();
  const ids = request.candidateIds.length ? request.candidateIds : search.hits.map(c => c.id);
  const selected = ids.map(id => {
    const candidate = search.candidates.find(c => c.id === id);
    if (!candidate) throw new Error('research_scientific_context_selection_invalid');
    return candidate;
  });
  const byGeneration = new Map(papers.map(p => [p.generation.id, p]));
  const groups = new Map<string, ScientificCandidate[]>();
  const omissions: ScientificContextResult['omissions'] = [];
  for (const candidate of selected) {
    const paper = byGeneration.get(candidate.generationId);
    if (!paper) throw new Error('research_scientific_context_candidate_invalid');
    if (candidate.chunkId === null) {
      omissions.push({candidateIds: [candidate.id], reason: 'metadata_or_citation_requires_document_evidence'});
      continue;
    }
    assertScientificChunkCandidate(candidate, paper);
    const key = digest([candidate.generationId, candidate.objectId]);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const evidence: ScientificContextEvidence[] = [], perPaper = new Map<string, number>();
  let paragraphs = 0, images = 0;
  for (const candidates of groups.values()) {
    signal.throwIfAborted();
    const first = candidates[0]!, paper = byGeneration.get(first.generationId)!;
    const omit = (reason: string) => omissions.push({candidateIds: candidates.map(c => c.id), reason});
    if (evidence.length >= budget.maxObjects) {omit('object_budget_exceeded'); continue;}
    if ((perPaper.get(first.paperId) ?? 0) >= budget.maxEvidencePerPaper) {omit('paper_evidence_budget_exceeded'); continue;}
    const baseParagraphs = first.object.kind === 'text' || first.object.kind === 'algorithm' ? candidates.length : 0;
    if (paragraphs + baseParagraphs > budget.maxParagraphs) {omit('paragraph_budget_exceeded'); continue;}
    const body: EvidenceBody = {
      candidateIds: candidates.map(c => c.id), generationId: first.generationId, documentId: first.documentId,
      paperId: first.paperId, objectId: first.objectId, objectType: first.objectType,
      title: first.title, sectionPath: first.sectionPath,
      hits: candidates.map(c => ({chunkId: c.chunkId!, selection: c.selection!, content: c.content, sources: c.sources})),
      object: mergeObject(candidates), passages: [], image: null
    };
    const item = (): ScientificContextEvidence => ({id: `scientific-evidence:${digest(body)}`, ...body});
    if (scientificContextTokens([...evidence, item()]) > budget.maxTokens) {omit('token_budget_exceeded'); continue;}
    paragraphs += baseParagraphs;
    for (const passage of expansions(paper, candidates, search.plan)) {
      if (paragraphs >= budget.maxParagraphs) {omit('paragraph_budget_exceeded'); continue;}
      body.passages.push(passage);
      if (scientificContextTokens([...evidence, item()]) > budget.maxTokens) {
        body.passages.pop(); omit('token_budget_exceeded');
      } else paragraphs++;
    }
    if (first.object.kind === 'figure') {
      if (images >= budget.maxImages) omit('image_budget_exceeded');
      else if (!imageReader) omit('image_reader_unavailable');
      else {
        const loaded = await imageReader(paper, first.objectId, budget.maxImageDimension, signal);
        signal.throwIfAborted();
        if (loaded.reason) omit(loaded.reason);
        if (loaded.image) {
          if (loaded.image.width > budget.maxImageDimension || loaded.image.height > budget.maxImageDimension) {
            omit('image_dimension_budget_exceeded');
          } else {
            body.image = loaded.image;
          }
          if (body.image && scientificContextTokens([...evidence, item()]) > budget.maxTokens) {
            body.image = null; omit('token_budget_exceeded');
          } else if (body.image) images++;
        }
      }
    }
    evidence.push(item());
    perPaper.set(first.paperId, (perPaper.get(first.paperId) ?? 0) + 1);
  }
  const result = {version: scientificContextVersion, snapshotId: search.snapshot.id,
    projectId: search.plan.scope.projectId, query: search.plan.query, selectedCandidateIds: ids, budget, evidence,
    usage: {objects: evidence.length, paragraphs, tokens: scientificContextTokens(evidence), images},
    omissions, requestedConditions: {datasets: search.plan.filters.datasets, metrics: search.plan.filters.metrics, splits: []},
    comparisonStatus: 'requires_validation' as const};
  return scientificContextResultSchema.parse({id: digest(result), ...result});
}
