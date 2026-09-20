import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { ResearchExperimentService } from '../../../../src/main/plugins/research/experiment-service';
import type { ResearchExperimentEnvironmentService, PreparedExperimentEnvironment } from '../../../../src/main/plugins/research/experiment-environment';
import type { ResearchProcessRequest, ResearchProcessResult } from '../../../../src/main/plugins/research/process-runner';
import type { ResearchExperimentStart } from '../../../../src/shared/schemas/research-experiments';

let db: Database.Database;
let repository: ResearchRepository;
let service: ResearchExperimentService;
let root: string;
let workspace: string;
let projectId: string;
const inspect = vi.fn<ResearchExperimentEnvironmentService['inspect']>();
const runProcess = vi.fn<(input: ResearchProcessRequest) => Promise<ResearchProcessResult>>();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const environment: PreparedExperimentEnvironment = {
  snapshot: { runtime: { kind: 'bundled-python' }, executable: '/python/bin/python', prefix: '/python', basePrefix: '/python', version: '3.12.14',
    platform: 'darwin', architecture: 'arm64', toolchainHash: 'a'.repeat(64), metadataHash: 'a'.repeat(64), packages: [{ name: 'matplotlib', version: '3.11.1' }], lockFiles: [], hash: 'b'.repeat(64) },
  readablePaths: ['/python'], environment: { PATH: '/python/bin:/usr/bin' }, python: '/python/bin/python'
};
function request(input: Partial<ResearchExperimentStart> = {}): ResearchExperimentStart {
  return { projectId, requestId: randomUUID(), label: 'Signal experiment', engine: 'python', runtime: { kind: 'bundled-python' }, sourcePath: 'run.py',
    inputPaths: ['data.csv'], arguments: [], parameters: { scale: '2' }, expectedEnvironmentHash: environment.snapshot.hash, timeoutMs: 10000, network: 'disabled', ...input };
}
async function finished(id: string) {
  await vi.waitFor(() => expect(['preparing', 'running']).not.toContain(repository.experiments.get(projectId, id).status), { timeout: 5000 });
  return repository.experiments.get(projectId, id);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'roc-experiment-')));
  workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'run.py'), 'print("source v1")');
  await writeFile(join(workspace, 'data.csv'), 'measurement\n21\n');
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); applyResearchDatabaseSchema(db);
  repository = new ResearchRepository(db);
  projectId = repository.createProject({ title: 'Experiment project', description: 'Frozen inputs and results.', workspacePath: workspace }).id;
  inspect.mockReset().mockResolvedValue(environment);
  runProcess.mockReset().mockImplementation(async (input) => {
    const directory = input.environment.ROC_OUTPUT_DIR;
    if (directory === undefined) throw new Error('output_directory_required');
    await writeFile(join(directory, 'result.csv'), 'measurement\n42\n');
    return { exitCode: 0, stdout: 'Measured signal 42.\n', stderr: '' };
  });
  service = new ResearchExperimentService(repository, { inspect }, join(root, 'runs'), logger, runProcess);
});
afterEach(async () => { await service.shutdown(); db.close(); await rm(root, { recursive: true, force: true }); });

