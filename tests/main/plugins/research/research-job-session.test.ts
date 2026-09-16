import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeFrozenManifest } from '../../../../src/main/plugins/research/research-frozen-manifest';
import { ResearchBackgroundJobs, ResearchJobSession } from '../../../../src/main/plugins/research/research-job-session';

describe('research job session', () => {
  it('rejects work after shutdown', async () => {
    const session = new ResearchJobSession('research_job_closed');
    await session.shutdown();
    await expect(session.run(async () => 'ok')).rejects.toThrow('research_job_closed');
    await expect(session.guard(async () => 'ok')).rejects.toThrow('research_job_closed');
  });
});

describe('research background jobs', () => {
  it('starts once, aborts matching jobs, and reports a lost execution', async () => {
    const session = new ResearchJobSession('research_job_closed');
    const lost: Array<{ id: string; error: unknown }> = [];
    const jobs = new ResearchBackgroundJobs<{ projectId: string }>(session, (id, error) => { lost.push({ id, error }); });
    let started = 0;
    const first = deferred();
    jobs.start('run_1', { projectId: 'p1' }, async (signal) => {
      started += 1;
      first.resolve();
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    jobs.start('run_1', { projectId: 'p1' }, async () => { started += 1; });
    await first.promise;
    expect(started).toBe(1);
    expect(jobs.has('run_1')).toBe(true);
    jobs.abortMatching((_id, job) => job.projectId === 'p1');
    await jobs.wait('run_1').catch(() => undefined);
    expect(jobs.has('run_1')).toBe(false);
    expect(lost).toEqual([{ id: 'run_1', error: expect.objectContaining({ message: 'aborted' }) }]);
  });

  it('aborts tracked jobs when the session shuts down', async () => {
    const session = new ResearchJobSession('research_job_closed');
    const jobs = new ResearchBackgroundJobs<{ projectId: string }>(session, () => undefined);
    let aborted = false;
    const ready = deferred();
    jobs.start('run_1', { projectId: 'p1' }, async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) { aborted = true; resolve(); return; }
        signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
        ready.resolve();
      });
    });
    await ready.promise;
    await session.shutdown();
    expect(aborted).toBe(true);
    expect(jobs.has('run_1')).toBe(false);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('frozen research manifest', () => {
  it('writes once and rejects a changed replay', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-manifest-')));
    const first = await writeFrozenManifest({
      root, path: 'manifest.json', content: '{"ok":true}', limit: 1024, changedCode: 'research_manifest_changed'
    });
    const second = await writeFrozenManifest({
      root, path: 'manifest.json', content: '{"ok":true}', limit: 1024, changedCode: 'research_manifest_changed'
    });
    expect(second).toBe(first);
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe('{"ok":true}');
    await chmod(join(root, 'manifest.json'), 0o600);
    await writeFile(join(root, 'manifest.json'), '{"ok":false}');
    await expect(writeFrozenManifest({
      root, path: 'manifest.json', content: '{"ok":true}', limit: 1024, changedCode: 'research_manifest_changed'
    })).rejects.toThrow('research_manifest_changed');
  });
});
