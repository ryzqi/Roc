import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { researchBibliographyEntrySchema, researchBibliographyFormatSchema } from '../../../shared/schemas/research-library';
import { researchJobError, runResearchJob } from './research-job';
import {
  bibliographyCodec,
  bibliographyCreatorNames,
  bibliographyCreatorsToCsl,
  bibliographyFieldText,
  BibliographyCodecError
} from './bibliography-codec';

export type BibliographyFormat = z.infer<typeof researchBibliographyFormatSchema>;
export type BibliographyEntry = {
  citationKey: string;
  entryType: string;
  fields: Record<string, string>;
  preambles: string[];
  csl: Record<string, unknown> | null;
  title: string;
  authors: string[];
  doi: string | null;
  publishedYear: number | null;
  abstract: string | null;
  url: string | null;
};

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const CSL_FIELDS: Record<string, string> = {
  publisher: 'publisher', 'publisher-place': 'address', edition: 'edition', volume: 'volume', issue: 'number',
  page: 'pages', ISBN: 'isbn', ISSN: 'issn', DOI: 'doi', URL: 'url', abstract: 'abstract', language: 'language', note: 'note'
};
const CSL_TYPES: Record<string, string> = {
  'article-journal': 'article', 'article-magazine': 'article', 'article-newspaper': 'article', book: 'book',
  chapter: 'incollection', 'paper-conference': 'inproceedings', report: 'techreport', thesis: 'phdthesis',
  webpage: 'online', dataset: 'misc', article: 'misc', bill: 'misc', broadcast: 'misc', classic: 'book',
  collection: 'book', document: 'misc', entry: 'incollection', 'entry-dictionary': 'incollection',
  'entry-encyclopedia': 'incollection', event: 'misc', figure: 'misc', graphic: 'misc', hearing: 'misc',
  interview: 'misc', legal_case: 'misc', legislation: 'misc', manuscript: 'unpublished', map: 'misc',
  motion_picture: 'misc', musical_score: 'misc', pamphlet: 'booklet', patent: 'misc', performance: 'misc',
  periodical: 'misc', personal_communication: 'misc', post: 'online', 'post-weblog': 'online', regulation: 'misc',
  review: 'article', 'review-book': 'article', software: 'misc', song: 'misc', speech: 'misc', standard: 'techreport',
  treaty: 'misc'
};
const BIB_TYPES: Record<string, string> = {
  article: 'article-journal', book: 'book', booklet: 'book', inbook: 'chapter', incollection: 'chapter',
  inproceedings: 'paper-conference', conference: 'paper-conference', proceedings: 'book', techreport: 'report',
  report: 'report', phdthesis: 'thesis', mastersthesis: 'thesis', thesis: 'thesis', online: 'webpage', misc: 'article',
  unpublished: 'manuscript', manual: 'book', collection: 'book', mvbook: 'book', mvcollection: 'book',
  mvproceedings: 'book', periodical: 'periodical', dataset: 'dataset', software: 'software', patent: 'patent',
  suppbook: 'chapter', suppcollection: 'chapter', suppperiodical: 'article-journal', bookinbook: 'chapter',
  reference: 'book', mvreference: 'book', inreference: 'entry-encyclopedia'
};
const BOOK_CONTAINERS = new Set(['chapter', 'paper-conference', 'entry', 'entry-dictionary', 'entry-encyclopedia']);
const MONTHS: Record<string, number> = Object.fromEntries(
  ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
    .flatMap((name, index) => [[name, index + 1], [name.slice(0, 3), index + 1]])
);
function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    researchJobError(code);
  }
  return value.trim();
}

