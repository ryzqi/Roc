import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
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
    context: fixture.repository.runs.getContext(fixture.run.id), capabilities: {invoke: async (name, input) => {
      assert.equal(name, 'research.figure.environment');
      assert.deepEqual(input, {projectId: fixture.project.id});
      return service.inspect(input.projectId);
    }},
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

test('faceted figures with long titles keep all data inside the requested physical output sizes', async () => {
  const fixture = await setup(realRenderer());
  try {
    await fixture.withWorker(async () => {
      const values = Array.from({length: 16}, (_, index) => ({
        endpoint: `endpoint_${Math.floor(index / 4)}`, condition: `B${index % 4}`, value: index / 15
      }));
      await writeFile(join(fixture.project.workspacePath, 'figure.vl.json'), JSON.stringify({
        title: {text: 'Engineering fixture — not safety findings; real LLM safety samples = 0',
          subtitle: 'All four endpoints and conditions must remain visible, including labels, axes, and this long explanatory subtitle.'},
        data: {values}, facet: {row: {field: 'endpoint', type: 'nominal'}},
        spec: {width: 380, height: 78, mark: 'point', encoding: {
          x: {field: 'condition', type: 'nominal'}, y: {field: 'value', type: 'quantitative'}
        }}
      }));
      const started = await fixture.service.start(figureRequest(fixture.project.id, fixture.run.id, {
        timeoutMs: 10_000, figure: {widthInches: 10, heightInches: 7, dpi: 150, seed: 42}
      }));
      await waitFor(() => !['preparing', 'running'].includes(fixture.repository.figureRuns.get(fixture.project.id, started.id).status));
      const completed = fixture.repository.figureRuns.get(fixture.project.id, started.id);
      const output = async path => (await fixture.service.readRunFile({projectId: fixture.project.id,
        runId: started.id, area: 'output', path})).bytes;
      const stderr = (await fixture.service.readRunFile({projectId: fixture.project.id,
        runId: started.id, area: 'log', path: 'stderr.txt'})).bytes.toString('utf8');
      assert.equal(completed.status, 'completed', `${completed.error}: ${stderr}`);
      const report = JSON.parse((await output('figure-validation.json')).toString('utf8'));
      assert.deepEqual([report.widthPixels, report.heightPixels], [1500, 1050]);
      assert.deepEqual([report.widthPoints, report.heightPoints], [720, 504]);
      const svg = (await output('figure.svg')).toString('utf8');
      assert.match(svg, /real LLM safety samples = 0/u);
      for (const endpoint of ['endpoint_0', 'endpoint_1', 'endpoint_2', 'endpoint_3']) assert.ok(svg.includes(endpoint));
      const trace = JSON.parse((await output('figure-data.json')).toString('utf8'));
      const plotted = trace.marks.flatMap(mark => mark.items.map(item => item.numericFields.value)).filter(value => value !== undefined);
      assert.deepEqual(plotted.toSorted((a, b) => a - b), values.map(value => value.value));
      const published = await fixture.service.publish(fixture.project.id, started.id, null);
      assert.equal((await fixture.service.verify(fixture.project.id, published.id)).id, published.id);
    });
  } finally { await fixture.dispose(); }
});

