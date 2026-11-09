import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { loadResearchTestApi, createResearchFixture } from './fixtures/research-test-kit.mjs';
import guard from '../../resources/research-runtime/process-guard.lock.json' with { type: 'json' };

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());
const unknownUsage = { mode: 'monitored', sampleIntervalMs: 100, samples: 0, observedCpuTimeMs: null, peakResidentBytes: null };
const measured = { mode: 'monitored', sampleIntervalMs: 100, samples: 3, observedCpuTimeMs: 20, peakResidentBytes: 4096 };
const admission = { waitMs: 11, holdMs: 30 };
const hash = 'a'.repeat(64);

async function fixture(processRun, inspectionError = null) {
  const temporary = await mkdtemp('/private/tmp/roc-experiment-resources-'), root = await realpath(temporary);
  const workspace = join(root, 'workspace');
  await mkdir(workspace); await writeFile(join(workspace, 'analysis.mts'), 'export function run() {}');
  const f = createResearchFixture(api, 'experiment', workspace);
  const persistenceErrors = [];
  const prepared = {
    snapshot: { runtime: { kind: 'bundled-node' }, executable: '/usr/bin/true', prefix: '/usr/bin', basePrefix: '/usr/bin',
      version: 'unit-fixture', platform: 'darwin', architecture: 'arm64', toolchainHash: hash, metadataHash: hash,
      packages: [], lockFiles: [], hash },
    readablePaths: [], environment: { PATH: '/usr/bin:/bin' }, nativeCode: null,
    typescriptRuntime: { executable: '/usr/bin/true', runnerPath: '/fixture-runner.mts', packageRoots: [], packageEntries: {} }
  };
  const environments = { async inspect() { if (inspectionError !== null) throw inspectionError; return prepared; } };
  const service = new api.ResearchExperimentService(f.repository, environments, root,
    { error: (...args) => persistenceErrors.push(args) }, processRun);
  const request = { projectId: f.project.id, ownerRunId: null, engine: 'typescript', runtime: { kind: 'bundled-node' },
    sourceVersion: 1, requestId: 'resource-record', label: 'Resource contract', sourcePath: 'analysis.mts', inputPaths: [],
    parameters: {}, timeoutMs: 1000, network: 'disabled' };
  return { ...f, root, service, request, persistenceErrors, async dispose() {
    await service.shutdown(); f.close(); await rm(root, { recursive: true, force: true });
  } };
}