function citationKey(value: unknown): string {
  const key = requiredText(value, 'research_citation_key_required');
  if (/[\s,{}\\%#"]/u.test(key)) {
    researchJobError('research_citation_key_invalid');
  }
  return key;
}

function decodeUri(value: string): string {
  let next = value.trim();
  if (next.startsWith('\\url{') && next.endsWith('}')) {
    next = next.slice(5, -1);
  }
  return next.replace(/\\([%&#_{}$])/gu, '$1');
}

export function encodeLatex(value: string): string {
  return value.replace(/([%&#_$])/gu, '\\$1');
}

function cslAuthorField(people: unknown): string {
  if (!Array.isArray(people)) {
    researchJobError('research_csl_authors_invalid');
  }
  const authors: string[] = [];
  for (const person of people) {
    if (typeof person !== 'object' || person === null) {
      researchJobError('research_csl_authors_invalid');
    }
    const record = person as Record<string, unknown>;
    if (record.literal) {
      authors.push(`{${encodeLatex(requiredText(record.literal, 'research_csl_authors_invalid'))}}`);
      continue;
    }
    const family = requiredText(record.family, 'research_csl_authors_invalid');
    const given = record.given ?? '';
    const particle = record['non-dropping-particle'] ?? '';
    const dropping = record['dropping-particle'] ?? '';
    const suffix = record.suffix ?? '';
    if ([given, particle, dropping, suffix].some((value) => typeof value !== 'string')) {
      researchJobError('research_csl_authors_invalid');
    }
    const last = [particle, family].filter((value) => typeof value === 'string' && value.length > 0).join(' ');
    const first = [given, dropping].filter((value) => typeof value === 'string' && value.length > 0).join(' ');
    authors.push(encodeLatex(last) + (suffix ? `, ${encodeLatex(String(suffix))}` : '') + (first ? `, ${encodeLatex(first)}` : ''));
  }
  return authors.join(' and ');
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function cslDateParts(value: unknown): number[][] | null {
  if (typeof value !== 'object' || value === null) {
    researchJobError('research_csl_date_invalid');
  }
  const record = value as Record<string, unknown>;
  if (!('date-parts' in record)) {
    if ([record.literal, record.raw].some((item) => typeof item === 'string' && item.trim().length > 0)) {
      return null;
    }
    researchJobError('research_csl_date_invalid');
  }
  const parts = record['date-parts'];
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2) {
    researchJobError('research_csl_date_invalid');
  }
  for (const date of parts) {
    if (!Array.isArray(date) || date.length < 1 || date.length > 3 || date.some((number) => typeof number !== 'number' || !Number.isInteger(number))) {
      researchJobError('research_csl_date_invalid');
    }
    if (date.length >= 2 && (date[1] < 1 || date[1] > 12)) {
      researchJobError('research_csl_date_invalid');
    }
    if (date.length === 3 && (date[2] < 1 || date[2] > daysInMonth(date[0], date[1]))) {
      researchJobError('research_csl_date_invalid');
    }
  }
  return parts as number[][];
}

type BibliographyPresentation = {
  title: string;
  authors: string[];
  abstract: string | null;
};

function entryRecord(
  key: string,
  entryType: string,
  fields: Record<string, string>,
  preambles: string[],
  csl: Record<string, unknown> | null,
  presentation: BibliographyPresentation
): BibliographyEntry {
  const title = requiredText(presentation.title, 'research_bibliography_title_required');
  if (title.length === 0) {
    researchJobError('research_bibliography_title_required');
  }
  const authors = presentation.authors;
  const date = fields.year ?? fields.date ?? '';
  const year = /^(-?\d{1,4})(?:\b|-)/u.exec(date);
  return {
    citationKey: citationKey(key),
    entryType: entryType.toLowerCase(),
    fields,
    preambles,
    csl,
    title,
    authors,
    doi: fields.doi ? decodeUri(fields.doi) : null,
    publishedYear: year ? Number(year[1]) : null,
    abstract: presentation.abstract,
    url: fields.url ? decodeUri(fields.url) : null
  };
}

function cslCreatorNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((person): string[] => {
    if (typeof person !== 'object' || person === null) {
      return [];
    }
    const record = person as Record<string, unknown>;
    if (typeof record.literal === 'string') {
      return [record.literal.trim()].filter((name) => name.length > 0);
    }
    const name = [record.given, record['dropping-particle'], record['non-dropping-particle'], record.family, record.suffix]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim())
      .join(' ');
    return name.length > 0 ? [name] : [];
  });
}

function bibtexPresentation(entry: ReturnType<typeof bibliographyCodec.parse>['entries'][number]): BibliographyPresentation {
  const title = bibliographyFieldText(entry.normalizedFields, 'title');
  const rawAuthor = entry.fields.author?.trim() ?? '';
  const normalizedAuthor = (entry.normalizedFields as Record<string, unknown>).author;
  if (rawAuthor.length > 0 && !Array.isArray(normalizedAuthor)) {
    researchJobError('research_bibliography_authors_invalid');
  }
  return {
    title: title ?? '',
    authors: bibliographyCreatorNames(normalizedAuthor),
    abstract: bibliographyFieldText(entry.normalizedFields, 'abstract') ?? null
  };
}

function journalTitle(fields: Record<string, string>): string | undefined {
  const values = ['journaltitle', 'journal'].map((key) => fields[key]).filter((value) => typeof value === 'string' && value.trim().length > 0);
  if (new Set(values).size > 1) {
    researchJobError('research_bibliography_journal_conflict');
  }
  return values[0];
}

function bibDate(
  fields: Record<string, string>,
  normalizedFields: ReturnType<typeof bibliographyCodec.parse>['entries'][number]['normalizedFields'],
  year: number | null
): Record<string, unknown> | null {
  if (fields.date) {
    const raw = bibliographyFieldText(normalizedFields, 'date') ?? fields.date;
    const dates = raw.split('/');
    if (dates.length <= 2 && dates.every((value) => /^-?\d{1,4}(?:-\d{2}){0,2}$/u.test(value))) {
      const parts = dates.map((value) => {
        const match = /^(-?\d{1,4})(?:-(\d{2}))?(?:-(\d{2}))?$/u.exec(value);
        if (match === null) {
          researchJobError('research_csl_date_invalid');
        }
        return [match[1], match[2], match[3]].filter((part) => part !== undefined).map((part) => Number(part));
      });
      const result = { 'date-parts': parts };
      cslDateParts(result);
      return result;
    }
    return { literal: raw };
  }
  if (year === null) {
    return null;
  }
  const parts: number[] = [year];
  if (fields.month) {
    const month = (bibliographyFieldText(normalizedFields, 'month') ?? fields.month).toLowerCase();
    if (/^\d+$/u.test(month)) {
      parts.push(Number(month));
    } else if (month in MONTHS) {
      parts.push(MONTHS[month]);
    } else {
      researchJobError('research_bibliography_month_invalid');
    }
    if (fields.day) {
      parts.push(Number(fields.day));
    }
  }
  const result = { 'date-parts': [parts] };
  cslDateParts(result);
  return result;
}

export function readBibtex(text: string): BibliographyEntry[] {
  let parsed: ReturnType<typeof bibliographyCodec.parse>;
  try {
    parsed = bibliographyCodec.parse(text);
  } catch (error) {
    if (error instanceof BibliographyCodecError) {
      researchJobError(error.code);
    }
    throw error;
  }
  if (parsed.entries.length === 0 || parsed.entries.length > MAX_ENTRIES) {
    researchJobError('research_bibliography_entry_count_invalid');
  }
  return parsed.entries.map((entry) => entryRecord(
    entry.citationKey,
    entry.entryType,
    entry.fields,
    parsed.preambles,
    null,
    bibtexPresentation(entry)
  ));
}

export function readCsl(text: string): BibliographyEntry[] {
  let items: unknown;
  try {
    items = JSON.parse(text) as unknown;
  } catch {
    researchJobError('research_json_invalid');
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ENTRIES) {
    researchJobError('research_bibliography_entry_count_invalid');
  }
  const entries: BibliographyEntry[] = [];
  const keys = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      researchJobError('research_csl_item_invalid');
    }
    const record = item as Record<string, unknown>;
    const rawId = record['citation-key'] ?? (typeof record.id === 'number' ? String(record.id) : record.id);
    const key = citationKey(rawId);
    if (keys.has(key)) {
      researchJobError('research_citation_key_duplicate');
    }
    keys.add(key);
    const cslType = requiredText(record.type, 'research_csl_type_required');
    if (!(cslType in CSL_TYPES)) {
      researchJobError(`research_csl_type_unsupported:${cslType}`);
    }
    const fields: Record<string, string> = { title: encodeLatex(requiredText(record.title, 'research_bibliography_title_required')) };
    for (const [cslName, bibName] of Object.entries(CSL_FIELDS)) {
      if (cslName in record && record[cslName] !== null && record[cslName] !== undefined) {
        const value = record[cslName];
        if (typeof value !== 'string') {
          researchJobError(`research_csl_field_invalid:${cslName}`);
        }
        fields[bibName] = bibName === 'doi' || bibName === 'url' ? value : encodeLatex(value);
      }
    }
    if (record['container-title'] !== undefined && record['container-title'] !== null) {
      const container = requiredText(record['container-title'], 'research_csl_container_title_invalid');
      fields[BOOK_CONTAINERS.has(cslType) ? 'booktitle' : 'journal'] = encodeLatex(container);
    }
    for (const role of ['author', 'editor', 'translator']) {
      const people = cslAuthorField(record[role] ?? []);
      if (people.length > 0) {
        fields[role] = people;
      }
    }
    if (record.issued !== undefined && record.issued !== null) {
      const parts = cslDateParts(record.issued);
      if (parts !== null) {
        fields.year = String(parts[0][0]);
        fields.date = parts.map((date) => String(date[0]) + date.slice(1).map((value) => `-${String(value).padStart(2, '0')}`).join('')).join('/');
      } else {
        const issued = record.issued as Record<string, string>;
        fields.date = encodeLatex(issued.literal ?? issued.raw);
      }
    }
    entries.push(entryRecord(key, CSL_TYPES[cslType], fields, [], structuredClone(record), {
      title: requiredText(record.title, 'research_bibliography_title_required'),
      authors: cslCreatorNames(record.author ?? []),
      abstract: typeof record.abstract === 'string' ? record.abstract : null
    }));
  }
  return entries;
}

function exportCsl(
  entry: BibliographyEntry,
  normalizedFields: ReturnType<typeof bibliographyCodec.parse>['entries'][number]['normalizedFields']
): Record<string, unknown> {
  if (entry.csl === null && !(entry.entryType in BIB_TYPES)) {
    researchJobError(`research_bibliography_type_unsupported:${entry.entryType}`);
  }
  const item: Record<string, unknown> = entry.csl !== null ? structuredClone(entry.csl) : { type: BIB_TYPES[entry.entryType] };
  item.id = entry.citationKey;
  item.title = entry.title;
  if ('citation-key' in item) {
    item['citation-key'] = entry.citationKey;
  }
  for (const role of ['author', 'editor', 'translator']) {
    const sourceCreators = (normalizedFields as Record<string, unknown>)[role];
    const names = bibliographyCreatorNames(sourceCreators);
    const people = bibliographyCreatorsToCsl(sourceCreators);
    const originalPeople = item[role] ?? [];
    cslAuthorField(originalPeople);
    const original = cslCreatorNames(originalPeople);
    if (people.length > 0 && names.join('\0') !== original.join('\0')) {
      item[role] = people;
    } else if (people.length === 0) {
      delete item[role];
    }
  }
  for (const [cslName, bibName] of Object.entries(CSL_FIELDS)) {
    const value = entry.fields[bibName];
    if (value !== undefined) {
      item[cslName] = bibName === 'doi' || bibName === 'url'
        ? decodeUri(value)
        : bibliographyFieldText(normalizedFields, bibName) ?? value;
    }
  }
  journalTitle(entry.fields);
  const container = BOOK_CONTAINERS.has(String(item.type))
    ? bibliographyFieldText(normalizedFields, 'booktitle') ?? entry.fields.booktitle
    : bibliographyFieldText(normalizedFields, 'journaltitle') ?? bibliographyFieldText(normalizedFields, 'journal') ?? journalTitle(entry.fields);
  if (container !== undefined) {
    item['container-title'] = container;
  }
  const issued = bibDate(entry.fields, normalizedFields, entry.publishedYear);
  if (issued !== null) {
    const original = item.issued;
    if (typeof original === 'object' && original !== null && JSON.stringify((original as Record<string, unknown>)['date-parts']) === JSON.stringify(issued['date-parts'])) {
      item.issued = { ...original as Record<string, unknown>, ...issued };
    } else {
      item.issued = issued;
    }
  }
  return item;
}

function brace(value: string): string {
  return `{${value}}`;
}

function collectPreambles(entries: BibliographyEntry[]): string[] {
  const preambles: string[] = [];
  const maximumCounts = new Map<string, number>();
  for (const entry of entries) {
    const entryCounts = new Map<string, number>();
    for (const preamble of entry.preambles) {
      const count = (entryCounts.get(preamble) ?? 0) + 1;
      entryCounts.set(preamble, count);
      if (count > (maximumCounts.get(preamble) ?? 0)) {
        preambles.push(preamble);
        maximumCounts.set(preamble, count);
      }
    }
  }
  return preambles;
}

function writeBib(entries: BibliographyEntry[], format: 'bibtex' | 'biblatex'): string {
  const preambles = collectPreambles(entries);
  const blocks = [
    ...preambles.map((value) => `@preamble{${brace(value)}}`),
    ...entries.map((entry) => {
      const fields = { ...entry.fields };
      const journal = journalTitle(fields);
      if ('journal' in fields || 'journaltitle' in fields) {
        delete fields.journal;
        delete fields.journaltitle;
        if (journal !== undefined) {
          fields[format === 'bibtex' ? 'journal' : 'journaltitle'] = journal;
        }
      }
      const body = Object.entries(fields).map(([key, value]) => `\t${key} = ${brace(value)}`).join(',\n');
      return `@${entry.entryType}{${citationKey(entry.citationKey)},\n${body}\n}`;
    })
  ];
  return `${blocks.join('\n\n')}\n`;
}

function parseBibOutput(text: string, expected: BibliographyEntry[]): ReturnType<typeof bibliographyCodec.parse> {
  let parsed: ReturnType<typeof bibliographyCodec.parse>;
  try {
    parsed = bibliographyCodec.parse(text);
  } catch {
    researchJobError('research_bibliography_export_invalid');
  }
  if (parsed.entries.length !== expected.length || parsed.entries.some((entry, index) => entry.citationKey !== expected[index].citationKey)) {
    researchJobError('research_bibliography_export_invalid');
  }
  return parsed;
}

export function writeBibliography(entries: BibliographyEntry[], format: BibliographyFormat): string {
  if (!['bibtex', 'biblatex', 'csl-json'].includes(format)) {
    researchJobError('research_bibliography_format_invalid');
  }
  if (entries.length < 1 || entries.length > MAX_ENTRIES) {
    researchJobError('research_bibliography_entry_count_invalid');
  }
  if (new Set(entries.map((entry) => entry.citationKey)).size !== entries.length) {
    researchJobError('research_citation_key_duplicate');
  }
  for (const entry of entries) {
    journalTitle(entry.fields);
    researchBibliographyEntrySchema.parse(entry);
  }
  const outputFormat = format === 'csl-json' ? 'biblatex' : format;
  const output = writeBib(entries, outputFormat);
  const restored = parseBibOutput(output, entries);
  if (format === 'csl-json') {
    return `${JSON.stringify(entries.map((entry, index) => exportCsl(entry, restored.entries[index].normalizedFields)), null, 2)}\n`;
  }
  return output;
}

export function normalizeBibliographyRecords(records: unknown): BibliographyEntry[] {
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_ENTRIES) {
    researchJobError('research_bibliography_entry_count_invalid');
  }
  return records.map((record) => {
    if (typeof record !== 'object' || record === null || !('metadata' in record)) {
      researchJobError('research_bibliography_entry_count_invalid');
    }
    const metadata = (record as { metadata: Record<string, unknown>; citationKey: string }).metadata;
    const fields: Record<string, string> = { title: encodeLatex(requiredText(metadata.title, 'research_bibliography_title_required')) };
    const authors = metadata.authors;
    if (!Array.isArray(authors)) {
      researchJobError('research_bibliography_authors_invalid');
    }
    if (authors.length > 0) {
      fields.author = authors.map((name) => `{${encodeLatex(requiredText(name, 'research_bibliography_authors_invalid'))}}`).join(' and ');
    }
    const abstract = metadata.abstract === null || metadata.abstract === undefined
      ? null
      : requiredText(metadata.abstract, 'research_bibliography_abstract_invalid');
    for (const name of ['doi', 'url', 'abstract'] as const) {
      const value = metadata[name];
      if (value !== null && value !== undefined) {
        const text = requiredText(value, `research_bibliography_${name}_invalid`);
        fields[name] = name === 'doi' || name === 'url' ? text : encodeLatex(text);
      }
    }
    if (metadata.publishedYear !== null && metadata.publishedYear !== undefined) {
      if (typeof metadata.publishedYear !== 'number' || !Number.isInteger(metadata.publishedYear)) {
        researchJobError('research_bibliography_year_invalid');
      }
      fields.year = String(metadata.publishedYear);
    }
    return entryRecord((record as { citationKey: string }).citationKey, 'misc', fields, [], null, {
      title: requiredText(metadata.title, 'research_bibliography_title_required'),
      authors: authors.map((name) => requiredText(name, 'research_bibliography_authors_invalid')),
      abstract
    });
  });
}

async function readUtf8(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_BYTES) {
    researchJobError('research_bibliography_too_large');
  }
  return bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0).toString('utf8');
}