test('fitted page margins preserve the resolved Vega background and explicit transparency', async () => {
  const fixture = await setup(realRenderer());
  try {
    await fixture.withWorker(async () => {
      for (const [requestId, background, expected] of [
        ['default-background', {}, [255, 255, 255, 255]],
        ['configured-background', {config: {background: '#123456'}}, [18, 52, 86, 255]],
        ['transparent-background', {background: null}, [0, 0, 0, 0]]
      ]) {
        await writeFile(join(fixture.project.workspacePath, 'figure.vl.json'), JSON.stringify({
          ...background, data: {values: [{group: 'A', value: 1}]},
          facet: {field: 'group', type: 'nominal'},
          spec: {width: 400, height: 40, mark: 'point', encoding: {
            x: {field: 'value', type: 'quantitative'}
          }}
        }));
        const started = await fixture.service.start(figureRequest(fixture.project.id, fixture.run.id, {
          requestId, timeoutMs: 10_000, figure: {widthInches: 10, heightInches: 7, dpi: 72, seed: 42}
        }));
        await waitFor(() => !['preparing', 'running'].includes(fixture.repository.figureRuns.get(fixture.project.id, started.id).status));
        const completed = fixture.repository.figureRuns.get(fixture.project.id, started.id);
        assert.equal(completed.status, 'completed', completed.error);
        for (const path of ['figure.png', 'figure.svg']) {
          const bytes = (await fixture.service.readRunFile({projectId: fixture.project.id,
            runId: started.id, area: 'output', path})).bytes;
          const image = await loadImage(bytes);
          const canvas = createCanvas(image.width, image.height);
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          assert.deepEqual([...context.getImageData(0, 0, 1, 1).data], expected, `${requestId} ${path} page margin`);
        }
      }
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

for (const options of [
  { widthInches: 2.125, heightInches: 1.625, dpi: 300, seed: 42 },
  { widthInches: 10.003, heightInches: 7.007, dpi: 150, seed: 42 },
]) test(`high-DPI fractional figure sizes preserve physical SVG/PDF dimensions and exact PNG pixel bounds (${options.widthInches} × ${options.heightInches} in at ${options.dpi} DPI)`, async () => {
  const fixture = await setup(realRenderer());
  try {
    await fixture.withWorker(async () => {
    const { project, run, effects, service } = fixture;
    const request = figureRequest(project.id, run.id, { figure: options, timeoutMs: 10_000 });
    const started = await effects.startFigure(run.id, project.id, request);
    await waitFor(() => !['preparing', 'running'].includes(effects.getFigure(run.id, project.id, started.id).status));
    const completed = effects.getFigure(run.id, project.id, started.id);
    assert.equal(completed.status, 'completed', completed.error);
    const publication = await effects.publishFigure(run.id, project.id, started.id, null);
    const verified = await service.verify(project.id, publication.id);
    assert.equal(verified.validation.widthPixels, Math.trunc(options.widthInches * options.dpi));
    assert.equal(verified.validation.heightPixels, Math.trunc(options.heightInches * options.dpi));
    assert.ok(Math.abs(verified.validation.widthPoints - options.widthInches * 72) < 1e-9);
    assert.ok(Math.abs(verified.validation.heightPoints - options.heightInches * 72) < 1e-9);
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


test('actual figure agent corrects a stale environment before any host effect and renders once', async () => {
  const f = await setup(realRenderer());
  const output = {title: 'Environment corrected', markdown: 'Actual renderer run started.', claims: [], sections: [], verdict: 'uncertain'};
  const {projectId, ownerRunId, ...request} = figureRequest(f.project.id, f.run.id, {timeoutMs: 10_000});
  let requests = 0, responseToolName, startedId;
  class Model extends BaseChatModel {
    _llmType() { return 'figure-environment-recovery-fixture'; }
    bindTools(tools) {
      const response = tools.find(tool => !['start_figure', 'inspect_figure_environment'].includes(tool.function?.name ?? tool.name));
      responseToolName = response.function?.name ?? response.name;
      return this;
    }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 4);
      let call;
      if (requests === 1) call = {id: 'stale', name: 'start_figure', args: {...request, expectedEnvironmentHash: '0'.repeat(64)}};
      else if (requests === 2) {
        const rejected = messages.find(message => message.tool_call_id === 'stale');
        assert.equal(rejected?.status, 'error');
        assert.match(String(rejected.content), /research_figure_environment_changed/);
        assert.match(String(rejected.content), /inspect_figure_environment/);
        assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_tool_effects').pluck().get(), 0);
        assert.equal(f.service.list(f.project.id, 10).length, 0);
        call = {id: 'preview', name: 'inspect_figure_environment', args: {}};
      } else if (requests === 3) {
        const preview = JSON.parse(messages.find(message => message.tool_call_id === 'preview').content);
        const environment = await f.service.inspect(f.project.id);
        assert.equal(preview.expectedEnvironmentHash, environment.hash);
        call = {id: 'corrected', name: 'start_figure', args: {...request, expectedEnvironmentHash: preview.expectedEnvironmentHash}};
      } else {
        startedId = JSON.parse(messages.find(message => message.tool_call_id === 'corrected').content).runId;
        assert.ok(startedId.startsWith('figure_run_'));
        call = {id: 'done', name: responseToolName, args: output};
      }
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{...call, type: 'tool_call'}]})}]};
    }
  }
  try {
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture-provider', modelId: 'fixture-model', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'}, api.createRunModelConfig({contextWindowTokens: 20_000, maxOutputTokens: 1000}));
    const result = await f.withWorker(() => prepared.execute({run: f.run, context: f.repository.runs.getContext(f.run.id),
      tools: f.tools.filter(tool => ['start_figure', 'inspect_figure_environment'].includes(tool.name)), signal: new AbortController().signal,
      loadTaskContext: () => ({task: f.tasks.get(f.run.taskId, f.project.id), facts: new api.ResearchTaskFactsService(f.repository).get({taskId: f.run.taskId, projectId: f.project.id})})}));
    assert.deepEqual(result.output, output);
    assert.equal(requests, 4);
    assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM agent_tool_effects WHERE status='unknown'").pluck().get(), 0);
    assert.equal(f.service.list(f.project.id, 10).length, 1);
    await waitFor(() => !['preparing', 'running'].includes(f.service.getRun(f.project.id, startedId).status));
    assert.equal(f.service.getRun(f.project.id, startedId).status, 'completed');
  } finally {await f.dispose();}
});

