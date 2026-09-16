import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { researchBibliographyEntrySchema, researchBibliographyFormatSchema } from '../../../shared/schemas/research-library';
import { ResearchProcessError } from './process-runner';
import { researchJobError, runResearchJob } from './research-job';

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
const PARTICLES = new Set(['von', 'van', 'de', 'der', 'den', 'la', 'le', 'du', 'del', 'della', 'ter', 'ten', 'bin', 'ibn', 'da', 'das', 'do', 'dos']);

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

export function decodeLatex(value: string): string {
  let index = 0;
  const parse = (stop: string | null): string => {
    let output = '';
    while (index < value.length) {
      const current = value[index];
      if (stop !== null && current === stop) {
        index += 1;
        break;
      }
      if (current === '{') {
        index += 1;
        output += parse('}');
        continue;
      }
      if (current === '\\' && index + 1 < value.length) {
        const next = value[index + 1];
        if ('%&#_{}$'.includes(next)) {
          output += next;
          index += 2;
          continue;
        }
        index += 1;
        while (index < value.length && /[A-Za-z]/u.test(value[index])) {
          index += 1;
        }
        if (value[index] === '*') {
          index += 1;
        }
        while (index < value.length && value[index] === ' ') {
          index += 1;
        }
        if (value[index] === '{') {
          index += 1;
          parse('}');
        }
        continue;
      }
      if (current === '&') {
        output += '     ';
        index += 1;
        continue;
      }
      output += current;
      index += 1;
    }
    return output;
  };
  return parse(null).trim();
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

type NameParts = { first: string[]; von: string[]; last: string[]; jr: string[]; literal: boolean };

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < value.length; ) {
    if (value[index] === '{') {
      depth += 1;
      current += value[index];
      index += 1;
      continue;
    }
    if (value[index] === '}') {
      depth = Math.max(0, depth - 1);
      current += value[index];
      index += 1;
      continue;
    }
    if (depth === 0 && value.slice(index, index + separator.length) === separator) {
      parts.push(current);
      current = '';
      index += separator.length;
      continue;
    }
    current += value[index];
    index += 1;
  }
  parts.push(current);
  return parts;
}

function parsePerson(raw: string): NameParts {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}') && !trimmed.slice(1, -1).includes('}')) {
    return { first: [], von: [], last: [trimmed], jr: [], literal: true };
  }
  const comma = splitTopLevel(trimmed, ',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (comma.length >= 2) {
    const lastTokens = comma[0].split(/\s+/u).filter(Boolean);
    let von: string[] = [];
    let last = lastTokens;
    const firstParticle = lastTokens.findIndex((token) => PARTICLES.has(token.toLowerCase()));
    if (firstParticle !== -1) {
      von = lastTokens.slice(firstParticle, firstParticle + 1);
      last = [...lastTokens.slice(0, firstParticle), ...lastTokens.slice(firstParticle + 1)];
      if (last.length === 0) {
        last = lastTokens.slice(-1);
        von = lastTokens.slice(0, -1);
      }
    }
    const jr = comma.length >= 3 ? [comma[1]] : [];
    const first = splitTopLevel(comma[comma.length >= 3 ? 2 : 1], ' ').map((part) => part.trim()).filter(Boolean);
    return { first, von, last, jr, literal: false };
  }
  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  return { first: tokens.slice(0, -1), von: [], last: tokens.slice(-1), jr: [], literal: false };
}

function authorNames(value: string): { names: string[]; people: Array<Record<string, string>> } {
  if (value.trim().length === 0) {
    return { names: [], people: [] };
  }
  const names: string[] = [];
  const people: Array<Record<string, string>> = [];
  for (const raw of splitTopLevel(value, ' and ')) {
    const person = parsePerson(raw);
    const family = decodeLatex(person.last.join(' '));
    const given = decodeLatex(person.first.join(' '));
    const particle = decodeLatex(person.von.join(' '));
    const suffix = decodeLatex(person.jr.join(' '));
    const name = [given, particle, family, suffix].filter((part) => part.length > 0).join(' ');
    if (name.length === 0) {
      researchJobError('research_bibliography_authors_invalid');
    }
    names.push(name);
    people.push(person.literal ? { literal: family } : Object.fromEntries(
      [['given', given], ['family', family], ['non-dropping-particle', particle], ['suffix', suffix]].filter(([, part]) => part.length > 0)
    ));
  }
  return { names, people };
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

function entryRecord(key: string, entryType: string, fields: Record<string, string>, preambles: string[], csl: Record<string, unknown> | null): BibliographyEntry {
  const title = decodeLatex(requiredText(fields.title, 'research_bibliography_title_required'));
  if (title.length === 0) {
    researchJobError('research_bibliography_title_required');
  }
  const authors = authorNames(fields.author ?? '').names;
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
    abstract: fields.abstract ? decodeLatex(fields.abstract) : null,
    url: fields.url ? decodeUri(fields.url) : null
  };
}

