import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResearchExportSources } from '../../../shared/schemas/research-exports';
import { createResearchDirectory, readResearchFile } from './research-files';
import type { ResearchToolchain } from './toolchain';

/**
 * 导出附带的**研究过程报告**：用 Typst 排版，不碰 LaTeX 主链。
 *
 * ## 为什么是「报告」而不是「第二份正文」
 *
 * 正文的真身是 `sections[].claimIds` 指向的 claim 序列，`latex-source.ts` 从它确定性重算
 * LaTeX（`docs/research-exports.md`）。把同一批 claim 再渲染一遍 Typst，就是在产品里放两份
 * 正文真相——PDF 一页对不上，谁也不知道该信哪一份。
 *
 * 所以这份报告装的是**正文之外、审稿闸门之外也需要看见的东西**：
 *
 *   * 项目与研究目标（这一版在解决什么问题）；
 *   * 参考文献表，按 CSL 样式排版（GB/T 7714 / APA / IEEE）——LaTeX 那边由模板的
 *     `\bibliographystyle` 决定，用户改不了；报告这里给出规范样式，方便直接贴进投稿系统或回复信；
 *   * 证据索引（哪条主张的哪段证据来自哪篇文献的哪个位置）；
 *   * 图稿清单与它们的 manifest 哈希。
 *
 * ## 为什么用 Typst
 *
 * 它自带 CSL（hayagriva 直接吃 `.bib` + `.csl`），不需要第二套引用引擎；编译一次几十到几百
 * 毫秒，没有 TeX bundle、没有 BibTeX 往返。实测数据与取舍见
 * `docs/adr/0025-typst-report-engine.md`。
 *
 * ## 失败不许拖垮导出
 *
 * 报告是**附加物**：`export-builder.ts` 在 `try/catch` 里调用本模块，失败只写
 * `logs/typst-report-error.txt`。一份能编译的论文不该因为报告排版失败而导不出来。
 */

export type TypstCitationStyle = 'apa' | 'ieee' | 'gb-t-7714';

/** 样式名 → 工具链 `csl/` 下的文件名。加样式时要同时改这里与 `resources/research-runtime/csl/README.md`。 */
export const typstCitationStyles: Readonly<Record<TypstCitationStyle, string>> = {
  apa: 'apa.csl',
  ieee: 'ieee.csl',
  'gb-t-7714': 'china-national-standard-gb-t-7714-2015-numeric.csl'
};

/** 文稿语言决定默认引用样式：中文投稿默认 GB/T 7714，英文默认 APA。 */
export function defaultTypstCitationStyle(language: 'zh' | 'en'): TypstCitationStyle {
  return language === 'zh' ? 'gb-t-7714' : 'apa';
}

/**
 * Typst 标记的转义。
 *
 * 只在正文位置用：`#` `*` `_` `` ` `` `$` `<` `>` `@` `[` `]` `~` 与 `\` 在 Typst 里都有含义，
 * 论文标题里的 `C#`、`H_2O`、`@handle` 不转义会被当代码。
 */
