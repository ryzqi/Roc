import type { ResearchBibliographyEntry, ResearchLibraryItem, ResearchLiterature } from '../../shared/types';

/**
 * Pure formatting + normalization helpers for the literature hub (P5).
 *
 * Everything here is a pure function so it can be unit-tested without IPC — and
 * every one of them exists because the contract forced a decision:
 *
 *   - `researchLiteratureSchema` has **no venue and no tags**, so a venue has to
 *     be read out of the bibliography entry's free-form `fields` (F16).
 *   - `researchCitationKeySchema` is `/^[^\s,{}\\%#"]+$/u`, so a key derived from
 *     a title must be sanitized *before* it is submitted; a derived key that
 *     cannot satisfy the schema returns `null` and the user is asked for one,
 *     rather than us inventing something that will be rejected.
 */

/** Mirrors `researchCitationKeySchema`. Kept in one place so the UI can pre-validate. */
const CITATION_KEY_PATTERN = /^[^\s,{}\\%#"]+$/u;

export function isCitationKeyValid(value: string): boolean {
  return value.length >= 1 && value.length <= 500 && CITATION_KEY_PATTERN.test(value);
}

/** Title shown for a library row: metadata first, bibliography as the fallback. */
export function libraryItemTitle(item: Pick<ResearchLibraryItem, 'metadata' | 'bibliography'>): string {
  const title = item.metadata.title.trim();
  if (title.length > 0) {
    return title;
  }
  const fallback = item.bibliography.title.trim();
  return fallback.length > 0 ? fallback : '（无题名）';
}

/**
 * First author list rendering: `Smith 等` beyond `max`, full list below it.
 *
 * Uses the author strings as the backend stored them (it already normalized
 * `"Last, First"` vs `"First Last"` when importing), so this never re-parses.
 */
export function formatAuthorList(authors: readonly string[], max = 2): string {
  const cleaned = authors.map((author) => author.trim()).filter((author) => author.length > 0);
  if (cleaned.length === 0) {
    return '作者未知';
  }
  if (cleaned.length <= max) {
    return cleaned.join(' · ');
  }
  return `${cleaned.slice(0, max).join(' · ')} 等 ${cleaned.length} 人`;
}

/** `2024` / `—`. Deliberately not "n.d." — an absent year is an absent year. */
export function formatYear(year: number | null): string {
  return year === null ? '—' : String(year);
}

/** Citation count is nullable in the contract; null means "the source did not report it". */
export function formatCitationCount(count: number | null): string {
  return count === null ? '引用数未知' : `被引 ${count}`;
}

/**
 * Venue, read out of the bibliography entry's free-form fields.
 *
 * There is no venue column in `researchLiteratureSchema`, so this is the only
 * honest source. Ordered by how the importers actually spell it: BibTeX uses
 * `journal`/`booktitle`, CSL-JSON uses `container-title`.
 */
const VENUE_FIELDS = ['journal', 'booktitle', 'container-title', 'container_title', 'proceedings-title', 'publisher'] as const;

export function readVenue(bibliography: Pick<ResearchBibliographyEntry, 'fields'>): string | null {
  for (const field of VENUE_FIELDS) {
    // `fields` is `Record<string, string>` in the schema (and the IPC boundary is
    // Zod-validated), so a present key is always a string; there is nothing to
    // narrow here.
    const value = bibliography.fields[field];
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** `DOI 10.1000/xyz` or null when the record carries no DOI. */
export function formatDoi(doi: string | null): string | null {
  const trimmed = doi?.trim() ?? '';
  return trimmed.length === 0 ? null : `10.${trimmed.replace(/^10\./u, '')}`;
}

/**
 * Normalizes user-typed DOI input: strips the URL/`doi:` wrappers, trims, and
 * refuses obvious non-DOIs instead of sending a 2000-character string to the
 * backend. Returns null when nothing usable remains.
 */
export function normalizeDoi(input: string): string | null {
  let value = input.trim();
  if (value.length === 0) {
    return null;
  }
  value = value.replace(/^https?:\/\/(dx\.)?doi\.org\//iu, '');
  value = value.replace(/^doi:\s*/iu, '');
  value = value.trim();
  // A DOI starts with `10.` and has a registrant/suffix split.
  if (!/^10\.\d{4,9}\/\S+$/u.test(value)) {
    return null;
  }
  return value;
}

/**
 * Extracts the query to send for "import by arXiv".
 *
 * The contract has no arXiv-specific import: an arXiv paper arrives via
 * `research.literature.search({ sources: ['arxiv'] })` followed by
 * `importRecord`. So this only has to turn whatever the user pasted — a bare id,
 * an `arXiv:…` prefix, or an abs/pdf URL — into the token worth searching.
 */
export function arxivQueryFromInput(input: string): string | null {
  const value = input.trim();
  if (value.length === 0) {
    return null;
  }
  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([^/?#]+)/iu.exec(value);
  const candidate = urlMatch?.[1] ?? value.replace(/^arxiv:\s*/iu, '');
  const withoutVersion = candidate.replace(/\.pdf$/iu, '').replace(/v\d+$/u, '');
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/iu.test(withoutVersion) ? withoutVersion : null;
}

/** Lowercased ASCII-ish surname, used only to seed a citation key. */
function asciiSurname(author: string): string {
  const parts = author.trim().split(/\s+/u).filter((part) => part.length > 0);
  const last = parts.at(-1) ?? '';
  return last
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^A-Za-z]/gu, '')
    .toLowerCase();
}

function firstTitleWord(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 3);
  return (words[0] ?? '').slice(0, 16);
}

/**
 * Suggests a citation key from what the import form already knows.
 *
 * Returns `null` when nothing usable can be built — the caller must then require
 * the user to type one. Fabricating a key here would produce something the
 * schema rejects (or, worse, a silently colliding key).
 */
export function deriveCitationKey(input: { title: string; authors: readonly string[]; year: number | null }): string | null {
  const surname = input.authors.length === 0 ? '' : asciiSurname(input.authors[0] ?? '');
  const year = input.year === null ? '' : String(input.year);
  const word = firstTitleWord(input.title);
  const parts = [surname.length > 0 ? surname.slice(0, 24) : '', year, word];
  const candidate = parts.join('');
  if (candidate.length === 0 || !isCitationKeyValid(candidate)) {
    return null;
  }
  return candidate;
}

/** The `record` half of `importLibraryRecord`, built from a search hit. */
export function literatureRecordFromSearchHit(hit: ResearchLiterature): ResearchLiterature {
  return { ...hit };
}