function journalTitle(fields: Record<string, string>): string | undefined {
  const values = ['journaltitle', 'journal'].map((key) => fields[key]).filter((value) => typeof value === 'string' && value.trim().length > 0);
  if (new Set(values).size > 1) {
    researchJobError('research_bibliography_journal_conflict');
  }
  return values[0];
}

function bibDate(fields: Record<string, string>, year: number | null): Record<string, unknown> | null {
  if (fields.date) {
    const raw = decodeLatex(fields.date);
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
    const month = decodeLatex(fields.month).toLowerCase();
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

class BibParser {
  constructor(private readonly text: string, private index = 0, readonly failedLines: number[] = []) {}

  line(): number {
    return this.text.slice(0, this.index).split('\n').length;
  }

  peek(): string {
    return this.text[this.index] ?? '';
  }

  skip(): void {
    while (this.index < this.text.length) {
      const current = this.text[this.index];
      if (/\s/u.test(current)) {
        this.index += 1;
        continue;
      }
      if (current === '%') {
        while (this.index < this.text.length && this.text[this.index] !== '\n') {
          this.index += 1;
        }
        continue;
      }
      break;
    }
  }

  takeUntil(pattern: RegExp): string {
    const start = this.index;
    while (this.index < this.text.length && !pattern.test(this.text[this.index])) {
      this.index += 1;
    }
    return this.text.slice(start, this.index);
  }

  braced(): string {
    if (this.peek() !== '{') {
      throw new Error('missing_brace');
    }
    let depth = 0;
    const start = this.index;
    do {
      if (this.text[this.index] === '{') {
        depth += 1;
      } else if (this.text[this.index] === '}') {
        depth -= 1;
      } else if (this.text[this.index] === '\\') {
        this.index += 1;
      }
      this.index += 1;
    } while (this.index < this.text.length && depth > 0);
    if (depth !== 0) {
      throw new Error('unbalanced');
    }
    return this.text.slice(start + 1, this.index - 1);
  }

  quoted(): string {
    this.index += 1;
    let output = '';
    while (this.index < this.text.length && this.text[this.index] !== '"') {
      if (this.text[this.index] === '\\') {
        output += this.text[this.index];
        this.index += 1;
      }
      output += this.text[this.index] ?? '';
      this.index += 1;
    }
    if (this.text[this.index] !== '"') {
      throw new Error('unbalanced');
    }
    this.index += 1;
    return output;
  }

  value(strings: Map<string, string>): string {
    const chunks: string[] = [];
    for (;;) {
      this.skip();
      if (this.peek() === '{') {
        chunks.push(this.braced());
      } else if (this.peek() === '"') {
        chunks.push(this.quoted());
      } else if (/[0-9]/u.test(this.peek())) {
        chunks.push(this.takeUntil(/[^0-9]/u));
      } else if (/[A-Za-z]/u.test(this.peek())) {
        const name = this.takeUntil(/[^A-Za-z0-9_:-]/u);
        chunks.push(strings.get(name.toLowerCase()) ?? name);
      } else {
        throw new Error('value');
      }
      this.skip();
      if (this.peek() === '#') {
        this.index += 1;
        continue;
      }
      return chunks.join('');
    }
  }

  parse(): { preambles: string[]; entries: BibliographyEntry[] } {
    const strings = new Map<string, string>();
    const preambles: string[] = [];
    const entries: BibliographyEntry[] = [];
    while (this.index < this.text.length) {
      this.skip();
      if (this.index >= this.text.length) {
        break;
      }
      if (this.peek() !== '@') {
        this.failedLines.push(this.line());
        this.index += 1;
        continue;
      }
      const startLine = this.line();
      try {
        this.index += 1;
        const type = this.takeUntil(/[^A-Za-z]/u).toLowerCase();
        this.skip();
        const closer = this.peek() === '(' ? ')' : this.peek() === '{' ? '}' : '';
        if (closer.length === 0) {
          throw new Error('entry');
        }
        this.index += 1;
        this.skip();
        if (type === 'comment') {
          if (this.peek() === '{') {
            this.braced();
          } else {
            this.takeUntil(new RegExp(`[${closer}]`));
            this.index += 1;
          }
          continue;
        }
        if (type === 'preamble') {
          const value = this.peek() === '"' ? this.quoted() : this.peek() === '{' ? this.braced() : this.value(strings);
          this.skip();
          if (this.peek() === closer) {
            this.index += 1;
          }
          preambles.push(value);
          continue;
        }
        if (type === 'string') {
          const name = this.takeUntil(/[^A-Za-z0-9_]/u).toLowerCase();
          this.skip();
          if (this.peek() !== '=') {
            throw new Error('string');
          }
          this.index += 1;
          strings.set(name, this.value(strings));
          this.skip();
          if (this.peek() === closer) {
            this.index += 1;
          }
          continue;
        }
        const key = this.takeUntil(/[,}\s]/u);
        this.skip();
        if (this.peek() === ',') {
          this.index += 1;
        }
        const fields: Record<string, string> = {};
        while (this.index < this.text.length) {
          this.skip();
          if (this.peek() === closer || this.peek() === '') {
            break;
          }
          const field = this.takeUntil(/[^A-Za-z0-9_:-]/u).toLowerCase();
          this.skip();
          if (this.peek() !== '=') {
            throw new Error('field');
          }
          this.index += 1;
          if (field in fields) {
            researchJobError('research_bibliography_fields_invalid');
          }
          fields[field] = this.value(strings);
          this.skip();
          if (this.peek() === ',') {
            this.index += 1;
          }
        }
        if (this.peek() !== closer) {
          throw new Error('unbalanced');
        }
        this.index += 1;
        entries.push(entryRecord(key, type, fields, preambles, null));
      } catch (error) {
        if (error instanceof ResearchProcessError) {
          throw error;
        }
        this.failedLines.push(startLine);
        while (this.index < this.text.length && this.text[this.index] !== '@') {
          this.index += 1;
        }
      }
    }
    return { preambles, entries };
  }
}

export function readBibtex(text: string): BibliographyEntry[] {
  const parser = new BibParser(text);
  const parsed = parser.parse();
  if (parser.failedLines.length > 0) {
    researchJobError(`research_bibliography_parse_failed:lines=${parser.failedLines.slice(0, 10).join(',')}`);
  }
  if (parsed.entries.length === 0 || parsed.entries.length > MAX_ENTRIES) {
    researchJobError('research_bibliography_entry_count_invalid');
  }
  return parsed.entries.map((entry) => ({ ...entry, preambles: parsed.preambles }));
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
    entries.push(entryRecord(key, CSL_TYPES[cslType], fields, [], structuredClone(record)));
  }
  return entries;
}

