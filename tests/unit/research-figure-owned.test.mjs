import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {withResearchTestWorker, createResearchTestRoleTools,  loadResearchTestApi, createResearchFixture, figureRequest } from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

function setup(workspacePath) {
  const fixture = createResearchFixture(api, 'figure', workspacePath);
  const { repository, project, run } = fixture;
  const figures = {
    async start(request) {
      return repository.figureRuns.create(request, project.workspacePath, project.workspacePath, '/tmp/roc-storage');
    },
    async publish(projectId, runId) {
      const saved = repository.figureRuns.get(projectId, runId);
      if (saved.status !== 'completed') throw new Error('research_figure_not_completed');
      return { id: 'figure', artifactId: 'artifact', runId, status: 'rendered', replacesFigureId: null };
    }
  };
  const effects = new api.ResearchProductionEffectService(repository, undefined, undefined, figures);
  const tools = createResearchTestRoleTools(api, {
    repository, run, context: repository.runs.getContext(run.id), capabilities: {},
    effects, signal: new AbortController().signal
  });
  return { ...fixture, effects, tools, figures };
}

test('figure role polls its own repository with runId from start_figure', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-figure-owned-')));
  for (const name of ['figure.vl.json', 'measurements.csv']) {
    await copyFile(`tests/fixtures/research-workflow/${name}`, join(directory, name));
  }
  const fixture = setup(directory);
  try {
    await fixture.withWorker(async () => {
    const { tools, repository, run, project } = fixture;
    assert.ok(tools.some((entry) => entry.name === 'get_figure'));
    assert.ok(!tools.some((entry) => entry.name === 'get_experiment'));
    const { projectId, ownerRunId, ...request } = figureRequest(project.id, run.id);
    const started = await tools.find((entry) => entry.name === 'start_figure').invoke(request);
    assert.ok(started.runId.startsWith('figure_run_'));
    assert.ok(!Object.hasOwn(started, 'experimentId'));
    const result = await tools.find((entry) => entry.name === 'get_figure').invoke({ runId: started.runId });
    assert.equal(result.status, 'preparing');
    assert.equal(result.fileCount, 0);
    assert.throws(() => repository.experiments.get(project.id, started.runId), /research_experiment_not_found/);
      });
  } finally { fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('figure query returns persisted failures, cancellation and restart interruption without fabricated success', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const fixture = setup();
    try {
    await fixture.withWorker(async () => {
      const { repository, project, run, effects } = fixture;
      const figure = await fixture.figures.start(figureRequest(project.id, run.id));
      if (status === 'interrupted') repository.figureRuns.recover();
      else repository.figureRuns.finish(project.id, figure.id, {
        status, files: [], exitCode: 1, error: `fixture_${status}`
      });
      const saved = effects.getFigure(run.id, project.id, figure.id);
      assert.equal(saved.status, status);
      assert.ok(saved.error);
      assert.equal(saved.artifactId, null);
      await assert.rejects(effects.publishFigure(run.id, project.id, figure.id, null), /research_figure_not_completed/);
        });
  } finally { fixture.close(); }
  }
});

test('figure query and publication reject another stage owner and cross-project IDs', async () => {
  const fixture = setup();
  try {
    await fixture.withWorker(async () => {
    const { repository, project, run, effects } = fixture;
    const foreignOwner = repository.figureRuns.create(figureRequest(project.id, null), project.workspacePath, project.workspacePath, '/tmp/roc-storage');
    assert.throws(() => effects.getFigure(run.id, project.id, foreignOwner.id), /research_production_owner_mismatch/);
    await assert.rejects(effects.publishFigure(run.id, project.id, foreignOwner.id, null), /research_production_owner_mismatch/);
    const foreign = repository.createProject({ title: 'Other', description: '', workspacePath: '/tmp/roc-other' });
    const foreignFigure = repository.figureRuns.create(figureRequest(foreign.id, null), foreign.workspacePath, foreign.workspacePath, '/tmp/roc-storage');
    assert.throws(() => effects.getFigure(run.id, project.id, foreignFigure.id), /research_figure_project_mismatch/);
    await assert.rejects(effects.publishFigure(run.id, project.id, foreignFigure.id, null), /research_figure_project_mismatch/);
      });
  } finally { fixture.close(); }
});

