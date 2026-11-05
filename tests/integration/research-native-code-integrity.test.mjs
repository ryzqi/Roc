import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, symlink, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi, createResearchFixture } from '../unit/fixtures/research-test-kit.mjs';

const exec = promisify(execFile);
let api, root;
const receipts = [];
before(async () => { api = await loadResearchTestApi(); root = await realpath(await mkdtemp('/private/tmp/roc-native-code-')); });
after(async () => {
  const output = join(process.cwd(), '.artifacts/research-optimization/xsafe-a7d2');
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
#include <string.h>
int load_value(const char *path, const char *symbol) {
  void *library = dlopen(path, RTLD_NOW | RTLD_LOCAL | RTLD_FIRST); if (library == NULL) { fprintf(stderr, "dlopen:%s\\n", dlerror()); return -1; }
  int (*value)(void) = dlsym(library, symbol); if (value == NULL) return -2;
  return value();
}
int main(int argc, char **argv) {
  char runtime[4096], package[4096], description[4096];
  snprintf(runtime, sizeof(runtime), "%s/lib/runtime.dylib", getenv("R_HOME"));
  snprintf(package, sizeof(package), "%s/FixturePkg/package.dylib", getenv("R_LIBS"));
  snprintf(description, sizeof(description), "%s/FixturePkg/DESCRIPTION", getenv("R_LIBS"));
  int runtime_value = load_value(runtime, "fixture_runtime_value"), package_value = load_value(package, "fixture_package_value");
  printf("runtimeValue=%d packageValue=%d\\n", runtime_value, package_value);
  if (runtime_value < 0 || package_value < 0) return 3;
  if (getenv("ROC_ENVIRONMENT_REPORT") != NULL && getenv("ROC_FAIL_ENVIRONMENT") != NULL) return 9;
  if (getenv("ROC_ENVIRONMENT_REPORT") == NULL) {
    char output[4096]; snprintf(output, sizeof(output), "%s/actual-values.json", getenv("ROC_OUTPUT_DIR"));
    FILE *result = fopen(output, "w"); if (result == NULL) return 5;
    fprintf(result, "{\\"runtime\\":%d,\\"package\\":%d}\\n", runtime_value, package_value);
    fclose(result);
    for (int index = 1; index < argc; index++) if (strcmp(argv[index], "--fail-native") == 0) return 7;
    return 0;
  }
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
    onProbe: receipt => receipts.push({ scenario, probe: receipt }),
    run: async request => {
      const result = await api.runResearchProcess(request);
      receipts.push({ scenario, output: result.stdout, usage: result.resourceUsage, admission: result.admission });
      if (afterRun !== null) await afterRun();
      return result;
    }
  });
  return { directory, workspace, runtimeRoot, packageRoot, toolsRoot, inspect };
}

test('native environment identity detects an actually loaded runtime dylib changing with executable/version/package metadata unchanged', async () => {
  const f = await fixture(), before = await f.inspect('runtime-before');
  await dylib(join(f.runtimeRoot, 'lib'), 2, 'runtime');
  const after = await f.inspect('runtime-after');
  assert.match(receipts.findLast(entry => entry.scenario === 'runtime-before' && 'output' in entry).output, /runtimeValue=1 packageValue=1/);
  assert.match(receipts.findLast(entry => entry.scenario === 'runtime-after' && 'output' in entry).output, /runtimeValue=2 packageValue=1/);
  assert.deepEqual(after.snapshot.packages, before.snapshot.packages);
  assert.deepEqual(after.snapshot.lockFiles, before.snapshot.lockFiles);
  assert.notEqual(after.snapshot.metadataHash, before.snapshot.metadataHash);
  assert.notEqual(after.snapshot.hash, before.snapshot.hash);
});

test('native environment identity detects actually loaded package code through an intentional renv cache link', async () => {
  const f = await fixture(), before = await f.inspect('package-before');
  await dylib(f.packageRoot, 2, 'package');
  const after = await f.inspect('package-after');
  assert.match(receipts.findLast(entry => entry.scenario === 'package-after' && 'output' in entry).output, /runtimeValue=1 packageValue=2/);
  assert.deepEqual(after.snapshot.packages, before.snapshot.packages);
  assert.notEqual(after.snapshot.hash, before.snapshot.hash);
});

test('native code changed after actual probe dispatch invalidates the environment instead of returning an original-metadata success', async () => {
  const f = await fixture();
  await assert.rejects(f.inspect('changed-during-probe', () => dylib(f.packageRoot, 2, 'package')), /research_experiment_native_code_changed/);
  assert.match(receipts.findLast(entry => entry.scenario === 'changed-during-probe' && 'output' in entry).output, /runtimeValue=1 packageValue=1/);
});

test('unchanged native code produces the same environment hash across independent actual probe executions', async () => {
  const f = await fixture(), before = await f.inspect('repeat-before'), after = await f.inspect('repeat-after');
  assert.equal(after.snapshot.hash, before.snapshot.hash);
});

