/** Conservative static dependency analysis. Originals are never rewritten; uncertain
 * dependencies disable pruning. Findings describe a candidate, not arXiv acceptance. */
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
  | 'missing_reference'
  | 'dependency_unknown'
  | 'shell_escape_required'
  | 'biblatex_review';

export type ArxivFinding = {
  code: ArxivFindingCode;
  severity: 'warning' | 'error';
  path: string | null;
  line: number | null;
  message: string;
};

export type ArxivPreflight = {
  ok: boolean;
  submissionBlocked: boolean;
  analysisComplete: boolean;
  externalDependencies: string[];
  findings: ArxivFinding[];
  /** 被剪掉的 `.tex`：路径 → 原 sha256（由调用方填，模块本身不做 IO）。 */
  pruned: string[];
  /** 从入口可达的 `.tex`（含入口）。 */
  reachable: string[];
};

const INCLUDE_PATTERN = /\\(input|include|subfile|InputIfFileExists|IfFileExists)\b\s*(?:\{([^{}]*)\}|([^\s{}%]+))/gu;
const IMPORT_PATTERN = /\\(?:sub)?import\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu;
const GRAPHICS_PATTERN = /\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/gu;
const FIGURE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'eps']);

/** Roc 的图稿体积提醒阈值；不代表 arXiv 当前投稿上限。 */
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

