/**
 * 引用键生成：与 Better BibTeX（Zotero 插件）的默认公式对齐。
 *
 * ## 为什么不用哈希
 *
 * 之前 DOI / 检索导入的条目一律是 `roc_<sha256 前 16 位>`。它唯一的好处是稳定，代价是
 * **用户读不出来、也无法与外部工具对齐**：模板、旧稿、笔记、合作者的 Zotero 库里写的是
 * `smith2020stutop`，导入 Roc 之后变成 `roc_6f2a…`，于是模板里每一处 `\cite` 都成了未定义
 * 引用（`citation-integrity.ts` 会在导出前把它挡下来，但用户看到的是「导不出」）。
 *
 * 所以键的形状改成 Better BibTeX 的默认公式 `[auth:lower][year][shorttitle3_3]`：
 *
 *   - `auth`：第一作者姓氏，ASCII 折叠后只留小写字母数字；
 *   - `year`：四位年份，缺失时用 `nd`（no date）；
 *   - `shorttitle3_3`：标题里前 3 个**有效词**（跳过 the/a/of/on… 这类虚词）各取前 3 个字母；
 *   - 冲突时在末尾追加 `a`、`b`、…（Better BibTeX 的消歧做法），而不是改写前缀。
 *
 * ## 边界
 *
 * - `.bib` 文件导入**不经过这里**：`readBibtex()` 原样保留文件里的键（那才是用户模板里写的）。
 *   本模块只服务「Roc 自己生成键」的三个入口：DOI 导入、检索结果入库、手工录入。
 * - 键是**ASCII、全小写**的。BibTeX 的键比较对大小写不敏感，而导出的 ZIP 写入器
 *   （`export-files.ts`）按小写比较路径冲突；统一小写让「生成键 → `\cite` → 文件名」这条链
 *   不会因为大小写差异出现两种真相。
 * - 纯函数、无 IO：只有调用方知道「已有哪些键」，本模块只回答「给定这批占用，新键是什么」。
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'for', 'and', 'or', 'to', 'with', 'at', 'by', 'from',
  'into', 'onto', 'over', 'under', 'about', 'as', 'is', 'are', 'be', 'via', 'toward', 'towards',
  'de', 'la', 'le', 'der', 'die', 'das', 'und', 'et', 'des', 'du', 'el', 'los', 'las'
]);

const MAX_KEY_LENGTH = 64;
const MAX_AUTHORS = 1;

export type CiteKeyInput = {
  authors: readonly string[];
  publishedYear: number | null;
  title: string;
};

/**
 * ASCII 折叠 + 只留小写字母数字。
 *
 * 不做 Unicode 归一化之外的花样：`Ångström` → `angstrom`，`王` → 空（中文姓氏没有拉丁转写，
 * 此时回落到 `anon`，由年份与标题承担区分度）。
 */
function foldAscii(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');
}

/**
 * 姓氏：`Family, Given` 取逗号前；否则取最后一个词（`Ann van der Berg` → `berg`）。
 *
 * 这是**显示名**上的启发式，不是姓名解析器：Roc 的 `metadata.authors` 存的是展示用的字符串，
 * 检索 API 返回的也是展示名。真正的姓名结构化在 `bibliography.ts` 的 `parsePerson()`，
 * 那条路有 `von`/`jr` 这些部件，本模块只需要一个够用的姓氏。
 */
export function citeKeyAuthor(author: string): string {
  const trimmed = author.trim();
  if (trimmed.length === 0) return '';
  const comma = trimmed.indexOf(',');
  const source = comma === -1 ? trimmed.split(/\s+/u).at(-1) ?? trimmed : trimmed.slice(0, comma);
  return foldAscii(source);
}

/** 标题片段：前 3 个有效词，各取前 3 个字母，拼成一串。 */
export function citeKeyTitle(title: string): string {
  const words = title
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !STOPWORDS.has(word.toLowerCase()));
  const parts: string[] = [];
  for (const word of words) {
    const folded = foldAscii(word);
    if (folded.length === 0) continue;
    parts.push(folded.slice(0, 3));
    if (parts.length === 3) break;
  }
  return parts.join('');
}

/** `a`、`b`、… `z`、`aa`、`ab`…：与 Better BibTeX 的消歧后缀同形。 */
function suffix(index: number): string {
  let value = index;
  let text = '';
  while (value >= 0) {
    text = String.fromCharCode(97 + (value % 26)) + text;
    value = Math.floor(value / 26) - 1;
  }
  return text;
}

/**
 * 生成一个在该上下文里唯一的引用键。
 *
 * `taken` 按**小写**比较（调用方传进来的键可能带大小写）；返回的键已经写入 `taken`，
 * 所以同一批里连续生成不会互相踩。
 */
export function betterBibtexKey(input: CiteKeyInput, taken: Set<string>): string {
  const author = input.authors.slice(0, MAX_AUTHORS).map(citeKeyAuthor).find((value) => value.length > 0) ?? 'anon';
  const year = input.publishedYear !== null && Number.isInteger(input.publishedYear) && input.publishedYear > 0
    ? String(input.publishedYear)
    : 'nd';
  const base = `${author}${year}${citeKeyTitle(input.title)}`.slice(0, MAX_KEY_LENGTH) || 'anon';
  let candidate = base;
  for (let index = 0; taken.has(candidate.toLowerCase()); index += 1) {
    if (index > 1000) throw new Error('research_citation_key_exhausted');
    candidate = `${base}${suffix(index)}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * 把一批已存在的键整理成生成器要的形状。
 *
 * 冲突比较只看小写：`Smith2020` 与 `smith2020` 在 BibTeX 里是同一个键，在同一个 `.bib` 里
 * 同时出现时 BibTeX 只会保留其中一个，所以它们必须算冲突。
 */
export function citationKeySet(keys: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const key of keys) set.add(key.toLowerCase());
  return set;
}
