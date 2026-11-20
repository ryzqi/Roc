/**
 * 被编译的 LaTeX 里引用的键，必须都能在本次快照的参考文献里找到。
 *
 * ## 这条规则为什么存在（实测结论，不是推断）
 *
 * 原本以为「模板里缺失的 `\cite` 键由 BibTeX 闸门兜住」——`export-builder.ts` 会拒绝 Tectonic
 * 输出里出现 `errors were issued by BibTeX, but were ignored` 的编译。**实测不成立**：用随包
 * Tectonic 编译一份 `\cite{does-not-exist}` 的文稿，
 *
 * - `.bib` 文件**不存在**时才会出现那一行（退出码仍是 0）→ 现有闸门只管这一种；
 * - `.bib` 存在但**缺这个键**时，BibTeX 只在 `.blg` 里写
 *   `Warning--I didn't find a database entry for "does-not-exist"`，Tectonic 退出码 0、
 *   stderr 里没有可匹配的字符串，于是 pdf 里的引用渲染成未定义引用
 *   （`m.log`：`LaTeX Warning: Citation 'does-not-exist' on page 1 undefined`）。
 *
 * 也就是说：**一份引用键对不上的模板会编译成功并交付出去**，错误只在 PDF 里以「?」的形式出现。
 * 这正是本模块要挡的事，而它挡的位置只能在编译之前、在拿到真实 LaTeX 文本的地方。
 *
 * ## 为什么在导出构建器里查，而不是在 `collect()` 里
 *
 * `collect()` 是纯读、无 IO 的（它被 prepare / publish / write / 每个 verifyStage 共用），
 * 而判断需要**被编译的字节**：模板入口与模板自己的 `.tex` 文件。这些在 `export-builder.ts`
 * 里本来就已经读进来了（它要校验模板槽位），所以检查放在那里既不新增 IO，也只对真正会编译的
 * 文本生效。
 *
 * ## 已知边界（写下来而不是假装没有）
 *
 * - 只扫描**这一次导出拷贝进的 `.tex` 文件**。模板若用 `\input{}` 引用工作目录里别处的文件，
 *   那些文件不参与本次编译（`writer.copy` 只带 `sources.template.files`），所以不需要扫；
 * - `\nocite{*}` 表示「把所有条目列进参考文献」，不是键，跳过；
 * - `verbatim` / `lstlisting` / `minted` 里的内容不是引用，先剔除再匹配——否则一份教人写
 *   `\cite` 的模板会把示例文本当成缺失键。
 */

const verbatimPatterns = [
  /\\begin\{verbatim\}[\s\S]*?\\end\{verbatim\}/gu,
  /\\begin\{Verbatim\}[\s\S]*?\\end\{Verbatim\}/gu,
  /\\begin\{lstlisting\}[\s\S]*?\\end\{lstlisting\}/gu,
  /\\begin\{minted\}[\s\S]*?\\end\{minted\}/gu
];

/** 注释、逐字环境与 `\cite` 家族引用。宏名一律含 `cite`，所以不枚举 `\citet` / `\parencite` 之类。 */
function stripNonCitations(source: string): string {
  let text = source.replace(/(?<!\\)%[^\n]*/gu, '');
  for (const pattern of verbatimPatterns) text = text.replace(pattern, '');
  return text;
}

/**
 * 取出源码里引用的所有键。重复键只保留一次，返回顺序为源码出现顺序（便于报告「第一个缺的键」）。
 */
export function latexCitationKeys(source: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const pattern = /\\[a-zA-Z]*[Cc]ite[a-zA-Z]*\*?(?:\s*\[[^\]]*\])*\s*\{([^}]*)\}/gu;
  for (const match of stripNonCitations(source).matchAll(pattern)) {
    for (const raw of match[1].split(',')) {
      const key = raw.trim();
      // `\nocite{*}` 是「全部」，不是键。
      if (key === '' || key === '*') continue;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * `keys` 里在 `known` 中找不到的那些，按出现顺序去重返回。
 *
 * 只做集合比较，不做模糊匹配：引用键是标识符，`zhang2023` 与 `zhang2023a` 是两个不同的键，
 * 「看起来像」在这里没有意义。
 */
export function unknownCitationKeys(keys: readonly string[], known: Iterable<string>): string[] {
  const available = known instanceof Set ? known : new Set(known);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (available.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(key);
  }
  return missing;
}

/**
 * 把一批 LaTeX 源码合起来求缺失引用键。
 *
 * 合并后再求差集（而不是逐个文件抛错）：用户要看到的是「这份导出缺哪些键」，一次给全，
 * 而不是改一个键、再编译、再发现下一个。
 */
export function unknownCitationKeysIn(sources: readonly string[], knownKeys: Iterable<string>): string[] {
  const keys = sources.flatMap((source) => latexCitationKeys(source));
  return unknownCitationKeys(keys, knownKeys);
}