test('cancelled or replaced stage cannot query or publish its owned figure', async () => {
  const fixture = setup();
  try {
    await fixture.withWorker(async () => {
    const { repository, project, run, effects } = fixture;
    const figure = await fixture.figures.start(figureRequest(project.id, run.id));
    repository.runs.terminate(run.id, project.id, 'cancelled', 'fixture_cancelled');
    assert.throws(() => effects.getFigure(run.id, project.id, figure.id), /research_run_not_current/);
    await assert.rejects(effects.publishFigure(run.id, project.id, figure.id, null), /research_run_not_current/);
      });
  } finally { fixture.close(); }
});

test('figure request identity returns one run and rejects changed content', async () => {
  const fixture = setup();
  try {
    await fixture.withWorker(async () => {
    const { project, run, figures } = fixture;
    const request = figureRequest(project.id, run.id);
    const first = await figures.start(request);
    const second = await figures.start(request);
    assert.equal(first.id, second.id);
    assert.equal(fixture.repository.figureRuns.list(project.id, 10).length, 1);
    await assert.rejects(figures.start({ ...request, label: 'Changed' }), /research_figure_request_conflict/);
      });
  } finally { fixture.close(); }
});

test('figure tool rejects obsolete experimentId input instead of accepting aliases', async () => {
  const fixture = setup();
  try {
    await fixture.withWorker(async () => {
    await assert.rejects(fixture.tools.find((entry) => entry.name === 'get_figure').invoke({ experimentId: 'old' }));
    await assert.rejects(fixture.tools.find((entry) => entry.name === 'publish_figure').invoke({
      experimentId: 'old', replacesFigureId: null
    }));
      });
  } finally { fixture.close(); }
});

test('obsolete frozen figure tool snapshot stays unchanged and cannot be retried', async () => {
  const fixture = setup();
  try {
    await fixture.withWorker(async () => {
    const { db, run, repository, project } = fixture;
    const old = { ...run, toolNames: run.toolNames.map((name) => name === 'get_figure' ? 'get_experiment' : name) };
    db.prepare('UPDATE research_stage_runs SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(old), run.id);
    repository.runs.terminate(run.id, project.id, 'failed', 'fixture_failure');
    assert.throws(() => repository.runs.retry({ projectId: project.id, runId: run.id, requestId: 'retry' }), /research_run_tool_contract_changed/);
    assert.ok(repository.runs.get(run.id, project.id).toolNames.includes('get_experiment'));
      });
  } finally { fixture.close(); }
});


test('a retry queries and publishes an existing figure only through the same frozen node', async () => {
  const f = setup();
  try {
    const figure = await f.withWorker(() => f.figures.start(figureRequest(f.project.id, f.run.id)));
    f.withWorker(() => f.repository.figureRuns.start(f.project.id, figure.id, {
      engine: 'vega-lite', vegaVersion: 'fixture', vegaLiteVersion: 'fixture',
      renderer: '@napi-rs/canvas', rendererVersion: 'fixture', pipelineVersion: 'fixture',
      nodeVersion: process.version, platform: process.platform, arch: process.arch, hash: 'a'.repeat(64)
    }, [], 'b'.repeat(64)));
    f.withWorker(() => f.repository.figureRuns.finish(f.project.id, figure.id, {
      status: 'completed', files: [], exitCode: 0, error: null
    }));
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture_retry');
    const next = f.repository.runs.retry({projectId: f.project.id, runId: f.run.id, requestId: 'retry-owned'});
    await withResearchTestWorker(api, f.repository, next.id, f.project.id, async id => {
      f.repository.runs.markRunning(id, f.project.id, {providerId: 'fixture', modelId: 'fixture'});
      assert.equal(f.effects.getFigure(id, f.project.id, figure.id).id, figure.id);
      assert.equal((await f.effects.publishFigure(id, f.project.id, figure.id, null)).runId, figure.id);
      const other = f.repository.figureRuns.create(figureRequest(f.project.id, null, {requestId: 'unowned'}),
        f.project.workspacePath, f.project.workspacePath, '/tmp/roc-storage');
      assert.throws(() => f.effects.getFigure(id, f.project.id, other.id), /research_production_owner_mismatch/);
    });
    assert.throws(() => f.withWorker(() => f.effects.getFigure(f.run.id, f.project.id, figure.id)), /research_run_not_current/);
    assert.equal(f.repository.figureRuns.list(f.project.id, 10).filter(run => run.ownerRunId === f.run.id).length, 1);
  } finally {f.close();}
});