test('actual figure agent corrects replacement IDs before any publication effect and reuses the completed render', async () => {
  const f = await setup(realRenderer());
  const output = {title: 'Publication corrected', markdown: 'Existing completed render published.', claims: [], sections: [], verdict: 'uncertain'};
  let requests = 0, responseToolName, startedId;
  class Model extends BaseChatModel {
    _llmType() { return 'figure-publication-recovery-fixture'; }
    bindTools(tools) {
      const response = tools.find(tool => (tool.function?.name ?? tool.name) !== 'publish_figure');
      responseToolName = response.function?.name ?? response.name;
      return this;
    }
    async _generate(messages) {
      requests++;
      assert.ok(requests <= 5);
      let call;
      if (requests === 1) call = {id: 'missing', name: 'publish_figure', args: {runId: startedId}};
      else if (requests <= 4) {
        const previousId = ['missing', 'sentinel', 'unknown'][requests - 2];
        const rejected = messages.find(message => message.tool_call_id === previousId);
        assert.equal(rejected?.status, 'error');
        if (requests >= 3) assert.match(String(rejected.content), /replacesFigureId.*JSON null/u);
        assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_tool_effects').pluck().get(), 0);
        assert.equal(f.repository.figures.list(f.project.id, 10).length, 0);
        call = requests === 2 ? {id: 'sentinel', name: 'publish_figure', args: {runId: startedId, replacesFigureId: 'null'}}
          : requests === 3 ? {id: 'unknown', name: 'publish_figure', args: {runId: startedId, replacesFigureId: 'figure_00000000-0000-0000-0000-000000000000'}}
          : {id: 'corrected', name: 'publish_figure', args: {runId: startedId, replacesFigureId: null}};
      } else {
        const published = JSON.parse(messages.find(message => message.tool_call_id === 'corrected').content);
        assert.equal(published.runId, startedId);
        assert.equal(published.replacesFigureId, null);
        assert.equal(published.status, 'rendered');
        call = {id: 'done', name: responseToolName, args: output};
      }
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [{...call, type: 'tool_call'}]})}]};
    }
  }
  try {
    const started = await f.withWorker(() => f.service.start(figureRequest(f.project.id, f.run.id, {timeoutMs: 10_000})));
    startedId = started.id;
    await waitFor(() => !['preparing', 'running'].includes(f.service.getRun(f.project.id, startedId).status));
    assert.equal(f.service.getRun(f.project.id, startedId).status, 'completed');
    const prepared = await api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture-provider', modelId: 'fixture-model', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb)).prepare({kind: 'app_default'}, api.createRunModelConfig({contextWindowTokens: 20_000, maxOutputTokens: 1000}));
    const result = await f.withWorker(() => prepared.execute({run: f.run, context: f.repository.runs.getContext(f.run.id),
      tools: f.tools.filter(tool => tool.name === 'publish_figure'), signal: new AbortController().signal,
      loadTaskContext: () => ({task: f.tasks.get(f.run.taskId, f.project.id), facts: new api.ResearchTaskFactsService(f.repository).get({taskId: f.run.taskId, projectId: f.project.id})})}));
    assert.deepEqual(result.output, output);
    assert.equal(requests, 5);
    assert.equal(f.agentDb.prepare("SELECT COUNT(*) FROM agent_tool_effects WHERE status='unknown'").pluck().get(), 0);
    assert.equal(f.agentDb.prepare('SELECT COUNT(*) FROM agent_tool_effects').pluck().get(), 1);
    assert.equal(f.service.list(f.project.id, 10).length, 1);
    const publications = f.repository.figures.list(f.project.id, 10);
    assert.equal(publications.length, 1);
    assert.equal((await f.service.verify(f.project.id, publications[0].id)).runId, startedId);
  } finally {await f.dispose();}
});
