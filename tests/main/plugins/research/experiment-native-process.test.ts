import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { runRExperimentProcess } from '../../../../src/main/plugins/research/experiment-native-process';
import { rExperimentCommand } from '../../../../src/main/plugins/research/experiment-native-probes';
import { runResearchProcess } from '../../../../src/main/plugins/research/process-runner';

const rRoot = process.env.ROC_RESEARCH_R_HOME;
describe.skipIf(rRoot === undefined)('R process initialization boundary', () => {
  it('preserves libc pipe bytes and child status under the actual process sandbox', async () => {
    const job = await realpath(await mkdtemp(join(tmpdir(), 'roc-pipe-contract-')));
    try {
      const source = join(job, 'probe.c');
      const executable = join(job, 'probe');
      await writeFile(source, '#include <stdio.h>\n#include <errno.h>\n#include <sys/wait.h>\nint main(void) { char data[128]={0}; FILE *f=popen("printf captured; exit 7", "r"); if(!f){perror("popen");return 1;} size_t count=fread(data,1,sizeof(data)-1,f); int err=errno; int failed=ferror(f); int status=pclose(f); printf("count=%zu data=%s error=%d failed=%d status=%d",count,data,err,failed,status);return 0;}\n');
      await promisify(execFile)('/usr/bin/xcrun', ['clang', source, '-o', executable]);
      const result = await runRExperimentProcess({ ...rExperimentCommand(job, executable, []), cwd: job,
        readablePaths: [job], writablePaths: [job], additionalExecutables: [executable], environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        timeoutMs: 10000, networkAccess: 'none', allowPosixSpawn: false, allowOcrAcceleration: false }, runResearchProcess);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^count=8 data=captured error=\d+ failed=0 status=1792$/u);
    } finally { await rm(job, { recursive: true, force: true }); }
  });

  it('loads standard R namespaces with a scoped temporary directory and cleans that directory', async () => {
    if (rRoot === undefined) throw new Error('r_runtime_required');
    const job = await realpath(await mkdtemp(join(tmpdir(), 'roc R process ')));
    try {
      const executable = join(rRoot, 'bin/exec/R');
      const result = await runRExperimentProcess({
        ...rExperimentCommand(rRoot, executable, ['--vanilla', '--slave', '-e', 'library(utils); library(stats); writeLines(tempdir(), "temporary.txt"); cat("namespaces_loaded")']),
        cwd: job, readablePaths: [rRoot], writablePaths: [job], additionalExecutables: [executable], environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        timeoutMs: 10000, networkAccess: 'none', allowPosixSpawn: false, allowOcrAcceleration: false
      }, runResearchProcess);
      expect(result).toEqual({ exitCode: 0, stdout: 'namespaces_loaded', stderr: '' });
      const temporary = (await readFile(join(job, 'temporary.txt'), 'utf8')).trim();
      await expect(readFile(join(temporary, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(writeFile(join(temporary, 'sentinel'), 'unexpected')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(job, { recursive: true, force: true }); }
  });

  it('preserves command output, exit status and writable pipe input', async () => {
    if (rRoot === undefined) throw new Error('r_runtime_required');
    const job = await realpath(await mkdtemp(join(tmpdir(), 'roc R pipes ')));
    try {
      const executable = join(rRoot, 'bin/exec/R');
      const code = String.raw`value <- suppressWarnings(system("printf captured; exit 7", intern=TRUE))
if (!identical(as.character(value), "captured") || !identical(attr(value, "status"), 7L)) stop(paste("Unexpected pipe result:", paste(value, collapse="|"), "status", attr(value, "status")))
connection <- pipe("IFS= read -r line; printf '%s' \"$line\" > received.txt", open="w")
writeLines("measured 42", connection)
close(connection)
stopifnot(system("exit 9", intern=FALSE) == 9L)
first <- pipe("echo first", open="r")
second <- pipe("echo second", open="r")
stopifnot(identical(readLines(first, warn=FALSE), "first"), identical(readLines(second, warn=FALSE), "second"))
close(first); close(second)
cat("pipes_verified")`;
      const result = await runRExperimentProcess({ ...rExperimentCommand(rRoot, executable, ['--vanilla', '--slave', '-e', code]),
        cwd: job, readablePaths: [rRoot], writablePaths: [job], additionalExecutables: [executable], environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        timeoutMs: 10000, networkAccess: 'none', allowPosixSpawn: false, allowOcrAcceleration: false }, runResearchProcess);
      expect(result).toEqual({ exitCode: 0, stdout: 'pipes_verified', stderr: '' });
      expect(await readFile(join(job, 'received.txt'), 'utf8')).toBe('measured 42');
    } finally { await rm(job, { recursive: true, force: true }); }
  });

  it('blocks writes outside the run and reaps a command which attempts to change process group', async () => {
    if (rRoot === undefined) throw new Error('r_runtime_required');
    const job = await realpath(await mkdtemp(join(tmpdir(), 'roc R group ')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'roc R outside ')));
    let child: number | null = null;
    try {
      const executable = join(rRoot, 'bin/exec/R');
      const code = `status <- system(paste("printf denied >", shQuote(Sys.getenv("ROC_OUTSIDE"))), intern=FALSE)
stopifnot(status != 0L)
system("set -m; (trap '' HUP TERM; while :; do :; done) >/dev/null 2>&1 & printf '%s' $! > child.pid; exit 0", intern=FALSE)
cat("group_verified")`;
      const result = await runRExperimentProcess({ ...rExperimentCommand(rRoot, executable, ['--vanilla', '--slave', '-e', code]),
        cwd: job, readablePaths: [rRoot], writablePaths: [job], additionalExecutables: [executable], environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', ROC_OUTSIDE: join(outside, 'denied.txt') },
        timeoutMs: 10000, networkAccess: 'none', allowPosixSpawn: false, allowOcrAcceleration: false }, runResearchProcess);
      expect(result).toMatchObject({ exitCode: 0, stdout: 'group_verified' });
      child = Number(await readFile(join(job, 'child.pid'), 'utf8'));
      expect(child).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(child!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })));
      await expect(readFile(join(outside, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child !== null) { try { process.kill(child, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      await rm(job, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
    }
  });
});
