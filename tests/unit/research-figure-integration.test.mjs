import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import {createResearchTestRoleTools,  loadResearchTestApi, createResearchFixture, figureRequest } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

async function setup(renderer) {
  const temporary = await mkdtemp(join(tmpdir(), 'roc-figure-integration-'));
  const root = await realpath(temporary);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  for (const name of ['figure.vl.json', 'measurements.csv']) {
    await copyFile(`tests/fixtures/research-workflow/${name}`, join(workspace, name));
  }
  const fixture = createResearchFixture(api, 'figure', workspace);
  const service = new api.ResearchFigureService(fixture.repository, renderer, root, {
    error: (...args) => { throw new Error(`unexpected_persistence_error:${JSON.stringify(args)}`); }
  });
  const effects = new api.ResearchProductionEffectService(
    fixture.repository, undefined, undefined, service
  );
  const tools = createResearchTestRoleTools(api, {
    repository: fixture.repository, run: fixture.run,
    context: fixture.repository.runs.getContext(fixture.run.id), capabilities: {},
    effects, signal: new AbortController().signal
  });
  return { ...fixture, service, effects, tools, async dispose() {
    await service.shutdown();
    fixture.close();
    await rm(temporary, { recursive: true, force: true });
  } };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'figure integration timed out');
    await setTimeout(10);
  }
}

function realRenderer() {
  return { renderFigure: (request) => api.renderResearchFigure({
    operation: 'render_figure', projectRoot: request.projectRoot, sourcePath: request.sourcePath,
    outputDir: request.outputDir, inputPaths: request.inputPaths, label: request.label,
    timeoutMs: request.timeoutMs, figure: request.figure
  }, request.signal) };
}

test('real figure rendering is polled with runId and published into a persisted artifact', async () => {
  const fixture = await setup(realRenderer());
  try {
    await fixture.withWorker(async () => {
    const { project, run, tools, effects, repository, service } = fixture;
    const { projectId, ownerRunId, ...request } = figureRequest(project.id, run.id, { timeoutMs: 10_000 });
    const started = await tools.find((entry) => entry.name === 'start_figure').invoke(request);
    assert.equal(started.status, 'preparing');
    const execution = fixture.tasks.requireExecution('figure', started.runId, project.id);
    assert.equal(execution.taskId, run.taskId);
    assert.equal(execution.parentKind, 'stage');
    assert.equal(execution.parentExecutionId, run.id);
    await waitFor(() => !['preparing', 'running'].includes(effects.getFigure(run.id, project.id, started.runId).status));
    const completed = await tools.find((entry) => entry.name === 'get_figure').invoke({ runId: started.runId });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.error, null);
    assert.equal(completed.fileCount, 9);
    const retained = repository.figureRuns.get(project.id, started.runId);
    const traceFile = retained.files.find(file => file.area === 'output' && file.path === 'figure-data.json');
    assert.ok(traceFile);
    const trace = JSON.parse((await service.readRunFile({projectId: project.id, runId: started.runId,
      area: 'output', path: traceFile.path})).bytes.toString('utf8'));
    assert.equal(trace.sourceHash, retained.files.find(file => file.area === 'input' && file.path === 'figure.vl.json').sha256);
    assert.equal(trace.rendererHash, retained.environment.hash);
    assert.equal(trace.marks.length, 1);
    assert.equal(trace.marks[0].directFields.y, 'mean_end');
    assert.deepEqual(trace.marks[0].items.map(item => item.numericFields.mean_end), [2, 4]);
    const published = await tools.find((entry) => entry.name === 'publish_figure').invoke({
      runId: started.runId, replacesFigureId: null
    });
    assert.equal(published.runId, started.runId);
    assert.equal(published.status, 'rendered');
    assert.equal(repository.getArtifact(published.artifactId).kind, 'figure');
    assert.equal((await service.verify(project.id, published.figureId)).id, published.figureId);
    const repeated = await effects.publishFigure(run.id, project.id, started.runId, null);
    assert.equal(repeated.id, published.figureId);
    assert.equal(effects.getFigure(run.id, project.id, started.runId).artifactId, published.artifactId);
      });
  } finally { await fixture.dispose(); }
});

