import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi } from '../unit/fixtures/research-test-kit.mjs';

const exec = promisify(execFile);
let api, root, runtimeRoot, toolsRoot;
const receipts = [];
before(async () => {
  api = await loadResearchTestApi();
  root = await realpath(await mkdtemp('/private/tmp/roc-julia-boundary-'));
  runtimeRoot = join(root, 'runtime'); toolsRoot = join(root, 'tools');
  await mkdir(join(runtimeRoot, 'bin'), { recursive: true }); await mkdir(toolsRoot);
  const source = join(root, 'probe.c');
  await writeFile(source, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) if (strcmp(argv[i], "--version") == 0) { puts("julia version 1.13.1"); return 0; }
  const char *names[] = {"undeclared.txt", "JuliaProject.toml", "Manifest-v1.13.toml", "nested/Project.toml", "local/JuliaProject.toml", "local/private.txt", "Manifest.toml"};
  for (int i = 0; i < 7; i++) {
    char path[4096]; snprintf(path, sizeof(path), "%s/%s", getenv("ROC_PROJECT_ROOT"), names[i]);
    int fd = open(path, O_RDONLY); int denied = fd < 0 && errno == EPERM;
    printf("file%dRead=%d file%dDenied=%d\\n", i, fd >= 0, i, denied);
    if (fd >= 0) close(fd);
  }
  FILE *report = fopen(getenv("ROC_ENVIRONMENT_REPORT"), "w"); if (report == NULL) return 4;
  fprintf(report, "{\\"version\\":\\"1.13.1\\",\\"platform\\":\\"Darwin\\",\\"architecture\\":\\"arm64\\",\\"prefix\\":\\"%s\\",\\"basePrefix\\":\\"%s\\",\\"packages\\":[{\\"name\\":\\"LocalFixture\\",\\"versions\\":[\\"1.0.0\\"]}],\\"metadataPaths\\":%s,\\"controls\\":%s}",
    getenv("ROC_JULIA_DEPOT"), getenv("ROC_FIXTURE_RUNTIME"), getenv("ROC_FIXTURE_METADATA"), getenv("ROC_FIXTURE_CONTROLS"));
  fclose(report); return 0;
}
`);
  await exec('/usr/bin/clang', ['-O0', source, '-o', join(runtimeRoot, 'bin/julia')], { timeout: 30000, maxBuffer: 1024 * 1024 });
});
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/xsafe-a7b');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'native-environment.json'), JSON.stringify({
    backend: 'macos-seatbelt', adapter: 'Julia version/environment adapter with synthetic C executable',
    actualRRuntimeTested: false, actualJuliaRuntimeTested: false, receipts
  }, null, 2));
  await rm(root, { recursive: true, force: true }); api.dispose();
});

async function fixture(attack = null) {
  const workspace = await mkdtemp(join(root, 'workspace-')), jobDir = await mkdtemp(join(root, 'job-'));
  const depot = await mkdtemp(join(root, 'depot-'));
  await mkdir(join(workspace, 'nested')); await mkdir(join(workspace, 'local'));
  const files = new Map([
    ['JuliaProject.toml', 'name = "Fixture"\n[workspace]\nprojects = ["nested"]\n[sources.LocalFixture]\npath = "local"\n'],
    ['Manifest-v1.13.toml', 'julia_version = "1.13.1"\nmanifest_format = "2.0"\n[[deps.LocalFixture]]\npath = "local"\nuuid = "718ebc78-342b-4bf8-9e22-5f6532b593b0"\nversion = "1.0.0"\n'],
    ['nested/Project.toml', 'name = "NestedFixture"\n'],
    ['local/JuliaProject.toml', 'name = "LocalFixture"\nversion = "1.0.0"\n'],
    ['undeclared.txt', 'synthetic private data'],
    ['local/private.txt', 'synthetic private package data'],
    ['Manifest.toml', 'julia_version = "1.12.0"\nmanifest_format = "2.0"\n']
  ]);
  for (const [path, content] of files) await writeFile(join(workspace, path), content);
  const controlPaths = ['JuliaProject.toml', 'Manifest-v1.13.toml', 'nested/Project.toml'];
  const controls = controlPaths.map(path => ({ path: join(workspace, path), sha256: createHash('sha256').update(files.get(path)).digest('hex') }));
  if (attack === 'controls') controls.push({ path: join(workspace, 'undeclared.txt'), sha256: createHash('sha256').update(files.get('undeclared.txt')).digest('hex') });
  if (attack === 'omitted') controls.pop();
  if (attack === 'hash') controls[0].sha256 = 'b'.repeat(64);
  if (attack === 'duplicate') controls.push(controls[0]);
  const metadata = [join(workspace, attack === 'metadata' ? 'local/private.txt' : 'local/JuliaProject.toml')];
  const calls = [];
  const inspect = () => api.inspectNativeExperimentEnvironment({
    workspace, runtime: { kind: 'julia', rootPath: runtimeRoot, depotPath: depot }, jobDir,
    tools: { root: toolsRoot, hash: 'a'.repeat(64), environment: { PATH: '/usr/bin:/bin',
      ROC_FIXTURE_RUNTIME: runtimeRoot, ROC_FIXTURE_CONTROLS: JSON.stringify(controls), ROC_FIXTURE_METADATA: JSON.stringify(metadata) } },
    signal: new AbortController().signal, admission: { projectId: 'julia-environment-boundary', priority: 'user' },
    onProbe: receipt => receipts.push({ scenario: attack ?? 'declared-controls', probe: receipt }),
    run: async request => {
      const result = await api.runResearchProcess(request);
      calls.push({ args: request.args, readablePaths: request.readablePaths, output: result.stdout });
      receipts.push({ scenario: attack ?? 'declared-controls', args: request.args.filter((arg, index) => request.args[index - 1] !== '-e'),
        output: result.stdout, resources: result.resourceUsage, admission: result.admission });
      if (!request.args.includes('--version') && attack === 'control-drift') await writeFile(join(workspace, 'JuliaProject.toml'), 'name = "Changed"\n');
      if (!request.args.includes('--version') && attack === 'metadata-drift') await writeFile(join(workspace, 'local/JuliaProject.toml'), 'name = "LocalFixture"\nversion = "2.0.0"\n');
      return result;
    }
  });
  return { workspace, calls, inspect };
}

test('Julia inspection reads version-selected controls and local package metadata while denying undeclared workspace/package data', async () => {
  const f = await fixture();
  const prepared = await f.inspect();
  assert.equal(prepared.snapshot.version, '1.13.1');
  assert.deepEqual(prepared.snapshot.lockFiles.map(file => file.path), ['JuliaProject.toml', 'Manifest-v1.13.toml', 'nested/Project.toml']);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].args.includes('--version'));
  assert.equal(f.calls[0].readablePaths.includes(f.workspace), false);
  assert.match(f.calls[1].output, /file0Read=0 file0Denied=1/);
  for (const index of [1, 2, 3, 4]) assert.match(f.calls[1].output, new RegExp(`file${index}Read=1`));
  for (const index of [5, 6]) assert.match(f.calls[1].output, new RegExp(`file${index}Read=0 file${index}Denied=1`));
  assert.equal(prepared.readablePaths.includes(f.workspace), false);
  assert.equal(prepared.readablePaths.includes(join(f.workspace, 'local')), false);
});

test('Julia control report cannot grant the main process access to undeclared project files', async () => {
  const f = await fixture('controls');
  await assert.rejects(f.inspect(), /research_experiment_environment_changed/);
});

test('Julia package report cannot widen exact local Project metadata access to private package data', async () => {
  const f = await fixture('metadata');
  await assert.rejects(f.inspect(), /research_experiment_metadata_outside_scope/);
});

test('Julia control report must contain the entire frozen declared control set', async () => {
  const f = await fixture('omitted');
  await assert.rejects(f.inspect(), /research_experiment_environment_changed/);
});

test('Julia reports cannot change a frozen control hash or duplicate a control', async () => {
  for (const attack of ['hash', 'duplicate']) {
    const f = await fixture(attack);
    await assert.rejects(f.inspect(), /research_experiment_environment_changed/);
  }
});

test('Julia controls and local package metadata are checked against pre-probe bytes after actual native dispatch', async () => {
  for (const attack of ['control-drift', 'metadata-drift']) {
    const f = await fixture(attack);
    await assert.rejects(f.inspect(), /research_experiment_environment_changed/);
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1].output, /file0Read=0 file0Denied=1/);
  }
});
