/**
 * arXiv 提交预检。
 *
 * ## 为什么需要它
 *
 * 导出的 ZIP 今天的承诺是「能重新编译」：模板原样带进去、正文与 `.bib` 由 Roc 生成。
 * arXiv 接受的是另一套东西——`pdflatex` 一遍、**不跑 BibTeX**、只收它认识的图稿格式、
 * 对文件名大小写与体积敏感。所以一份在 Roc 里能编译成功的包，到了 arXiv 上仍然可能
 * 变成一整页 `?` 或者被退回。
 *
 * 这里只做**检查与剪枝**，不做改写：
 *
 * - **不改任何 `.tex` 字节**。模板文件的 sha256 是模板记录的一部分（`export-sources.ts`），
 *   改一个逗号就会让 `provenance` 里的哈希与磁盘上的字节对不上。注释与 `\todo{}` 由本模块
 *   **报告**（作者自己决定删不删），不替作者删。
 * - **剪掉的只是「从入口到不了、也不被任何到达的文件引用」的 `.tex`**。它们移出 `source/`，
 *   路径与哈希记进 `logs/arxiv-preflight.json`；模板本身仍在模板库里，可恢复。
 * - 结论是**警告**，不是闸门。今天的导出闸门（引用键、正文结构、BibTeX 错误）一条都不动：
 *   arXiv 的体裁要求不该让一份合法的内部交付包导不出来。
 *
 * ## 「到不了」怎么算
 *
 * 从入口出发，沿 `\input` / `\include` / `\subfile` / `\InputIfFileExists` / `\import` 做闭包；
 * 解析每个引用时同时试「相对引用文件所在目录」与「相对根目录」，并补 `.tex` 后缀。
 * 引用的非 `.tex`（图片、`.bib`、`.cls`）只登记为「被引用」，不参与剪枝——它们可能通过
 * `\includegraphics`、宏包参数甚至 `\bibliography` 的样式被间接用到，剪掉它们收益极小、风险不小。
 *
 * 唯一放过 `.tex` 的情形是**它被某个到达的文件按名字提到过**（哪怕不是 `\input`，例如
 * `\IfFileExists` 的探测或注释里的说明）。宁可不剪，也不让一次导出少一页。
 */

/** 预检结论的码。它们是日志与界面上的稳定标识，不要改字符串。 */
export type ArxivFindingCode =
  | 'missing_bbl'
  | 'unreachable_tex'
  | 'draft_markup'
  | 'todo_markup'
  | 'commented_block'
  | 'conditional_block'
  | 'absolute_path'
  | 'filename_not_portable'
  | 'figure_extension'
  | 'figure_size'
  | 'missing_reference';

export type ArxivFinding = {
  code: ArxivFindingCode;
  severity: 'warning';
  path: string | null;
  line: number | null;
  message: string;
};

export type ArxivPreflight = {
  ok: boolean;
  findings: ArxivFinding[];
  /** 被剪掉的 `.tex`：路径 → 原 sha256（由调用方填，模块本身不做 IO）。 */
  pruned: string[];
  /** 从入口可达的 `.tex`（含入口）。 */
  reachable: string[];
};

const INCLUDE_PATTERNS = [
  /\\input\s*\{([^{}]+)\}/gu,
  /\\include\s*\{([^{}]+)\}/gu,
  /\\subfile\s*\{([^{}]+)\}/gu,
  /\\InputIfFileExists\s*\{([^{}]+)\}/gu,
  /\\import\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gu,
  /\\subimport\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gu
];

/** 图稿引用：只用于「缺图」与「格式」两类警告，不参与剪枝。 */
const GRAPHICS_PATTERN = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu;

const FIGURE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'eps']);

/** 单张图稿体积上限：arXiv 单文件上限 10 MB，但超过 5 MB 的图在论文里几乎总是可以压。 */
export const figureSizeWarningBytes = 5 * 1024 * 1024;

/**
 * 去掉 LaTeX 注释（`%` 到行尾，`\%` 不算）。
 *
 * 与 `citation-integrity.ts` 用同一个近似：`verbatim` 里的 `%` 会被误当注释。这里可以接受——
 * 本模块只做「这段文本里提到了哪些文件名」的宽松扫描，误删只会让扫描更保守（更少剪枝）。
 */
export function stripLatexComments(value: string): string {
  return value.replace(/(?<!\\)%[^\n]*/gu, '');
}

