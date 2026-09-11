import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export function researchRelativePath(value: string): string {
  if (!value || isAbsolute(value) || /[\\\u0000-\u001f]/u.test(value)
      || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('research_relative_path_invalid');
  }
  return value;
}

export function assertResearchDescendant(root: string, target: string): void {
  const path = relative(root, target);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('research_path_outside_project');
  }
}

export async function researchWorkspace(path: string | null): Promise<string> {
  if (path === null || !isAbsolute(path)) throw new Error('research_project_workspace_required');
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new Error('research_project_directory_required');
  return root;
}

export async function researchPath(root: string, relativePath: string): Promise<string> {
  const parts = researchRelativePath(relativePath).split('/');
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('research_path_symlink');
  }
  const path = await realpath(target);
  assertResearchDescendant(root, path);
  return path;
}

export async function createResearchDirectory(root: string, relativePath: string): Promise<string> {
  const parts = researchRelativePath(relativePath).split('/');
  let target = root;
  for (const part of parts) {
    target = join(target, part);
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('research_directory_invalid');
    assertResearchDescendant(root, await realpath(target));
  }
  return target;
}

export async function readResearchFile(root: string, relativePath: string, maxBytes: number): Promise<Buffer> {
  const path = await researchPath(root, relativePath);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error('research_file_size_invalid');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('research_file_changed_during_read');
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export function researchContentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function researchAbsolutePath(root: string, relativePath: string): string {
  const path = resolve(root, researchRelativePath(relativePath));
  assertResearchDescendant(root, path);
  return path;
}
