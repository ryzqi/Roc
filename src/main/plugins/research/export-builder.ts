import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { ResearchExportExecution, ResearchExportSources } from '../../../shared/schemas/research-exports';
import { exportFileLimit, ResearchExportFiles, type ExportToolchain } from './export-files';
import { unknownCitationKeysIn } from './citation-integrity';
import { latexReachability, prunableTexFiles, runArxivPreflight } from './arxiv-preflight';
import { defaultExportEntry, renderExportBody } from './export-sources';
import { createTypstReport } from './typst-report';
import { compileLatex } from './latex-service';
import { createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace } from './research-files';
import { requireTemplateRoot } from './template-files';
import type { ResearchRepository } from './repository';
import { assertFigureRun, figureManifest, figureManifestPath } from './figure-repository';
import {researchExportResourceKey, type ResearchExportResourceSource} from '../../../shared/schemas/research-export-publication';
import {serializeResearchPublicProjection} from './export-public-projection';
import {assertPublicExportText, copyPublicExportFile, writePublicExportFileProjection} from './export-public-files';

export async function buildExportFiles(input: { record: ResearchExportExecution; sources: ResearchExportSources; writer: ResearchExportFiles;
  repository: ResearchRepository; tools: ExportToolchain; scratch: string; signal: AbortSignal }): Promise<void> {
  const { record, sources, writer, repository, tools, scratch, signal } = input;
  const resources = new Map(record.request.publicationReview.resources.map(resource => [researchExportResourceKey(resource.source), resource]));
  const bundled = (source: ResearchExportResourceSource): boolean => {
    const resource = resources.get(researchExportResourceKey(source));
    if (resource === undefined) throw new Error('research_export_resource_selection_required');
    return resource.delivery.kind === 'bundled';
  };
  let entryPath = 'main.tex';
  // 模板里所有 `.tex` 的正文。三件事共用这一份：引用键扫描、引用闭包（决定剪枝）、
  // arXiv 预检的草稿标记扫描。
  const texContents = new Map<string, string>();
  let pruned: string[] = [];
  // 模板里所有会参与编译的 .tex 文本。缺失的 `\cite` 键**不会**让编译失败（Tectonic 退出码 0，
  // 现有 BibTeX 闸门只管「.bib 文件缺失」），只会在 PDF 里渲染成未定义引用；
  // 所以必须在编译前对真实字节做一次键的存在性检查。理由与实测见 `citation-integrity.ts`。
  const citationSources: string[] = [];
  if (record.request.template.kind === 'imported') {
    if (sources.template === null) throw new Error('research_export_template_required');
    const template = repository.getTemplate({ projectId: record.projectId, templateId: sources.template.id });
    const root = await requireTemplateRoot(await researchWorkspace(sources.project.workspacePath), template.rootPath);
    entryPath = template.entryPath;
    const reservedPaths = ['roc-manuscript.tex', 'roc-references.bib'].map((name) => join(dirname(entryPath), name));
    if (reservedPaths.includes(entryPath)) throw new Error('research_export_template_entry_invalid');
    // 先把整棵树的 `.tex` 读进来：`\input` 闭包与「哪些文件到不了」都不可能逐个文件看出来。
    for (const file of sources.template.files) {
      signal.throwIfAborted();
      if (!file.path.endsWith('.tex') || file.size > 1024 * 1024) continue;
      texContents.set(file.path, (await readResearchFile(root, file.path, 1024 * 1024)).toString('utf8'));
    }
    const entry = (texContents.get(entryPath) ?? '').replace(/(?<!\\)%[^\n]*/gu, '');
    if (!/\\input\s*\{roc-manuscript\.tex\}/u.test(entry) || !/\\bibliography\s*\{roc-references\}/u.test(entry)) throw new Error('research_export_template_slots_required');
    const tree = new Map(texContents);
    for (const file of sources.template.files) if (!tree.has(file.path)) tree.set(file.path, '');
    const reachability = latexReachability({ entryPath, files: tree });
    pruned = prunableTexFiles({ entryPath, files: tree, reachable: reachability.texFiles });
    // 剪掉的 `.tex` 不参与引用键扫描：它们不进编译，扫描它们只会报出假缺失。
    for (const path of reachability.texFiles) citationSources.push(texContents.get(path) ?? '');
    for (const file of sources.template.files) {
      signal.throwIfAborted();
      if (!bundled({...file, kind: 'template', id: sources.template.id, area: null})) throw new Error('research_export_resource_bundled_required');
      const reserved = reservedPaths.includes(file.path);
      // Unreachable files are explicitly licensed provenance, outside the compilation tree.
      await copyPublicExportFile(writer, root, file, `${reserved || pruned.includes(file.path) ? 'provenance/template' : 'source'}/${file.path}`);
    }
  } else {
    const entry = defaultExportEntry(record.request.title, record.request.template.language);
    assertPublicExportText(entry);
    texContents.set('main.tex', entry);
    await writer.write('source/main.tex', entry);
  }

  const entryDirectory = dirname(entryPath);
  const body = renderExportBody(sources);
  assertPublicExportText(body);
  assertPublicExportText(sources.manuscript.latex);
  const unknownCitations = unknownCitationKeysIn([...citationSources, body], sources.bibliography.map((entry) => entry.citationKey));
  if (unknownCitations.length > 0) {
    // 报告先写盘再抛：失败作业会保留 `writer.list()` 里的文件（`export-service.ts` 的 catch 分支），
    // 所以读 `logs/citation-report.json` 能拿到全部缺失键，而错误码里只放第一个（见下）。
    await writer.write('logs/citation-report.json', `${JSON.stringify({ unknownCitationKeys: unknownCitations }, null, 2)}\n`);
    // 只把第一个键放进错误码：本域的错误码就是用户看到的信号，但它要能通过
    // `exportError()` 的形状校验（与 `stage-runtime.ts` 同一形态），多键拼接会整条丢掉。
    throw new Error(`research_export_citation_unknown:${unknownCitations[0]}`);
  }
  await writer.write(join('source', entryDirectory, 'roc-manuscript.tex'), body);
  await writer.write('provenance/approved-manuscript.tex', sources.manuscript.latex);
  await writer.write('provenance/sources.json', serializeResearchPublicProjection(sources));
  const bibliography = join(scratch, 'bibliography.json');
  await writeFile(bibliography, JSON.stringify(sources.bibliography), { flag: 'wx', mode: 0o400 });
  const references = await tools.writeBibliography({ projectRoot: repository.exports.root(record.projectId, record.id), sourcePath: bibliography,
    outputDir: join(scratch, 'bibliography-result'), jobDir: scratch, format: 'bibtex', signal,
    admission: { projectId: record.projectId, priority: 'user' } });
  assertPublicExportText(references.content);
  await writer.write(join('source', entryDirectory, 'roc-references.bib'), references.content);
  await writer.write('references.bib', references.content);
  for (const run of sources.experiments) {
    for (const file of run.files) {
      signal.throwIfAborted();
      const root = repository.experiments.root(record.projectId, run.id);
      const source = {...file, path: `${file.area}/${file.path}`};
      const target = `provenance/experiments/${run.id}/${file.area}/${file.path}`;
      if (file.area === 'log') {
        await writePublicExportFileProjection(writer, root, source, `${target}.public.json`, 'text');
      } else if (bundled({...file, area: file.area, kind: 'experiment', id: run.id})) {
        await copyPublicExportFile(writer, root, source, target);
      }
    }
  }
  for (const figure of sources.figures) {
    const run = repository.figureRuns.get(record.projectId, figure.runId);
    assertFigureRun(run, figure.validation);
    if (researchContentHash(figureManifest(run, figure.validation)) !== figure.manifestHash) {
      throw new Error('research_export_snapshot_changed');
    }
    const root = repository.figureRuns.root(record.projectId, run.id);
    const manifest = await readResearchFile(root, figureManifestPath, exportFileLimit);
    if (researchContentHash(manifest) !== figure.manifestHash) throw new Error('research_export_snapshot_changed');
    await writePublicExportFileProjection(writer, root,
      {path: figureManifestPath, size: manifest.length, sha256: figure.manifestHash},
      `provenance/figures/${figure.id}/figure-manifest.public.json`, 'json');
    for (const file of run.files) {
      signal.throwIfAborted();
      const source = {...file, path: `${file.area}/${file.path}`};
      const target = `provenance/figures/${figure.id}/${file.area}/${file.path}`;
      if (file.area === 'log') {
        await writePublicExportFileProjection(writer, root, source, `${target}.public.json`, 'text');
      } else if (bundled({...file, area: file.area, kind: 'figure', id: figure.id})) {
        await copyPublicExportFile(writer, root, source, target);
      }
    }
    for (const file of figure.validation.files) {
      signal.throwIfAborted();
      await copyPublicExportFile(writer, root, { ...file, path: `output/${file.path}` },
        join('source', entryDirectory, `figures/${figure.id}.${file.path.split('.').at(-1)}`));
    }
  }
  const sourceRoot = await createResearchDirectory(writer.root, 'source');
  const result = await compileLatex({ rootPath: sourceRoot, entryPath, outputDir: join(scratch, 'compiled'), jobDir: scratch, signal,
    runner: async (request) => {
      const result = await tools.compile({ ...request, admission: { projectId: record.projectId, priority: 'user' } });
      await writer.write('logs/compile-stdout.public.json', serializeResearchPublicProjection({stdout: result.stdout}));
      await writer.write('logs/compile-stderr.public.json', serializeResearchPublicProjection({stderr: result.stderr}));
      if (/^warning:\s+errors were issued by BibTeX,\s+but were ignored\b/mu.test(result.stderr)) throw new Error('research_export_bibliography_failed');
      return result;
    } });
  await writer.write('logs/compile-diagnostics.public.json', serializeResearchPublicProjection(result.diagnostics));
  if (result.status !== 'ready' || result.pdfPath === null || result.pdfHash === null) throw new Error('research_export_compile_failed');
  const pdf = await readResearchFile(scratch, relative(scratch, result.pdfPath), exportFileLimit);
  if (researchContentHash(pdf) !== result.pdfHash) throw new Error('research_export_snapshot_changed');
  assertPublicExportText(pdf.toString('utf8'));
  await writer.write('paper.pdf', pdf);
  // `--keep-intermediates` 在内夹了 `.bbl`：arXiv 不跑 BibTeX，随包不带 `.bbl` 的提交在那边
  // 引用会全部变成 `?`。同名文件如果模板自己就带了，以模板为准，不覆盖（writer 也会报冲突）。
  const bblName = `${basename(entryPath, extname(entryPath))}.bbl`;
  const bblTarget = join('source', entryDirectory, bblName);
  const bblPresent = writer.list().some((file) => file.path === bblTarget);
  const bblBytes = bblPresent ? null : await readOptionalIntermediates(scratch, join('compiled', bblName), signal);
  if (bblBytes !== null) { assertPublicExportText(bblBytes.toString('utf8')); await writer.write(bblTarget, bblBytes); }
  const bblNameOrNull = bblPresent || bblBytes !== null ? bblName : null;
  const origin = sources.template === null ? [] : sources.template.files;
  const figurePrefix = `source/${join(entryDirectory, 'figures')}/`;
  const preflight = runArxivPreflight({ entryPath, texFiles: texContents,
    files: [
      ...origin.filter((file) => !pruned.includes(file.path)).map((file) => ({ path: file.path, size: file.size })),
      ...writer.list().filter((file) => file.path.startsWith(figurePrefix))
        .map((file) => ({ path: `figures/${file.path.slice(figurePrefix.length)}`, size: file.size }))
    ],
    bbl: bblNameOrNull });
  await writer.write('logs/arxiv-preflight.json', `${JSON.stringify({
    ...preflight,
    // 剪掉的文件原件在 provenance/template；这里记录它们不参与编译的原因与哈希。
    pruned: preflight.pruned.map((path) => ({ path, sha256: origin.find((file) => file.path === path)?.sha256 ?? null })),
    bbl: bblNameOrNull
  }, null, 2)}\n`);
  const preview = await tools.renderPdf({ projectRoot: repository.exports.root(record.projectId, record.id), sourcePath: join(writer.root, 'paper.pdf'),
    outputDir: join(scratch, 'preview'), jobDir: scratch, page: 1, scale: 1, signal,
    admission: { projectId: record.projectId, priority: 'user' } });
  if (preview.sourceHash !== result.pdfHash) throw new Error('research_export_snapshot_changed');
  const report = await createTypstReport({ tools, jobDir: scratch, sources, bibliography: references.content,
    language: repository.getProject(record.projectId).language, signal, admission: { projectId: record.projectId, priority: 'user' } });
  assertPublicExportText(report.source);
  assertPublicExportText(report.pdf.toString('utf8'));
  await writer.write(report.filename, report.pdf);
  await writer.write('report.typ', report.source);
  await writer.write('README.txt', `Roc 科研交付文件\n\nPDF：paper.pdf\n编译入口：source/${entryPath}\n参考文献：references.bib\n` +
    `source/${join(entryDirectory, bblName)} 是编译产出的 BibTeX 结果，arXiv 不运行 BibTeX，上传时一并带上。\n` +
    `source/${join(entryDirectory, 'figures')} 保留 PNG、SVG、PDF；provenance 保存批准正文、公开来源投影和明确获准交付的原件。\n` +
    'arXiv 提交预检的结论在 logs/arxiv-preflight.json（警告不阻断导出；被剪掉的文件也记在那里）。\n' +
    '复现时使用 manifest.json 记录的固定科研工具链，在 source 目录编译指定入口；保持仅使用本地 TeX bundle。\n' +
    'provenance/validation.json 记录语义建议、人工审核引用、历史 Skill 固定版本及仅元数据依赖；实验未重新运行，科学复现未验证。\n' +
    '文件字节哈希位于 manifest.json；provenance/sources.json 保存公开投影及独立的原始 JSON 摘要。\n' +
    'ro-crate-metadata.json 声明作者、许可、原件或仅元数据交付、环境、参数及审批绑定；仅元数据资源须按获取说明另行取得。\n');
}

/** 读一个可能不存在的中间产物：只有 `ENOENT` 是「没有」，其余错误照抛。 */
async function readOptionalIntermediates(root: string, path: string, signal: AbortSignal): Promise<Buffer | null> {
  signal.throwIfAborted();
  try { return await readResearchFile(root, path, 16 * 1024 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
