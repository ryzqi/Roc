import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchSandboxProfile, runResearchProcess, type ResearchProcessRequest } from '../../../../src/main/plugins/research/process-runner';

const roots: string[] = [];
async function fixture(): Promise<ResearchProcessRequest> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'roc-research-process-')));
  roots.push(cwd);
  return { command: '/bin/bash', args: [], cwd, readablePaths: [cwd, '/bin'], writablePaths: [cwd],
    environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeoutMs: 5000, allowOcrAcceleration: false, networkAccess: 'none', allowPosixSpawn: false };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.runIf(process.platform === 'darwin')('research process boundary', () => {
  it('permits scoped input/output and denies reads/writes outside the job', async () => {
    const request = await fixture();
    const other = (await fixture()).cwd;
    await writeFile(join(other, 'private.txt'), 'outside sentinel');
    const result = await runResearchProcess({ ...request, args: ['-c',
      'printf permitted > local.txt; if read -r value < "$1/private.txt"; then exit 20; fi; if printf bad > "$1/created.txt"; then exit 21; fi; printf done', 'test', other] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
    expect(await readFile(join(request.cwd, 'local.txt'), 'utf8')).toBe('permitted');
    expect(await readFile(join(other, 'private.txt'), 'utf8')).toBe('outside sentinel');
    await expect(readFile(join(other, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not turn an empty write scope into unrestricted writes', async () => {
    const request = await fixture();
    const profile = await researchSandboxProfile({ ...request, writablePaths: [] });
    expect(profile).not.toContain('(allow file-write* )');
    const result = await runResearchProcess({ ...request, writablePaths: [], args: ['-c', 'printf denied > blocked.txt'] });
    expect(result.exitCode).not.toBe(0);
    await expect(readFile(join(request.cwd, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops timed out commands and bounds accumulated output', async () => {
    const request = await fixture();
    await expect(runResearchProcess({ ...request, args: ['-c', 'while :; do :; done'], timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'research_process_timeout' });
    await expect(runResearchProcess({ ...request, args: ['-c', 'while :; do printf 1234567890; done'], maxOutputBytes: 100 }))
      .rejects.toMatchObject({ code: 'research_process_output_limit', stdout: expect.stringMatching(/^1234567890/) });
  });

  it('cancels the process group including a detached-output child', async () => {
    const request = await fixture();
    const controller = new AbortController();
    const pending = runResearchProcess({ ...request, signal: controller.signal, args: ['-c',
      '(trap "" TERM; while :; do :; done) >/dev/null 2>&1 & printf "%s" "$!" > child.pid; wait'] });
    const completed = pending.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    let pid: number | undefined;
    try {
    for (let count = 0; count < 100; count += 1) {
      try {
        const candidate = Number(await readFile(join(request.cwd, 'child.pid'), 'utf8'));
        if (Number.isSafeInteger(candidate) && candidate > 0) { pid = candidate; break; }
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid).toBeGreaterThan(0);
    if (pid === undefined) throw new Error('child_pid_missing');
    controller.abort();
    expect((await completed).error).toMatchObject({ code: 'research_process_cancelled' });
    // 内核回收子进程需要一个调度间隔。
    let alive = true;
    for (let count = 0; count < 100 && alive; count += 1) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; }
    }
    expect(alive).toBe(false);
    } finally { controller.abort(); await completed; }
  });

  it('reaps remaining child processes after the parent succeeds', async () => {
    const request = await fixture();
    const result = await runResearchProcess({ ...request, args: ['-c', '(while :; do :; done) >/dev/null 2>&1 & printf "%s" "$!" > child.pid; exit 0'] });
    expect(result.exitCode).toBe(0);
    const pid = Number(await readFile(join(request.cwd, 'child.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })));
  });

  it('prevents child jobs from escaping cancellation by changing their process group', async () => {
    const request = await fixture();
    const result = await runResearchProcess({ ...request, args: ['-c', 'set -m; (trap "" HUP TERM; while :; do :; done) >/dev/null 2>&1 & printf "%s" "$!" > child.pid; exit 0'] });
    expect(result.exitCode).toBe(0);
    const pid = Number(await readFile(join(request.cwd, 'child.pid'), 'utf8'));
    try { await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))); }
    finally { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  });
});