test('post-transform scene data retains negative aggregates and formula values with explicit encoding limits', async () => {
  const f = await setup(realRenderer());
  try {
    await f.withWorker(async () => {
    const spec = {data: {values: [{group: 'A', value: -2}, {group: 'A', value: -4}, {group: 'B', value: 99}]},
      transform: [{filter: "datum.group === 'A'"}, {aggregate: [{op: 'mean', field: 'value', as: 'mean'}], groupby: ['group']},
        {calculate: 'datum.mean * 0.001', as: 'seconds'}],
      mark: 'bar', encoding: {x: {field: 'group', type: 'nominal'}, y: {field: 'seconds', type: 'quantitative'},
        color: {condition: {test: 'datum.mean < 0', value: 'red'}, value: 'blue'}}};
    await writeFile(join(f.project.workspacePath, 'figure.vl.json'), JSON.stringify(spec));
    const traces = [];
    for (const requestId of ['transformed-a', 'transformed-b']) {
      const started = await f.service.start(figureRequest(f.project.id, f.run.id, {requestId, timeoutMs: 10_000}));
      await waitFor(() => !['preparing', 'running'].includes(f.repository.figureRuns.get(f.project.id, started.id).status));
      const completed = f.repository.figureRuns.get(f.project.id, started.id);
      assert.equal(completed.status, 'completed', completed.error);
      const traceFile = completed.files.find(file => file.area === 'output' && file.path === 'figure-data.json');
      const bytes = (await f.service.readRunFile({projectId: f.project.id, runId: started.id,
        area: 'output', path: traceFile.path})).bytes;
      traces.push(JSON.parse(bytes));
      assert.equal(traces.at(-1).marks.length, 1);
      const mark = traces.at(-1).marks[0];
      assert.equal(mark.directFields.y, 'seconds_end');
      assert.ok(!Object.values(mark.directFields).includes('mean'), 'unused numeric fields cannot become directly encoded values');
      assert.ok(mark.unsupportedChannels.includes('fill'), 'conditional encoding is retained as unsupported for automatic mapping');
      assert.match(mark.encoding, /datum\.mean < 0/u);
      assert.equal(mark.items.length, 1, 'filtered data cannot survive in emitted marks');
      assert.equal(mark.items[0].numericFields.mean, -3);
      assert.equal(mark.items[0].numericFields.seconds, -0.003);
      assert.equal(mark.items[0].numericFields.seconds_end, -0.003);
      assert.equal(mark.items[0].numericFields.value, undefined);
      const publication = await f.service.publish(f.project.id, started.id, null);
      assert.equal((await f.service.verify(f.project.id, publication.id)).id, publication.id);
      if (requestId === 'transformed-b') {
        const root = f.repository.figureRuns.root(f.project.id, started.id);
        const path = join(root, 'output', 'figure-data.json');
        const original = await readFile(path);
        await writeFile(path, '{}');
        await assert.rejects(f.service.verify(f.project.id, publication.id), /research_figure_snapshot_changed/u);
        await writeFile(path, original);
        assert.equal((await f.service.verify(f.project.id, publication.id)).id, publication.id);
      }
    }
    assert.deepEqual(traces[0], traces[1], 'scene trace bytes have no run ID or wall-clock variability');
      });
  } finally {await f.dispose();}
});

test('changed trace between renderer return and validation prevents completion and publication', async () => {
  const renderer = realRenderer();
  const f = await setup({async renderFigure(request) {
    const result = await renderer.renderFigure(request);
    await writeFile(join(request.outputDir, result.dataTrace.path), '{}');
    return result;
  }});
  try {
    await f.withWorker(async () => {
    const started = await f.service.start(figureRequest(f.project.id, f.run.id, {timeoutMs: 10_000}));
    await waitFor(() => !['preparing', 'running'].includes(f.repository.figureRuns.get(f.project.id, started.id).status));
    const completed = f.repository.figureRuns.get(f.project.id, started.id);
    assert.equal(completed.status, 'failed');
    assert.equal(completed.error, 'research_figure_data_trace_changed');
    await assert.rejects(f.service.publish(f.project.id, started.id, null), /research_figure_completed_required/u);
    assert.equal(f.repository.figures.list(f.project.id, 10).length, 0);
      });
  } finally {await f.dispose();}
});
test('association persistence failure prevents renderer dispatch and records failed figure', async () => {
  let renders = 0;
  const fixture = await setup({ renderFigure() { renders += 1; throw new Error('must_not_render'); } });
  try {
    await fixture.withWorker(async () => {
    const { agentDb, project, run, service, repository } = fixture;
    agentDb.exec(`CREATE TRIGGER reject_figure_task BEFORE INSERT ON research_task_executions
      WHEN NEW.kind = 'figure' BEGIN SELECT RAISE(ABORT, 'fixture_figure_link_failed'); END`);
    await assert.rejects(service.start(figureRequest(project.id, run.id)), /fixture_figure_link_failed/);
    assert.equal(renders, 0);
    const saved = repository.figureRuns.list(project.id, 10)[0];
    assert.equal(saved.status, 'failed');
    assert.equal(saved.error, 'research_task_association_failed');
    assert.equal(repository.figures.list(project.id, 10).length, 0);
      });
  } finally { await fixture.dispose(); }
});

test('high-DPI fractional figure sizes preserve physical SVG/PDF dimensions and exact PNG pixel bounds', async () => {
  const fixture = await setup(realRenderer());
  try {
    await fixture.withWorker(async () => {
    const { project, run, effects, service } = fixture;
    const options = { widthInches: 2.125, heightInches: 1.625, dpi: 300, seed: 42 };
    const request = figureRequest(project.id, run.id, { figure: options, timeoutMs: 10_000 });
    const started = await effects.startFigure(run.id, project.id, request);
    await waitFor(() => !['preparing', 'running'].includes(effects.getFigure(run.id, project.id, started.id).status));
    const completed = effects.getFigure(run.id, project.id, started.id);
    assert.equal(completed.status, 'completed', completed.error);
    const publication = await effects.publishFigure(run.id, project.id, started.id, null);
    const verified = await service.verify(project.id, publication.id);
    assert.equal(verified.validation.widthPixels, Math.trunc(options.widthInches * options.dpi));
    assert.equal(verified.validation.heightPixels, Math.trunc(options.heightInches * options.dpi));
    assert.equal(verified.validation.widthPoints, options.widthInches * 72);
    assert.equal(verified.validation.heightPoints, options.heightInches * 72);
      });
  } finally { await fixture.dispose(); }
});

test('rendering cancellation persists terminal state and rejects late publication', async () => {
  let started = false;
  const fixture = await setup({
    async renderFigure(request) {
      started = true;
      await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
      request.signal.throwIfAborted();
    }
  });
  try {
    await fixture.withWorker(async () => {
    const { project, run, effects, service, repository } = fixture;
    const figure = await effects.startFigure(run.id, project.id, figureRequest(project.id, run.id));
    await waitFor(() => started);
    const cancelled = await service.cancel(project.id, figure.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(effects.getFigure(run.id, project.id, figure.id).error, 'research_figure_cancelled');
    await assert.rejects(effects.publishFigure(run.id, project.id, figure.id, null), /research_figure_completed_required/);
    assert.equal(repository.figures.list(project.id, 10).length, 0);
      });
  } finally { await fixture.dispose(); }
});
