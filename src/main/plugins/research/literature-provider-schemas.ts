import { z } from 'zod';

const text = z.string().trim().min(1);
const nullableText = z.string().nullable().optional();
const nullableCount = z.number().int().nonnegative().nullable().optional();
const nullableYear = z.number().int().nullable().optional();

// Providers may add fields. Required result containers and paper identities do not
// become empty successes when an API changes its response or returns a 200 error.
export const openAlexSearchPayload = z.looseObject({
  meta: z.looseObject({count: z.number().int().nonnegative()}).optional(),
  results: z.array(z.looseObject({
    id: text, title: text, doi: nullableText, type: nullableText, is_retracted: z.boolean().nullable().optional(),
    primary_location: z.looseObject({landing_page_url: nullableText, license: nullableText,
      version: z.enum(['publishedVersion', 'acceptedVersion', 'submittedVersion']).nullable().optional()}).nullable().optional(),
    ids: z.looseObject({doi: nullableText, pmid: nullableText}).nullable().optional(),
    authorships: z.array(z.looseObject({author: z.looseObject({display_name: nullableText}).optional()})).optional(),
    abstract_inverted_index: z.record(z.string(), z.array(z.number().int().nonnegative())).nullable().optional(),
    publication_year: nullableYear, cited_by_count: nullableCount,
    open_access: z.looseObject({oa_url: nullableText}).optional()
  }))
});

export const crossrefSearchPayload = z.looseObject({
  message: z.looseObject({'total-results': z.number().int().nonnegative().optional(), items: z.array(z.looseObject({
    DOI: text, title: z.array(text).min(1), URL: nullableText, type: nullableText,
    license: z.array(z.looseObject({URL: text, 'content-version': text})).optional(),
    'update-to': z.array(z.looseObject({DOI: text, type: text, label: z.string(), source: text})).optional(),
    author: z.array(z.looseObject({given: z.string().optional(), family: z.string().optional()})).optional(),
    abstract: nullableText, published: z.looseObject({'date-parts': z.array(z.array(z.number().int())).optional()}).optional()
  }))})
});

export const semanticScholarSearchPayload = z.looseObject({
  total: z.number().int().nonnegative().optional(), next: z.number().int().positive().optional(),
  data: z.array(z.looseObject({
    paperId: text, title: text, authors: z.array(z.looseObject({name: text})).optional(),
    abstract: nullableText, year: nullableYear, citationCount: nullableCount,
    externalIds: z.looseObject({DOI: nullableText, ArXiv: nullableText}).nullable().optional(),
    openAccessPdf: z.looseObject({url: nullableText}).nullable().optional(), url: nullableText
  }))
});

const arxivAuthor = z.looseObject({name: text});
const arxivEntry = z.looseObject({
  id: text.refine(value => !/^https?:\/\/arxiv\.org\/api\/errors(?:[#/]|$)/u.test(value), 'arxiv_api_error'),
  title: text, summary: z.string(), published: z.string().regex(/^\d{4}-\d{2}-\d{2}T/u),
  author: z.union([arxivAuthor, z.array(arxivAuthor)]), doi: z.string().optional()
});
export const arxivSearchPayload = z.looseObject({
  feed: z.looseObject({totalResults: z.number().int().nonnegative(),
    entry: z.union([arxivEntry, z.array(arxivEntry)]).optional()})
});

export const europePmcSearchPayload = z.looseObject({
  hitCount: z.number().int().nonnegative().optional(), nextCursorMark: z.string().min(1).max(2048).optional(),
  resultList: z.looseObject({result: z.array(z.looseObject({
    id: text, title: text, pmid: z.string().optional(), doi: nullableText,
    authorString: z.string().optional(), abstractText: nullableText,
    pubYear: z.string().regex(/^\d{4}$/u).optional(), citedByCount: nullableCount,
    isOpenAccess: z.enum(['Y', 'N']).optional(), source: text
  }))})
});
