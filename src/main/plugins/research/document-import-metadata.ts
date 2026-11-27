import type {ResearchBibliographyEntry, ResearchLiterature} from '../../../shared/types';
import {literatureIdentityAliases, normalizeResearchArxiv, normalizeResearchDoi} from './literature-identity';
import {extractResearchPdfPageText, withResearchPdf} from './pdf-render';

export type DocumentImportEntry = {metadata: ResearchLiterature; bibliography: ResearchBibliographyEntry};
export type DocumentDoiPreparation = (doi: string, projectId: string | null, signal: AbortSignal) => Promise<DocumentImportEntry>;
export type DocumentImportMetadata = {
  title: string | null; authors: string[]; doi: string | null; arxivId: string | null; publishedYear: number | null;
};

const emptyMetadata = (): DocumentImportMetadata => ({title: null, authors: [], doi: null, arxivId: null, publishedYear: null});
const maximumMetadataText = 16_384;

/** Read source metadata before creating a library item; PDF.js must never transfer the original source buffer. */
export async function inspectPdfImportMetadata(input: Uint8Array | URL, signal: AbortSignal): Promise<DocumentImportMetadata> {
  signal.throwIfAborted();
  try {
    return await withResearchPdf(input instanceof URL ? input : Uint8Array.from(input), async pdf => {
      signal.throwIfAborted();
      const {info, metadata} = await pdf.getMetadata();
      const fields = new Map<string, unknown>();
      if (typeof info === 'object' && info !== null) {
        for (const [name, value] of Object.entries(info)) fields.set(name.toLowerCase(), value);
        const custom = (info as Record<string, unknown>).Custom;
        if (custom instanceof Map) {
          for (const [name, value] of custom) if (typeof name === 'string') fields.set(name.toLowerCase(), value);
        }
      }
      if (metadata !== null) {
        for (const candidate of metadata as Iterable<unknown>) {
          if (Array.isArray(candidate) && typeof candidate[0] === 'string') fields.set(candidate[0].toLowerCase(), candidate[1]);
        }
      }
      const title = firstTitle(fields.get('dc:title')) ?? firstTitle(fields.get('title'));
      const xmpAuthors = authorNames(fields.get('dc:creator'));
      const authors = xmpAuthors.length ? xmpAuthors : authorNames(fields.get('author'));
      const dois = new Set<string>(), arxivIds = new Set<string>(), years = new Set<number>();
      for (const [name, value] of fields) {
        const key = name.replace(/[\s_-]/gu, '');
        if (['doi', 'prism:doi', 'bibo:doi', 'crossref:doi', 'citationdoi', 'dc:identifier'].includes(key)) {
          for (const candidate of stringValues(value)) addDoi(dois, candidate);
        }
        if (['arxiv', 'arxivid', 'arxiv:id', 'citationarxivid'].includes(key)) {
          for (const candidate of stringValues(value)) addArxiv(arxivIds, candidate);
        }
        if (key === 'dc:identifier') {
          for (const candidate of stringValues(value)) {
            if (/^(?:arxiv\s*:|https?:\/\/(?:www\.)?arxiv\.org\/abs\/)/iu.test(candidate)) addArxiv(arxivIds, candidate);
          }
        }
        if (['subject', 'keywords', 'dc:description'].includes(key)) {
          for (const candidate of stringValues(value)) {
            addLabelledDois(dois, candidate);
            addLabelledArxivIds(arxivIds, candidate);
          }
        }
        // PDF CreationDate/ModDate and generic dc:date are not publication dates.
        if (['publicationyear', 'publishedyear', 'publicationdate', 'prism:publicationdate', 'prism:coverdate'].includes(key)) {
          for (const candidate of stringValues(value)) {
            const match = /^([12]\d{3})(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?$/u.exec(candidate);
            if (match !== null) years.add(Number(match[1]));
          }
        }
      }
      if (pdf.numPages > 0) {
        const page = await pdf.getPage(1);
        try {
          signal.throwIfAborted();
          const text = (await extractResearchPdfPageText(page, 1)).slice(0, maximumMetadataText);
          const header = text.split(/(?:^|\n)\s*(?:abstract|(?:\d+\.?\s+)?introduction|(?:\d+\.?\s+)?references|bibliography)\b/iu, 1)[0];
          // Only standalone, labelled identifiers before article sections qualify; references and body mentions do not.
          for (const line of header.split('\n')) {
            if (/^\s*(?:doi\s*:|https?:\/\/(?:dx\.)?doi\.org\/)/iu.test(line)) addLabelledDois(dois, line);
            if (/^\s*(?:arxiv\s*:|https?:\/\/(?:www\.)?arxiv\.org\/abs\/)/iu.test(line)) addLabelledArxivIds(arxivIds, line);
          }
        } catch {
          signal.throwIfAborted();
        } finally {page.cleanup();}
      }
      signal.throwIfAborted();
      let doi = dois.size === 1 ? [...dois][0] : null;
      // An ambiguous DOI cannot be bypassed by falling back to an arXiv lookup.
      let arxivId = dois.size > 1 || arxivIds.size !== 1 ? null : [...arxivIds][0];
      if (doi !== null && arxivId !== null) {
        const doiArxivAlias = literatureIdentityAliases(`doi:${doi}`).find(alias => alias.startsWith('arxiv:'));
        if (doiArxivAlias !== undefined && doiArxivAlias !== `arxiv:${normalizeResearchArxiv(arxivId).id}`) {
          doi = null; arxivId = null;
        }
      }
      return {title, authors, doi, arxivId, publishedYear: years.size === 1 ? [...years][0] : null};
    });
  } catch {
    signal.throwIfAborted();
    return emptyMetadata();
  }
}

function stringValues(value: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? value.slice(0, 100) : [value];
  return values.flatMap(candidate => typeof candidate === 'string' && candidate.length <= maximumMetadataText && candidate.trim() ?
    [candidate.trim()] : []);
}

function firstTitle(value: unknown): string | null {
  for (const candidate of stringValues(value)) {
    const title = candidate.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (title.length <= 1000 && !/^(?:untitled|unknown|none)$/iu.test(title)) return title;
  }
  return null;
}

function authorNames(value: unknown): string[] {
  return [...new Set(stringValues(value).flatMap(candidate => candidate.split(/;|\n|\s+and\s+/iu))
    .map(candidate => candidate.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .filter(candidate => candidate.length > 0 && candidate.length <= 500))].slice(0, 100);
}

function addDoi(dois: Set<string>, candidate: string): void {
  try {dois.add(normalizeResearchDoi(candidate));}
  catch { /* Invalid metadata cannot establish a literature identity. */ }
}

function addLabelledDois(dois: Set<string>, text: string): void {
  for (const match of text.matchAll(/\b(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s<>"']+)/giu)) {
    addDoi(dois, match[1].replace(/[.,;]+$/u, ''));
  }
}

function addArxiv(ids: Set<string>, candidate: string): void {
  try {
    const {id, version} = normalizeResearchArxiv(candidate);
    ids.add(`${id}${version === null ? '' : `v${version}`}`);
  } catch { /* Invalid metadata cannot establish an arXiv identity. */ }
}

function addLabelledArxivIds(ids: Set<string>, text: string): void {
  for (const match of text.matchAll(/\b(?:arxiv\s*:\s*|https?:\/\/(?:www\.)?arxiv\.org\/abs\/)([^\s<>"']+)/giu)) {
    addArxiv(ids, match[1].replace(/[.,;]+$/u, ''));
  }
}
