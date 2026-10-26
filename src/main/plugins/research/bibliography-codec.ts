import { Parser } from 'htmlparser2';
import { parse, parseVerbatim, type Creator, type Fields } from '@retorquere/bibtex-parser';

export class BibliographyCodecError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BibliographyCodecError';
  }
}

export type BibliographyCodecEntry = {
  citationKey: string;
  entryType: string;
  fields: Record<string, string>;
  normalizedFields: Fields;
};

export type BibliographyCodecResult = {
  preambles: string[];
  entries: BibliographyCodecEntry[];
};

export type BibliographyCodec = {
  parse(input: string): BibliographyCodecResult;
};

const CREATOR_FIELDS = [
  'author', 'bookauthor', 'collaborator', 'commentator', 'director', 'editor', 'editora', 'editorb', 'editors', 'holder', 'scriptwriter', 'translator'
];

function parseFailureCode(input: string, errors: Array<{ error: string; input?: string }>): string {
  const lines = errors.flatMap(({ input: snippet }) => {
    if (typeof snippet !== 'string' || snippet.length === 0) {
      return [];
    }
    const index = input.indexOf(snippet);
    return index < 0 ? [] : [input.slice(0, index).split('\n').length];
  });
  const uniqueLines = [...new Set(lines)].slice(0, 10);
  return uniqueLines.length > 0
    ? `research_bibliography_parse_failed:lines=${uniqueLines.join(',')}`
    : 'research_bibliography_parse_failed';
}

function assertNoParseErrors(input: string, errors: Array<{ error: string; input?: string }>): void {
  if (errors.length > 0) {
    throw new BibliographyCodecError(parseFailureCode(input, errors));
  }
}

function assertNoStructuralParseErrors(input: string, errors: Array<{ error: string; input?: string }>): void {
  assertNoParseErrors(input, errors.filter(({ error }) => !/^unhandled (?:macro|environment) /u.test(error)));
}

function parsePreamble(expression: string, strings: Record<string, string>, index: number): string {
  const parsed = parseVerbatim(`@misc{roc-preamble-${index}, value=${expression}}`, { strings });
  assertNoParseErrors(expression, parsed.errors);
  const value = parsed.entries[0]?.fields.value;
  if (parsed.entries.length !== 1 || typeof value !== 'string') {
    throw new BibliographyCodecError('research_bibliography_parse_failed');
  }
  return value;
}

function fieldDuplicate(fields: Record<string, string>): boolean {
  return Object.keys(fields).some((field) => /\+duplicate-\d+$/u.test(field));
}

function validateCreatorFields(raw: Record<string, string>, normalized: Fields): void {
  const parsedFields = normalized as unknown as Record<string, unknown>;
  for (const name of CREATOR_FIELDS) {
    if (!(raw[name]?.trim())) {
      continue;
    }
    const creators = parsedFields[name];
    if (!Array.isArray(creators) || creators.length === 0 || creators.some((creator) => {
      if (typeof creator !== 'object' || creator === null) {
        return true;
      }
      const person = creator as Creator;
      return ![person.name, person.lastName].some((part) => typeof part === 'string' && part.trim().length > 0);
    })) {
      throw new BibliographyCodecError(name === 'author' ? 'research_bibliography_authors_invalid' : 'research_bibliography_fields_invalid');
    }
  }
}

export const bibliographyCodec: BibliographyCodec = {
  parse(input) {
    try {
      const raw = parseVerbatim(input);
      assertNoParseErrors(input, raw.errors);
      if (raw.entries.some((entry) => fieldDuplicate(entry.fields))) {
        throw new BibliographyCodecError('research_bibliography_fields_invalid');
      }

      const normalized = parse(input, {
        raw: false,
        sentenceCase: false,
        applyCrossRef: false
      });
      assertNoStructuralParseErrors(input, normalized.errors);
      if (raw.entries.length !== normalized.entries.length) {
        throw new BibliographyCodecError('research_bibliography_parse_failed');
      }

      const entries = raw.entries.map((entry, index): BibliographyCodecEntry => {
        const decoded = normalized.entries[index];
        if (decoded === undefined || decoded.key !== entry.key || decoded.type.toLowerCase() !== entry.type.toLowerCase()) {
          throw new BibliographyCodecError('research_bibliography_parse_failed');
        }
        validateCreatorFields(entry.fields, decoded.fields);
        return {
          citationKey: entry.key,
          entryType: entry.type.toLowerCase(),
          fields: { ...entry.fields },
          normalizedFields: decoded.fields
        };
      });

      return {
        preambles: raw.preambles.map((expression, index) => parsePreamble(expression, raw.strings, index)),
        entries
      };
    } catch (error) {
      if (error instanceof BibliographyCodecError) {
        throw error;
      }
      throw new BibliographyCodecError('research_bibliography_parse_failed');
    }
  }
};

function plainText(value: string): string {
  const chunks: string[] = [];
  const parser = new Parser({
    onopentag(name) {
      if (name === 'br' || name === 'p' || name === 'li') {
        chunks.push(' ');
      }
    },
    onclosetag(name) {
      if (name === 'p' || name === 'li') {
        chunks.push(' ');
      }
    },
    ontext(text) {
      chunks.push(text);
    }
  });
  parser.end(value);
  return chunks.join('').replace(/\s+/gu, ' ').trim().normalize('NFC');
}

export function bibliographyFieldText(fields: Fields, name: string): string | undefined {
  const value = (fields as Record<string, unknown>)[name];
  if (typeof value === 'string') {
    return plainText(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => plainText(item)).join(', ');
  }
  return undefined;
}

function creatorName(creator: Creator): string {
  if (typeof creator.name === 'string') {
    return plainText(creator.name);
  }
  return [creator.firstName, creator.prefix, creator.lastName, creator.suffix]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map(plainText)
    .join(' ');
}

export function bibliographyCreatorNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((creator): creator is Creator => typeof creator === 'object' && creator !== null)
    .map(creatorName)
    .filter((name) => name.length > 0);
}

export function bibliographyCreatorsToCsl(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((creator): Array<Record<string, string>> => {
    if (typeof creator !== 'object' || creator === null) {
      return [];
    }
    const person = creator as Creator;
    if (typeof person.name === 'string') {
      const literal = plainText(person.name);
      return literal.length > 0 ? [{ literal }] : [];
    }
    const fields: Record<string, string> = {};
    const family = typeof person.lastName === 'string' ? plainText(person.lastName) : '';
    const given = typeof person.firstName === 'string' ? plainText(person.firstName) : '';
    const particle = typeof person.prefix === 'string' ? plainText(person.prefix) : '';
    const suffix = typeof person.suffix === 'string' ? plainText(person.suffix) : '';
    if (family.length > 0) fields.family = family;
    if (given.length > 0) fields.given = given;
    if (particle.length > 0) fields['non-dropping-particle'] = particle;
    if (suffix.length > 0) fields.suffix = suffix;
    return Object.keys(fields).length > 0 ? [fields] : [];
  });
}
