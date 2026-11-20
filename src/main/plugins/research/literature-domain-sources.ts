import {z} from 'zod';
import {parseDocument, DomUtils} from 'htmlparser2';
import {XMLValidator} from 'fast-xml-parser';
import type {ResearchLiterature} from '../../../shared/types';
import type {LiteratureSearchInput} from '../../../shared/schemas/literature-import';
import {normalizeResearchDoi} from './literature-identity';
import {readPublicOpenReviewSearch} from './openreview-adapter';

type DomainSource = 'openreview' | 'acl' | 'dblp' | 'cvf';
type Page = {records: ResearchLiterature[]; total: number | null; nextOffset: number | null};
type Read = (url: string, accept: string) => Promise<string>;
const doi = (value: string | undefined): string | null => value?.trim() ? normalizeResearchDoi(value) : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const base = (source: DomainSource, externalId: string, timestamp: string): ResearchLiterature => ({
  id: `${source}:${externalId}`, source, externalId, doi: null, title: '', authors: [], abstract: null,
  publishedYear: null, citationCount: null, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp
});
const next = (total: number | null, offset: number, count: number, limit: number): number | null =>
  count && (total === null ? count === limit : offset + count < total) ? offset + count : null;

/** Public APIs or official collection snapshots only; no web-search scraping. */
export async function searchDomainSource(
  source: DomainSource, request: LiteratureSearchInput, offset: number, read: Read, timestamp: () => string
): Promise<Page> {
  const {limit, query} = request;
  if (source === 'openreview') {
    const url = new URL('https://api2.openreview.net/notes/search');
    for (const [key, value] of Object.entries({term: query, content: 'all', group: 'all', source: 'forum', limit, offset}))
      url.searchParams.set(key, String(value));
    const page = readPublicOpenReviewSearch(JSON.parse(await read(url.href, 'application/json')), limit);
    const records = page.notes.map(note => {
      const field = (name: string): unknown => {
        const field = note.content[name];
        if (field?.readers !== undefined && !field.readers.includes('everyone')) return undefined;
        return field?.value;
      };
      const title = text(field('title'));
      if (title === null) throw new Error('literature_provider_response_invalid');
      const pdf = text(field('pdf'));
      const published = note.pdate ?? note.cdate ?? note.tcdate;
      const authors = z.array(z.union([z.string(), z.object({fullname: z.string()})])).parse(field('authors') ?? [])
        .map(author => typeof author === 'string' ? author : author.fullname);
      return {...base(source, note.id, timestamp()), title,
        authors, abstract: text(field('abstract')),
        doi: doi(text(field('doi')) ?? undefined),
        publishedYear: published == null ? null : new Date(published).getUTCFullYear(),
        url: `https://openreview.net/forum?id=${encodeURIComponent(note.id)}`,
        openAccessUrl: pdf === null ? null : new URL(pdf, 'https://openreview.net').href};
    });
    return {records, total: page.count, nextOffset: next(page.count, offset, records.length, limit)};
  }
  if (source === 'dblp') {
    const url = new URL('https://dblp.org/search/publ/api');
    for (const [key, value] of Object.entries({q: query, format: 'json', h: limit, f: offset})) url.searchParams.set(key, String(value));
    const author = z.union([z.string(), z.object({text: z.string()})]);
    const payload = z.object({result: z.object({hits: z.object({
      '@total': z.string().regex(/^\d+$/u),
      hit: z.array(z.object({info: z.object({
        key: z.string().min(1), title: z.string().min(1), year: z.string().regex(/^\d{4}$/u).optional(),
        doi: z.string().optional(), url: z.string().url(), authors: z.object({author: z.union([author, z.array(author)])}).optional()
      })})).max(limit).optional()
    })})}).parse(JSON.parse(await read(url.href, 'application/json')));
    const total = Number(payload.result.hits['@total']);
    const records = (payload.result.hits.hit ?? []).map(({info}) => ({
      ...base(source, info.key, timestamp()), title: info.title, doi: doi(info.doi), url: info.url,
      publishedYear: info.year === undefined ? null : Number(info.year),
      authors: array(info.authors?.author).map(author => typeof author === 'string' ? author : author.text)
    }));
    return {records, total, nextOffset: next(total, offset, records.length, limit)};
  }
  const collection = request.collections?.[source];
  if (collection === undefined) throw new Error('literature_collection_scope_required');
  const url = source === 'acl' ? `https://raw.githubusercontent.com/acl-org/acl-anthology/master/data/xml/${collection}.xml` :
    `https://openaccess.thecvf.com/${collection}?day=all`;
  const body = await read(url, source === 'acl' ? 'application/xml, text/xml, text/plain' : 'text/html');
  const all = source === 'acl' ? readAclCollection(body, collection, timestamp()) : readCvfCollection(body, collection, timestamp());
  // Collection-local lexical search; each page slices the same stable, audited snapshot.
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(word => !['acl', 'emnlp', 'cvpr', 'iccv', 'wacv', 'the', 'and', 'of', 'in', 'for'].includes(word) && !/^\d{4}$/u.test(word));
  const ranked = all.map(record => ({record, score: terms.reduce((sum, term) =>
    sum + (record.title.toLowerCase().includes(term) ? 3 : (record.abstract ?? '').toLowerCase().includes(term) ? 1 : 0), 0)}))
    .filter(item => terms.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || a.record.externalId.localeCompare(b.record.externalId));
  const records = ranked.slice(offset, offset + limit).map(item => item.record);
  return {records, total: ranked.length, nextOffset: next(ranked.length, offset, records.length, limit)};
}

