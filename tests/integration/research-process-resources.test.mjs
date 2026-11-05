import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const exec = promisify(execFile);
const { runResearchProcess } = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', { platform: 'node' });
let root, executable;
const receipts = [];

before(async () => {
  assert.equal(process.platform, 'darwin');
  root = await mkdtemp('/private/tmp/roc-research-resources-');
  executable = join(root, 'probe');
  const source = join(root, 'probe.c');
  await writeFile(source, `
#include <unistd.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (strcmp(argv[1], "network") == 0) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 3;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET; address.sin_port = htons(atoi(argv[2]));
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
    printf("connect=%d errno=%d\\n", result, errno); close(fd);
    return result < 0 ? 0 : 4;
  }
  if (strcmp(argv[1], "normal") == 0) { usleep(500000); puts("complete"); return 0; }
  pid_t child = fork();
  if (child < 0) return 4;
  if (child == 0) {
    if (strcmp(argv[1], "memory") == 0) {
      volatile char *data = malloc(64 * 1024 * 1024);
      if (data == NULL) return 5;
      for (int i = 0; i < 64 * 1024 * 1024; i += 4096) data[i] = 1;
      for (;;) usleep(10000);
    }
    if (strcmp(argv[1], "cpu") == 0) { volatile unsigned long n = 0; for (;;) n++; }
    for (;;) usleep(10000);
  }
  FILE *file = fopen(argv[2], "w");
  if (file == NULL) return 6;
  fprintf(file, "%d %d", getpid(), child); fclose(file);
  if (strcmp(argv[1], "orphan") == 0) { usleep(300000); return 0; }
  for (;;) usleep(10000);
}
`);
  await exec('/usr/bin/clang', ['-O0', source, '-o', executable], { timeout: 30000, maxBuffer: 1024 * 1024 });
});
after(async () => {
  const directory = join(process.cwd(), '.artifacts/research-optimization/xsafe-a1');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'native-resources.json'), JSON.stringify({
    backend: 'macos-seatbelt', cpuHardLimit: false, memoryHardLimit: false,
    accounting: 'sampled live process CPU high-water and sum of resident sets', receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true });
});

async function request(mode, overrides = {}) {
  const output = await mkdtemp(join(root, 'run-'));
  const marker = join(output, 'pids');
  return {
    marker,
    input: {
      command: executable, args: [mode, marker], cwd: output, readablePaths: [executable, '/usr/lib', '/System/Library'],
      writablePaths: [output], environment: { PATH: '/usr/bin:/bin' }, timeoutMs: 10000,
      resourceLimits: { mode: 'monitored', cpuTimeMs: 5000, maxResidentBytes: 128 * 1024 * 1024 },
      allowGpuAcceleration: false, networkAccess: 'none', allowPosixSpawn: false, ...overrides
    }
  };
}

async function pids(marker) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    try { return (await readFile(marker, 'utf8')).split(' ').map(Number); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('native_process_marker_timeout');
}

async function gone(ids) {
  for (const pid of ids) {
    const end = Date.now() + 2000;
    let missing = false;
    while (Date.now() < end) {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal(error.code, 'ESRCH'); missing = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(missing, true, `process ${pid} remains`);
  }
}

test('actual monitored process reports observed group resources and retains denied network policy', async () => {
  const normal = await request('normal');
  const result = await runResearchProcess(normal.input);
  assert.equal(result.exitCode, 0); assert.equal(result.stdout.trim(), 'complete');
  assert.ok(result.resourceUsage.samples > 0); assert.ok(result.resourceUsage.peakResidentBytes > 0);
  receipts.push({ scenario: 'normal', usage: result.resourceUsage });
  let connections = 0;
  const server = createServer(socket => { connections += 1; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const network = await request('network', { args: ['network', String(server.address().port)] });
    const denied = await runResearchProcess(network.input);
    assert.equal(denied.exitCode, 0); assert.match(denied.stdout, /connect=-1 errno=(1|13)/);
    assert.equal(connections, 0);
    receipts.push({ scenario: 'network-denied', output: denied.stdout, connections });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('CPU limit measures the busy descendant and terminates the whole real process group', async () => {
  const f = await request('cpu', { resourceLimits: { mode: 'monitored', cpuTimeMs: 150, maxResidentBytes: 128 * 1024 * 1024 } });
  let failure;
  const result = runResearchProcess(f.input).catch(error => { failure = error; });
  const ids = await pids(f.marker);
  await result;
  assert.equal(failure?.code, 'research_process_cpu_limit');
  assert.ok(failure.resourceUsage.observedCpuTimeMs > 150); await gone(ids);
  receipts.push({ scenario: 'descendant-cpu-limit', usage: failure.resourceUsage });
});

test('resident threshold observes the allocating descendant and terminates real memory pressure', async () => {
  const f = await request('memory', { resourceLimits: { mode: 'monitored', cpuTimeMs: 5000, maxResidentBytes: 8 * 1024 * 1024 } });
  let failure;
  const result = runResearchProcess(f.input).catch(error => { failure = error; });
  const ids = await pids(f.marker);
  await result;
  assert.equal(failure?.code, 'research_process_memory_limit');
  assert.ok(failure.resourceUsage.peakResidentBytes > 8 * 1024 * 1024); await gone(ids);
  receipts.push({ scenario: 'descendant-memory-limit', usage: failure.resourceUsage });
});

test('normal leader exit cleans descendants holding stdout before the process timeout', async () => {
  const f = await request('orphan'), started = Date.now();
  const result = await runResearchProcess(f.input);
  assert.equal(result.exitCode, 0); assert.ok(Date.now() - started < 3000);
  await gone(await pids(f.marker));
  receipts.push({ scenario: 'leader-exit', elapsedMs: Date.now() - started, usage: result.resourceUsage });
});

test('actual cancellation and timeout clean descendants and retain distinct terminal reasons', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const controller = new AbortController();
    const f = await request('wait', { signal: controller.signal, timeoutMs: mode === 'timeout' ? 500 : 10000 });
    let failure;
    const result = runResearchProcess(f.input).catch(error => { failure = error; });
    const ids = await pids(f.marker);
    if (mode === 'cancel') controller.abort();
    await result;
    assert.equal(failure?.code, `research_process_${mode === 'cancel' ? 'cancelled' : 'timeout'}`); await gone(ids);
    receipts.push({ scenario: mode, usage: failure.resourceUsage });
  }
});

test('hard CPU and memory requirements are refused before launching any code', async () => {
  const f = await request('cpu', { resourceLimits: { mode: 'hard', cpuTimeMs: 1000, maxResidentBytes: 1024 ** 3 } });
  await assert.rejects(runResearchProcess(f.input), /research_process_hard_limits_unsupported/);
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  receipts.push({ scenario: 'hard-limits-refused', requests: 0 });
});
