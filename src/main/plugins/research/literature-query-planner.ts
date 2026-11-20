import {literatureQueryPlanInputSchema, type LiteratureSearchInput, type LiteratureSearchResult} from '../../../shared/schemas/literature-import';

type Source = NonNullable<LiteratureSearchInput['sources']>[number];
export type ResolvedLiteratureSearch = LiteratureSearchInput & {sources: Source[]};
type Routing = NonNullable<LiteratureSearchResult['planning']>;

/** Domain routing is a small, inspectable heuristic; explicit source choices always win. */
export function routeLiteratureSources(input: LiteratureSearchInput): {request: ResolvedLiteratureSearch; receipt: Routing} {
  const computing = /\b(?:llms?|rag|agentic|multi[- ]agent|machine learning|artificial intelligence|neural|language models?|computer vision|nlp|multimodal|cvpr|iccv|wacv|acl|emnlp|naacl|natural language processing)\b|大模型|人工智能|智能体|机器学习|自然语言|多模态|计算机视觉/iu.test(input.query);
  const biomedical = /\b(?:biomedical|clinical|patients?|cancer|oncology|genomics?|proteins?|pubmed|medicine|medical|drug|disease|trial)\b|医学|临床|肿瘤|基因|药物/iu.test(input.query);
  const domain = computing && biomedical ? 'mixed' : biomedical ? 'biomedical' : computing ? 'computing' : 'general';
  const sources: Source[] = input.sources ?? (domain === 'biomedical' ? ['openalex', 'pubmed', 'europe_pmc'] :
    domain === 'mixed' ? ['openalex', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc'] :
      ['openalex', 'semantic_scholar', 'arxiv']);
  if (input.sources === undefined && computing) {
    sources.push('openreview');
    if (/\b(?:nlp|acl|emnlp|naacl|eacl|coling|natural language processing)\b|自然语言/iu.test(input.query)) sources.push('acl');
    if (/\b(?:computer vision|multimodal|cvpr|iccv|wacv)\b|多模态|计算机视觉/iu.test(input.query)) sources.push('cvf');
  }
  const year = input.yearTo ?? Number(input.dateTo?.slice(0, 4) ?? new Date().getUTCFullYear() - 1);
  const aclVenue = /\b(emnlp|naacl|eacl|coling)\b/iu.exec(input.query)?.[1]?.toLowerCase() ?? 'acl';
  const cvfVenue = /\b(ICCV|WACV)\b/iu.exec(input.query)?.[1]?.toUpperCase() ?? 'CVPR';
  const collections = {
    ...input.collections,
    ...(sources.includes('acl') ? {acl: input.collections?.acl ?? `${year}.${aclVenue}`} : {}),
    ...(sources.includes('cvf') ? {cvf: input.collections?.cvf ?? `${cvfVenue}${year}`} : {})
  };
  return {request: {...input, sources, ...(Object.keys(collections).length ? {collections} : {})}, receipt: {version: 1, domain,
    sourceSelection: input.sources === undefined ? 'domain' : 'explicit',
    reasons: input.sources !== undefined ? ['explicit_sources_preserved'] : [
      `query_domain_${domain}`, 'openalex_cross_discipline',
      ...(computing || !biomedical ? ['semantic_scholar_and_arxiv_discovery'] : []),
      ...(biomedical ? ['pubmed_and_europe_pmc_share_ebi_host'] : []),
      ...(sources.includes('openreview') ? ['openreview_public_forums'] : []),
      ...(sources.includes('acl') ? [`acl_collection_${collections.acl}`] : []),
      ...(sources.includes('cvf') ? [`cvf_collection_${collections.cvf}`] : []),
      'crossref_available_for_explicit_metadata_search'
    ], dateInterpretation: 'provider_native_with_local_year_check'}};
}

const vocabulary = [
  ['LLM', 'large language model'], ['RAG', 'retrieval augmented generation'],
  ['NLP', 'natural language processing'], ['RLHF', 'reinforcement learning from human feedback'],
  ['multi-agent', 'multi agent']
] as const;

/** Return explicit queries, not synthetic relevance labels or an implicit search execution. */
export function planLiteratureQueries(input: unknown, now = new Date()): {
  version: 1; mode: 'quick' | 'deep'; originalQuery: string; routing: Routing;
  queries: ResolvedLiteratureSearch[]; maximumProviderPages: number;
  time: {asOf: string; rule: 'explicit_bounds' | 'rolling_calendar_years_utc'; dateFrom: string | null; dateTo: string | null};
} {
  const parsed = literatureQueryPlanInputSchema.parse(input);
  const {mode, recentYears, asOf: reference, ...parameters} = parsed;
  const asOf = reference ?? now.toISOString().slice(0, 10);
  if (recentYears !== undefined) {
    const [year, month, day] = asOf.split('-').map(Number);
    if (year - recentYears < 1) throw new Error('literature_relative_date_invalid');
    // Clamp leap-day anniversaries to the final day of the target month.
    const targetYear = year - recentYears;
    const leap = targetYear % 4 === 0 && (targetYear % 100 !== 0 || targetYear % 400 === 0);
    const lastDay = month === 2 ? leap ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
    parameters.dateFrom = `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
    parameters.dateTo = asOf;
  }
  const routed = routeLiteratureSources(parameters);
  const texts = [parameters.query];
  if (mode === 'deep') {
    let expanded = parameters.query;
    let shortened = parameters.query;
    for (const [short, long] of vocabulary) {
      expanded = expanded.replace(new RegExp(`\\b${short}\\b`, 'giu'), long);
      shortened = shortened.replace(new RegExp(`\\b${long}\\b`, 'giu'), short);
    }
    texts.push(expanded, shortened);
  }
  const queries = [...new Set(texts)].filter(query => query.length <= 1000).slice(0, 3)
    .map(query => ({...routed.request, query}));
  return {version: 1, mode, originalQuery: parameters.query, routing: routed.receipt, queries,
    maximumProviderPages: queries.reduce((sum, query) => sum + query.sources.length * query.maxPages, 0),
    time: {asOf, rule: recentYears === undefined ? 'explicit_bounds' : 'rolling_calendar_years_utc',
      dateFrom: parameters.dateFrom ?? null, dateTo: parameters.dateTo ?? null}};
}