test('actual native experiment persists complete code receipt, excludes it from scientific indexing and binds immutable publication', async () => {
  const native = await fixture();
  await writeFile(join(native.workspace, 'analysis.R'), '# Synthetic C adapter acceptance fixture; no R language claim.\n');
  const f = createResearchFixture(api, 'experiment', native.workspace);
  const failures = [];
  const environments = new api.ResearchExperimentEnvironmentService({
    nativeRuntime: async () => ({ root: native.toolsRoot, hash: 'a'.repeat(64), environment: { PATH: '/usr/bin:/bin' } }),
    typescriptRuntime: async () => assert.fail('native fixture must not select TypeScript')
  });
  const service = new api.ResearchExperimentService(f.repository, environments, native.directory, { error: (...args) => failures.push(args) });
  try {
    const request = {
      projectId: f.project.id, ownerRunId: null, engine: 'r',
      runtime: { kind: 'renv', rootPath: native.runtimeRoot, libraryPath: 'library' },
      requestId: 'native-code-receipt', label: 'Native C adapter acceptance',
      sourcePath: 'analysis.R', inputPaths: [], arguments: [], parameters: {}, timeoutMs: 5000, network: 'disabled'
    };
    const created = await service.start(request);
    const deadline = Date.now() + 15000;
    let run;
    do {
      run = f.repository.experiments.get(f.project.id, created.id);
      if (!['preparing', 'running'].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    const logs = await Promise.all(run.files.filter(file => file.area === 'log').map(async file => ({
      file, content: (await service.read({ projectId: f.project.id, runId: run.id, area: 'log', path: file.path })).content
    })));
    receipts.push({ scenario: 'native-service-code-receipt', runId: run.id, status: run.status, error: run.error,
      environmentHash: run.environment?.hash ?? null, logs });
    assert.equal(run.status, 'completed', run.error); assert.deepEqual(failures, []);
    const result = await service.read({ projectId: f.project.id, runId: run.id, area: 'output', path: 'actual-values.json' });
    assert.deepEqual(JSON.parse(result.content), { runtime: 1, package: 1 });
    const read = await service.read({ projectId: f.project.id, runId: run.id, area: 'log', path: 'environment-code.json' });
    const resources = api.researchExperimentResourceReportSchema.parse(JSON.parse((await service.read({
      projectId: f.project.id, runId: run.id, area: 'log', path: 'resources.json'
    })).content));
    assert.equal(resources.schemaVersion, 2);
    assert.deepEqual(resources.probes.map(probe => [probe.phase, probe.kind, probe.outcome, probe.exitCode]),
      [['preparation', 'environment', 'returned', 0], ['verification', 'environment', 'returned', 0]]);
    for (const probe of resources.probes) {
      assert.ok(probe.admission.holdMs > 0);
      assert.ok(probe.policy.writeLimits.some(limit => limit.path.startsWith('/private/tmp/roc-research-r-')));
      assert.equal(probe.policy.timeoutMs, 60000); assert.equal(probe.policy.networkAccess, 'none');
    }
    const report = api.nativeCodeReportSchema.parse(JSON.parse(read.content));
    assert.equal(report.runId, run.id); assert.equal(report.projectId, f.project.id);
    assert.equal(report.inputHash, run.inputHash); assert.equal(report.environmentHash, run.environment.hash);
    api.assertNativeCodeReceipt(report.native, run.environment.metadataHash);
    assert.ok(report.native.code.entries.some(entry => entry.path === 'lib/runtime.dylib' && entry.type === 'file'));
    assert.ok(report.native.code.entries.some(entry => entry.path === 'package.dylib' && entry.type === 'file'));
    assert.ok(report.native.code.entries.some(entry => entry.type === 'symlink' && entry.resolved === native.packageRoot));
    assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_documents WHERE source_id=? AND id LIKE '%environment-code.json'").pluck().get(run.id), 0);
    const failed = await service.start({ ...request, requestId: 'native-code-failed', arguments: ['--fail-native'] });
    const failureDeadline = Date.now() + 15000;
    let failedRun;
    do {
      failedRun = f.repository.experiments.get(f.project.id, failed.id);
      if (!['preparing', 'running'].includes(failedRun.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < failureDeadline);
    const failureLogs = await Promise.all(failedRun.files.filter(file => file.area === 'log').map(async file => ({
      file, content: (await service.read({ projectId: f.project.id, runId: failed.id, area: 'log', path: file.path })).content
    })));
    receipts.push({ scenario: 'failed-native-service-code-receipt', runId: failed.id, status: failedRun.status, error: failedRun.error, logs: failureLogs });
    assert.equal(failedRun.status, 'failed'); assert.equal(failedRun.error, 'research_experiment_process_failed');
    const failedCode = api.nativeCodeReportSchema.parse(JSON.parse((await service.read({
      projectId: f.project.id, runId: failed.id, area: 'log', path: 'environment-code.json'
    })).content));
    assert.equal(failedCode.runId, failed.id); assert.equal(failedCode.inputHash, failedRun.inputHash);
    assert.equal(failedCode.environmentHash, failedRun.environment.hash);
    api.assertNativeCodeReceipt(failedCode.native, failedRun.environment.metadataHash);
    const failedResources = api.researchExperimentResourceReportSchema.parse(JSON.parse((await service.read({
      projectId: f.project.id, runId: failed.id, area: 'log', path: 'resources.json'
    })).content));
    assert.equal(failedResources.outcome, 'returned'); assert.equal(failedResources.exitCode, 7);
    assert.deepEqual(failedResources.probes.map(probe => [probe.phase, probe.kind, probe.exitCode]),
      [['preparation', 'environment', 0]]);
    await assert.rejects(service.publish(f.project.id, failed.id), /research_experiment_completed_required/);
    receipts.push({ scenario: 'failed-native-service-retains-code', runId: failed.id, error: failedRun.error, code: failedCode, resources: failedResources });
    const published = await service.publish(f.project.id, run.id);
    await service.verifyPublication(f.project.id, published.artifactId);
    const storage = f.repository.experiments.root(f.project.id, run.id);
    const manifest = JSON.parse(await readFile(join(storage, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.find(file => file.path === 'environment-code.json'), read.file);
    const exportRoot = await mkdtemp(join(native.directory, 'export-')), writer = new api.ResearchExportFiles(exportRoot);
    const exportedPath = `provenance/experiments/${run.id}/log/environment-code.json`;
    const source = { path: 'log/environment-code.json', size: read.file.size, sha256: read.file.sha256 };
    const exported = await writer.copy(storage, source, exportedPath);
    assert.equal(exported.sha256, read.file.sha256);
    assert.equal(await readFile(join(exportRoot, exportedPath), 'utf8'), read.content);
    const foreignWorkspace = await mkdtemp(join(native.directory, 'foreign-'));
    const foreign = f.repository.createProject({ title: 'Foreign project', description: '', workspacePath: foreignWorkspace });
    await assert.rejects(service.read({ projectId: foreign.id, runId: run.id, area: 'log', path: 'environment-code.json' }), /research_experiment_project_mismatch/);
    const file = join(storage, 'log/environment-code.json');
    await chmod(file, 0o600); await writeFile(file, JSON.stringify({ ...report, projectId: foreign.id }));
    await assert.rejects(service.verifyPublication(f.project.id, published.artifactId), /research_experiment_snapshot_changed/);
    await assert.rejects(writer.copy(storage, source, 'corrupt-native-code.json'), /research_export_snapshot_changed/);
    for (const phase of ['preparation', 'verification']) {
      let inspections = 0;
      const failingEnvironment = new api.ResearchExperimentEnvironmentService({
        nativeRuntime: async () => {
          inspections++;
          return { root: native.toolsRoot, hash: 'a'.repeat(64), environment: {
            PATH: '/usr/bin:/bin', ...(phase === 'preparation' || inspections === 2 ? { ROC_FAIL_ENVIRONMENT: '1' } : {})
          } };
        },
        typescriptRuntime: async () => assert.fail('native fixture must not select TypeScript')
      });
      const failingService = new api.ResearchExperimentService(f.repository, failingEnvironment, native.directory,
        { error: (...args) => failures.push(args) });
      try {
        const createdFailure = await failingService.start({ ...request, requestId: `native-${phase}-failed` });
        const deadline = Date.now() + 15000;
        let rejected;
        do {
          rejected = f.repository.experiments.get(f.project.id, createdFailure.id);
          if (!['preparing', 'running'].includes(rejected.status)) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        assert.equal(rejected.status, 'failed'); assert.equal(rejected.error, 'research_experiment_environment_probe_failed');
        const retained = api.researchExperimentResourceReportSchema.parse(JSON.parse((await failingService.read({
          projectId: f.project.id, runId: rejected.id, area: 'log', path: 'resources.json'
        })).content));
        assert.equal(retained.outcome, phase === 'preparation' ? 'not_dispatched' : 'returned');
        assert.equal(retained.probes.at(-1).phase, phase); assert.equal(retained.probes.at(-1).exitCode, 9);
        assert.ok(retained.probes.at(-1).admission.holdMs > 0);
        assert.equal(retained.exitCode, phase === 'preparation' ? null : 0);
        if (phase === 'preparation') {
          assert.equal(retained.usage, null); assert.equal(retained.admission, null);
          assert.equal(retained.inputHash, null); assert.equal(retained.environmentHash, null);
        }
        await assert.rejects(failingService.publish(f.project.id, rejected.id), /research_experiment_completed_required/);
        receipts.push({ scenario: `failed-${phase}-probe-retained`, runId: rejected.id, resources: retained });
      } finally { await failingService.shutdown(); }
    }
    assert.deepEqual(failures, []);
  } finally { await service.shutdown(); f.close(); }
});