function normalizeRelative(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function joinPath(base: string, name: string): string {
  return normalizeRelative(base === '' ? name : `${base}/${name}`);
}

/** 解析一个引用名：先按「相对引用文件」，再按「相对根」，逐个补齐 `.tex`。 */
function resolveReference(name: string, fromPath: string, files: ReadonlyMap<string, string>): string | null {
  const clean = name.trim().replace(/^\.\//u, '');
  if (clean.length === 0) return null;
  const directory = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const candidates = [joinPath(directory, clean), normalizeRelative(clean)];
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
    if (!candidate.includes('.') && files.has(`${candidate}.tex`)) return `${candidate}.tex`;
  }
  return null;
}

export type ReachabilityResult = {
  /** 从入口可达的 `.tex`，按字典序。 */
  texFiles: string[];
  /** 被可达文件按名字提到过、但磁盘上没有的引用（含非 `.tex`）。 */
  missing: Array<{ from: string; name: string; line: number }>;
  /** 被可达文件引用到的非 `.tex` 文件（图片、`.bib`、`.cls` 等）。 */
  referenced: string[];
};

/**
 * 从入口做一次引用闭包。
 *
 * `files` 是「路径 → 文本」：只喂 `.tex` 就够了；其它文件只需要路径存在性，
 * 由调用方通过把非 `.tex` 放进同一个 map（值为该文件是否存在的空串）来表达。
 */
export function latexReachability(input: { entryPath: string; files: ReadonlyMap<string, string> }): ReachabilityResult {
  const { entryPath, files } = input;
  if (!files.has(entryPath)) throw new Error('research_arxiv_entry_missing');
  const reachable = new Set<string>([entryPath]);
  const referenced = new Set<string>();
  const missing: Array<{ from: string; name: string; line: number }> = [];
  const queue = [entryPath];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    const text = stripLatexComments(files.get(path) ?? '');
    const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
    for (const pattern of INCLUDE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const names = match.length === 3 ? [joinPath(match[1], match[2])] : [match[1]];
        for (const name of names) {
          const resolved = resolveReference(name, path, files);
          if (resolved === null) {
            missing.push({ from: path, name: name.trim(), line: lineOf(match.index ?? 0) });
            continue;
          }
          if (resolved.endsWith('.tex')) {
            if (!reachable.has(resolved)) {
              reachable.add(resolved);
              queue.push(resolved);
            }
          } else referenced.add(resolved);
        }
      }
    }
    for (const match of text.matchAll(GRAPHICS_PATTERN)) {
      for (const name of match[1].split(',')) {
        const resolved = resolveReference(name, path, files);
        if (resolved === null) missing.push({ from: path, name: name.trim(), line: lineOf(match.index ?? 0) });
        else referenced.add(resolved);
      }
    }
  }
  return {
    texFiles: [...reachable].sort((left, right) => left.localeCompare(right)),
    missing,
    referenced: [...referenced].sort((left, right) => left.localeCompare(right))
  };
}

/**
 * 剪枝候选：模板里存在、但既不可达也没被任何可达文件按名字提到的 `.tex`。
 *
 * 「按名字提到过」是宽松判断：`files` 的所有键里，只要某个可达文件的正文化里出现了这个
 * 文件名（不含扩展名也算），就保留。它挡住了 `\IfFileExists`、`\input` 拼出来的名字、
 * 以及作者在注释里写的「备用入口 main-alt.tex」这类情形。
 */
