import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

export async function loadResearchTestApi() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-research-contract-'));
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
    const outfile = join(directory, 'api.mjs');
    await build({
      entryPoints: ['tests/unit/fixtures/research-test-api.ts'],
      outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external',
      loader: { '.md': 'text' }, logLevel: 'silent'
    });
    const api = await import(outfile);
    return { ...api, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function createResearchFixture(api, stage = 'figure', workspacePath = '/tmp/roc-research-fixture') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const now = () => '2026-11-03T00:00:00.000Z';
  api.applyResearchDatabaseSchema(db, now);
  const agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  api.applyDatabaseMigrations(agentDb, { dbName: 'agent', migrations: api.agentMigrations });
  const tasks = new api.ResearchTaskRepository(agentDb, now);
  const repository = new api.ResearchRepository(db, tasks, now);
  const project = repository.createProject({
    title: 'Synthetic reproducibility study', description: 'Contract fixture',
    workspacePath
  });
  tasks.projectBudgets.save({ projectId: project.id, expectedRevision: 0, limits: {
    maxTotalTokens: Number.MAX_SAFE_INTEGER, maxModelCalls: 100000, maxConcurrentModelCalls: 100,
    maxCostMicrousd: null
  } });
  db.prepare('UPDATE research_projects SET current_stage = ? WHERE id = ?').run(stage, project.id);
  db.prepare("UPDATE research_stage_states SET status = 'ready' WHERE project_id = ? AND stage = ?")
    .run(project.id, stage);
  const queued = repository.runs.begin({
    projectId: project.id, expectedStage: stage, instruction: 'Produce fixture artifact', requestId: 'stage-1'
  });
  tasks.linkStage(queued, null);
  repository.runs.bindTask(queued.id, project.id);
  const run = repository.runs.markRunning(queued.id, project.id, { providerId: 'fixture-provider', modelId: 'fixture-model' });
  return { db, agentDb, tasks, repository, project, run, close: () => { db.close(); agentDb.close(); } };
}

export function figureRequest(projectId, ownerRunId, overrides = {}) {
  return {
    projectId, ownerRunId, requestId: 'figure-1', label: 'Synthetic means',
    engine: 'vega-lite', sourceVersion: 1, sourcePath: 'figure.vl.json',
    inputPaths: ['measurements.csv'], timeoutMs: 1000,
    figure: { widthInches: 3, heightInches: 2, dpi: 72, seed: 42 },
    ...overrides
  };
}
