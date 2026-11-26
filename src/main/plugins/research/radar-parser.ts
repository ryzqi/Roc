import {createHash} from 'node:crypto';
import {XMLParser, XMLValidator} from 'fast-xml-parser';
import {Parser} from 'htmlparser2';
import {z} from 'zod';
import type {RadarArticle} from '../../../shared/schemas/research-reading';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const string = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : typeof object(value)['#text'] === 'string' ? String(object(value)['#text']) : '';
export function plainArticleText(html: string): string {
  const chunks: string[] = []; let hidden = 0;
  const parser = new Parser({onopentag(name) {if (['script','style'].includes(name)) hidden++; if (['p','br','div'].includes(name)) chunks.push('\n');},
    ontext(text) {if (!hidden) chunks.push(text);}, onclosetag(name) {if (['script','style'].includes(name)) hidden = Math.max(0,hidden-1);}}, {decodeEntities: true});
  parser.write(html); parser.end(); return chunks.join('').replace(/[ \t]+/gu,' ').replace(/\n{3,}/gu,'\n\n').trim();
}
export function parseRadarFeed(xml: string, feedId: string, sourceUrl: string): RadarArticle[] {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('来源不是有效的 RSS/Atom 文档。');
  const root = object(new XMLParser({ignoreAttributes: false, removeNSPrefix: true, processEntities: false, parseTagValue: false}).parse(xml));
  const atom = root.feed !== undefined, channel = atom ? object(root.feed) : object(object(root.rss).channel);
  if (!atom && root.rss === undefined) throw new Error('仅支持 RSS 2.0 与 Atom 订阅。');
  return array(atom ? channel.entry : channel.item).slice(0,500).flatMap(raw => {
    const row = object(raw), title = plainArticleText(string(row.title));
    const link = atom ? array(row.link).map(object).find(link => link['@_rel'] === 'alternate' || link['@_rel'] === undefined)?.['@_href'] : row.link;
    const identity = string(row.id ?? row.guid) || string(link);
    let url: URL;
    try {url = new URL(string(link) || identity, sourceUrl);} catch {return [];}
    if (!['https:','http:'].includes(url.protocol) || !title || !identity) return [];
    const arxivId = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?$/iu.exec(url.href)?.[1] ?? null;
    const summary = plainArticleText(string(row.summary ?? row.description ?? row.content ?? row.encoded)).slice(0,60000);
    const date = string(row.published ?? row.pubDate ?? row.updated ?? row.date);
    const doi = string(row.doi) || /https?:\/\/(?:dx\.)?doi\.org\/(10\.[^\s<]+)/iu.exec(`${url.href} ${summary}`)?.[1] || null;
    return [{id: createHash('sha256').update(`${feedId}\n${identity}`).digest('hex'), feedId, title, url: url.href, summary,
      authors: array(row.author ?? row.creator).map(value => string(object(value).name ?? value)).filter(Boolean),
      publishedAt: date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null,
      arxivId, doi, read: false, importedItemId: null, score: null}];
  });
}
const huggingFacePapersSchema = z.array(z.object({paper:z.object({
  id:z.string().regex(/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/u),
  title:z.string().trim().min(1),summary:z.string().optional().default(''),
  authors:z.array(z.object({name:z.string()})).optional().default([]),
  publishedAt:z.string().nullable().optional()
})})).max(500);
export function parseHuggingFacePapers(json: string, feedId: string): RadarArticle[] {
  let input: unknown;
  try {input = JSON.parse(json);} catch {throw new Error('Hugging Face 每日论文响应不是有效的 JSON。');}
  const result = huggingFacePapersSchema.safeParse(input);
  if (!result.success) throw new Error('Hugging Face 每日论文响应格式无效。');
  return result.data.map(({paper}) => {
    const title = plainArticleText(paper.title), identity = paper.id.replace(/v\d+$/u,'');
    if (!title) throw new Error('Hugging Face 每日论文标题为空。');
    return {id:createHash('sha256').update(`${feedId}\n${identity}`).digest('hex'),feedId,title,
      url:`https://huggingface.co/papers/${identity}`,summary:plainArticleText(paper.summary).slice(0,60000),
      pdfUrl:`https://arxiv.org/pdf/${paper.id}`,authors:paper.authors.map(author => plainArticleText(author.name)).filter(Boolean),
      publishedAt:paper.publishedAt && Number.isFinite(Date.parse(paper.publishedAt)) ? new Date(paper.publishedAt).toISOString() : null,
      arxivId:paper.id,doi:null,read:false,importedItemId:null,score:null};
  });
}
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || [...a,...b].some(value => !Number.isFinite(value))) throw new Error('嵌入向量无效。');
  const normA = Math.hypot(...a), normB = Math.hypot(...b);
  if (normA === 0 || normB === 0) throw new Error('嵌入端点返回零向量。');
  return a.reduce((sum,value,index) => sum + value*b[index]!,0) / (normA*normB);
}
