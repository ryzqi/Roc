import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type { z } from 'zod';
import type { researchTemplateFileSchema } from '../../../shared/schemas/research-production';
import { createResearchDirectory, readResearchFile, researchContentHash, researchPath, researchRelativePath, researchWorkspace } from './research-files';

export type TemplateFile = z.infer<typeof researchTemplateFileSchema>;
export const editableTemplateExtensions = new Set(['.tex', '.cls', '.sty', '.bib', '.bst', '.bbx', '.cbx', '.lbx', '.def', '.cfg', '.clo', '.ltx', '.txt', '.md', '.tikz', '.pgf', '.csv', '.dat', '.fd', '.ldf', '.map', '.enc']);
const ignoredNames = new Set(['.git', '.roc-research', '.roc-build', '.DS_Store', '__MACOSX', 'node_modules']);
const maximumFileBytes = 64 * 1024 * 1024;

export async function listTemplateFiles(rootPath: string): Promise<TemplateFile[]> {
  const root = await researchWorkspace(rootPath);
  const files: TemplateFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  let visited = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 20) throw new Error('research_template_too_deep');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 5000) throw new Error('research_template_too_many_files');
      if (ignoredNames.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('research_template_symlink');
      const path = researchRelativePath(`${prefix}${entry.name}`);
      const key = path.normalize('NFC').toLowerCase();
      if (paths.has(key)) throw new Error('research_template_path_collision');
      paths.add(key);
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`, depth + 1);
      else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        const content = await readResearchFile(root, path, maximumFileBytes);
        total += content.byteLength;
        if (total > 256 * 1024 * 1024) throw new Error('research_template_too_large');
        files.push({ path, size: content.byteLength, sha256: researchContentHash(content), editable: editableTemplateExtensions.has(extension) });
      } else throw new Error('research_template_file_type_invalid');
    }
  };
  await visit(root, '', 0);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function copyTemplateFiles(source: string, destination: string, files: readonly TemplateFile[]): Promise<void> {
  await mkdir(destination);
  try {
    const root = await researchWorkspace(source);
    for (const file of files) {
      const content = await readResearchFile(root, file.path, maximumFileBytes);
      if (researchContentHash(content) !== file.sha256) throw new Error('research_template_source_changed');
      const directory = dirname(file.path);
      if (directory !== '.') await createResearchDirectory(destination, directory);
      await writeFile(join(destination, file.path), content, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export function templateDigest(entryPath: string, files: readonly TemplateFile[]): string {
  return researchContentHash(JSON.stringify({ entryPath, files: files.map((file) => [file.path, file.sha256]) }));
}

export async function requireTemplateRoot(workspace: string, rootPath: string): Promise<string> {
  const root = await researchPath(workspace, relative(workspace, rootPath));
  if (!(await lstat(root)).isDirectory()) throw new Error('research_template_root_invalid');
  return root;
}