function normalizeRelative(path: string): string | null {
  if (/^(?:\/|[A-Za-z]:)|[\u0000-\u001f]/u.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function scanText(text: string): string {
  // Preserve line numbers and don't treat examples inside verbatim as dependencies.
  return stripLatexComments(text.replace(/\\begin\{(verbatim\*?|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}|\\verb\*?([^\w\s])[\s\S]*?\2/gu,
    value => value.replace(/[^\n]/gu, ' ')));
}

function resolveReferences(name: string, from: string, files: ReadonlyMap<string, string>, extensions: readonly string[], directories: readonly string[] = []): string[] {
  const directory = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const matches = new Set<string>();
  for (const base of [directory, '', ...directories]) {
    const path = normalizeRelative(base ? `${base}/${name.trim()}` : name.trim());
    if (path === null) continue;
    for (const suffix of ['', ...extensions]) if (files.has(`${path}${suffix}`)) matches.add(`${path}${suffix}`);
  }
  return [...matches];
}

export type ReachabilityResult = {
  texFiles: string[];
  missing: Array<{ from: string; name: string; line: number }>;
  referenced: string[];
  uncertain: Array<{from: string; name: string; line: number}>;
  externalDependencies: string[];
};

export function latexReachability(input: { entryPath: string; files: ReadonlyMap<string, string> }): ReachabilityResult {
  const {entryPath, files} = input;
  if (!files.has(entryPath)) throw new Error('research_arxiv_entry_missing');
  const visited = new Set<string>();
  const referenced = new Set<string>();
  const missing: ReachabilityResult['missing'] = [];
  const uncertain: ReachabilityResult['uncertain'] = [];
  const external = new Set<string>();
  const graphics: Array<{from: string; name: string; line: number}> = [];
  const directories = new Set<string>();
  const queue = [entryPath];
  while (queue.length) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const text = scanText(files.get(path) ?? '');
    const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
    const dependency = (name: string, index: number, extensions: string[], optional = false, system = false): void => {
      const location = {from: path, name: name.trim(), line: lineOf(index)};
      if (/[\\#{}]/u.test(name) || name.trim() === '') { uncertain.push(location); return; }
      const matches = resolveReferences(name, path, files, extensions);
      if (matches.length === 0) {
        if (system && /^[\w.-]+$/u.test(name)) external.add(`${name}${extensions[0]}`);
        else if (!optional) missing.push(location);
        return;
      }
      // TeX package search paths may differ from the source file directory. Keep
      // every possible target and disable pruning when resolution is ambiguous.
      if (matches.length > 1) uncertain.push(location);
      for (const resolved of matches) {
        referenced.add(resolved);
        if (/\.(?:tex|sty|cls)$/u.test(resolved)) queue.push(resolved);
      }
    };
    for (const match of text.matchAll(INCLUDE_PATTERN)) dependency(match[2] ?? match[3], match.index, ['.tex'], /IfFileExists/u.test(match[1]));
    for (const match of text.matchAll(IMPORT_PATTERN)) dependency(`${match[1]}/${match[2]}`, match.index, ['.tex']);
    for (const match of text.matchAll(/\\(bibliography|addbibresource|documentclass|usepackage|RequirePackage|LoadClass|bibliographystyle)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/gu)) {
      const command = match[1];
      const extension = ['bibliography', 'addbibresource'].includes(command) ? '.bib' : command === 'bibliographystyle' ? '.bst' : /class|Class/u.test(command) ? '.cls' : '.sty';
      for (const name of match[2].split(',')) dependency(name.trim(), match.index, [extension], false, extension !== '.bib');
    }
    for (const match of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})+\s*)\}/gu)) {
      for (const entry of match[1].matchAll(/\{([^{}]*)\}/gu)) {
        if (/[\\#]/u.test(entry[1])) uncertain.push({from: path, name: entry[1], line: lineOf(match.index)});
        else {
          directories.add(entry[1]);
          const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
          directories.add(`${base}${entry[1]}`);
        }
      }
    }
    for (const match of text.matchAll(GRAPHICS_PATTERN)) graphics.push({from: path, name: match[1], line: lineOf(match.index)});
    // TeX can synthesize commands or open files without the common include forms.
    if (/\\(?:csname|openin|read|input@path|includeonly|(?:sub)?(?:inputfrom|includefrom))\b|\\(?:input|include|subfile|includegraphics|bibliography|addbibresource)\s*\{[^}]*\{/u.test(text)) {
      uncertain.push({from: path, name: 'dynamic TeX dependency', line: 1});
    }
  }
  for (const graphic of graphics) {
    if (/[\\#{}]/u.test(graphic.name)) { uncertain.push(graphic); continue; }
    const matches = resolveReferences(graphic.name, graphic.from, files, [...FIGURE_EXTENSIONS].map(value => `.${value}`), [...directories]);
    if (matches.length === 0) missing.push(graphic);
    else for (const resolved of matches) referenced.add(resolved);
  }
  return {texFiles: [...visited].filter(path => path.endsWith('.tex')).sort(), missing,
    referenced: [...referenced].sort(), uncertain, externalDependencies: [...external].sort()};
}

/**
 * 剪枝候选：模板里存在、但既不可达也没被任何可达文件按名字提到的 `.tex`。
 *
 * 「按名字提到过」是宽松判断：`files` 的所有键里，只要某个可达文件的正文化里出现了这个
 * 文件名（不含扩展名也算），就保留。它挡住了 `\IfFileExists`、`\input` 拼出来的名字、
 * 以及作者在注释里写的「备用入口 main-alt.tex」这类情形。
 */
export function prunableTexFiles(input: { entryPath: string; files: ReadonlyMap<string, string>; reachable: readonly string[] }): string[] {
  const analysis = latexReachability({entryPath: input.entryPath, files: input.files});
  if (analysis.uncertain.length > 0) return [];
  const reachable = new Set(input.reachable);
  const mentioned = new Set<string>();
  const queue = [...input.reachable, ...analysis.referenced.filter(path => /\.(?:cls|sty)$/u.test(path))];
  const scanned = new Set<string>();
  while (queue.length) {
    const path = queue.shift()!;
    if (scanned.has(path)) continue;
    scanned.add(path);
    // Retained alternate entries may themselves use dynamic dependencies.
    if (latexReachability({entryPath: path, files: input.files}).uncertain.length) return [];
    // 这里用**未削去注释**的原文：作者在注释里写的「备用入口 main-alt.tex」也是一次提到，
    // 剪掉它等于把作者留的线索删了。（引用闭包那边用削去注释的版本，那是在判断真实编译。）
    const text = input.files.get(path) ?? '';
    for (const candidate of input.files.keys()) {
      if (!candidate.endsWith('.tex') || reachable.has(candidate)) continue;
      const base = candidate.slice(candidate.lastIndexOf('/') + 1);
      const stem = base.slice(0, base.length - '.tex'.length);
      if (text.includes(base) || new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(stem)}([^\\p{L}\\p{N}]|$)`, 'u').test(text)) {
        if (!mentioned.has(candidate)) queue.push(candidate);
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
 * 「已随包提供」处理。具体处理器与 bbl 兼容性仍需目标平台核验。
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
  const usesBibtex = [...input.texFiles.values()].some((text) => /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{/u.test(stripLatexComments(text)))
    || /\\bibliographystyle\s*\{/u.test(input.texFiles.get(input.entryPath) ?? '');
  if (usesBibtex && input.bbl === null) {
    findings.push({ code: 'missing_bbl', severity: 'error', path: input.entryPath, line: null,
      message: '文稿使用外部参考文献处理器，但未提供 .bbl；请核对当前 arXiv 处理器及所需中间文件。' });
  }
  for (const path of pruned) {
    findings.push({ code: 'unreachable_tex', severity: 'warning', path, line: null,
      message: '这个 .tex 从入口到达不了，也不会被任何可达文件引用；可从投稿候选目录中移除，完整 source/ 仍保留。' });
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
    findings.push({ code: 'missing_reference', severity: 'error', path: missing.from, line: missing.line,
      message: `引用的 ${missing.name} 不在模板文件里；编译会失败或产出空白。` });
  }
  for (const item of reachability.uncertain) findings.push({code: 'dependency_unknown', severity: 'warning', path: item.from, line: item.line, message: `静态分析无法解析 ${item.name}；保留全部 TeX 文件，需人工检查依赖。`});
  for (const path of [...reachability.texFiles, ...reachability.referenced.filter(path => /\.(?:sty|cls)$/u.test(path))]) {
    const text = stripLatexComments(input.texFiles.get(path) ?? '');
    if (/\\(?:write18|usepackage(?:\[[^\]]*\])?\{minted\}|begin\{minted\})/u.test(text)) {
      findings.push({code: 'shell_escape_required', severity: 'error', path, line: null, message: '检测到 minted 或外部命令；需在目标环境验证冻结缓存，候选包不能自动认定可提交。'});
    }
    if (/\\(?:addbibresource|printbibliography)\b|\{biblatex\}/u.test(text)) findings.push({code: 'biblatex_review', severity: 'warning', path, line: null, message: '请核对 biblatex/Biber 版本与 .bbl 的兼容性。'});
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
  return { ok: findings.length === 0, submissionBlocked: findings.some(finding => finding.severity === 'error'),
    analysisComplete: reachability.uncertain.length === 0, externalDependencies: reachability.externalDependencies, findings, pruned, reachable: reachability.texFiles };
}