async function completed(f) {
  const created = await f.service.start(f.request), deadline = Date.now() + 10000;
  let run;
  while (Date.now() < deadline) {
    run = f.repository.experiments.get(f.project.id, created.id);
    if (!['preparing', 'running'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(run); assert.ok(!['preparing', 'running'].includes(run.status));
  assert.deepEqual(f.persistenceErrors, []);
  const content = await f.service.read({ projectId: f.project.id, runId: run.id, area: 'log', path: 'resources.json' });
  return { run, report: api.researchExperimentResourceReportSchema.parse(JSON.parse(content.content)) };
}

async function observations(f, run, source = f.service) {
  const association = f.tasks.requireExecution('experiment', run.id, f.project.id);
  const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, new api.RunUsageLedger(f.agentDb), null, source);
  return diagnostics.inspectExecution({projectId: f.project.id, taskId: association.taskId, executionKind: 'experiment',
    executionId: run.id, afterCallSequence: 0, afterEventSequence: 0, limit: 50});
}

test('experiment resource receipt pins returned measurements to input/environment and frozen publication without indexing metrics as scientific evidence', async () => {
  let actualRequest;
  const f = await fixture(async request => {
    actualRequest = request;
    return { exitCode: 0, stdout: 'actual unit fixture log', stderr: '', resourceUsage: measured, admission };
  });
  try {
    const { run, report } = await completed(f);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(report.runId, run.id); assert.equal(report.projectId, f.project.id);
    assert.equal(report.inputHash, run.inputHash); assert.equal(report.environmentHash, run.environment.hash);
    assert.equal(report.schemaVersion, 3); assert.deepEqual(report.probes, []);
    for (const schemaVersion of [1, 2]) assert.equal(api.researchExperimentResourceReportSchema.safeParse({ ...report, schemaVersion }).success, false);
    assert.deepEqual(report.usage, measured); assert.deepEqual(report.admission, admission);
    const diagnostics = await observations(f, run);
    assert.equal(diagnostics.resources.reportSha256, run.files.find(file => file.area === 'log' && file.path === 'resources.json').sha256);
    assert.deepEqual(diagnostics.resources.usage, measured);
    assert.deepEqual(diagnostics.resources.admission, admission);
    assert.equal(JSON.stringify(diagnostics).includes('/usr/bin/true'), false);
    await assert.rejects(observations(f, run, {source: async request => {
      const current = await f.service.source(request);
      return {...current, bytes: Buffer.from(JSON.stringify({...report, projectId: 'foreign'}))};
    }}), /research_experiment_resource_report_changed/);
    assert.deepEqual(report.policy.resourceLimits, actualRequest.resourceLimits);
    assert.equal(report.backend.cpuHardLimit, false); assert.equal(report.backend.memoryHardLimit, false);
    assert.equal(report.backend.contractVersion, 2); assert.equal(report.backend.hostCrashCleanup, true);
    assert.equal(report.backend.processGuardHash, guard.sha256);
    assert.equal(f.db.prepare("SELECT count(*) FROM research_knowledge_documents WHERE source_id=? AND id LIKE '%resources.json'")
      .pluck().get(run.id), 0);
    const published = await f.service.publish(f.project.id, run.id);
    const manifest = JSON.parse(await readFile(join(f.repository.experiments.root(f.project.id, run.id), 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.find(file => file.path === 'resources.json'), run.files.find(file => file.path === 'resources.json'));
    await f.service.verifyPublication(f.project.id, published.artifactId);
    const file = join(f.repository.experiments.root(f.project.id, run.id), 'log/resources.json');
    await chmod(file, 0o600); await writeFile(file, JSON.stringify({ ...report, inputHash: 'b'.repeat(64) }));
    await assert.rejects(f.service.verifyPublication(f.project.id, published.artifactId), /research_experiment_snapshot_changed/);
    await assert.rejects(observations(f, run), /research_experiment_snapshot_changed/);
    const foreignWorkspace = join(f.root, 'foreign-workspace');
    await mkdir(foreignWorkspace);
    const foreign = f.repository.createProject({ title: 'Foreign project', description: '', workspacePath: foreignWorkspace });
    await assert.rejects(f.service.read({ projectId: foreign.id, runId: run.id, area: 'log', path: 'resources.json' }),
      /research_experiment_project_mismatch/);
  } finally { await f.dispose(); }
});

test('runner rejection retains its real resource reason and explicitly unknown observations without converting them to zero or success', async () => {
  const f = await fixture(async () => {
    const error = new api.ResearchProcessError('research_process_cpu_limit', 'observed stdout', 'observed stderr', unknownUsage);
    error.admission = admission;
    throw error;
  });
  try {
    const { run, report } = await completed(f);
    assert.equal(run.status, 'failed'); assert.equal(run.error, 'research_process_cpu_limit');
    assert.equal(report.outcome, 'rejected'); assert.equal(report.error, run.error);
    assert.equal(report.exitCode, null); assert.deepEqual(report.usage, unknownUsage); assert.deepEqual(report.admission, admission);
    assert.equal(report.inputHash, run.inputHash); assert.equal(report.environmentHash, run.environment.hash);
    const diagnostics = await observations(f, run);
    assert.equal(diagnostics.resources.outcome, 'rejected');
    assert.deepEqual(diagnostics.resources.usage, unknownUsage);
    assert.equal((await f.service.read({ projectId: f.project.id, runId: run.id, area: 'log', path: 'stdout.txt' })).content, 'observed stdout');
    await assert.rejects(f.service.publish(f.project.id, run.id), /research_experiment_completed_required/);
    assert.equal(api.researchProcessResourceUsageSchema.safeParse({ ...unknownUsage, observedCpuTimeMs: 0, peakResidentBytes: 0 }).success, false);
  } finally { await f.dispose(); }
});

test('preparation failure records no compute dispatch or observations and preserves the actual failure before any runner invocation', async () => {
  let invocations = 0;
  const f = await fixture(async () => { invocations++; throw new Error('must_not_dispatch'); }, new Error('research_experiment_environment_changed'));
  try {
    const { run, report } = await completed(f);
    assert.equal(run.status, 'failed'); assert.equal(invocations, 0);
    assert.equal(report.outcome, 'not_dispatched'); assert.equal(report.error, 'research_experiment_environment_changed');
    assert.equal(report.inputHash, null); assert.equal(report.environmentHash, null);
    assert.equal(report.usage, null); assert.equal(report.admission, null); assert.equal(report.exitCode, null);
    const diagnostics = await observations(f, run);
    assert.equal(diagnostics.resources.outcome, 'not_dispatched');
    assert.equal(diagnostics.resources.usage, null);
  } finally { await f.dispose(); }
});