function exportCsl(entry: BibliographyEntry): Record<string, unknown> {
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
    const { names, people } = authorNames(entry.fields[role] ?? '');
    const original = authorNames(cslAuthorField((item[role] ?? []) as unknown[])).names;
    if (people.length > 0 && names.join('\0') !== original.join('\0')) {
      item[role] = people;
    } else if (people.length === 0) {
      delete item[role];
    }
  }
  for (const [cslName, bibName] of Object.entries(CSL_FIELDS)) {
    const value = entry.fields[bibName];
    if (value !== undefined) {
      item[cslName] = bibName === 'doi' || bibName === 'url' ? decodeUri(value) : decodeLatex(value);
    }
  }
  const container = BOOK_CONTAINERS.has(String(item.type)) ? entry.fields.booktitle : journalTitle(entry.fields);
  if (container !== undefined) {
    item['container-title'] = decodeLatex(container);
  }
  const issued = bibDate(entry.fields, entry.publishedYear);
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

function writeBib(entries: BibliographyEntry[], format: 'bibtex' | 'biblatex'): string {
  const preambles = [...new Set(entries.flatMap((entry) => entry.preambles))];
  const blocks = [
    ...preambles.map((value) => `@preamble{"${value.replaceAll('"', '\\"')}"}`),
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
  if (format === 'csl-json') {
    return `${JSON.stringify(entries.map((entry) => exportCsl(entry)), null, 2)}\n`;
  }
  const output = writeBib(entries, format);
  const restored = new BibParser(output);
  restored.parse();
  if (restored.failedLines.length > 0) {
    researchJobError('research_bibliography_export_invalid');
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
    return entryRecord((record as { citationKey: string }).citationKey, 'misc', fields, [], null);
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