describe('research experiment lifecycle', () => {
  it('freezes input files and publishes traceable searchable results into the workflow', async () => {
    const originalRun = runProcess.getMockImplementation();
    runProcess.mockImplementationOnce(async (input) => {
      await writeFile(join(workspace, 'data.csv'), 'measurement\n100\n');
      expect(await readFile(join(input.cwd, 'data.csv'), 'utf8')).toBe('measurement\n21\n');
      expect(input.environment.ROC_PARAMETERS_JSON).toBe('{"scale":"2"}');
      if (originalRun === undefined) throw new Error('runner_required');
      return await originalRun(input);
    });
    const started = await service.start(request());
    const done = await finished(started.id);
    expect(done).toMatchObject({ status: 'completed', exitCode: 0, error: null, environment: environment.snapshot });
    expect(done.files.map((file) => `${file.area}/${file.path}`)).toEqual(expect.arrayContaining(['input/run.py', 'input/data.csv', 'output/result.csv', 'log/stdout.txt', 'log/stderr.txt']));
    expect((await service.read({ projectId, runId: done.id, area: 'input', path: 'data.csv' })).content).toContain('21');
    const evidence = repository.evidence.capture({ projectId, chunkId: `experiment:${done.id}:output:result.csv:chunk:0` });
    expect(service.evidenceSource(projectId, evidence.id)).toEqual({ projectId, runId: done.id, area: 'output', path: 'result.csv' });
    await expect(service.publish(projectId, done.id)).rejects.toThrow('research_artifact_stage_inactive');
    repository.transitionWorkflow({ projectId, expectedStage: 'discovery', action: 'move', targetStage: 'experiment' });
    const published = await service.publish(projectId, done.id);
    expect(repository.getArtifact(published.artifactId!).kind).toBe('experiment_run');
    expect((await service.publish(projectId, done.id)).artifactId).toBe(published.artifactId);
    expect(repository.listProvenance({ projectId, subjectId: published.artifactId! })[0]).toMatchObject({ sourceType: 'experiment', sourceId: done.id });
    await rm(workspace, { recursive: true });
    expect((await service.read({ projectId, runId: done.id, area: 'output', path: 'result.csv' })).content).toContain('42');
  });

  it('deduplicates requests and rejects a reused request identity with changed arguments', async () => {
    const input = request();
    const first = await service.start(input);
    expect((await service.start(input)).id).toBe(first.id);
    await expect(service.start({ ...input, parameters: { scale: '3' } })).rejects.toThrow('research_experiment_request_conflict');
    await finished(first.id);
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(repository.experiments.list(projectId, 20)).toHaveLength(1);
  });

  it('inspects internally when start omits expectedEnvironmentHash', async () => {
    const { expectedEnvironmentHash: _hash, ...withoutHash } = request();
    const started = await service.start(withoutHash);
    expect(await finished(started.id)).toMatchObject({ status: 'completed', environment: environment.snapshot });
    expect(inspect).toHaveBeenCalled();
  });

  it('refuses an environment changed since preflight before executing any script', async () => {
    const started = await service.start(request({ expectedEnvironmentHash: 'c'.repeat(64) }));
    expect(await finished(started.id)).toMatchObject({ status: 'failed', error: 'research_experiment_environment_changed' });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('does not publish results when the environment changes during execution', async () => {
    inspect.mockResolvedValueOnce(environment).mockResolvedValue({ ...environment, snapshot: { ...environment.snapshot, hash: 'd'.repeat(64) } });
    const started = await service.start(request());
    expect(await finished(started.id)).toMatchObject({ status: 'failed', error: 'research_experiment_environment_changed' });
    expect(db.prepare("SELECT count(*) AS count FROM research_knowledge_documents WHERE source_type = 'experiment'").get()).toEqual({ count: 0 });
    expect((await service.read({ projectId, runId: started.id, area: 'log', path: 'stdout.txt' })).content).toContain('42');
  });

  it('cancels a late process result while retaining logs and generated files', async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    runProcess.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { exitCode: 0, stdout: 'partial result\n', stderr: '' }; });
    const started = await service.start(request());
    await entered.promise;
    const cancellation = service.cancel(projectId, started.id);
    release.resolve();
    expect(await cancellation).toMatchObject({ status: 'cancelled', artifactId: null });
    expect((await service.read({ projectId, runId: started.id, area: 'log', path: 'stdout.txt' })).content).toContain('partial result');
    expect(db.prepare("SELECT count(*) AS count FROM research_knowledge_documents WHERE source_type = 'experiment'").get()).toEqual({ count: 0 });
  });

  it('marks shutdown and recovered work interrupted without rerunning it automatically', async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    runProcess.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { exitCode: 0, stdout: 'stopped', stderr: '' }; });
    const input = request();
    const started = await service.start(input); await entered.promise;
    const closing = service.shutdown(); release.resolve(); await closing;
    expect(repository.experiments.get(projectId, started.id).status).toBe('interrupted');
    const pending = repository.experiments.create(request(), workspace, workspace, join(root, 'runs'));
    service = new ResearchExperimentService(repository, { inspect }, join(root, 'runs'), logger, runProcess);
    service.recover();
    expect(repository.experiments.get(projectId, pending.id).status).toBe('interrupted');
    expect((await service.start(input)).status).toBe('interrupted');
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it('rejects linked input files and output links without exposing their targets', async () => {
    const outside = join(root, 'outside.txt'); await writeFile(outside, 'private sentinel');
    await symlink(outside, join(workspace, 'linked.txt'));
    const first = await service.start(request({ inputPaths: ['linked.txt'] }));
    expect(await finished(first.id)).toMatchObject({ status: 'failed', error: 'research_path_symlink' });
    expect(runProcess).not.toHaveBeenCalled();
    runProcess.mockImplementationOnce(async (input) => { await symlink(outside, join(input.environment.ROC_OUTPUT_DIR!, 'linked.txt')); return { exitCode: 0, stdout: 'before invalid output', stderr: '' }; });
    const second = await service.start(request());
    expect(await finished(second.id)).toMatchObject({ status: 'failed', error: 'research_experiment_output_invalid' });
    await expect(service.source({ projectId, runId: second.id, area: 'output', path: 'linked.txt' })).rejects.toThrow('research_experiment_file_not_found');
    expect((await service.read({ projectId, runId: second.id, area: 'log', path: 'stdout.txt' })).content).toBe('before invalid output');
  });

  it('keeps failed-process diagnostics and rejects forged updates of managed execution records', async () => {
    runProcess.mockResolvedValueOnce({ exitCode: 2, stdout: 'before failure', stderr: 'invalid measurement' });
    const started = await service.start(request());
    const done = await finished(started.id);
    expect(done).toMatchObject({ status: 'failed', exitCode: 2, error: 'research_experiment_process_failed' });
    expect((await service.read({ projectId, runId: done.id, area: 'log', path: 'stderr.txt' })).content).toContain('invalid measurement');
    expect(() => repository.experiments.record({ id: done.id, projectId, label: 'Forged', command: 'none', parameters: {}, environment: {}, status: 'completed', outputs: [], startedAt: done.createdAt, endedAt: done.endedAt }))
      .toThrow('research_experiment_execution_immutable');
    await expect(service.publish(projectId, done.id)).rejects.toThrow('research_experiment_completed_required');
  });

  it('protects project ownership and stops execution after a project workspace change', async () => {
    const other = repository.createProject({ title: 'Other', description: 'Other project.', workspacePath: workspace });
    const entered = deferred<void>(); const release = deferred<void>();
    runProcess.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { exitCode: 0, stdout: 'late', stderr: '' }; });
    const started = await service.start(request()); await entered.promise;
    expect(() => repository.experiments.get(other.id, started.id)).toThrow('research_experiment_project_mismatch');
    service.projectChanged(other.id);
    expect(runProcess.mock.calls[0][0].signal?.aborted).toBe(false);
    repository.updateProject({ id: projectId, workspacePath: join(root, 'replacement') });
    service.projectChanged(projectId);
    expect(runProcess.mock.calls[0][0].signal?.aborted).toBe(true);
    release.resolve();
    expect(await finished(started.id)).toMatchObject({ status: 'cancelled' });
  });

  it('rolls back successful publication when indexing output fails', async () => {
    db.exec("CREATE TRIGGER reject_experiment_output BEFORE INSERT ON research_knowledge_documents BEGIN SELECT RAISE(ABORT, 'index_failed'); END;");
    const started = await service.start(request());
    expect(await finished(started.id)).toMatchObject({ status: 'failed' });
    expect(db.prepare('SELECT count(*) AS count FROM research_knowledge_documents').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT status FROM research_experiment_runs WHERE id = ?').get(started.id)).toEqual({ status: 'failed' });
    expect((await service.read({ projectId, runId: started.id, area: 'log', path: 'stdout.txt' })).content).toContain('42');
    expect((await service.read({ projectId, runId: started.id, area: 'output', path: 'result.csv' })).content).toContain('42');
    await expect(readFile(join(repository.experiments.root(projectId, started.id), 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });


  it('rejects matplotlib starts instead of running them as experiments', async () => {
    await expect(service.start(request({ engine: 'matplotlib', figure: { widthInches: 4, heightInches: 3, dpi: 150, seed: 42 } })))
      .rejects.toThrow('research_experiment_engine_invalid');
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('generates a manifest from committed state before publication and rejects a modified manifest', async () => {
    const started = await service.start(request()); await finished(started.id);
    repository.transitionWorkflow({ projectId, expectedStage: 'discovery', action: 'move', targetStage: 'experiment' });
    const published = await service.publish(projectId, started.id);
    const path = repository.getArtifact(published.artifactId!).path;
    if (path === null) throw new Error('manifest_required');
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('completed');
    await rm(path);
    await service.publish(projectId, started.id);
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('completed');
    await rm(path); await writeFile(path, '{}');
    await expect(service.publish(projectId, started.id)).rejects.toThrow('research_experiment_manifest_changed');
  });
});
