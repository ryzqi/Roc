import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertTexBundle, extractToolArchive } from '../../../scripts/research/archive-utils';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-archive-utils-')));
  roots.push(root);
  return root;
}

function python(script: string, args: string[], cwd: string): void {
  const result = spawnSync('python3', ['-c', script, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'python_archive_helper_failed');
  }
}

function writeTar(path: string, entries: Record<string, string | { link: string }>, gzip = false): void {
  const payload = Buffer.from(JSON.stringify(entries), 'utf8').toString('hex');
  python(`
import json, sys, tarfile
from io import BytesIO
from pathlib import Path
path, gzip, payload = Path(sys.argv[1]), sys.argv[2] == '1', bytes.fromhex(sys.argv[3])
entries = json.loads(payload.decode())
mode = 'w:gz' if gzip else 'w'
with tarfile.open(path, mode) as archive:
    for name, value in entries.items():
        if isinstance(value, dict):
            member = tarfile.TarInfo(name)
            member.type = tarfile.SYMTYPE
            member.linkname = value['link']
            archive.addfile(member)
            continue
        data = value.encode()
        member = tarfile.TarInfo(name)
        member.size = len(data)
        archive.addfile(member, BytesIO(data))
`, [path, gzip ? '1' : '0', payload], dirnameSafe(path));
}

function dirnameSafe(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function zipEntries(path: string): Record<string, string> {
  const result = spawnSync('python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps({name: archive.read(name).decode() for name in archive.namelist()}))
`, path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'python_zip_helper_failed');
  return JSON.parse(result.stdout) as Record<string, string>;
}

function pythonConvert(archive: string, destination: string): void {
  python(`
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[3])
from archive_utils import convert_tex_bundle
convert_tex_bundle(Path(sys.argv[1]), Path(sys.argv[2]))
`, [archive, destination, fileURLToPath(new URL('../../../scripts/research', import.meta.url))], dirnameSafe(destination));
}

describe('research archive utils', () => {
  it('converts a tex bundle without changing contents', async () => {
    const root = await workspace();
    const archive = join(root, 'source.tar');
    const target = join(root, 'bundle.zip');
    writeTar(archive, {
      SHA256SUM: 'a'.repeat(64),
      'tectonic-format-latex.tex': '\\input latex.ltx',
      'example.sty': 'license and contents'
    });
    await convertTexBundle(archive, target);
    expect(zipEntries(target)).toEqual({
      SHA256SUM: 'a'.repeat(64),
      'tectonic-format-latex.tex': '\\input latex.ltx',
      'example.sty': 'license and contents'
    });
    const pythonZip = join(root, 'python.zip');
    pythonConvert(archive, pythonZip);
    expect(await readFile(target)).toEqual(await readFile(pythonZip));
    await expect(convertTexBundle(archive, target))
      .rejects.toMatchObject({ message: 'research_tex_bundle_destination_exists' });
  });

  it('rejects bundle paths and leaves no final output', async () => {
    const root = await workspace();
    const archive = join(root, 'source.tar');
    writeTar(archive, { '../escape': 'bad' });
    await expect(convertTexBundle(archive, join(root, 'bundle.zip')))
      .rejects.toMatchObject({ message: 'research_tex_bundle_entry_invalid' });
    await expect(readFile(join(root, 'bundle.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, '..', 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('extracts gzip tool archives and keeps internal symlinks', async () => {
    const root = await workspace();
    const archive = join(root, 'tool.tar.gz');
    writeTar(archive, {
      'tool/bin/tool': 'binary',
      'tool/bin/current': { link: 'tool' }
    }, true);
    const output = join(root, 'output');
    await extractToolArchive(archive, output);
    expect(await readFile(join(output, 'tool/bin/tool'), 'utf8')).toBe('binary');
    expect(await readFile(join(output, 'tool/bin/current'), 'utf8')).toBe('binary');
  });

  it('rejects a symlink that escapes the destination', async () => {
    const root = await workspace();
    const archive = join(root, 'source.tar');
    writeTar(archive, { escape: { link: '../outside' } });
    const output = join(root, 'output');
    await expect(extractToolArchive(archive, output))
      .rejects.toMatchObject({ message: 'research_archive_link_outside' });
    await expect(readFile(join(output, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an existing destination, including a symlink', async () => {
    const root = await workspace();
    const archive = join(root, 'source.tar');
    writeTar(archive, { 'file.txt': 'ok' });
    const output = join(root, 'output');
    await writeFile(output, 'keep');
    await expect(extractToolArchive(archive, output))
      .rejects.toMatchObject({ message: 'research_archive_destination_exists' });
    expect(await readFile(output, 'utf8')).toBe('keep');
    await rm(output);
    await symlink(root, output);
    await expect(extractToolArchive(archive, output))
      .rejects.toMatchObject({ message: 'research_archive_destination_exists' });
  });
});
