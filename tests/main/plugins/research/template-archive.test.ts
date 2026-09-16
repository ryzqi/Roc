import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { extractResearchTemplate } from '../../../../src/main/plugins/research/template-archive';
import { hashResearchFile } from '../../../../src/main/plugins/research/research-job';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; archive: string; output: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-template-archive-')));
  roots.push(root);
  return { root, archive: join(root, 'template.zip'), output: join(root, 'extracted') };
}

function zip(archive: string, entries: Array<{ name: string; data?: string; symlink?: string; mode?: number }>): void {
  const script = `
import json, stat, sys, zipfile
archive, entries = sys.argv[1], json.loads(sys.argv[2])
with zipfile.ZipFile(archive, 'w') as zf:
    for item in entries:
        info = zipfile.ZipInfo(item['name'])
        info.create_system = 3
        if item.get('symlink'):
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, item['symlink'])
        else:
            mode = item.get('mode', stat.S_IFREG | 0o644)
            info.external_attr = mode << 16
            zf.writestr(info, item.get('data', ''))
`;
  const result = spawnSync('python3', ['-c', script, archive, JSON.stringify(entries)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'zip_fixture_failed');
  }
}

describe('research template archive', () => {
  it('extracts nested template files and keeps the source digest', async () => {
    const { root, archive, output } = await workspace();
    zip(archive, [
      { name: 'template/main.tex', data: '\\documentclass{article}' },
      { name: 'template/references.bib', data: '@article{sample}' }
    ]);
    const result = await extractResearchTemplate({ projectRoot: root, sourcePath: archive, outputDir: output });
    expect(result.fileCount).toBe(2);
    expect(result.sourceHash).toBe(await hashResearchFile(archive));
    expect(await readFile(join(output, 'template/references.bib'), 'utf8')).toBe('@article{sample}');
  });

  it('rejects path traversal without writing outside the project', async () => {
    const { root, archive, output } = await workspace();
    const outside = join(await realpath(root), '..', `${createHash('sha256').update(root).digest('hex').slice(0, 8)}-escape.tex`);
    await writeFile(join(root, 'keep.txt'), 'protected');
    zip(archive, [{ name: '../escape.tex', data: 'bad' }]);
    await expect(extractResearchTemplate({ projectRoot: root, sourcePath: archive, outputDir: output }))
      .rejects.toMatchObject({ message: expect.stringMatching(/archive_entry_invalid/) });
    expect(existsSync(output)).toBe(false);
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('protected');
    void outside;
    void constants;
  });

  it('rejects symlink members and case-colliding paths', async () => {
    const { root, archive, output } = await workspace();
    zip(archive, [{ name: 'link.tex', symlink: '../secret' }]);
    await expect(extractResearchTemplate({ projectRoot: root, sourcePath: archive, outputDir: output }))
      .rejects.toMatchObject({ message: expect.stringMatching(/archive_entry_invalid/) });
    zip(archive, [
      { name: 'Figures/a.pdf', data: 'a' },
      { name: 'figures/b.pdf', data: 'b' }
    ]);
    await expect(extractResearchTemplate({ projectRoot: root, sourcePath: archive, outputDir: output }))
      .rejects.toMatchObject({ message: expect.stringMatching(/path_collision/) });
    expect(existsSync(output)).toBe(false);
  });

  it('extracts explicit directory members', async () => {
    const { root, archive, output } = await workspace();
    zip(archive, [
      { name: 'template/', data: '' },
      { name: 'template/main.tex', data: '\\documentclass{article}' }
    ]);
    const result = await extractResearchTemplate({ projectRoot: root, sourcePath: archive, outputDir: output });
    expect(result.fileCount).toBe(1);
    expect(await readFile(join(output, 'template/main.tex'), 'utf8')).toBe('\\documentclass{article}');
  });

  it('rejects collapsed traversal names', async () => {
    const { root, archive, output } = await workspace();
    zip(archive, [{ name: 'template/../escape.tex', data: 'bad' }]);
    await expect(extractResearchTemplate({ projectRoot: root, sourcePath: archive, outputDir: output }))
      .rejects.toMatchObject({ message: expect.stringMatching(/archive_entry_invalid/) });
    expect(existsSync(output)).toBe(false);
  });

  it('rejects excessive member counts before writing files', async () => {
    const { root, archive, output } = await workspace();
    zip(archive, Array.from({ length: 5001 }, (_, index) => ({ name: `${index}.tex`, data: '' })));
    await expect(extractResearchTemplate({ projectRoot: root, sourcePath: archive, outputDir: output }))
      .rejects.toMatchObject({ message: expect.stringMatching(/archive_too_large/) });
    expect(existsSync(output)).toBe(false);
  });
});
