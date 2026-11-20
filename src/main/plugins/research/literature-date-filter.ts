import type { LiteratureSearchInput } from '../../../shared/schemas/literature-import';

export type LiteratureDateRange = {from: string | null; to: string | null};

/** The shared input schema validates ISO dates and rejects disjoint bounds. */
export function literatureDateRange(input: LiteratureSearchInput): LiteratureDateRange {
  const lower = [input.dateFrom, input.yearFrom === undefined ? undefined : `${input.yearFrom}-01-01`]
    .filter((value): value is string => value !== undefined);
  const upper = [input.dateTo, input.yearTo === undefined ? undefined : `${input.yearTo}-12-31`]
    .filter((value): value is string => value !== undefined);
  return {from: lower.sort().at(-1) ?? null, to: upper.sort().at(0) ?? null};
}

/** Apply native filters without changing paging, sorting, or the provider's result records. */
export function literatureDateFilterUrl(
  url: string, source: NonNullable<LiteratureSearchInput['sources']>[number], dates: LiteratureDateRange
): string {
  if (dates.from === null && dates.to === null) return url;
  const filtered = new URL(url);
  switch (source) {
    case 'openalex':
    case 'crossref': {
      // https://docs.openalex.org/api-entities/works/filter-works
      // https://github.com/CrossRef/rest-api-doc
      const from = source === 'openalex' ? 'from_publication_date' : 'from-pub-date';
      const to = source === 'openalex' ? 'to_publication_date' : 'until-pub-date';
      filtered.searchParams.set('filter', [
        ...(dates.from === null ? [] : [`${from}:${dates.from}`]),
        ...(dates.to === null ? [] : [`${to}:${dates.to}`])
      ].join(','));
      break;
    }
    case 'semantic_scholar':
      // Supported on relevance /paper/search, retaining its offset/limit pagination.
      // https://api.semanticscholar.org/api-docs/graph#tag/Paper-Data/operation/get_graph_get_paper_search
      filtered.searchParams.set('publicationDateOrYear', `${dates.from ?? ''}:${dates.to ?? ''}`);
      break;
    case 'arxiv': {
      // arXiv filters submission dates, at minute precision in GMT; include both full days.
      // https://info.arxiv.org/help/api/user-manual.html#query_details
      const from = (dates.from ?? '0001-01-01').replaceAll('-', '') + '0000';
      const to = (dates.to ?? '9999-12-31').replaceAll('-', '') + '2359';
      filtered.searchParams.set('search_query', `(${filtered.searchParams.get('search_query')}) AND submittedDate:[${from} TO ${to}]`);
      break;
    }
    case 'pubmed':
    case 'europe_pmc':
      // FIRST_PDATE is the first electronic/print publication date, not index/update time.
      // https://europepmc.org/searchsyntax
      filtered.searchParams.set('query',
        `(${filtered.searchParams.get('query')}) AND FIRST_PDATE:[${dates.from ?? '*'} TO ${dates.to ?? '*'}]`);
      break;
  }
  return filtered.toString();
}