export async function readResearchBibliography(input: {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  format: BibliographyFormat;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ entries: BibliographyEntry[]; sourceHash: string }> {
  return await runResearchJob({ ...input, maxSourceBytes: MAX_BYTES, timeoutMs: input.timeoutMs ?? 60_000 }, async (job) => {
    const text = await readUtf8(job.source);
    const entries = input.format === 'csl-json' ? readCsl(text) : readBibtex(text);
    return { entries };
  });
}

export async function normalizeResearchBibliography(input: {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ entries: BibliographyEntry[]; sourceHash: string }> {
  return await runResearchJob({ ...input, maxSourceBytes: MAX_BYTES, timeoutMs: input.timeoutMs ?? 60_000 }, async (job) => {
    const text = await readUtf8(job.source);
    let records: unknown;
    try {
      records = JSON.parse(text) as unknown;
    } catch {
      researchJobError('research_json_invalid');
    }
    return { entries: normalizeBibliographyRecords(records) };
  });
}

export async function writeResearchBibliography(input: {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  format: BibliographyFormat;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ filename: string; content: string; sourceHash: string }> {
  return await runResearchJob({ ...input, maxSourceBytes: MAX_BYTES, timeoutMs: input.timeoutMs ?? 60_000 }, async (job) => {
    const text = await readUtf8(job.source);
    let entries: unknown;
    try {
      entries = JSON.parse(text) as unknown;
    } catch {
      researchJobError('research_json_invalid');
    }
    if (!Array.isArray(entries)) {
      researchJobError('research_bibliography_entry_count_invalid');
    }
    const content = writeBibliography(entries as BibliographyEntry[], input.format);
    const filename = input.format === 'csl-json' ? 'references.json' : 'references.bib';
    await mkdir(job.output, { recursive: true });
    await writeFile(join(job.output, filename), content, { encoding: 'utf8', flag: 'wx' });
    return { filename, content };
  });
}