export function prunableTexFiles(input: { entryPath: string; files: ReadonlyMap<string, string>; reachable: readonly string[] }): string[] {
  const reachable = new Set(input.reachable);
  const mentioned = new Set<string>();
  for (const path of input.reachable) {
    // 这里用**未削去注释**的原文：作者在注释里写的「备用入口 main-alt.tex」也是一次提到，
    // 剪掉它等于把作者留的线索删了。（引用闭包那边用削去注释的版本，那是在判断真实编译。）
    const text = input.files.get(path) ?? '';
    for (const candidate of input.files.keys()) {
      if (!candidate.endsWith('.tex') || reachable.has(candidate)) continue;
      const base = candidate.slice(candidate.lastIndexOf('/') + 1);
      const stem = base.slice(0, base.length - '.tex'.length);
      if (text.includes(base) || new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(stem)}([^\\p{L}\\p{N}]|$)`, 'u').test(text)) {
        mentioned.add(candidate);
      }
    }
  }
  return [...input.files.keys()]
    .filter((path) => path.endsWith('.tex') && path !== input.entryPath && !reachable.has(path) && !mentioned.has(path))
    .sort((left, right) => left.localeCompare(right));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 文件名在 arXiv 上是否好带：只允许 ASCII 字母数字与 `. _ -`，且不能有空格。 */
export function isPortableFileName(path: string): boolean {
  return /^[\w./-]+$/u.test(path) && !/\s/u.test(path);
}

/**
 * 跑全部检查。
 *
 * `bbl` 为 `null` 表示这次编译没拿到 `.bbl`（模板不用 BibTeX 时正常）。给了内容就按
 * 「已随包提供」处理——arXiv 不跑 BibTeX，缺 `.bbl` 的包在那边引用会渲染成 `?`。
 */
export function runArxivPreflight(input: {
  entryPath: string;
  /** 模板里所有 `.tex` 的正文（含入口）。 */
  texFiles: ReadonlyMap<string, string>;
  /** 会被写进 `source/` 的所有文件路径与体积。 */
  files: readonly { path: string; size: number }[];
  /** 随包 `.bbl` 的文件名（相对入口目录），没有则为 `null`。 */
  bbl: string | null;
}): ArxivPreflight {
  const files = new Map(input.texFiles);
  for (const file of input.files) if (!files.has(file.path)) files.set(file.path, '');
  const reachability = latexReachability({ entryPath: input.entryPath, files });
  const pruned = prunableTexFiles({ entryPath: input.entryPath, files, reachable: reachability.texFiles });
  const findings: ArxivFinding[] = [];
  const usesBibtex = [...input.texFiles.values()].some((text) => /\\bibliography\s*\{/u.test(stripLatexComments(text)))
    || /\\bibliographystyle\s*\{/u.test(input.texFiles.get(input.entryPath) ?? '');
  if (usesBibtex && input.bbl === null) {
    findings.push({ code: 'missing_bbl', severity: 'warning', path: input.entryPath, line: null,
      message: '模板用 BibTeX 生成参考文献，但这次编译没有产出 .bbl；arXiv 不运行 BibTeX，提交后引用会显示为问号。' });
  }
  for (const path of pruned) {
    findings.push({ code: 'unreachable_tex', severity: 'warning', path, line: null,
      message: '这个 .tex 从入口到达不了，也不会被任何可达文件引用；已从 source/ 剪掉（模板库中的记录不受影响）。' });
  }
  for (const [path, text] of input.texFiles) {
    const lines = text.split('\n');
    const scan = (pattern: RegExp, code: ArxivFindingCode, message: string): void => {
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line)) findings.push({ code, severity: 'warning', path, line: index + 1, message });
      }
    };
    scan(/\\todo\b/u, 'todo_markup', '这行有 \\todo{} 草稿标记，提交前需要清掉。');
    scan(/^\s*%.*\b(?:TODO|FIXME|XXX)\b/u, 'draft_markup', '这行注释是草稿标记（TODO/FIXME）；注释会随源文件一起提交。');
    scan(/\\iffalse\b/u, 'conditional_block', '这里用 \\iffalse 屏蔽了一段内容，确认它不该被删掉。');
    scan(/\\begin\s*\{comment\}/u, 'commented_block', '这里用 comment 环境屏蔽了一段内容，确认它不该被删掉。');
    scan(/(?:\/Users\/|\/home\/|[A-Za-z]:\\\\)/u, 'absolute_path', '这里出现绝对路径，换一台机器就找不到文件了。');
  }
  for (const missing of reachability.missing) {
    findings.push({ code: 'missing_reference', severity: 'warning', path: missing.from, line: missing.line,
      message: `引用的 ${missing.name} 不在模板文件里；编译会失败或产出空白。` });
  }
  const sizes = new Map(input.files.map((file) => [file.path, file.size]));
  for (const path of input.files.map((file) => file.path)) {
    if (!isPortableFileName(path)) {
      findings.push({ code: 'filename_not_portable', severity: 'warning', path, line: null,
        message: '文件名含空格或非 ASCII 字符；arXiv 与部分 TeX 文件系统按原样取用，容易在别人机器上失败。' });
    }
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
    if (/figures\//u.test(path) && extension !== '' && !FIGURE_EXTENSIONS.has(extension)) {
      findings.push({ code: 'figure_extension', severity: 'warning', path, line: null,
        message: `图稿格式 .${extension} 不在 arXiv 接受的 pdf/png/jpg/eps 里。` });
    }
    const size = sizes.get(path) ?? 0;
    if (/figures\//u.test(path) && size > figureSizeWarningBytes) {
      findings.push({ code: 'figure_size', severity: 'warning', path, line: null,
        message: `图稿 ${Math.round(size / 1024 / 1024)} MB，超过 ${figureSizeWarningBytes / 1024 / 1024} MB 的提示线；压一下再提交更稳。` });
    }
  }
  findings.sort((left, right) => (left.path ?? '').localeCompare(right.path ?? '') || (left.line ?? 0) - (right.line ?? 0)
    || left.code.localeCompare(right.code));
  return { ok: findings.length === 0, findings, pruned, reachable: reachability.texFiles };
}
