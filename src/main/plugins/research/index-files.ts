import { lstat, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, matchesGlob, relative, sep } from 'node:path';
import type { z } from 'zod';
import type { researchIndexKindSchema, researchIndexOptionsSchema } from '../../../shared/schemas/research-index';
import { assertResearchDescendant, readResearchFile, researchContentHash, researchPath, researchRelativePath } from './research-files';

export type IndexFileKind = z.infer<typeof researchIndexKindSchema>;
export type ScannedIndexFile = { path: string; kind: IndexFileKind; size: number; signature: string };
export type IndexedText = { content: string; chunks: Array<{ content: string; locator: string }>; parserVersion: string };
const textExtensions: Readonly<Record<string, IndexFileKind>> = { '.md': 'markdown', '.tex': 'latex', '.bib': 'bibliography', '.csv': 'csv', '.pdf': 'pdf', '.html': 'html', '.htm': 'html',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.tif': 'image', '.tiff': 'image', '.bmp': 'image', '.webp': 'image' };

export function indexFileKind(path: string): IndexFileKind | null { return textExtensions[extname(path).toLowerCase()] ?? null; }

export async function indexFileSignature(path: string): Promise<{ size: number; signature: string }> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('research_index_source_invalid');
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('research_index_source_too_large');
  return { size: Number(stat.size), signature: [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
}

export async function scanIndexFiles(root: string, options: z.infer<typeof researchIndexOptionsSchema>, storageRoot: string, signal: AbortSignal): Promise<ScannedIndexFile[]> {
  const result: ScannedIndexFile[] = [];
  let visited = 0;
  const excluded = (path: string): boolean => options.exclude.some((pattern) => matchesGlob(path, pattern));
  const walk = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    const resolved = await realpath(directory);
    if (directory === root && resolved !== root) throw new Error('research_index_workspace_changed');
    if (directory !== root) assertResearchDescendant(root, resolved);
    const fromStorage = relative(storageRoot, resolved);
    if (fromStorage === '' || (!fromStorage.startsWith(`..${sep}`) && fromStorage !== '..' && !isAbsolute(fromStorage))) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted();
      visited += 1;
      if (visited > 50_000) throw new Error('research_index_directory_limit');
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isSymbolicLink() || excluded(name)) continue;
      try {
        if (entry.isDirectory()) {
          if (!excluded(`${name}/`)) await walk(path);
        } else if (entry.isFile()) {
          const kind = indexFileKind(name);
          if (kind === null || !options.kinds.includes(kind) || !options.include.some((pattern) => matchesGlob(name, pattern))) continue;
          if (result.length >= 10_000) throw new Error('research_index_file_limit');
          const identity = await indexFileSignature(path);
          result.push({ path: name, kind, ...identity });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
  await walk(root);
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** null requests a full scan when a watcher cannot identify a safe file-only change. */
export async function scanChangedIndexFiles(root: string, paths: ReadonlySet<string>, options: z.infer<typeof researchIndexOptionsSchema>, storageRoot: string, signal: AbortSignal): Promise<ScannedIndexFile[] | null> {
  const files: ScannedIndexFile[] = [];
  for (const name of paths) {
    signal.throwIfAborted();
    try {
      researchRelativePath(name);
      const parts = name.split('/');
      if (parts.some((_, index) => {
        const ancestor = parts.slice(0, index + 1).join('/');
        return options.exclude.some((pattern) => matchesGlob(ancestor, pattern) || (index < parts.length - 1 && matchesGlob(`${ancestor}/`, pattern)));
      })) continue;
      const path = await researchPath(root, name);
      const fromStorage = relative(storageRoot, path);
      if (fromStorage === '' || (!fromStorage.startsWith(`..${sep}`) && fromStorage !== '..' && !isAbsolute(fromStorage))) continue;
      if (!(await lstat(path)).isFile()) return null;
      const kind = indexFileKind(name);
      if (kind === null || !options.kinds.includes(kind) || !options.include.some((pattern) => matchesGlob(name, pattern))) continue;
      files.push({ path: name, kind, ...await indexFileSignature(path) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return files;
}

export async function readIndexFile(root: string, file: ScannedIndexFile): Promise<{ bytes: Buffer; sourceHash: string }> {
  const limit = ['pdf', 'image', 'html'].includes(file.kind) ? 512 * 1024 * 1024 : 16 * 1024 * 1024;
  if (file.size > limit) throw new Error('research_index_source_too_large');
  const path = await researchPath(root, file.path);
  if ((await indexFileSignature(path)).signature !== file.signature) throw new Error('research_index_source_changed');
  const bytes = await readResearchFile(root, file.path, limit);
  if ((await indexFileSignature(path)).signature !== file.signature) throw new Error('research_index_source_changed');
  return { bytes, sourceHash: researchContentHash(bytes) };
}

export function indexText(bytes: Buffer): IndexedText {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const chunks: IndexedText['chunks'] = [];
  const lines = text.split(/\r\n|\n|\r/u);
  let pending: string[] = [];
  let start = 1;
  let length = 0;
  const flush = (end: number): void => {
    const content = pending.join('\n');
    if (content.trim()) chunks.push({ content, locator: `lines ${start}-${end}` });
    pending = []; length = 0;
  };
  for (const [index, line] of lines.entries()) {
    if (line.length > 2000) {
      flush(index);
      for (let offset = 0; offset < line.length;) {
        let end = Math.min(offset + 2000, line.length);
        const last = line.charCodeAt(end - 1);
        if (end < line.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        const content = line.slice(offset, end);
        if (content.trim()) chunks.push({ content, locator: `line ${index + 1}; UTF-16 ${offset + 1}-${offset + content.length}` });
        offset = end;
      }
      start = index + 2;
      continue;
    }
    if (length + line.length + 1 > 2000) { flush(index); start = index + 1; }
    if (pending.length === 0) start = index + 1;
    pending.push(line); length += line.length + 1;
  }
  flush(lines.length);
  return { content: chunks.map((chunk) => chunk.content).join('\n\n'), chunks, parserVersion: 'roc-text-1' };
}

export function indexLocatedText(text: string, locator: string): IndexedText['chunks'] {
  if (text.length <= 2000) return text.trim() ? [{ content: text, locator }] : [];
  return indexText(Buffer.from(text, 'utf8')).chunks.map((chunk) => ({ content: chunk.content, locator: `${locator}; extracted ${chunk.locator}` }));
}
