import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { ResearchTemplate } from '../../../shared/types';
import { assertResearchDescendant, readResearchFile, researchContentHash, researchPath, researchWorkspace } from './research-files';
import { listTemplateFiles, type TemplateFile } from './template-files';
import type { ResearchProcessResult } from './process-runner';

export type LatexCompileInput = { rootPath: string; entryPath: string; outputDir: string; jobDir: string; signal?: AbortSignal };
export type LatexCommandRunner = (input: LatexCompileInput) => Promise<ResearchProcessResult>;
export type LatexCompileResult = Pick<ResearchTemplate, 'pdfPath' | 'pdfHash' | 'errors' | 'diagnostics'> & { status: 'ready' | 'failed' };

export async function discoverLatexEntry(rootPath: string, tree?: readonly TemplateFile[]): Promise<string> {
  const root = await researchWorkspace(rootPath);
  const files = tree ?? await listTemplateFiles(root);
  const priority = (path: string): number => {
    const preferred = ['main.tex', 'paper.tex', 'manuscript.tex'].indexOf(basename(path).toLowerCase());
    return (preferred === -1 ? 10 : preferred) + path.split('/').length * 100;
  };
  const candidates = files.filter((file) => extname(file.path).toLowerCase() === '.tex')
    .sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path));
  for (const candidate of candidates) {
    const text = (await readResearchFile(root, candidate.path, 1024 * 1024)).toString('utf8');
    if (/\\(?:documentclass|documentstyle)\b|\\begin\s*\{document\}/u.test(text.replace(/(?<!\\)%[^\n]*/gu, ''))) return candidate.path;
  }
  throw new Error('latex_template_entry_missing');
}

export async function compileLatex(input: LatexCompileInput & { runner: LatexCommandRunner }): Promise<LatexCompileResult> {
  const root = await researchWorkspace(input.rootPath);
  await researchPath(root, input.entryPath);
  if (extname(input.entryPath).toLowerCase() !== '.tex') throw new Error('latex_template_entry_invalid');
  const job = await researchWorkspace(input.jobDir);
  assertResearchDescendant(job, input.outputDir);
  if (dirname(input.outputDir) !== job) await researchPath(job, relative(job, dirname(input.outputDir)));
  try { await mkdir(input.outputDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('research_compile_output_exists');
    throw error;
  }
  const result = await input.runner({ ...input, rootPath: root });
  const diagnostics = parseLatexDiagnostics(`${result.stderr}\n${result.stdout}`, root);
  const failed = (message: string): LatexCompileResult => ({ status: 'failed', pdfPath: null, pdfHash: null,
    errors: diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).concat(message ? [message] : []),
    diagnostics: message ? [...diagnostics, { severity: 'error', message, file: null, line: null }] : diagnostics });
  if (result.exitCode !== 0) return failed(diagnostics.some((item) => item.severity === 'error') ? '' : `编译器退出，状态码 ${result.exitCode}。`);
  const filename = `${basename(input.entryPath, extname(input.entryPath))}.pdf`;
  let bytes: Buffer;
  try { bytes = await readResearchFile(input.outputDir, filename, 64 * 1024 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failed('编译未生成 PDF。');
    throw error;
  }
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return failed('编译产物不是有效的 PDF。');
  return { status: 'ready', pdfPath: join(input.outputDir, filename), pdfHash: researchContentHash(bytes), errors: [], diagnostics };
}

export function parseLatexDiagnostics(output: string, root: string): ResearchTemplate['diagnostics'] {
  const diagnostics: ResearchTemplate['diagnostics'] = [];
  for (const line of output.replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u)) {
    const location = /^(?:error:\s*|warning:\s*)?(.+?\.(?:tex|sty|cls|bib)):(\d+):\s*(.+)$/iu.exec(line);
    if (location !== null) {
      const file = isAbsolute(location[1]) ? relative(root, location[1]) : location[1];
      diagnostics.push({ severity: /^warning:/iu.test(line) ? 'warning' : 'error', message: location[3],
        file: file.startsWith('..') || isAbsolute(file) ? null : file, line: Number(location[2]) > 0 ? Number(location[2]) : null });
    } else if (/^(?:!|error:|warning:)/iu.test(line.trim())) {
      diagnostics.push({ severity: /^warning:/iu.test(line.trim()) ? 'warning' : 'error', message: line.trim(), file: null, line: null });
    } else {
      const detail = /^l\.(\d+)\s/u.exec(line.trim());
      if (detail !== null && diagnostics.length > 0) diagnostics[diagnostics.length - 1].line = Number(detail[1]) || null;
    }
    if (diagnostics.length >= 40) break;
  }
  return diagnostics;
}
