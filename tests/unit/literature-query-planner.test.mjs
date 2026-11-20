import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let planner, schemas, ranking, dates;
before(async () => {
  [planner, schemas, ranking, dates] = await Promise.all([
    'src/main/plugins/research/literature-query-planner.ts',
    'src/shared/schemas/literature-import.ts',
    'src/main/plugins/research/literature-reranker.ts',
    'src/main/plugins/research/literature-date-filter.ts'
  ].map(path => importTypeScriptModule(path)));
});

test('domain routing is inspectable, bounded and preserves explicit provider order', () => {
  for (const [query, domain, sources] of [
    ['Multi-Agent Security', 'computing', ['openalex', 'semantic_scholar', 'arxiv', 'openreview']],
    ['clinical cancer trial', 'biomedical', ['openalex', 'pubmed', 'europe_pmc']],
    ['LLM clinical diagnosis', 'mixed', ['openalex', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc', 'openreview']],
    ['智能体在医学领域的应用', 'mixed', ['openalex', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc', 'openreview']],
    ['geological history', 'general', ['openalex', 'semantic_scholar', 'arxiv']]
  ]) {
    const routed = planner.routeLiteratureSources(schemas.literatureSearchInputSchema.parse({query}));
    assert.deepEqual(routed.request.sources, sources);
    assert.equal(routed.receipt.domain, domain);
    assert.equal(routed.receipt.sourceSelection, 'domain');
    const explicit = planner.routeLiteratureSources(schemas.literatureSearchInputSchema.parse({query, sources: ['crossref', 'arxiv']}));
    assert.deepEqual(explicit.request.sources, ['crossref', 'arxiv']);
    assert.deepEqual(explicit.receipt.reasons, ['explicit_sources_preserved']);
  }
  assert.equal(schemas.literatureResolvedSearchInputSchema.safeParse({query: 'must be explicit'}).success, false);
});

test('quick and deep planning preserve original queries and report their full provider page budget', () => {
  const input = {query: 'LLM memory and retrieval augmented generation', sources: ['crossref'], maxPages: 3, limit: 20};
  const quick = planner.planLiteratureQueries(input);
  assert.deepEqual(quick.queries.map(query => query.query), [input.query]);
  assert.equal(quick.maximumProviderPages, 3);
  const deep = planner.planLiteratureQueries({...input, mode: 'deep'});
  assert.deepEqual(deep.queries.map(query => query.query), [
    input.query, 'large language model memory and retrieval augmented generation', 'LLM memory and RAG'
  ]);
  assert.equal(deep.maximumProviderPages, 9);
  assert.ok(deep.queries.every(query => query.limit === 20 && query.maxPages === 3 && query.sources[0] === 'crossref'));
  assert.equal(planner.planLiteratureQueries({query: 'unmapped terminology', mode: 'deep'}).queries.length, 1);
  assert.ok(planner.planLiteratureQueries({query: `LLM ${'x'.repeat(996)}`, mode: 'deep'}).queries.every(query => query.query.length <= 1000));
});

test('rolling calendar years use explicit UTC dates, clamp leap days and reject ambiguous bounds', () => {
  const plan = planner.planLiteratureQueries({query: 'LLM', recentYears: 2}, new Date('2026-11-19T12:00:00Z'));
  assert.deepEqual(plan.time, {asOf: '2026-11-19', rule: 'rolling_calendar_years_utc', dateFrom: '2024-11-19', dateTo: '2026-11-19'});
  assert.equal(plan.queries[0].dateFrom, '2024-11-19');
  assert.equal(planner.planLiteratureQueries({query: 'LLM', recentYears: 1, asOf: '2024-02-29'}).time.dateFrom, '2023-02-28');
  for (const input of [{dateFrom: '2026-02-29'}, {dateFrom: '2026-11-20', dateTo: '2026-11-19'},
    {dateTo: '2023-12-31', yearFrom: 2024}, {recentYears: 2, yearFrom: 2024}]) {
    assert.throws(() => planner.planLiteratureQueries({query: 'LLM', ...input}));
  }
  const input = schemas.literatureSearchInputSchema.parse({query: 'x', dateFrom: '2024-11-19', yearFrom: 2025,
    dateTo: '2026-11-19', yearTo: 2025});
  assert.deepEqual(dates.literatureDateRange(input), {from: '2025-01-01', to: '2025-12-31'});
  assert.equal(ranking.literatureMatchesYears({publishedYear: 2024}, input), false);
  assert.equal(ranking.literatureMatchesYears({publishedYear: null}, input), false);
  assert.equal(ranking.literatureMatchesYears({publishedYear: null}, {query: 'x'}), true);
});

test('optional reranking improves a known lexical match while retaining RRF and all evidence', () => {
  const candidate = (id, title, abstract = '') => ({candidateId: id, record: {title, abstract}, score: 1 / (61 + Number(id)),
    origins: [{rank: Number(id) + 1}], contributions: [{rank: Number(id) + 1}]});
  const inputs = [
    candidate('0', 'Unrelated geology'), candidate('1', 'LLM Agent Memory', 'LLM Agent Memory'),
    candidate('2', 'LLM Agent Memory', 'LLM Agent Memory'), candidate('3', 'Agent Memory retrieval', 'LLM Agent Memory')
  ];
  const before = structuredClone(inputs);
  const result = ranking.rerankLiterature('LLM Agent Memory', inputs);
  assert.deepEqual(result.candidates.map(candidate => candidate.candidateId), ['1', '2', '3', '0']);
  assert.deepEqual(result.receipt.scores.map(score => score.diversityPenalty), [0, .15, .075, 0]);
  for (const output of result.candidates) assert.equal(output, inputs.find(input => input.candidateId === output.candidateId));
  assert.deepEqual(inputs, before);
  assert.deepEqual(ranking.rerankLiterature('LLM Agent Memory', inputs), result);
  const many = Array.from({length: 102}, (_, id) => candidate(String(id), 'Title'));
  const bounded = ranking.rerankLiterature('Title', many);
  assert.equal(bounded.receipt.scores.length, 100);
  assert.deepEqual(bounded.candidates.slice(100), many.slice(100));
});
