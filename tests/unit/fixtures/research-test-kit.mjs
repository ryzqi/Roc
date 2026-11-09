import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cp, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

async function loadApi(productionWorkers) {
  const directory = mkdtempSync(join(tmpdir(), 'roc-research-contract-'));
  try {
    symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
    if (productionWorkers) {
      await cp(join(process.cwd(), 'dist/main'), directory, {recursive: true});
      await writeFile(join(directory, 'package.json'), JSON.stringify({type: 'module'}));
    }
    const outfile = join(directory, 'api.mjs');
    await build({
      entryPoints: ['tests/unit/fixtures/research-test-api.ts'],
      outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external',
      loader: { '.md': 'text', '.c': 'text' }, logLevel: 'silent'
    });
    const api = await import(outfile);
    return { ...api, modulePath: outfile, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function loadResearchTestApi() { return loadApi(false); }
export function loadResearchWorkerTestApi() { return loadApi(true); }

const testWorkerLeases = new WeakMap();
/** Explicit worker adapter for repository tests; uses the production claim and fencing checks. */
export function withResearchTestWorker(api, repository, runId, projectId, work) {
  let leases = testWorkerLeases.get(repository);
  if (leases === undefined) { leases = new Map(); testWorkerLeases.set(repository, leases); }
  let lease = leases.get(runId);
  if (lease === undefined) {
    const run = repository.runs.get(runId, projectId);
    const binding = repository.tasks.requireExecution('stage', runId, run.projectId).nodeBinding;
    if (binding.kind !== 'dag') throw new Error('fixture_worker_binding_missing');
    const node = repository.tasks.graph.get(binding.nodeId, run.projectId);
    lease = node.lease ?? repository.tasks.graph.claim({nodeId: node.id, projectId: run.projectId,
      workerId: 'fixture-worker', expectedRevision: node.revision, ttlMs: 300_000, concurrency: 2});
    if (lease === null) throw new Error('fixture_worker_claim_failed');
    leases.set(runId, lease);
  }
  return api.withResearchWorker(lease, () => work(runId));
}

/** Run both tool construction and invocation in the same explicitly claimed test worker. */
export function createResearchTestRoleTools(api, input) {
  const worker = work => withResearchTestWorker(api, input.repository, input.run.id, input.run.projectId, work);
  return worker(() => api.createResearchRoleTools(input)).map(tool => {
    const invoke = tool.invoke.bind(tool);
    tool.invoke = (...args) => worker(() => invoke(...args));
    return tool;
  });
}

export function researchSearchPlanFixture(researchQuestion, queries = [
  {query: 'Synthetic reproducibility fixture', sources: ['openalex'], limit: 5, maxPages: 1}
]) {
  const identified = queries.map((query, index) => ({...structuredClone(query), id: `query-${index + 1}`}));
  return {schemaVersion: 1, version: 1, researchQuestion, refinedQuestion: 'What are the fixed synthetic group means?',
    keywords: ['synthetic', 'reproducibility'], synonyms: [{term: 'reproducibility', alternatives: ['replication']}],
    domain: 'Synthetic engineering fixture', excludedTerms: [], queries: identified,
    perspectives: [{id: 'primary', label: 'Primary evidence', rationale: 'Answer the frozen question',
      expectedEvidence: 'Reproducible reported results', queryIds: identified.map(query => query.id)}]};
}

export function createResearchFixture(api, stage = 'figure', workspacePath = '/tmp/roc-research-fixture') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const now = () => '2026-11-03T00:00:00.000Z';
  api.applyResearchDatabaseSchema(db, now);
  const agentDb = new Database(':memory:');
  agentDb.pragma('foreign_keys = ON');
  api.applyAgentDatabaseSchema(agentDb);
  const tasks = new api.ResearchTaskRepository(agentDb, now);
  const repository = new api.ResearchRepository(db, tasks, now);
  const project = repository.createProject({
    title: 'Synthetic reproducibility study', description: 'Contract fixture',
    workspacePath
  });
  db.prepare('UPDATE research_projects SET current_stage = ? WHERE id = ?').run(stage, project.id);
  db.prepare("UPDATE research_stage_states SET status = 'ready' WHERE project_id = ? AND stage = ?")
    .run(project.id, stage);
  const queued = repository.runs.begin({
    projectId: project.id, expectedStage: stage, instruction: 'Produce fixture artifact', requestId: 'stage-1'
  });
  tasks.linkStage(queued, null);
  repository.runs.bindTask(queued.id, project.id);
  const binding = tasks.requireExecution('stage', queued.id, project.id).nodeBinding;
  const lease = tasks.graph.claim({nodeId: binding.nodeId, projectId: project.id, workerId: 'fixture-worker',
    expectedRevision: 1, ttlMs: 300_000, concurrency: 2});
  if (lease === null) throw new Error('fixture_worker_claim_failed');
  const withWorker = work => api.withResearchWorker(lease, work);
  const run = withWorker(() => repository.runs.markRunning(queued.id, project.id, { providerId: 'fixture-provider', modelId: 'fixture-model' }));
  return { db, agentDb, tasks, repository, project, run, lease, withWorker, close: () => { db.close(); agentDb.close(); } };
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

/** Freeze the exact stored artifact versions before a synthetic human decision. */
export function captureResearchArtifactVersions(repository, projectId) {
  const workflow=repository.getWorkflow(projectId);
  const current=workflow.stages.find(stage=>stage.stage===workflow.currentStage);
  return current.artifactIds.map(artifactId=>({artifactId,
    version:repository.inspectArtifact({projectId,artifactId,expectedVersion:null}).snapshot.version}));
}
