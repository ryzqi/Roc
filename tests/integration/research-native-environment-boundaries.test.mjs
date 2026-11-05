import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi } from '../unit/fixtures/research-test-kit.mjs';

const exec = promisify(execFile);
let api, root, runtimeRoot, workspace, toolsRoot, packageRoot;
const receipts = [];
before(async () => {
  api = await loadResearchTestApi();
  root = await realpath(await mkdtemp('/private/tmp/roc-native-env-boundary-'));
  runtimeRoot = join(root, 'runtime'); workspace = join(root, 'workspace'); toolsRoot = join(root, 'tools');
  for (const path of [join(runtimeRoot, 'bin/exec'), join(workspace, 'library'), join(workspace, 'renv'), toolsRoot]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(workspace, 'renv.lock'), '{"R":{"Version":"C-boundary-probe"},"Packages":{}}');
  await writeFile(join(workspace, 'renv/settings.json'), '{}');
  await writeFile(join(workspace, 'undeclared.txt'), 'synthetic private project fixture');
  packageRoot = join(root, 'cache/FixturePkg');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'DESCRIPTION'), 'Package: FixturePkg\nVersion: 1.0.0\n');
  await symlink(packageRoot, join(workspace, 'library/FixturePkg'), 'dir');
  const source = join(root, 'probe.c');
  await writeFile(source, `
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
int main(void) {
  char secret[4096], lock[4096], settings[4096], description[4096];
  snprintf(secret, sizeof(secret), "%s/undeclared.txt", getenv("ROC_PROJECT_ROOT"));
  snprintf(lock, sizeof(lock), "%s/renv.lock", getenv("ROC_PROJECT_ROOT"));
  snprintf(settings, sizeof(settings), "%s/renv/settings.json", getenv("ROC_PROJECT_ROOT"));
  snprintf(description, sizeof(description), "%s/FixturePkg/DESCRIPTION", getenv("ROC_R_LIBRARY"));
  int fd = open(secret, O_RDONLY); int denied = fd < 0 && errno == EPERM; int read = fd >= 0; if (fd >= 0) close(fd);
  fd = open(lock, O_RDONLY); int lockRead = fd >= 0; if (fd >= 0) close(fd);
  fd = open(settings, O_RDONLY); int settingsRead = fd >= 0; if (fd >= 0) close(fd);
  fd = open(description, O_RDONLY); int cacheRead = fd >= 0; if (fd >= 0) close(fd);
  printf("privateRead=%d privateDenied=%d lockRead=%d settingsRead=%d cacheRead=%d\\n", read, denied, lockRead, settingsRead, cacheRead);
  FILE *report = fopen(getenv("ROC_ENVIRONMENT_REPORT"), "w"); if (report == NULL) return 4;
  fprintf(report, "\\"type\\",\\"name\\",\\"value\\"\\n");
  fprintf(report, "\\"runtime\\",\\"version\\",\\"C-boundary-probe\\"\\n");
  fprintf(report, "\\"runtime\\",\\"platform\\",\\"Darwin\\"\\n");
  fprintf(report, "\\"runtime\\",\\"architecture\\",\\"arm64\\"\\n");
  fprintf(report, "\\"runtime\\",\\"prefix\\",\\"%s\\"\\n", getenv("ROC_R_LIBRARY"));
  fprintf(report, "\\"runtime\\",\\"basePrefix\\",\\"%s\\"\\n", getenv("R_HOME"));
  fprintf(report, "\\"package\\",\\"FixturePkg\\",\\"1.0.0\\"\\n");
  fprintf(report, "\\"metadata\\",\\"%s\\",\\"\\"\\n", description);
  if (getenv("ROC_METADATA_ATTACK") != NULL) fprintf(report, "\\"metadata\\",\\"%s\\",\\"\\"\\n", secret);
  fclose(report); return 0;
}
`);
  await exec('/usr/bin/clang', ['-O0', source, '-o', join(runtimeRoot, 'bin/exec/R')], { timeout: 30000, maxBuffer: 1024 * 1024 });
});
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/xsafe-a7a');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'native-environment.json'), JSON.stringify({
    backend: 'macos-seatbelt', adapter: 'R environment launcher with synthetic C probe',
    actualRRuntimeTested: false, actualJuliaRuntimeTested: false, receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true }); api.dispose();
});

async function inspect(attack) {
  const jobDir = await mkdtemp(join(root, 'job-'));
  let result;
  const promise = api.inspectNativeExperimentEnvironment({
    workspace, runtime: { kind: 'renv', rootPath: runtimeRoot, libraryPath: 'library' }, jobDir,
    tools: { root: toolsRoot, hash: 'a'.repeat(64), environment: { PATH: '/usr/bin:/bin' } },
    signal: new AbortController().signal, admission: { projectId: 'native-environment-boundary', priority: 'user' },
    onProbe: receipt => receipts.push({ scenario: attack ? 'forged-project-metadata' : 'declared-lock-only', probe: receipt }),
    run: async request => {
      result = await api.runResearchProcess(attack ? { ...request, environment: { ...request.environment, ROC_METADATA_ATTACK: '1' } } : request);
      receipts.push({ scenario: attack ? 'forged-project-metadata' : 'declared-lock-only', output: result.stdout,
        resources: result.resourceUsage, admission: result.admission });
      return result;
    }
  });
  return { promise, output: () => result.stdout };
}

test('actual R launch sandbox reads declared lock/settings and denies undeclared project data during environment inspection', async () => {
  const probe = await inspect(false);
  const prepared = await probe.promise;
  assert.equal(prepared.snapshot.runtime.kind, 'renv');
  assert.equal(prepared.snapshot.lockFiles.length, 2);
  assert.equal(probe.output().trim(), 'privateRead=0 privateDenied=1 lockRead=1 settingsRead=1 cacheRead=1');
  assert.equal(prepared.readablePaths.includes(workspace), false);
  assert.equal(prepared.readablePaths.includes(packageRoot), true);
  assert.deepEqual(prepared.snapshot.packages, [{ name: 'FixturePkg', version: '1.0.0' }]);
});

test('a forged environment report cannot make the main process read undeclared project files as package metadata', async () => {
  const probe = await inspect(true);
  await assert.rejects(probe.promise, /research_experiment_metadata_outside_scope/);
  assert.match(probe.output(), /privateRead=0 privateDenied=1/);
});
