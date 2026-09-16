import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runResearchJob } from '../../../../src/main/plugins/research/research-job';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('research job timeout and cancel', () => {
  it('times out a stalled job and removes the new output', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-research-job-')));
    roots.push(root);
    const source = join(root, 'source.txt');
    await writeFile(source, 'payload');
    const output = join(root, 'out');
    await expect(runResearchJob(
      { projectRoot: root, sourcePath: source, outputDir: output, maxSourceBytes: 1024, timeoutMs: 20 },
      async () => await new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 200))
    )).rejects.toMatchObject({ code: 'research_process_timeout' });
    expect(existsSync(output)).toBe(false);
  });

  it('cancels an in-flight job', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-research-job-')));
    roots.push(root);
    const source = join(root, 'source.txt');
    await writeFile(source, 'payload');
    const output = join(root, 'out');
    const controller = new AbortController();
    const pending = runResearchJob(
      { projectRoot: root, sourcePath: source, outputDir: output, maxSourceBytes: 1024, timeoutMs: 1000, signal: controller.signal },
      async () => await new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 200))
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'research_process_cancelled' });
    expect(existsSync(output)).toBe(false);
  });
});
