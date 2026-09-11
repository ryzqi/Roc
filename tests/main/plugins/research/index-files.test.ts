import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultResearchIndexOptions } from '../../../../src/shared/schemas/research-index';
import { indexText, readIndexFile, scanIndexFiles } from '../../../../src/main/plugins/research/index-files';

let root: string;
let storage: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-index-files-')));
  storage = join(root, 'index-cache');
  outside = await realpath(await mkdtemp(join(tmpdir(), 'roc-index-outside-')));
  await mkdir(storage);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('research index file boundaries', () => {
  it('selects supported formats while excluding hidden, generated, linked and private cache paths', async () => {
    for (const directory of ['notes', 'build', 'node_modules/pkg', '.private']) await mkdir(join(root, directory), { recursive: true });
    for (const path of ['paper.PDF', 'data.csv', 'notes/study.md', 'build/generated.md', 'node_modules/pkg/readme.md', '.private/source.md', '.secret.md', 'index-cache/cached.md', 'ignore.txt']) {
      await writeFile(join(root, path), 'source');
    }
    await writeFile(join(outside, 'secret.md'), 'outside');
    await symlink(outside, join(root, 'linked-folder'));
    await symlink(join(outside, 'secret.md'), join(root, 'linked.md'));
    const files = await scanIndexFiles(root, defaultResearchIndexOptions, storage, new AbortController().signal);
    expect(files.map((file) => [file.path, file.kind])).toEqual([['data.csv', 'csv'], ['notes/study.md', 'markdown'], ['paper.PDF', 'pdf']]);
  });

  it('honors include/exclude patterns independently of supported types', async () => {
    await mkdir(join(root, 'notes'));
    for (const path of ['notes/keep.md', 'notes/drop.md', 'outside.md', 'notes/code.py']) await writeFile(join(root, path), 'source');
    const files = await scanIndexFiles(root, { ...defaultResearchIndexOptions, include: ['notes/**'], exclude: ['**/drop.md'] }, storage, new AbortController().signal);
    expect(files.map((file) => file.path)).toEqual(['notes/keep.md']);
  });

  it('rejects changed content even when size and modification time are restored', async () => {
    const path = join(root, 'study.md');
    await writeFile(path, 'before');
    const [file] = await scanIndexFiles(root, defaultResearchIndexOptions, storage, new AbortController().signal);
    const before = await stat(path);
    await writeFile(path, 'after!');
    await utimes(path, before.atime, before.mtime);
    await expect(readIndexFile(root, file)).rejects.toThrow('research_index_source_changed');
  });

  it('keeps readable Unicode and precise source line locations in long text', () => {
    const line = 'a'.repeat(1999) + '🧬' + 'b'.repeat(10);
    const result = indexText(Buffer.from(`First\r\n${line}\r\nLast`, 'utf8'));
    expect(result.chunks[0]).toEqual({ content: 'First', locator: 'lines 1-1' });
    expect(result.chunks[1].content).toHaveLength(1999);
    expect(result.chunks[2].content.startsWith('🧬')).toBe(true);
    expect(result.chunks[1].content + result.chunks[2].content).toBe(line);
    expect(result.chunks.at(-1)).toEqual({ content: 'Last', locator: 'lines 3-3' });
  });

  it('fails on invalid UTF-8 and respects cancellation before reading a directory', async () => {
    expect(() => indexText(Buffer.from([0xff, 0xfe]))).toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(scanIndexFiles(root, defaultResearchIndexOptions, storage, controller.signal)).rejects.toThrow();
    expect(indexText(Buffer.from(' \n\t')).chunks).toEqual([]);
  });
});
