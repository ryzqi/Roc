import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const exec = promisify(execFile);
const { runResearchProcess } = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', { platform: 'node' });
let root, executable, metalExecutable;
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
#include <netdb.h>
#include <fcntl.h>
#include <spawn.h>
#include <sys/stat.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
extern char **environ;
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  if (strcmp(argv[1], "fileflood") == 0 || strcmp(argv[1], "totalflood") == 0 || strcmp(argv[1], "manyfiles") == 0 ||
      strcmp(argv[1], "manyentries") == 0 || strcmp(argv[1], "hardlink") == 0 || strcmp(argv[1], "logflood") == 0) {
    printf("group=%d\\n", getpgrp()); fflush(stdout);
  }
  if (strcmp(argv[1], "fileflood") == 0) {
    int fd = open(argv[2], O_WRONLY | O_CREAT, 0600); if (fd < 0) return 8;
    char data[4096]; memset(data, 'x', sizeof(data));
    for (int index = 0; index < 32; index++) if (write(fd, data, sizeof(data)) != sizeof(data)) return 9;
    close(fd); printf("writtenBytes=131072\\n"); return 0;
  }
  if (strcmp(argv[1], "manyfiles") == 0 || strcmp(argv[1], "manyentries") == 0) {
    for (int index = 0; index < 16; index++) {
      char path[4096]; snprintf(path, sizeof(path), "%s-%d", argv[2], index);
      if (strcmp(argv[1], "manyentries") == 0) { if (mkdir(path, 0700) != 0) return 10; }
      else { int fd = open(path, O_WRONLY | O_CREAT, 0600); if (fd < 0) return 11; close(fd); }
    }
    printf("createdEntries=16\\n"); return 0;
  }
  if (strcmp(argv[1], "totalflood") == 0) {
    for (int index = 0; index < 8; index++) {
      char path[4096], data[8192]; memset(data, 'x', sizeof(data)); snprintf(path, sizeof(path), "%s-%d", argv[2], index);
      int fd = open(path, O_WRONLY | O_CREAT, 0600); if (fd < 0) return 13;
      if (write(fd, data, sizeof(data)) != sizeof(data)) return 14; close(fd);
    }
    printf("writtenBytes=65536\\n"); return 0;
  }
  if (strcmp(argv[1], "hardlink") == 0) {
    int fd = open(argv[2], O_WRONLY | O_CREAT, 0600); if (fd < 0) return 12; close(fd);
    char path[4096]; snprintf(path, sizeof(path), "%s-link", argv[2]);
    printf("hardlinkCreated=%d\\n", link(argv[2], path) == 0); return 0;
  }
  if (strcmp(argv[1], "logflood") == 0) {
    signal(SIGTERM, SIG_IGN);
    for (int index = 0; index < 262144; index++) putchar('x');
    fflush(stdout); sleep(10); return 0;
  }
  if (strcmp(argv[1], "dns") == 0) {
    struct addrinfo *address = NULL;
    int result = getaddrinfo("example.com", NULL, NULL, &address);
    printf("dnsCode=%d errno=%d\\n", result, errno);
    if (address != NULL) freeaddrinfo(address);
    return 0;
  }
  if (strcmp(argv[1], "credentials") == 0) { printf("credentialPresent=%d\\n", getenv("OPENAI_API_KEY") != NULL); return 0; }
  if (strcmp(argv[1], "files") == 0 && argc == 5) {
    int input = open(argv[2], O_RDONLY); int readable = input >= 0; if (input >= 0) close(input);
    int modified = open(argv[2], O_WRONLY); int inputDenied = modified < 0 && errno == EPERM; if (modified >= 0) close(modified);
    int secret = open(argv[3], O_RDONLY); int secretDenied = secret < 0 && errno == EPERM; if (secret >= 0) close(secret);
    int traversal = open(argv[3], O_WRONLY); int traversalDenied = traversal < 0 && errno == EPERM; if (traversal >= 0) close(traversal);
    int output = open(argv[4], O_WRONLY | O_CREAT, 0600); int writable = output >= 0; if (output >= 0) close(output);
    printf("inputRead=%d inputWriteDenied=%d secretReadDenied=%d traversalWriteDenied=%d outputWrite=%d\\n",
      readable, inputDenied, secretDenied, traversalDenied, writable); return 0;
  }
  if (strcmp(argv[1], "link") == 0 && argc == 4) {
    int linked = symlink(argv[2], argv[3]) == 0;
    int input = open(argv[3], O_RDONLY); int denied = input < 0 && errno == EPERM; if (input >= 0) close(input);
    printf("linkCreated=%d linkReadDenied=%d\\n", linked, denied); return 0;
  }
  if (strcmp(argv[1], "pgchild") == 0) { printf("changedGroup=%d\\n", getpgrp() != atoi(argv[2])); return 0; }
  if (strcmp(argv[1], "escape") == 0) {
    pid_t child = fork(); if (child < 0) return 7;
    if (child == 0) {
      int group = setpgid(0, getpgrp()); int groupDenied = group < 0 && errno == EPERM;
      int session = setsid(); int sessionDenied = session < 0 && errno == EPERM;
      printf("setpgidDenied=%d setsidDenied=%d\\n", groupDenied, sessionDenied); fflush(stdout); _exit(0);
    }
    waitpid(child, NULL, 0);
    posix_spawnattr_t attr; posix_spawnattr_init(&attr);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP); posix_spawnattr_setpgroup(&attr, 0);
    char group[32]; snprintf(group, sizeof(group), "%d", getpgrp()); char *args[] = {argv[0], "pgchild", group, NULL};
    int result = posix_spawn(&child, argv[0], NULL, &attr, args, environ);
    printf("spawnDenied=%d\\n", result == EPERM); posix_spawnattr_destroy(&attr); if (result == 0) waitpid(child, NULL, 0); return 0;
  }
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
  const metalSource = join(root, 'metal.m');
  metalExecutable = join(root, 'metal');
  await writeFile(metalSource, `
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdio.h>
int main(void) { @autoreleasepool {
  id<MTLDevice> device = MTLCreateSystemDefaultDevice(); id<MTLCommandQueue> queue = [device newCommandQueue];
  printf("deviceFound=%d queueFound=%d deviceName=%s\\n", device != nil, queue != nil, device == nil ? "none" : [[device name] UTF8String]);
} return 0; }
`);
  await exec('/usr/bin/clang', ['-fobjc-arc', metalSource, '-framework', 'Foundation', '-framework', 'Metal', '-o', metalExecutable],
    { timeout: 30000, maxBuffer: 1024 * 1024 });
});
after(async () => {
  const directory = join(process.cwd(), '.artifacts/research-optimization/xsafe-a5');
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
      writeLimits: [{ path: output, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxFiles: 100, maxEntries: 200 }],
      resourceLimits: { mode: 'monitored', cpuTimeMs: 5000, maxResidentBytes: 128 * 1024 * 1024 },
      admission: { projectId: 'native-resource-test', priority: 'user', resourceClass: 'compute' },
      allowGpuAcceleration: false, networkAccess: 'none', ...overrides
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

test('real process admission prioritizes foreground once, then runs the waiting background process ahead of later foreground', async () => {
  const jobs = [];
  const enqueue = async (projectId, priority) => {
    const controller = new AbortController();
    const f = await request('wait', { admission: { projectId, priority, resourceClass: 'compute' }, signal: controller.signal });
    const promise = runResearchProcess(f.input).then(result => ({ result }), error => ({ error }));
    const job = { ...f, controller, promise };
    jobs.push(job); return job;
  };
  try {
    const a = await enqueue('a', 'user'), b = await enqueue('b', 'user');
    const aIds = await pids(a.marker), bIds = await pids(b.marker);
    const background = await enqueue('background', 'background');
    const firstUser = await enqueue('firstUser', 'user'), laterUser = await enqueue('laterUser', 'user');
    await assert.rejects(readFile(background.marker), { code: 'ENOENT' });
    await assert.rejects(readFile(firstUser.marker), { code: 'ENOENT' });
    a.controller.abort(); await a.promise; await gone(aIds);
    const firstIds = await pids(firstUser.marker);
    await assert.rejects(readFile(background.marker), { code: 'ENOENT' });
    await assert.rejects(readFile(laterUser.marker), { code: 'ENOENT' });
    firstUser.controller.abort(); await firstUser.promise; await gone(firstIds);
    const backgroundIds = await pids(background.marker);
    await assert.rejects(readFile(laterUser.marker), { code: 'ENOENT' });
    background.controller.abort(); const completedBackground = await background.promise; await gone(backgroundIds);
    const laterIds = await pids(laterUser.marker);
    laterUser.controller.abort(); b.controller.abort();
    await laterUser.promise; await b.promise; await gone([...laterIds, ...bIds]);
    assert.ok(completedBackground.error.admission.waitMs > 0);
    assert.ok(completedBackground.error.admission.holdMs > 0);
    receipts.push({ scenario: 'real-fair-admission', order: ['firstUser', 'background', 'laterUser'],
      backgroundAdmission: completedBackground.error.admission });
  } finally {
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map(job => job.promise));
  }
});

test('cancelling a queued same-project process launches no code and does not cancel its active peer', async () => {
  const activeController = new AbortController(), queuedController = new AbortController();
  const active = await request('wait', { signal: activeController.signal });
  const activePromise = runResearchProcess(active.input).catch(error => error);
  try {
    const ids = await pids(active.marker);
    const queued = await request('wait', { signal: queuedController.signal });
    const queuedPromise = runResearchProcess(queued.input);
    queuedController.abort();
    await assert.rejects(queuedPromise, /research_process_cancelled/);
    await assert.rejects(readFile(queued.marker), { code: 'ENOENT' });
    for (const pid of ids) assert.doesNotThrow(() => process.kill(pid, 0));
    activeController.abort(); await activePromise; await gone(ids);
    receipts.push({ scenario: 'queued-cancel', launched: false, activePeerPreserved: true });
  } finally { activeController.abort(); await activePromise; }
});

test('real DNS resolution and application credentials are unavailable to the compute process', async () => {
  const control = await exec(executable, ['dns', 'unused'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.match(control.stdout, /dnsCode=0 /);
  const dns = await request('dns');
  const denied = await runResearchProcess(dns.input);
  assert.match(denied.stdout, /dnsCode=[1-9]\d* errno=1/);
  const previousKey = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = `fixture-${randomUUID()}`;
    const credentialControl = await exec(executable, ['credentials', 'unused'], { timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.match(credentialControl.stdout, /credentialPresent=1/);
    const credentials = await request('credentials');
    const isolated = await runResearchProcess(credentials.input);
    assert.match(isolated.stdout, /credentialPresent=0/);
    receipts.push({ scenario: 'dns-and-credentials', dnsControl: control.stdout, dnsDenied: denied.stdout, credentials: isolated.stdout });
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('real file boundaries allow declared reads and outputs while denying input mutation and undeclared traversal', async () => {
  const source = join(root, 'declared-input'), secret = join(root, 'synthetic-private-secret');
  await writeFile(source, 'controlled input'); await writeFile(secret, 'controlled private fixture');
  const f = await request('files');
  const output = join(f.input.cwd, 'created');
  const result = await runResearchProcess({ ...f.input,
    args: ['files', source, join(f.input.cwd, '..', 'synthetic-private-secret'), output],
    readablePaths: [...f.input.readablePaths, source]
  });
  assert.equal(result.stdout.trim(), 'inputRead=1 inputWriteDenied=1 secretReadDenied=1 traversalWriteDenied=1 outputWrite=1');
  assert.equal(await readFile(source, 'utf8'), 'controlled input');
  assert.equal(await readFile(secret, 'utf8'), 'controlled private fixture');
  assert.equal((await readFile(output)).length, 0);
  receipts.push({ scenario: 'file-boundaries', output: result.stdout });
});

test('an output symlink cannot read undeclared data and fails the real monitored output contract', async () => {
  const secret = join(root, 'link-private-secret'); await writeFile(secret, 'controlled protected fixture');
  const f = await request('link');
  let failure;
  await runResearchProcess({ ...f.input, args: ['link', secret, join(f.input.cwd, 'escape')],
    writeLimits: [{ path: f.input.cwd, maxFileBytes: 1024, maxTotalBytes: 4096, maxFiles: 20, maxEntries: 20 }]
  }).catch(error => { failure = error; });
  assert.equal(failure?.code, 'research_process_write_limit');
  assert.match(failure.stdout, /linkCreated=1 linkReadDenied=1/);
  assert.equal(await readFile(secret, 'utf8'), 'controlled protected fixture');
  receipts.push({ scenario: 'output-symlink', code: failure.code, output: failure.stdout });
});

test('real child session/group changes and atomic posix_spawn group escape are denied', async () => {
  const control = await exec(executable, ['escape', 'unused'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.match(control.stdout, /setpgidDenied=0 setsidDenied=0/); assert.match(control.stdout, /changedGroup=1/);
  const f = await request('escape');
  const result = await runResearchProcess(f.input);
  assert.match(result.stdout, /setpgidDenied=1 setsidDenied=1/);
  assert.match(result.stdout, /spawnDenied=1/); assert.doesNotMatch(result.stdout, /changedGroup=1/);
  receipts.push({ scenario: 'group-escape-denied', output: result.stdout });
});

test('actual Metal device and command queue access require the explicit GPU policy', async () => {
  const control = await exec(metalExecutable, [], { timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.match(control.stdout, /deviceFound=1 queueFound=1/);
  const f = await request('unused', { command: metalExecutable, args: [],
    readablePaths: [metalExecutable, '/usr/lib', '/System/Library'] });
  const denied = await runResearchProcess(f.input);
  assert.match(denied.stdout, /deviceFound=0 queueFound=0 deviceName=none/);
  const allowed = await runResearchProcess({ ...f.input, allowGpuAcceleration: true });
  assert.match(allowed.stdout, /deviceFound=1 queueFound=1 deviceName=.+/);
  receipts.push({ scenario: 'explicit-gpu', platform: process.platform, architecture: process.arch, kernelRelease: release(),
    denied: denied.stdout, allowed: allowed.stdout, admission: allowed.admission });
});

test('missing or incomplete write limits refuse execution before any file is created', async () => {
  const missing = await request('fileflood');
  await assert.rejects(runResearchProcess({ ...missing.input, writeLimits: undefined }), /research_process_write_limits_required/);
  await assert.rejects(readFile(missing.marker), { code: 'ENOENT' });
  const uncovered = await request('fileflood');
  await assert.rejects(runResearchProcess({ ...uncovered.input, writeLimits: [] }), /research_process_write_limit_invalid/);
  await assert.rejects(readFile(uncovered.marker), { code: 'ENOENT' });
  const partial = await request('fileflood'), secondOutput = await mkdtemp(join(root, 'uncovered-'));
  const secondMarker = join(secondOutput, 'pids');
  await assert.rejects(runResearchProcess({ ...partial.input, args: ['fileflood', secondMarker],
    writablePaths: [...partial.input.writablePaths, secondOutput] }), /research_process_write_limit_invalid/);
  await assert.rejects(readFile(secondMarker), { code: 'ENOENT' });
  receipts.push({ scenario: 'required-write-path-coverage', launched: false });
});

for (const [mode, limits, output] of [
  ['fileflood', { maxFileBytes: 16384 }, 'writtenBytes=131072'],
  ['totalflood', { maxFileBytes: 16384, maxTotalBytes: 16384 }, 'writtenBytes=65536'],
  ['manyfiles', { maxFiles: 8 }, 'createdEntries=16'],
  ['manyentries', { maxEntries: 8 }, 'createdEntries=16'],
  ['hardlink', {}, 'hardlinkCreated=1']
]) {
  test(`real ${mode} violates the monitored output contract and is rejected after confirmed process cleanup`, async () => {
    const f = await request(mode), configured = { ...f.input.writeLimits[0], ...limits };
    let failure;
    await runResearchProcess({ ...f.input, writeLimits: [configured] }).catch(error => { failure = error; });
    assert.equal(failure?.code, 'research_process_write_limit');
    assert.match(failure.stdout, new RegExp(output));
    assert.ok(failure.admission.holdMs > 0);
    const group = /^group=(\d+)\n/u.exec(failure.stdout);
    assert.ok(group); assert.throws(() => process.kill(-Number(group[1]), 0), { code: 'ESRCH' });
    receipts.push({ scenario: mode, code: failure.code, output: failure.stdout,
      configured, resources: failure.resourceUsage, admission: failure.admission });
  });
}

test('real log flooding preserves at most the declared combined byte cap and terminates computation', async () => {
  const f = await request('logflood');
  let failure;
  await runResearchProcess({ ...f.input, maxOutputBytes: 4096 }).catch(error => { failure = error; });
  assert.equal(failure?.code, 'research_process_output_limit');
  assert.equal(Buffer.byteLength(failure.stdout) + Buffer.byteLength(failure.stderr), 4096);
  assert.ok(failure.admission.holdMs > 0);
  assert.ok(failure.admission.holdMs < 750, `log flood cleanup exceeded the resource-stop grace: ${failure.admission.holdMs}ms`);
  const group = /^group=(\d+)\n/u.exec(failure.stdout);
  assert.ok(group); assert.throws(() => process.kill(-Number(group[1]), 0), { code: 'ESRCH' });
  receipts.push({ scenario: 'logflood', code: failure.code, capturedBytes: 4096,
    resources: failure.resourceUsage, admission: failure.admission });
});
