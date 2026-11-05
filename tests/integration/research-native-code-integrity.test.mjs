import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi } from '../unit/fixtures/research-test-kit.mjs';

const exec = promisify(execFile);
let api, root;
const receipts = [];
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-native-code-')); });
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/xsafe-a7c');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'native-code.json'), JSON.stringify({
    backend: 'macos-seatbelt', adapter: 'R launcher with C executable loading real runtime and package dylibs',
    actualRRuntimeTested: false, actualJuliaRuntimeTested: false, receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true }); api.dispose();
});

async function dylib(directory, value, kind) {
  const scratch = await mkdtemp(join(root, 'dylib-source-'));
  try {
    const source = join(scratch, 'fixture.c');
    await writeFile(source, `int fixture_${kind}_value(void) { return ${value}; }\n`);
    const output = join(directory, `${kind}.dylib`);
    await exec('/usr/bin/clang', ['-O0', '-dynamiclib', '-install_name', output, source, '-o', output], { timeout: 30000, maxBuffer: 1024 * 1024 });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function fixture() {
  const directory = await mkdtemp(join(root, 'fixture-'));
  const workspace = join(directory, 'workspace'), runtimeRoot = join(directory, 'runtime'), toolsRoot = join(directory, 'tools'), packageRoot = join(directory, 'cache/FixturePkg');
  for (const path of [join(workspace, 'library'), join(runtimeRoot, 'bin/exec'), join(runtimeRoot, 'lib'), toolsRoot, packageRoot]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, 'renv.lock'), '{"R":{"Version":"C-code-probe"},"Packages":{}}');
  await writeFile(join(packageRoot, 'DESCRIPTION'), 'Package: FixturePkg\nVersion: 1.0.0\n');
  await symlink(packageRoot, join(workspace, 'library/FixturePkg'), 'dir');
  await dylib(join(runtimeRoot, 'lib'), 1, 'runtime'); await dylib(packageRoot, 1, 'package');
  const source = join(directory, 'probe.c');
  await writeFile(source, `
#include <stdio.h>
#include <stdlib.h>
#include <dlfcn.h>
int load_value(const char *path, const char *symbol) {
  void *library = dlopen(path, RTLD_NOW | RTLD_LOCAL | RTLD_FIRST); if (library == NULL) { fprintf(stderr, "dlopen:%s\\n", dlerror()); return -1; }
  int (*value)(void) = dlsym(library, symbol); if (value == NULL) return -2;
  return value();
}
int main(void) {
  char runtime[4096], package[4096], description[4096];
  snprintf(runtime, sizeof(runtime), "%s/lib/runtime.dylib", getenv("R_HOME"));
  snprintf(package, sizeof(package), "%s/FixturePkg/package.dylib", getenv("ROC_R_LIBRARY"));
  snprintf(description, sizeof(description), "%s/FixturePkg/DESCRIPTION", getenv("ROC_R_LIBRARY"));
  int runtime_value = load_value(runtime, "fixture_runtime_value"), package_value = load_value(package, "fixture_package_value");
  printf("runtimeValue=%d packageValue=%d\\n", runtime_value, package_value);
  if (runtime_value < 0 || package_value < 0) return 3;
  FILE *report = fopen(getenv("ROC_ENVIRONMENT_REPORT"), "w"); if (report == NULL) return 4;
  fprintf(report, "\\"type\\",\\"name\\",\\"value\\"\\n");
  fprintf(report, "\\"runtime\\",\\"version\\",\\"C-code-probe\\"\\n");
  fprintf(report, "\\"runtime\\",\\"platform\\",\\"Darwin\\"\\n");
  fprintf(report, "\\"runtime\\",\\"architecture\\",\\"arm64\\"\\n");
  fprintf(report, "\\"runtime\\",\\"prefix\\",\\"%s\\"\\n", getenv("ROC_R_LIBRARY"));
  fprintf(report, "\\"runtime\\",\\"basePrefix\\",\\"%s\\"\\n", getenv("R_HOME"));
  fprintf(report, "\\"package\\",\\"FixturePkg\\",\\"1.0.0\\"\\n");
  fprintf(report, "\\"metadata\\",\\"%s\\",\\"\\"\\n", description);
  fclose(report); return 0;
}
`);
  await exec('/usr/bin/clang', ['-O0', source, '-o', join(runtimeRoot, 'bin/exec/R')], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const inspect = async (scenario, afterRun = null) => api.inspectNativeExperimentEnvironment({
    workspace, runtime: { kind: 'renv', rootPath: runtimeRoot, libraryPath: 'library' }, jobDir: await mkdtemp(join(directory, 'job-')),
    tools: { root: toolsRoot, hash: 'a'.repeat(64), environment: { PATH: '/usr/bin:/bin' } },
    signal: new AbortController().signal, admission: { projectId: 'native-code-integrity', priority: 'user' },
    run: async request => {
      const result = await api.runResearchProcess(request);
      receipts.push({ scenario, output: result.stdout, usage: result.resourceUsage, admission: result.admission });
      if (afterRun !== null) await afterRun();
      return result;
    }
  });
  return { runtimeRoot, packageRoot, inspect };
}

test('native environment identity detects an actually loaded runtime dylib changing with executable/version/package metadata unchanged', async () => {
  const f = await fixture(), before = await f.inspect('runtime-before');
  await dylib(join(f.runtimeRoot, 'lib'), 2, 'runtime');
  const after = await f.inspect('runtime-after');
  assert.match(receipts.at(-2).output, /runtimeValue=1 packageValue=1/);
  assert.match(receipts.at(-1).output, /runtimeValue=2 packageValue=1/);
  assert.deepEqual(after.snapshot.packages, before.snapshot.packages);
  assert.deepEqual(after.snapshot.lockFiles, before.snapshot.lockFiles);
  assert.notEqual(after.snapshot.metadataHash, before.snapshot.metadataHash);
  assert.notEqual(after.snapshot.hash, before.snapshot.hash);
});

test('native environment identity detects actually loaded package code through an intentional renv cache link', async () => {
  const f = await fixture(), before = await f.inspect('package-before');
  await dylib(f.packageRoot, 2, 'package');
  const after = await f.inspect('package-after');
  assert.match(receipts.at(-1).output, /runtimeValue=1 packageValue=2/);
  assert.deepEqual(after.snapshot.packages, before.snapshot.packages);
  assert.notEqual(after.snapshot.hash, before.snapshot.hash);
});

test('native code changed after actual probe dispatch invalidates the environment instead of returning an original-metadata success', async () => {
  const f = await fixture();
  await assert.rejects(f.inspect('changed-during-probe', () => dylib(f.packageRoot, 2, 'package')), /research_experiment_native_code_changed/);
  assert.match(receipts.at(-1).output, /runtimeValue=1 packageValue=1/);
});

test('unchanged native code produces the same environment hash across independent actual probe executions', async () => {
  const f = await fixture(), before = await f.inspect('repeat-before'), after = await f.inspect('repeat-after');
  assert.equal(after.snapshot.hash, before.snapshot.hash);
});
