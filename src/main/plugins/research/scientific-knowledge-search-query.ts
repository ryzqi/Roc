import type {Database} from 'better-sqlite3';
import type {ScientificKnowledgeSearchRequest} from '../../../shared/schemas/research-scientific-knowledge-search';
import type {ScientificEntityAlias} from '../../../shared/schemas/research-scientific-entities';

export type ScientificKnowledgePointer = {
  id: string; candidateId: string; documentId: string; generationId: string; exactMatch: number;
};
const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().trim();
/** SQL identifiers are program-owned; names, aliases, IDs and conditions are bound values. */
const names = (row: 'v' | 'e'): string => `
  SELECT json_extract(${row}.snapshot_json,'$.canonicalName') AS name
  UNION ALL SELECT json_extract(${row}.snapshot_json,'$.proposal.canonicalName')
  UNION ALL SELECT value FROM json_each(${row}.snapshot_json,'$.aliases')
  UNION ALL SELECT value FROM json_each(${row}.snapshot_json,'$.proposal.aliases')
  UNION ALL SELECT json_extract(a.value,'$.alias') FROM json_each(@aliases) a
    WHERE json_extract(a.value,'$.targetEntityId')=${row}.id
      AND json_extract(a.value,'$.entityType')=${row}.entity_type`;
const nameMatch = (row: 'v' | 'e', exact = false): string => `EXISTS (
  SELECT 1 FROM (${names(row)}) WHERE ${exact ? 'roc_scientific_search_name(name)=@query' :
    'instr(roc_scientific_search_name(name),@query)>0'})`;

/** Select bounded pointers. Full source records are verified by the extraction reader before publication. */
export function queryScientificKnowledge(db: Database, request: ScientificKnowledgeSearchRequest,
  documentIds: readonly string[], aliases: ScientificEntityAlias[]): ScientificKnowledgePointer[] {
  db.function('roc_scientific_search_name', {deterministic: true},
    (value: unknown) => typeof value === 'string' ? normalize(value) : '');
  const tables = {entity: 'research_paper_entities', fact: 'research_paper_facts', relation: 'research_paper_relations'} as const;
  const parameters: Record<string, string | number | null> = {
    projectId: request.projectId, documents: JSON.stringify(documentIds), aliases: JSON.stringify(aliases),
    query: normalize(request.query), limit: request.limit + 1, offset: request.offset
  };
  const filters = ['j.project_id=@projectId', "j.publication='active'",
    'j.document_id IN (SELECT value FROM json_each(@documents))'];
  const typeFilter = (column: string, values: string[]): void => {
    parameters.types = JSON.stringify(values);
    filters.push(`(@types='[]' OR v.${column} IN (SELECT value FROM json_each(@types)))`);
  };
  let match: string, exact: string;
  if (request.kind === 'entity') {
    typeFilter('entity_type', request.entityTypes);
    match = nameMatch('v'); exact = nameMatch('v', true);
  } else {
    const entityIds = request.kind === 'fact'
      ? ["$.subjectEntityId", "$.objectEntityId", "$.conditions.datasetId", "$.conditions.metricId", "$.conditions.baselineId"]
      : ["$.fromEntityId", "$.toEntityId"];
    const related = `e.generation_id=v.generation_id AND e.id IN (${entityIds.map(path =>
      `json_extract(v.snapshot_json,'${path}')`).join(',')})`;
    match = `EXISTS (SELECT 1 FROM research_paper_entities e WHERE ${related} AND ${nameMatch('e')})`;
    exact = `EXISTS (SELECT 1 FROM research_paper_entities e WHERE ${related} AND ${nameMatch('e', true)})`;
    if (request.kind === 'fact') {
      typeFilter('fact_type', request.factTypes);
      match = `(${match} OR instr(roc_scientific_search_name(json_extract(v.snapshot_json,'$.predicate')),@query)>0)`;
      for (const key of ['datasetId', 'metricId', 'baselineId', 'datasetVersion', 'split'] as const) {
        parameters[key] = request[key];
        filters.push(`(@${key} IS NULL OR json_extract(v.snapshot_json,'$.conditions.${key}')=@${key})`);
      }
      parameters.methodId = request.methodId;
      filters.push(`(@methodId IS NULL OR EXISTS (SELECT 1 FROM research_paper_entities e
        WHERE e.generation_id=v.generation_id AND e.id=@methodId AND e.entity_type IN ('Method','Model')
          AND e.id IN (json_extract(v.snapshot_json,'$.subjectEntityId'),json_extract(v.snapshot_json,'$.objectEntityId'))))`);
    } else {
      typeFilter('relation_type', request.relationTypes);
      match = `(${match} OR instr(roc_scientific_search_name(v.relation_type),@query)>0)`;
      parameters.entityId = request.entityId;
      filters.push(`(@entityId IS NULL OR @entityId IN
        (json_extract(v.snapshot_json,'$.fromEntityId'),json_extract(v.snapshot_json,'$.toEntityId')))`);
      for (const key of ['fromEntityId', 'toEntityId'] as const) {
        parameters[key] = request[key];
        filters.push(`(@${key} IS NULL OR json_extract(v.snapshot_json,'$.${key}')=@${key})`);
      }
    }
  }
  filters.push(`(@query='' OR ${match})`);
  return db.prepare(`SELECT v.id,json_extract(v.snapshot_json,'$.candidateId') AS candidateId,
    j.document_id AS documentId,j.id AS generationId,
    CASE WHEN @query!='' AND ${exact} THEN 1 ELSE 0 END AS exactMatch
    FROM ${tables[request.kind]} v JOIN research_paper_extraction_jobs j ON j.id=v.generation_id
    WHERE ${filters.join(' AND ')} ORDER BY exactMatch DESC,j.document_id,j.id,v.ordinal LIMIT @limit OFFSET @offset`)
    .all(parameters) as ScientificKnowledgePointer[];
}
