import type {
  MemoryKind,
  MemoryScope,
  MemorySearchHit,
  MemorySearchResult
} from '../../../shared/types';
import { parseAutoMemoryEntries, parseUserPreferenceEntries } from './auto-memory-candidates';

export type MemorySearchDocument = {
  path: string;
  scope: MemoryScope;
  kind: MemoryKind | 'topic';
  content: string;
};

type MemoryEntryUnit = {
  path: string;
  scope: MemoryScope;
  kind: MemoryKind | 'topic';
  entryType: string;
  key: string | null;
  text: string;
  /** 参与打分的加权字段：key 命中比正文命中更有意义。 */
  keyText: string;
  summaryText: string;
  bodyText: string;
};

const KEY_WEIGHT = 6;
const SUMMARY_WEIGHT = 3;
const BODY_WEIGHT = 1;
const MAX_SNIPPET_CHARS = 320;

/**
 * 记忆内容是有界的（5 个固定文件加上每个作用域至多 32 个主题文件），
 * 因此检索直接在内存里解析并打分，不额外维护会与 markdown 失步的倒排索引。
 */
export function searchMemoryDocuments(
  documents: readonly MemorySearchDocument[],
  query: string,
  limit: number
): MemorySearchResult {
  const terms = tokenizeQuery(query);
  const units = documents.flatMap((document) => parseDocumentEntries(document));
  if (terms.length === 0) {
    return { query, hits: [], scannedDocuments: documents.length, scannedEntries: units.length };
  }
  const hits: MemorySearchHit[] = [];
  for (const unit of units) {
    const score = scoreUnit(unit, terms);
    if (score <= 0) {
      continue;
    }
    hits.push({
      path: unit.path,
      scope: unit.scope,
      kind: unit.kind,
      entryType: unit.entryType,
      key: unit.key,
      text: truncate(unit.text),
      score
    });
  }
  hits.sort((left, right) => (right.score === left.score ? left.path.localeCompare(right.path) : right.score - left.score));
  return {
    query,
    hits: hits.slice(0, limit),
    scannedDocuments: documents.length,
    scannedEntries: units.length
  };
}

/**
 * 查询词切分同时覆盖拉丁词与中日韩文本：
 * 拉丁按词切分，中日韩按二元组切分（单字查询保留单字），避免整词匹配漏掉中文。
 */
export function tokenizeQuery(query: string): string[] {
  const normalized = query.normalize('NFKC').toLocaleLowerCase();
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Letter}\p{Number}_.-]+/gu)) {
    // 中英混排的查询词（例如 "python偏好"）先按字符类拆段，再各自切分。
    for (const segment of splitByScript(match[0])) {
      if (isCjk(segment)) {
        for (const term of cjkTerms(segment)) {
          terms.add(term);
        }
        continue;
      }
      if (segment.length >= 2) {
        terms.add(segment);
      }
    }
  }
  return [...terms];
}

function splitByScript(token: string): string[] {
  const segments = token.match(/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+|[^぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/gu);
  return segments === null ? [] : segments;
}

function cjkTerms(token: string): string[] {
  const characters = [...token];
  if (characters.length === 1) {
    return characters;
  }
  const terms: string[] = [];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    terms.push(`${characters[index]}${characters[index + 1]}`);
  }
  return terms;
}

function isCjk(token: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u.test(token);
}

function scoreUnit(unit: MemoryEntryUnit, terms: readonly string[]): number {
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const keyHits = countOccurrences(unit.keyText, term);
    const summaryHits = countOccurrences(unit.summaryText, term);
    const bodyHits = countOccurrences(unit.bodyText, term);
    const termScore = keyHits * KEY_WEIGHT + summaryHits * SUMMARY_WEIGHT + bodyHits * BODY_WEIGHT;
    if (termScore === 0) {
      continue;
    }
    matched += 1;
    score += termScore;
  }
  if (matched === 0) {
    return 0;
  }
  // 命中的查询词越多越可信，用覆盖率放大分数，避免单词高频条目压过全词命中条目。
  return score * (matched / terms.length);
}

function countOccurrences(haystack: string, term: string): number {
  if (haystack.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
}

function parseDocumentEntries(document: MemorySearchDocument): MemoryEntryUnit[] {
  if (document.kind === 'user') {
    return parseUserPreferenceEntries(document.content).map((entry) => ({
      path: document.path,
      scope: document.scope,
      kind: document.kind,
      entryType: 'user_preference',
      key: entry.key,
      text: entry.summary,
      keyText: normalize(entry.key),
      summaryText: normalize(entry.summary),
      bodyText: ''
    }));
  }
  const structured = parseAutoMemoryEntries(document.content).map((entry) => ({
    path: document.path,
    scope: document.scope,
    kind: document.kind,
    entryType: entry.type,
    key: entry.key,
    text: entry.summary,
    keyText: normalize(entry.key),
    summaryText: normalize(entry.summary),
    bodyText: normalize(entry.evidence.join(' '))
  }));
  const sections = parseSectionEntries(document);
  return [...structured, ...sections];
}

/** 非结构化正文（AGENTS.md、主题文件散文段落）按二级标题切块参与检索。 */
function parseSectionEntries(document: MemorySearchDocument): MemoryEntryUnit[] {
  const lines = document.content.split('\n');
  const units: MemoryEntryUnit[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body.length === 0 && heading === null) {
      return;
    }
    const withoutStructured = body
      .split('\n')
      .filter((line) => !/^\s*-\s+type:\s*\S+\s*$/u.test(line) && !/^\s+[A-Za-z]+:\s*/u.test(line))
      .join('\n')
      .trim();
    if (withoutStructured.length === 0) {
      return;
    }
    const title = heading === null ? '' : heading;
    units.push({
      path: document.path,
      scope: document.scope,
      kind: document.kind,
      entryType: 'section',
      key: heading,
      text: title.length === 0 ? withoutStructured : `${title}\n${withoutStructured}`,
      keyText: normalize(title),
      summaryText: '',
      bodyText: normalize(withoutStructured)
    });
  };
  for (const line of lines) {
    const headingMatch = /^#{1,3}\s+(.+?)\s*$/u.exec(line);
    if (headingMatch !== null) {
      flush();
      heading = headingMatch[1];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return units;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function truncate(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_SNIPPET_CHARS) {
    return value;
  }
  return `${characters.slice(0, MAX_SNIPPET_CHARS).join('')}…`;
}
