import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildExportZip, createExportZipArchive } from '../../../../src/main/plugins/research/export-archive';
import { researchContentHash } from '../../../../src/main/plugins/research/research-files';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; bundle: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-export-archive-')));
  roots.push(root);
  const bundle = join(root, 'bundle');
  await mkdir(bundle);
  return { root, bundle };
}

function pythonZip(name: string, data: Buffer): Buffer | null {
  const script = `
import json, sys, zipfile
from pathlib import PurePosixPath
name, payload = sys.argv[1], bytes.fromhex(sys.argv[2])
import io
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    info = zipfile.ZipInfo(PurePosixPath(name).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100444 << 16
    archive.writestr(info, payload, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
sys.stdout.buffer.write(buf.getvalue())
`;
  const result = spawnSync('python3', ['-c', script, name, data.toString('hex')], { encoding: 'buffer' });
  if (result.status !== 0) return null;
  return result.stdout;
}

describe('research export archive', () => {
  it('matches python zipfile bytes for ascii and unicode members', () => {
    const cases: Array<[string, Buffer]> = [
      ['paper.tex', Buffer.from('hello world\n')],
      ['正文.tex', Buffer.from('批准的正文\n', 'utf8')],
      ['empty.txt', Buffer.alloc(0)]
    ];
    for (const [name, data] of cases) {
      const expected = pythonZip(name, data);
      expect(expected, `python zipfile required for ${name}`).not.toBeNull();
      expect(buildExportZip([{ path: name, data }])).toEqual(expected);
    }
  });

  it('keeps unicode paths, bytes and fixed zip metadata across two archives', async () => {
    const { root, bundle } = await workspace();
    const content = Buffer.from('批准的正文\n', 'utf8');
    await writeFile(join(bundle, '正文.tex'), content);
    const entry = { path: '正文.tex', size: content.length, sha256: researchContentHash(content) };
    const first = join(root, 'first.zip');
    const second = join(root, 'second.zip');
    const signal = new AbortController().signal;
    const result = await createExportZipArchive(bundle, first, [entry], signal);
    await createExportZipArchive(bundle, second, [entry], signal);
    expect(await readFile(first)).toEqual(await readFile(second));
    expect(result.sha256).toBe(createHash('sha256').update(await readFile(first)).digest('hex'));
  });

  it('rejects changed files and existing destinations', async () => {
    const { root, bundle } = await workspace();
    await writeFile(join(bundle, 'paper.tex'), 'changed');
    const signal = new AbortController().signal;
    await expect(createExportZipArchive(bundle, join(root, 'changed.zip'), [
      { path: 'paper.tex', size: 8, sha256: researchContentHash(Buffer.from('original')) }
    ], signal)).rejects.toMatchObject({ message: 'research_export_snapshot_changed' });
    const destination = join(root, 'existing.zip');
    await writeFile(destination, 'original delivery');
    await writeFile(join(bundle, 'ok.tex'), 'ok');
    await expect(createExportZipArchive(bundle, destination, [
      { path: 'ok.tex', size: 2, sha256: researchContentHash(Buffer.from('ok')) }
    ], signal)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('original delivery');
  });

  it('rejects links and paths outside the bundle', async () => {
    const { root, bundle } = await workspace();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside sentinel');
    await (await import('node:fs/promises')).symlink(outside, join(bundle, 'linked.txt'));
    const signal = new AbortController().signal;
    const bytes = await readFile(outside);
    const sha256 = researchContentHash(bytes);
    await expect(createExportZipArchive(bundle, join(root, 'invalid-link.zip'), [
      { path: 'linked.txt', size: bytes.length, sha256 }
    ], signal)).rejects.toMatchObject({ message: 'research_path_symlink' });
    for (const name of ['../outside.txt', outside, 'folder\\outside.txt']) {
      await expect(createExportZipArchive(bundle, join(root, `invalid-${Buffer.byteLength(name)}.zip`), [
        { path: name, size: bytes.length, sha256 }
      ], signal)).rejects.toMatchObject({ message: 'research_relative_path_invalid' });
    }
  });
});