/** XML text traversal retains inline title order (fixed-case, italics, math). */
export function readAclCollection(xml: string, collection: string, timestamp: string): ResearchLiterature[] {
  if (XMLValidator.validate(xml) !== true || /<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('literature_provider_response_invalid');
  const document = parseDocument(xml, {xmlMode: true, decodeEntities: true});
  const roots = DomUtils.getElementsByTagName('collection', document.children);
  if (roots.length !== 1 || roots[0].attribs.id !== collection) throw new Error('literature_provider_response_invalid');
  return DomUtils.getElementsByTagName('volume', roots[0].children, false).flatMap(volume => {
    const child = (name: string, parent = volume): string | null => {
      const element = DomUtils.getElementsByTagName(name, parent.children, false)[0];
      return element === undefined ? null : DomUtils.textContent(element).trim();
    };
    const meta = DomUtils.getElementsByTagName('meta', volume.children, false)[0];
    const year = meta === undefined ? null : Number(child('year', meta));
    return DomUtils.getElementsByTagName('paper', volume.children, false).map(paper => {
      const id = /^\d{4}\./u.test(collection) ? `${collection}-${volume.attribs.id}.${paper.attribs.id}` :
        child('url', paper);
      const title = child('title', paper);
      if (!id || !/^[a-zA-Z0-9.-]+$/u.test(id) || !title || !year || !Number.isInteger(year)) throw new Error('literature_provider_response_invalid');
      return {...base('acl', id, timestamp), title, doi: doi(child('doi', paper) ?? undefined), publishedYear: year,
        abstract: child('abstract', paper),
        authors: DomUtils.getElementsByTagName('author', paper.children, false).map(author =>
          [child('first', author), child('last', author)].filter(Boolean).join(' ')),
        url: `https://aclanthology.org/${id}/`,
        openAccessUrl: DomUtils.getElementsByTagName('pdf', paper.children, false).length ? `https://aclanthology.org/${id}.pdf` : null};
    });
  });
}

export function readCvfCollection(html: string, collection: string, timestamp: string): ResearchLiterature[] {
  const document = parseDocument(html);
  const titles = DomUtils.getElementsByTagName('dt', document.children).filter(node => node.attribs.class?.split(/\s/u).includes('ptitle'));
  if (titles.length === 0) throw new Error('literature_provider_response_invalid');
  return titles.map(node => {
    const anchor = DomUtils.getElementsByTagName('a', node.children)[0];
    const url = new URL(anchor?.attribs.href ?? '', 'https://openaccess.thecvf.com');
    if (url.origin !== 'https://openaccess.thecvf.com' || !url.pathname.startsWith(`/content/${collection}/html/`) ||
      !url.pathname.endsWith('.html')) throw new Error('literature_provider_response_invalid');
    const title = DomUtils.textContent(anchor).trim();
    const id = url.pathname.slice(1);
    const siblings = [];
    for (let sibling = node.next; sibling !== null; sibling = sibling.next) {
      if (sibling.type === 'tag' && sibling.name === 'dt') break;
      siblings.push(sibling);
    }
    const expectedPdf = url.href.replace('/html/', '/papers/').replace(/\.html$/u, '.pdf');
    const hasPdf = DomUtils.getElementsByTagName('a', siblings).some(link => {
      try {return new URL(link.attribs.href, url).href === expectedPdf;} catch {return false;}
    });
    return {...base('cvf', id, timestamp), title, publishedYear: Number(collection.slice(-4)), url: url.href,
      authors: DomUtils.getElementsByTagName('input', siblings).filter(input => input.attribs.name === 'query_author')
        .map(input => input.attribs.value).filter((name): name is string => typeof name === 'string' && name.length > 0),
      openAccessUrl: hasPdf ? expectedPdf : null};
  });
}
