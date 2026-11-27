import type {Database} from 'better-sqlite3';
import {Converter} from 'opencc-js/t2cn';
import {pinyin} from 'pinyin-pro';

const simplify = Converter({from: 't', to: 'cn'});
const han = /\p{Script=Han}/u;
const dashes = /[\p{Dash_Punctuation}\u2212]/gu;
const cacheEntries = 2_048;
const cacheBytes = 8 * 1024 * 1024;
export const searchNormalizationLimits = {
  projectionCharacters: 32_768, queryCharacters: 4_000, cacheEntries, cacheBytes
} as const;

type Projection = {
  folded: string;
  canonical: string;
  compact: string;
  phonetic?: {full: string; initials: string};
};
type CacheEntry = {projection: Projection; bytes: number};

/** Content-keyed projections never cache permissions, document identities or search results. */
class ProjectionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  get(text: string): Projection {
    const cached = this.entries.get(text);
    if (cached) {
      this.entries.delete(text);
      this.entries.set(text, cached);
      return cached.projection;
    }
    const folded = fold(text);
    const canonical = han.test(folded) ? simplify(folded) : folded;
    const projection: Projection = {folded, canonical, compact: compact(canonical)};
    // Short ASCII keys/queries are cheap to fold and must not evict costly metadata projections.
    if (text.length > 64 || han.test(folded)) this.store(text, projection);
    return projection;
  }

  phonetic(text: string, projection: Projection): NonNullable<Projection['phonetic']> {
    if (projection.phonetic) return projection.phonetic;
    const options = {toneType: 'none', type: 'array', nonZh: 'consecutive', v: true} as const;
    projection.phonetic = {
      full: compact(pinyin(projection.canonical, options).join('')),
      initials: compact(pinyin(projection.canonical, {...options, pattern: 'first'}).join(''))
    };
    this.store(text, projection);
    return projection.phonetic;
  }

  private store(text: string, projection: Projection): void {
    const previous = this.entries.get(text);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(text);
    }
    // JS strings use up to two bytes per code unit. Include keys and every retained projection.
    const size = 2 * (text.length + projection.folded.length + projection.canonical.length +
      projection.compact.length + (projection.phonetic?.full.length ?? 0) + (projection.phonetic?.initials.length ?? 0));
    if (size > cacheBytes) return;
    this.entries.set(text, {projection, bytes: size});
    this.bytes += size;
    while (this.entries.size > cacheEntries || this.bytes > cacheBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
}

const projections = new ProjectionCache();
const registered = new WeakSet<Database>();

function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\u00ad/gu, '').replace(dashes, '-').replace(/\s+/gu, ' ').trim();
}
function compact(value: string): string {
  return value.replace(/[-\s]/gu, '');
}
function phoneticQuery(value: string): string | null {
  // Tone marks and ü/v are spelling variants. Punctuation remains literal in every matching path.
  const plain = value.normalize('NFD').replace(/u\u0308/gu, 'v').replace(/\p{Mark}/gu, '');
  if (!/^[a-zv\s-]+$/u.test(plain)) return null;
  const key = compact(plain);
  return key.length >= 2 ? key : null;
}

/**
 * Read-time lexical tolerance, ordered below literal matches. Original bytes and stored indexes
 * remain untouched; '%'/'_'/'\\' keep their literal meaning rather than becoming wildcards.
 */
export function searchMatchScore(text: string, query: string, allowPhonetic = true): number {
  // Scientific/library contracts cap queries below this. Legacy oversized keyword requests still
  // use their existing literal FTS path, rather than creating unbounded tolerant projections.
  if (query.length > searchNormalizationLimits.queryCharacters) return 0;
  const needle = projections.get(query);
  if (!needle.folded) return 0;
  const overlap = Math.max(64, query.length + 64);
  const stride = searchNormalizationLimits.projectionCharacters - overlap;
  let score = 0;
  for (let offset = 0; offset < text.length; offset += stride) {
    const window = text.slice(offset, offset + searchNormalizationLimits.projectionCharacters);
    score = Math.max(score, projectionScore(window, needle, allowPhonetic));
    if (score === 4) return score;
  }
  return score;
}

function projectionScore(text: string, needle: Projection, allowPhonetic: boolean): number {
  const source = projections.get(text);
  if (source.folded.includes(needle.folded)) return 4;
  if (source.canonical.includes(needle.canonical)) return 3;
  if (needle.compact && source.compact.includes(needle.compact)) return 2;
  const phonetic = allowPhonetic ? phoneticQuery(needle.canonical) : null;
  if (phonetic === null || !han.test(source.canonical)) return 0;
  const romanized = projections.phonetic(text, source);
  if (romanized.full.includes(phonetic)) return 1;
  // Initials are useful for short abbreviations, but a single letter would match almost everything.
  return phonetic.length <= 8 && romanized.initials.includes(phonetic) ? 1 : 0;
}

/** Preserve OR-term retrieval while trying an entire spaced pinyin/compound query first. */
export function searchTerms(query: string): string[] {
  return [...new Set([query.trim(), ...query.trim().split(/\s+/u)])].filter(Boolean).slice(0, 33);
}

export function searchTermsScore(text: string, terms: readonly string[]): number {
  return terms.reduce((score, term, index) => Math.max(score,
    searchMatchScore(text, term, index === 0 || term.length <= searchNormalizationLimits.queryCharacters &&
      (phoneticQuery(fold(term))?.length ?? 0) >= 4)), 0);
}

/** Registered on every connection, including the read-only query worker, without schema changes. */
export function registerSearchFunctions(db: Database): void {
  if (registered.has(db)) return;
  db.function('roc_search_match', {deterministic: true}, (text: unknown, query: unknown) =>
    typeof text === 'string' && typeof query === 'string' ? searchMatchScore(text, query) : 0);
  db.function('roc_search_terms', {deterministic: true}, (text: unknown, serialized: unknown) => {
    if (typeof text !== 'string' || typeof serialized !== 'string') return 0;
    const terms: unknown = JSON.parse(serialized);
    return Array.isArray(terms) && terms.every((term): term is string => typeof term === 'string')
      ? searchTermsScore(text, terms) : 0;
  });
  registered.add(db);
}
