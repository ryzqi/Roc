import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATEX, PLOT, smoke } from '../../../scripts/research/smoke';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-smoke-')));
  roots.push(root);
  return root;
}

describe('research smoke', () => {
  it('exports the latex and plot samples used by the live toolchain test', () => {
    expect(LATEX).toContain('研究数据与方法');
    expect(PLOT).toContain("matplotlib.use('Agg')");
  });

  it('rejects an existing output directory before running the toolchain', async () => {
    const root = await workspace();
    const output = join(root, 'out');
    await mkdir(output);
    await writeFile(join(output, 'keep'), 'keep');
    await expect(smoke(join(root, 'missing-toolchain'), output))
      .rejects.toThrow();
    expect(await (await import('node:fs/promises')).readFile(join(output, 'keep'), 'utf8')).toBe('keep');
  });
});
