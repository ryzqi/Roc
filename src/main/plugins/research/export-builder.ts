import { writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ResearchExportExecution, ResearchExportSources } from '../../../shared/schemas/research-exports';
import { archiveSource, exportFileLimit, ResearchExportFiles, type ExportToolchain } from './export-files';
import { unknownCitationKeysIn } from './citation-integrity';
import { defaultExportEntry, renderExportBody } from './export-sources';
import { compileLatex } from './latex-service';
import { createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace } from './research-files';
import { requireTemplateRoot } from './template-files';
import type { ResearchRepository } from './repository';

export async function buildExportFiles(input: { record: ResearchExportExecution; sources: ResearchExportSources; writer: ResearchExportFiles;
  repository: ResearchRepository; tools: ExportToolchain; scratch: string; signal: AbortSignal }): Promise<void> {
  const { record, sources, writer, repository, tools, scratch, signal } = input;
  let entryPath = 'main.tex';
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
    const entry = (await readResearchFile(root, entryPath, 1024 * 1024)).toString('utf8').replace(/(?<!\\)%[^\n]*/gu, '');
    if (!/\\input\s*\{roc-manuscript\.tex\}/u.test(entry) || !/\\bibliography\s*\{roc-references\}/u.test(entry)) throw new Error('research_export_template_slots_required');
    citationSources.push(entry);
    for (const file of sources.template.files) {
      signal.throwIfAborted();
      const reserved = reservedPaths.includes(file.path);
      await writer.copy(root, file, `${reserved ? 'provenance/template' : 'source'}/${file.path}`);
      if (file.path === entryPath || !file.path.endsWith('.tex') || file.size > 1024 * 1024) continue;
      citationSources.push((await readResearchFile(root, file.path, 1024 * 1024)).toString('utf8'));
    }
  } else await writer.write('source/main.tex', defaultExportEntry(record.request.title, record.request.template.language));

  const entryDirectory = dirname(entryPath);
  const body = renderExportBody(sources);
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
  await writer.write('provenance/sources.json', JSON.stringify(sources, null, 2));
  await writer.write('provenance/export-archive.ts', archiveSource);
  const bibliography = join(scratch, 'bibliography.json');
  await writeFile(bibliography, JSON.stringify(sources.bibliography), { flag: 'wx', mode: 0o400 });
  const references = await tools.writeBibliography({ projectRoot: repository.exports.root(record.projectId, record.id), sourcePath: bibliography,
    outputDir: join(scratch, 'bibliography-result'), jobDir: scratch, format: 'bibtex', signal });
  await writer.write(join('source', entryDirectory, 'roc-references.bib'), references.content);
  await writer.write('references.bib', references.content);
  for (const run of sources.experiments) {
    for (const file of run.files) {
      signal.throwIfAborted();
      await writer.copy(repository.experiments.root(record.projectId, run.id), { ...file, path: `${file.area}/${file.path}` },
        `provenance/experiments/${run.id}/${file.area}/${file.path}`);
    }
  }
  for (const figure of sources.figures) {
    for (const file of figure.validation.files) {
      signal.throwIfAborted();
      await writer.copy(repository.figureRuns.root(record.projectId, figure.runId), { ...file, path: `output/${file.path}` },
        join('source', entryDirectory, `figures/${figure.id}.${file.path.split('.').at(-1)}`));
    }
  }
  const sourceRoot = await createResearchDirectory(writer.root, 'source');
  const result = await compileLatex({ rootPath: sourceRoot, entryPath, outputDir: join(scratch, 'compiled'), jobDir: scratch, signal,
    runner: async (request) => {
      const result = await tools.compile(request);
      await writer.write('logs/compile-stdout.txt', result.stdout);
      await writer.write('logs/compile-stderr.txt', result.stderr);
      if (/^warning:\s+errors were issued by BibTeX,\s+but were ignored\b/mu.test(result.stderr)) throw new Error('research_export_bibliography_failed');
      return result;
    } });
  await writer.write('logs/compile-diagnostics.json', JSON.stringify(result.diagnostics, null, 2));
  if (result.status !== 'ready' || result.pdfPath === null || result.pdfHash === null) throw new Error('research_export_compile_failed');
  const pdf = await readResearchFile(scratch, relative(scratch, result.pdfPath), exportFileLimit);
  if (researchContentHash(pdf) !== result.pdfHash) throw new Error('research_export_snapshot_changed');
  await writer.write('paper.pdf', pdf);
  const preview = await tools.renderPdf({ projectRoot: repository.exports.root(record.projectId, record.id), sourcePath: join(writer.root, 'paper.pdf'),
    outputDir: join(scratch, 'preview'), jobDir: scratch, page: 1, scale: 1, signal });
  if (preview.sourceHash !== result.pdfHash) throw new Error('research_export_snapshot_changed');
  await writer.write('README.txt', `Roc 科研交付文件\n\nPDF：paper.pdf\n编译入口：source/${entryPath}\n参考文献：references.bib\n` +
    `source/${join(entryDirectory, 'figures')} 保留 PNG、SVG、PDF；provenance 保存批准正文、证据定位、模型/实验运行和输入输出。\n` +
    '复现时使用 manifest.json 记录的固定科研工具链，在 source 目录编译指定入口；保持仅使用本地 TeX bundle。\n' +
    '源代码和数据的哈希位于 manifest.json 与 provenance/sources.json。\n');
}
