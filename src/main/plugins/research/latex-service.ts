import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export type LatexCommandResult = { exitCode: number; stdout: string; stderr: string };
export type LatexCommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<LatexCommandResult>;

export type LatexCompileResult = {
  status: 'ready' | 'failed';
  pdfPath: string | null;
  errors: string[];
};

export function discoverLatexEntry(rootPath: string): string {
  const root = resolve(rootPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('latex_template_root_invalid');
  }
  const candidates = collectTexFiles(root);
  if (candidates.length === 0) throw new Error('latex_template_entry_missing');
  const preferred = candidates.find((path) => ['main.tex', 'paper.tex', 'manuscript.tex'].includes(basename(path).toLowerCase()));
  return relative(root, preferred ?? candidates[0]).replaceAll('\\', '/');
}

export async function compileLatex(input: {
  rootPath: string;
  entryPath: string;
  outputDir: string;
  runner?: LatexCommandRunner;
}): Promise<LatexCompileResult> {
  const root = resolve(input.rootPath);
  const entry = resolve(root, input.entryPath);
  if (!entry.startsWith(`${root}/`) || extname(entry).toLowerCase() !== '.tex' || !existsSync(entry)) {
    throw new Error('latex_template_entry_invalid');
  }
  const outputDir = resolve(input.outputDir);
  const runner = input.runner ?? runLatexCommand;
  const result = await runner('tectonic', ['--keep-logs', '--outdir', outputDir, input.entryPath], root);
  const pdfPath = join(outputDir, `${basename(input.entryPath, '.tex')}.pdf`);
  if (result.exitCode !== 0 || !existsSync(pdfPath)) {
    return { status: 'failed', pdfPath: existsSync(pdfPath) ? pdfPath : null, errors: parseLatexErrors(result.stderr || result.stdout) };
  }
  return { status: 'ready', pdfPath, errors: [] };
}

async function runLatexCommand(command: string, args: readonly string[], cwd: string): Promise<LatexCommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolvePromise({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (exitCode) => resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function collectTexFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.tex') files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function parseLatexErrors(output: string): string[] {
  const lines = output.split(/\r?\n/u).filter((line) => line.includes('!') || /error/iu.test(line));
  return lines.slice(0, 20);
}

