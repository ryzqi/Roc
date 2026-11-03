import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { loadResearchTestApi, createResearchFixture, figureRequest } from './fixtures/research-test-kit.mjs';

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
  const tools = api.createResearchRoleTools({
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
    const { project, run, tools, effects, repository, service } = fixture;
    const { projectId, ownerRunId, ...request } = figureRequest(project.id, run.id, { timeoutMs: 10_000 });
    const started = await tools.find((entry) => entry.name === 'start_figure').invoke(request);
    assert.equal(started.status, 'preparing');
    await waitFor(() => !['preparing', 'running'].includes(effects.getFigure(run.id, project.id, started.runId).status));
    const completed = await tools.find((entry) => entry.name === 'get_figure').invoke({ runId: started.runId });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.error, null);
    assert.equal(completed.fileCount, 8);
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
  } finally { await fixture.dispose(); }
});

test('high-DPI fractional figure sizes preserve physical SVG/PDF dimensions and exact PNG pixel bounds', async () => {
  const fixture = await setup(realRenderer());
  try {
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
    const { project, run, effects, service, repository } = fixture;
    const figure = await effects.startFigure(run.id, project.id, figureRequest(project.id, run.id));
    await waitFor(() => started);
    const cancelled = await service.cancel(project.id, figure.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(effects.getFigure(run.id, project.id, figure.id).error, 'research_figure_cancelled');
    await assert.rejects(effects.publishFigure(run.id, project.id, figure.id, null), /research_figure_completed_required/);
    assert.equal(repository.figures.list(project.id, 10).length, 0);
  } finally { await fixture.dispose(); }
});
