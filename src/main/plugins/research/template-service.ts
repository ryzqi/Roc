import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { compileLatex, discoverLatexEntry } from './latex-service';

export function importLatexTemplate(input: { sourcePath: string; destinationRoot: string }): { rootPath: string; entryPath: string } {
  const source = resolve(input.sourcePath);
  if (!existsSync(source)) throw new Error('latex_template_source_missing');
  const destination = resolve(input.destinationRoot);
  mkdirSync(destination, { recursive: true });
  if (statSync(source).isDirectory()) {
    for (const entry of readdirSync(source)) cpSync(join(source, entry), join(destination, entry), { recursive: true, force: true });
  } else if (extname(source).toLowerCase() === '.zip') {
    const extraction = spawnSync('/usr/bin/ditto', ['-x', '-k', source, destination], { encoding: 'utf8' });
    if (extraction.status !== 0) {
      const fallback = spawnSync('/usr/bin/unzip', ['-q', '-o', source, '-d', destination], { encoding: 'utf8' });
      if (fallback.status !== 0) throw new Error(`latex_template_extract_failed:${fallback.stderr || extraction.stderr || ''}`);
    }
  } else {
    throw new Error('latex_template_source_must_be_directory_or_zip');
  }
  return { rootPath: destination, entryPath: discoverLatexEntry(destination) };
}

export async function compileImportedLatexTemplate(input: {
  rootPath: string;
  entryPath: string;
  runner?: Parameters<typeof compileLatex>[0]['runner'];
}): Promise<Awaited<ReturnType<typeof compileLatex>>> {
  const outputDir = join(resolve(input.rootPath), '.roc-build');
  mkdirSync(outputDir, { recursive: true });
  return await compileLatex({ rootPath: input.rootPath, entryPath: input.entryPath, outputDir, runner: input.runner });
}

