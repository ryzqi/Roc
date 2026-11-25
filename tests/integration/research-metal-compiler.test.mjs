import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const exec = promisify(execFile);
const { runResearchProcess } = await importTypeScriptModule('src/main/plugins/research/process-runner.ts', { platform: 'node' });
let root, executable, cacheRoot;
const caches = [];
before(async () => {
  root = await realpath(await mkdtemp('/private/tmp/roc-metal-compiler-'));
  cacheRoot = await realpath((await exec('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'])).stdout.trim());
  executable = join(root, 'metal');
  const source = join(root, 'metal.m');
  await writeFile(source, `
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern int _set_user_dir_suffix(const char *);
typedef char *(*issue_fn)(const char *, const char *, unsigned int);
int main(int argc, char **argv) { @autoreleasepool {
  if (argc != 5 || _set_user_dir_suffix(argv[1]) != 1) return 2;
  void *sandbox = dlopen("/usr/lib/libsandbox.1.dylib", RTLD_NOW);
  issue_fn issue = (issue_fn)dlsym(sandbox, "sandbox_extension_issue_file");
  if (!issue) return 3;
  char *inside = issue("com.apple.app-sandbox.read-write", argv[2], 0);
  char *outside = issue("com.apple.app-sandbox.read-write", argv[3], 0);
  printf("cacheExtension=%d outsideExtension=%d\\n", inside != NULL, outside != NULL);
  free(inside); free(outside); fflush(stdout);
  if (strcmp(argv[4], "extensions") == 0) return 0;
  id<MTLDevice> device = MTLCreateSystemDefaultDevice();
  if (!device) return 4;
  NSError *error = nil;
  id<MTLLibrary> library = [device newLibraryWithSource:@"#include <metal_stdlib>\\nusing namespace metal; kernel void squares(device float *out [[buffer(0)]], uint i [[thread_position_in_grid]]) { out[i]=float(i*i); }" options:nil error:&error];
  if (!library) { fprintf(stderr, "%s\\n", [[error description] UTF8String]); return 5; }
  id<MTLComputePipelineState> pipeline = [device newComputePipelineStateWithFunction:[library newFunctionWithName:@"squares"] error:&error];
  if (!pipeline) return 6;
  id<MTLBuffer> output = [device newBufferWithLength:32*sizeof(float) options:MTLResourceStorageModeShared];
  id<MTLCommandQueue> queue = [device newCommandQueue];
  id<MTLCommandBuffer> command = [queue commandBuffer];
  id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
  [encoder setComputePipelineState:pipeline]; [encoder setBuffer:output offset:0 atIndex:0];
  [encoder dispatchThreads:MTLSizeMake(32,1,1) threadsPerThreadgroup:MTLSizeMake(32,1,1)];
  [encoder endEncoding]; [command commit]; [command waitUntilCompleted];
  if (command.status != MTLCommandBufferStatusCompleted) return 7;
  float *values = output.contents;
  for (int i=0; i<32; i++) if (values[i] != (float)(i*i)) return 8;
  puts("kernelVerified=1"); return 0;
} }
`);
  await exec('/usr/bin/clang', ['-fobjc-arc', source, '-framework', 'Foundation', '-framework', 'Metal', '-o', executable], { timeout: 30000 });
});
after(async () => {
  for (const cache of caches) await rm(cache, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

async function fixture(mode = 'compile') {
  const output = await mkdtemp(join(root, 'output-'));
  const cache = await mkdtemp(join(cacheRoot, 'roc-metal-test-')); caches.push(cache);
  return { cache, output, request: {
    command: executable, args: [basename(cache), cache, output, mode], cwd: output,
    readablePaths: [executable, '/usr/lib', '/System/Library'], writablePaths: [output, cache],
    environment: { PATH: '/usr/bin:/bin', HOME: output, TMPDIR: output },
    timeoutMs: 30000, resourceLimits: { mode: 'monitored', cpuTimeMs: 30000, maxResidentBytes: 512 * 1024 ** 2 },
    admission: { projectId: 'metal-compiler-test', resourceClass: 'parse', priority: 'user' },
    allowGpuAcceleration: true, metalCompilerCachePath: cache, networkAccess: 'none',
    writeLimits: [output, cache].map(path => ({ path, maxFileBytes: 64 * 1024 ** 2, maxTotalBytes: 128 * 1024 ** 2, maxFiles: 500, maxEntries: 1000 }))
  } };
}

test('Metal dynamic compilation receives a scoped extension; other writable paths cannot receive one', async () => {
  const f = await fixture();
  // System compilation caches can survive a worker. Test extension refusal
  // directly, rather than assuming every unauthorized compile is a cache miss.
  const denied = await runResearchProcess({ ...f.request, args: [...f.request.args.slice(0, 3), 'extensions'], metalCompilerCachePath: undefined });
  assert.equal(denied.exitCode, 0, denied.stderr);
  assert.match(denied.stdout, /cacheExtension=0 outsideExtension=0/);
  const allowed = await runResearchProcess(f.request);
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.match(allowed.stdout, /cacheExtension=1 outsideExtension=0/);
  assert.match(allowed.stdout, /kernelVerified=1/);
});

test('ordinary jobs cannot request Metal cache extensions and GPU jobs must explicitly own the writable cache', async () => {
  const f = await fixture('extensions');
  await assert.rejects(runResearchProcess({ ...f.request, allowGpuAcceleration: false }), /research_process_metal_cache_policy_invalid/);
  await assert.rejects(runResearchProcess({ ...f.request, metalCompilerCachePath: root }), /research_process_metal_cache_policy_invalid/);
  const ordinary = await runResearchProcess({ ...f.request, allowGpuAcceleration: false, metalCompilerCachePath: undefined });
  assert.equal(ordinary.exitCode, 0, ordinary.stderr);
  assert.match(ordinary.stdout, /cacheExtension=0 outsideExtension=0/);
});

test('Metal lock exceptions reject outside targets and output symlinks', async () => {
  const f = await fixture('extensions');
  const modules = join(f.cache, 'com.apple.metalfe', 'test'); await mkdir(modules, { recursive: true });
  const lock = join(modules, 'monolithic_metal.pcm.lock');
  await symlink(join(root, 'monolithic_metal.pcm.lock-deadbeef'), lock);
  await assert.rejects(runResearchProcess(f.request), /research_process_write_limit/);
  await rm(lock);
  await symlink(join(f.output, 'monolithic_metal.pcm.lock-deadbeef'), join(f.output, 'monolithic_metal.pcm.lock'));
  await assert.rejects(runResearchProcess(f.request), /research_process_write_limit/);
});