export function escapeTypst(value: string): string {
  return value.replace(/[\\#*_`$<>@[\]~]/gu, '\\$&');
}

/** 表格单元格里的多行文本：Typst 表格不接受裸换行，先折成空格。 */
function cell(value: string): string {
  return escapeTypst(value.replace(/\s+/gu, ' ').trim());
}

export type TypstReportInput = {
  sources: Pick<ResearchExportSources, 'project' | 'manuscript' | 'claims' | 'evidence' | 'figures' | 'bibliography' | 'citationKeys' | 'review'>;
  language: 'zh' | 'en';
  style: TypstCitationStyle;
  /** 参考文献文件名（相对报告目录）。由调用方写入同一目录。 */
  bibliographyFile: string;
};

/**
 * 生成 `.typ` 源。
 *
 * 这里**不写时间戳**：同一份来源两次生成应当逐字节相同（导出会把它的哈希记进 manifest）。
 * 需要「什么时候导的」的地方是 `manifest.json` 与导出的 `createdAt`，不是正文。
 */
export function renderTypstReportSource(input: TypstReportInput): string {
  const { sources, language, style } = input;
  const zh = language === 'zh';
  const t = (zhText: string, enText: string): string => (zh ? zhText : enText);
  const styleFile = typstCitationStyles[style];
  const fonts = zh ? '("Songti SC", "STSong", "Times New Roman")' : '("Times New Roman", "Songti SC")';
  const sections = sources.manuscript.sections.length;
  const claims = sources.claims.length;
  const supported = sources.claims.filter((claim) => claim.status === 'supported').length;
  const evidenceRows = sources.evidence
    .map((item) => `  [${cell(item.title)}], [${cell(item.locator)}], [${cell(sources.citationKeys[item.id] ?? item.id)}],`)
    .join('\n');
  const figureRows = sources.figures
    .map((figure) => `  [${cell(figure.title)}], [${cell(figure.id)}], [${cell(figure.manifestHash.slice(0, 12))}],`)
    .join('\n');
  return [
    `#set document(title: ${JSON.stringify(t('研究过程报告', 'Research process report'))})`,
    '#set page(paper: "a4", margin: (x: 2.2cm, y: 2.4cm))',
    `#set text(font: ${fonts}, size: 10.5pt, lang: ${JSON.stringify(zh ? 'zh' : 'en')})`,
    '#set par(justify: true)',
    '#set heading(numbering: none)',
    '',
    `#align(center)[#text(size: 18pt, weight: "bold")[${cell(sources.project.title)}]]`,
    `#align(center)[#text(size: 12pt)[${cell(t('研究过程报告', 'Research process report'))}]]`,
    '#v(1.5em)',
    `= ${t('项目与研究目标', 'Project and objective')}`,
    cell(sources.project.description),
    '',
    `= ${t('本版规模', 'This revision at a glance')}`,
    `#table(columns: (auto, 1fr), stroke: none, align: (right, left),`,
    `  [${t('小节', 'Sections')}], [${sections}],`,
    `  [${t('主张', 'Claims')}], [${claims}],`,
    `  [${t('有证据支持的主张', 'Claims with support')}], [${supported}],`,
    `  [${t('证据片段', 'Evidence passages')}], [${sources.evidence.length}],`,
    `  [${t('图稿', 'Figures')}], [${sources.figures.length}],`,
    `  [${t('参考文献', 'References')}], [${sources.bibliography.length}],`,
    ')',
    '',
    `= ${t('证据索引', 'Evidence index')}`,
    sources.evidence.length === 0 ? t('（本次导出没有引用的证据。）', '(No evidence cited in this export.)') : [
      `#table(columns: (1fr, auto, auto), stroke: 0.25pt + luma(200),`,
      `  [${t('来源', 'Source')}], [${t('定位', 'Locator')}], [${t('引用键', 'Key')}],`,
      evidenceRows,
      ')'
    ].join('\n'),
    '',
    `= ${t('图稿', 'Figures')}`,
    sources.figures.length === 0 ? t('（本次导出没有图稿。）', '(No figures in this export.)') : [
      `#table(columns: (1fr, auto, auto), stroke: 0.25pt + luma(200),`,
      `  [${t('标题', 'Title')}], [${t('编号', 'Id')}], [${t('manifest', 'Manifest')}],`,
      figureRows,
      ')'
    ].join('\n'),
    '',
    `= ${t('参考文献', 'References')}`,
    `#bibliography(${JSON.stringify(input.bibliographyFile)}, style: ${JSON.stringify(styleFile)}, full: true)`,
    ''
  ].join('\n');
}

export type TypstReport = { filename: string; pdf: Buffer; source: string; style: TypstCitationStyle };

type TypstTools = Pick<ResearchToolchain, 'compileTypst' | 'typstStyle'>;

/**
 * 生成并编译报告。返回 PDF 字节与生成它的 `.typ` 源（源会作为 `report.typ` 一起进交付包，
 * 用户手上有 Typst 就能改）。
 */
export async function createTypstReport(input: {
  tools: TypstTools;
  jobDir: string;
  sources: TypstReportInput['sources'];
  bibliography: string;
  language: 'zh' | 'en';
  style?: TypstCitationStyle;
  signal?: AbortSignal;
}): Promise<TypstReport> {
  input.signal?.throwIfAborted();
  const style = input.style ?? defaultTypstCitationStyle(input.language);
  const styleName = typstCitationStyles[style];
  const directory = await createResearchDirectory(input.jobDir, 'typst-report');
  const bibliographyFile = 'references.bib';
  const source = renderTypstReportSource({ sources: input.sources, language: input.language, style, bibliographyFile });
  await writeFile(join(directory, 'report.typ'), source, { flag: 'wx', mode: 0o400 });
  await writeFile(join(directory, bibliographyFile), input.bibliography, { flag: 'wx', mode: 0o400 });
  // 样式文件从工具链只读目录复制进本次 job：Typst 的 `--root` 之外读不到任何东西。
  await writeFile(join(directory, styleName), await input.tools.typstStyle(styleName), { flag: 'wx', mode: 0o400 });
  input.signal?.throwIfAborted();
  const result = await input.tools.compileTypst({ rootPath: directory, sourcePath: 'report.typ', outputPath: 'report.pdf', jobDir: input.jobDir, signal: input.signal });
  if (result.exitCode !== 0) throw new Error(`research_typst_report_failed:${result.stderr.trim().split('\n')[0] ?? ''}`);
  const pdf = await readResearchFile(directory, 'report.pdf', 32 * 1024 * 1024);
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('research_typst_report_invalid');
  return { filename: 'report.pdf', pdf, source, style };
}
