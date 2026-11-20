import {scientificCandidateSchema, type ScientificCandidate, type ScientificSearchResult} from '../../../shared/schemas/research-scientific-search';
import {scientificEvidenceResultSchema, scientificEvidenceVersion, type ScientificEvidenceRequest,
  type ScientificEvidenceResult, type ScientificStatementValidation} from '../../../shared/schemas/research-scientific-evidence';
import type {ScientificSearchPaper} from './scientific-search-snapshot';
import type {ScholarlyRelationsRepository} from './scholarly-relations-repository';
import {assertScientificChunkCandidate} from './scientific-context-assembler';
import {scientificMetadataCandidate, scientificCitationCandidate} from './scientific-search-candidate';
import {researchContentHash} from './research-files';

const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
const sourceSchema = scientificCandidateSchema.omit({signals: true, score: true});
const sourceProjection = (candidate: ScientificCandidate) => {
  const {signals: _signals, score: _score, ...source} = candidate;
  return sourceSchema.parse(source);
};

/** Check all saved candidates, including those outside the selected context and final hits. */
export function assertScientificSearchSources(search: ScientificSearchResult, papers: readonly ScientificSearchPaper[],
  scholarly: Pick<ScholarlyRelationsRepository, 'read'>, signal: AbortSignal): void {
  const byGeneration = new Map(papers.map(p => [p.generation.id, p]));
  const candidates = new Map<string, ScientificCandidate>();
  const citations = new Map<string, Map<string, ReturnType<typeof scientificCitationCandidate>>>();
  for (const candidate of search.candidates) {
    signal.throwIfAborted();
    const paper = byGeneration.get(candidate.generationId);
    if (!paper || candidates.has(candidate.id)) throw new Error('research_scientific_search_candidate_invalid');
    candidates.set(candidate.id, candidate);
    if (candidate.chunkId !== null) {
      assertScientificChunkCandidate(candidate, paper);
      continue;
    }
    let expected: ReturnType<typeof scientificMetadataCandidate> | undefined;
    if (candidate.object.kind === 'metadata') expected = scientificMetadataCandidate(paper);
    else if (candidate.object.kind === 'citation') {
      const projectId = search.plan.scope.projectId, itemId = paper.libraryItemId, object = candidate.object;
      if (projectId === null || itemId === null) throw new Error('research_scientific_search_citation_invalid');
      const key = digest([candidate.generationId, object.snapshotId, object.source]);
      let relations = citations.get(key);
      if (!relations) {
        relations = new Map();
        for (let offset = 0;;) {
          signal.throwIfAborted();
          const page = scholarly.read({projectId, itemId, snapshotId: object.snapshotId, source: object.source, offset, limit: 100});
          if (page.total > 20_000 || !page.snapshot.sources.some(s => s.source === object.source && s.status === 'ok')) {
            throw new Error('research_scientific_search_citation_invalid');
          }
          for (const relation of page.relations) {
            const projection = scientificCitationCandidate(paper, {kind: 'citation', snapshotId: page.snapshot.id,
              contentHash: page.snapshot.contentHash, queriedAt: page.snapshot.queriedAt, source: page.source, relation});
            relations.set(projection.id, projection);
          }
          if (page.nextOffset === null) break;
          if (page.nextOffset <= offset) throw new Error('research_scientific_search_citation_invalid');
          offset = page.nextOffset;
        }
        citations.set(key, relations);
      }
      expected = relations.get(candidate.id);
    }
    if (!expected || digest(sourceProjection(candidate)) !== digest(sourceSchema.parse(expected))) {
      throw new Error('research_scientific_search_candidate_invalid');
    }
  }
  const hitIds = new Set<string>();
  for (const hit of search.hits) {
    const candidate = candidates.get(hit.id);
    if (!candidate || hitIds.has(hit.id) || digest(sourceProjection(candidate)) !== digest(sourceProjection(hit))) {
      throw new Error('research_scientific_search_hit_invalid');
    }
    hitIds.add(hit.id);
  }
}

/** Called only after the router has rebuilt the context from current source bytes. */
export function validateScientificStatements(request: ScientificEvidenceRequest): ScientificEvidenceResult {
  const byId = new Map(request.context.evidence.map(e => [e.id, e]));
  const statements: ScientificStatementValidation[] = request.statements.map(statement => {
    const evidenceIds = 'evidenceId' in statement ? [statement.evidenceId] : statement.evidenceIds;
    const result: ScientificStatementValidation = {statementId: statement.id, kind: statement.kind,
      text: statement.text, evidenceIds, sourceStatus: 'valid', supportStatus: 'insufficient_evidence', reasons: []};
    if (!evidenceIds.length || evidenceIds.some(id => !byId.has(id))) {
      return {...result, sourceStatus: 'missing', reasons: ['statement_evidence_missing']};
    }
    if (statement.kind === 'inference') return {...result, supportStatus: 'inference', reasons: ['explicit_inference']};
    if (statement.kind === 'claim') return {...result, reasons: ['semantic_support_not_proven']};
    if (statement.kind === 'comparison') return {...result, reasons: [
      'comparison_dataset_version_split_metric_unit_conditions_unvalidated']};
    const evidence = byId.get(statement.evidenceId)!;
    if (statement.kind === 'quote') {
      const sources = [...evidence.hits.flatMap(h => h.sources),
        ...evidence.passages.map(p => ({text: p.text, locator: p.sourceLocator}))];
      const source = sources.find(s => digest(s.locator) === digest(statement.sourceLocator));
      if (!source || statement.start >= statement.end || statement.end > source.text.length ||
          source.text.slice(statement.start, statement.end) !== statement.text) {
        return {...result, sourceStatus: 'mismatch', reasons: ['quote_source_span_mismatch']};
      }
    } else if (statement.kind === 'table_value') {
      const cell = evidence.object.kind === 'table' ? evidence.object.cells.find(c => c.id === statement.cellId) : null;
      if (evidence.objectId !== statement.objectId || !cell || cell.text !== statement.text) {
        return {...result, sourceStatus: 'mismatch', reasons: ['table_object_cell_value_mismatch']};
      }
    } else if (evidence.object.kind !== 'equation' || evidence.objectId !== statement.objectId ||
        evidence.object.data.rawLatex !== statement.text) {
      return {...result, sourceStatus: 'mismatch', reasons: ['equation_object_value_mismatch']};
    }
    return {...result, supportStatus: 'supported'};
  });
  const answerStatus = statements.length && statements.every(s => s.supportStatus === 'supported') ? 'supported' :
    statements.length && statements.every(s => s.supportStatus !== 'insufficient_evidence') ? 'inference' : 'insufficient_evidence';
  const body = {version: scientificEvidenceVersion, projectId: request.context.projectId,
    snapshotId: request.search.snapshot.id, contextId: request.context.id, sourceStatus: 'valid' as const,
    statements, answerStatus, canAnswerAsFacts: answerStatus === 'supported'};
  return scientificEvidenceResultSchema.parse({id: digest(body), ...body});
}
