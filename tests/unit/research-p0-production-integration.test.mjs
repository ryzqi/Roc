import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import electronPath from 'electron';
import { createResearchFixture, loadResearchTestApi } from './fixtures/research-test-kit.mjs';

let api;
before(async () => {
  api = await loadResearchTestApi();
  after(() => api.dispose());
});
const hash = value => createHash('sha256').update(value).digest('hex');

async function runtimeDescription() {
  const executable = await realpath(electronPath);
  const probe = spawnSync(executable, ['-e', 'console.log(JSON.stringify({nodeVersion:process.versions.node,electronVersion:process.versions.electron,platform:process.platform,architecture:process.arch,typescript:process.features.typescript}))'], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8'
  });
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  assert.equal(metadata.typescript, 'strip');
  const runnerPath = await realpath('resources/research-runtime/typescript-experiment-runner.mts');
  const runnerHash = hash(await readFile(runnerPath));
  const require = createRequire(import.meta.url);
  const packageEntries = {}, packageRoots = [], packages = [];
  for (const name of ['csv-parse', 'csv-stringify', 'd3-dsv', 'simple-statistics']) {
    const entry = await realpath(require.resolve(name));
    let root = dirname(entry);
    while (!existsSync(join(root, 'package.json'))) {
      const parent = dirname(root);
      assert.notEqual(parent, root, `package root missing: ${name}`);
      root = parent;
    }
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    packageEntries[name] = entry; packageRoots.push(root); packages.push({name, version: manifest.version});
  }
  packages.sort((left, right) => left.name.localeCompare(right.name));
  return { root: dirname(runnerPath), executable, runnerPath, runnerHash, packageEntries, packageRoots, packages,
    ...metadata, hash: hash(JSON.stringify({runnerHash, packages, ...metadata})), environment: {...process.env} };
}

async function until(predicate) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'P0 production integration timed out');
    await wait(10);
  }
}

function seedChat(f, budget) {
  const timestamp = new Date().toISOString();
  const manifest = api.compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
    mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null,
    researchProjectId: f.project.id
  }).manifest;
  const snapshot = api.createRunExecutionSnapshot({runId: 'chat', threadId: 'thread', inputMessageId: 'message', snapshot: {
    schemaVersion: 9, submissionHash: 'a'.repeat(64),
    taskContract: {contractVersion: 1, objective: 'Reproduce the synthetic means and publish a figure',
      constraints: [], kind: 'reply', criteria: [{id: 'response', description: 'Synthetic result', check: {kind: 'response'}}]},
    runOrigin: 'chat', model: {providerId: 'p0-fixture', modelId: 'fixture-model'}, mode: 'run',
    workspace: null, capabilityManifest: manifest, workflowHint: null, explicitSkillIds: [], dispatchKey: null,
    researchProjectId: f.project.id, budget
  }});
  f.agentDb.prepare(`INSERT INTO agent_threads(id,kind,title,goal,status,research_project_id,created_at,updated_at)
    VALUES ('thread','chat','P0 integration','Synthetic research','active',?,?,?)`).run(f.project.id, timestamp, timestamp);
  f.agentDb.prepare(`INSERT INTO agent_runs(id,thread_id,run_number,user_input,status,started_at,
    enabled_capabilities_json,run_origin,snapshot_json,snapshot_version)
    VALUES ('chat','thread',1,'Reproduce means and publish a figure','running',?,'{}','chat',?,9)`)
    .run(timestamp, JSON.stringify(snapshot));
  return {manifest, broker: new api.ExecutionGrantBroker(f.agentDb)};
}

test('trusted chat task spans real TypeScript data output, Skia figure publication and human approval', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'roc-p0-production-'));
  const root = await realpath(temporary), workspace = join(root, 'workspace');
  await mkdir(workspace);
  for (const name of ['experiment.mts', 'measurements.csv']) {
    await copyFile(`tests/fixtures/research-workflow/${name}`, join(workspace, name));
  }
  const f = createResearchFixture(api, 'experiment', workspace);
  const persistenceErrors = [];
  const logger = {error: (...args) => persistenceErrors.push(args), warn: (...args) => persistenceErrors.push(args)};
  const description = await runtimeDescription();
  const environments = new api.ResearchExperimentEnvironmentService({typescriptRuntime: async () => description});
  const experiments = new api.ResearchExperimentService(f.repository, environments, root, logger);
  const figures = new api.ResearchFigureService(f.repository, {
    renderFigure: request => api.renderResearchFigure({
      operation: 'render_figure', projectRoot: request.projectRoot, sourcePath: request.sourcePath,
      outputDir: request.outputDir, inputPaths: request.inputPaths, label: request.label,
      timeoutMs: request.timeoutMs, figure: request.figure
    }, request.signal)
  }, root, logger);
  const files = new api.ResearchWorkspaceFileService(f.db, f.repository, () => new Date().toISOString());
  const tools = new api.ResearchToolchain(root);
  const templates = new api.ResearchTemplateService(f.repository, tools);
  const exports = new api.ResearchExportService(f.repository,
    new api.ResearchExportSourceService(f.repository, figures, experiments, templates), tools, root, logger);
  const effects = new api.ResearchProductionEffectService(f.repository, files, experiments, figures, templates, exports);
  const gate = api.createResearchHumanGate({repository: f.repository, production: {verifyStage: projectId => figures.verifyStage(projectId)}});
  const budget = {...api.createRunBudget({contextBudgetTokens: 1000, maxOutputTokens: 250}),
    maxCallTokens: 1400, maxTotalTokens: 20000, maxModelCalls: 12};
  f.tasks.projectBudgets.save({projectId: f.project.id, expectedRevision: 1,
    limits: {maxTotalTokens: 30000, maxModelCalls: 20, maxConcurrentModelCalls: 2, maxCostMicrousd: null}});
  const ledger = new api.RunBudgetLedger(f.agentDb);
  const chat = seedChat(f, budget);
  let providerAttempts = 0, currentRun, responseToolName;
  const produced = {};
  const executionErrors = [];
  class Model extends BaseChatModel {
    _llmType() { return 'p0-fixed-provider'; }
    bindTools(tools) {
      const output = tools.find(tool => !currentRun.toolNames.includes(tool.function?.name ?? tool.name));
      assert.ok(output, 'structured response tool must be supplied by the actual SDK');
      responseToolName = output.function?.name ?? output.name;
      return this;
    }
    async _generate() {
      providerAttempts++;
      return {generations: [{text: '', message: new AIMessage({
        content: '', tool_calls: [{id: `output-${providerAttempts}`, name: responseToolName, type: 'tool_call',
          args: {title: `Fixed ${currentRun.stage}`, markdown: 'Original synthetic engineering fixture.',
            claims: currentRun.stage === 'figure' ? [{
              subjectType: 'figure', content: 'The fixed data means are A=2 and B=4.',
              status: 'supported', evidenceIds: [produced.evidence.id]
            }] : [], sections: [], verdict: 'ready'}}],
        usage_metadata: {input_tokens: 12, output_tokens: 8, total_tokens: 20}
      })}]};
    }
  }
  const delegate = api.createResearchRoleExecutor({createDefaultModelHandle: async () => ({
    providerId: 'p0-fixture', modelId: 'fixture-model', langChainHandle: {model: new Model({maxRetries: 0})}
  })}, ledger);
  const executor = {
    async prepare(selection, limits) {
      const prepared = await delegate.prepare(selection, limits);
      return {...prepared, async execute(input) {
        try {
          currentRun = input.run;
          const tool = name => {
            const selected = input.tools.find(item => item.name === name);
            assert.ok(selected, `real role tool is missing: ${name}`);
            return selected;
          };
          if (input.run.stage === 'experiment') {
            const started = await tool('start_experiment').invoke({
              engine: 'typescript', runtime: {kind: 'bundled-node'}, requestId: 'fixed-data',
              label: 'Original synthetic group means', sourcePath: 'experiment.mts', sourceVersion: 1,
              inputPaths: ['measurements.csv'], parameters: {}, timeoutMs: 15000, network: 'disabled'
            });
            await until(() => !['preparing', 'running'].includes(f.repository.experiments.get(f.project.id, started.experimentId).status));
            const status = await tool('get_experiment').invoke({experimentId: started.experimentId});
            const stderr = await experiments.read({projectId: f.project.id, runId: started.experimentId, area: 'log', path: 'stderr.txt'});
            assert.equal(status.status, 'completed', `${status.error}\n${stderr.content}`);
            const output = await experiments.source({projectId: f.project.id, runId: started.experimentId, area: 'output', path: 'means.csv'});
            assert.equal(output.bytes.toString(), 'group,mean\nA,2\nB,4');
            produced.experiment = await tool('publish_experiment').invoke({experimentId: started.experimentId});
            produced.means = output;
          } else if (input.run.stage === 'figure') {
            const chunk = f.db.prepare(`SELECT c.id FROM research_knowledge_chunks c
              JOIN research_knowledge_documents d ON d.id=c.document_id
              WHERE d.project_id=? AND d.source_type='experiment' AND d.source_id=?
                AND c.locator='output/means.csv; lines 1-3'`).get(f.project.id, produced.experiment.experimentId);
            assert.ok(chunk, 'the real experiment must index its output as located evidence');
            produced.evidence = await tool('capture_evidence').invoke({chunkId: chunk.id});
            assert.equal(produced.evidence.excerpt, produced.means.bytes.toString());
            const values = produced.means.bytes.toString().split('\n').slice(1).map(line => {
              const [group, mean] = line.split(','); return {group, mean: Number(mean)};
            });
            const specification = JSON.stringify({data: {values}, mark: 'bar', encoding: {
              x: {field: 'group', type: 'nominal'}, y: {field: 'mean', type: 'quantitative'}
            }});
            await effects.saveWorkspaceFile(input.run.id, f.project.id, {path: 'means.csv', content: produced.means.bytes.toString(), expectedHash: null});
            await effects.saveWorkspaceFile(input.run.id, f.project.id, {path: 'figure.vl.json', content: specification, expectedHash: null});
            const started = await tool('start_figure').invoke({
              requestId: 'fixed-figure', label: 'Original synthetic group means',
              engine: 'vega-lite', sourceVersion: 1, sourcePath: 'figure.vl.json', inputPaths: ['means.csv'],
              timeoutMs: 15000, figure: {widthInches: 3, heightInches: 2, dpi: 72, seed: 42}
            });
            await until(() => !['preparing', 'running'].includes(figures.getRun(f.project.id, started.runId).status));
            const status = await tool('get_figure').invoke({runId: started.runId});
            assert.equal(status.status, 'completed', status.error);
            produced.figure = await tool('publish_figure').invoke({runId: started.runId, replacesFigureId: null});
          }
          return await prepared.execute(input);
        } catch (error) {
          executionErrors.push(error);
          throw error;
        }
      }};
    }
  };
  const runtime = new api.ResearchStageRuntime(f.repository, {}, executor, gate, effects);
  try {
    await new api.RunBudgetObserver(ledger, 'chat', budget, 'p0-fixture', {providerId: 'p0-fixture', modelId: 'fixture-model'}).invoke({
      purpose: 'agent', messages: [new HumanMessage('Reproduce the fixed synthetic means.')], responseMessage: value => value,
      invoke: async () => {
        providerAttempts++;
        return new AIMessage({content: 'Use the fixed data experiment.', usage_metadata: {input_tokens: 12, output_tokens: 8, total_tokens: 20}});
      }
    });
    f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture_initial_stage_replaced');
    let taskId;
    for (const stage of ['experiment', 'figure']) {
      const request = {projectId: f.project.id, expectedStage: stage, instruction: 'Reproduce the fixed synthetic means.', requestId: `p0-${stage}`};
      const token = chat.broker.issueResearchDispatch({runId: 'chat', threadId: 'thread', manifest: chat.manifest, request});
      const run = runtime.start(request, chat.broker.consumeResearchDispatch(token, request));
      taskId ??= run.taskId;
      assert.equal(run.taskId, taskId);
      await runtime.waitForIdle();
      assert.deepEqual(executionErrors, []);
      assert.equal(f.repository.runs.get(run.id, f.project.id).status, 'completed',
        f.repository.runs.get(run.id, f.project.id).error);
      const task = f.tasks.get(taskId, f.project.id);
      assert.equal(task.status, 'waiting_approval', `${stage}: ${task.statusReason}`);
      await gate.approve({projectId: f.project.id, expectedStage: stage, action: 'approve'});
      runtime.synchronizeTaskState(taskId, f.project.id);
      assert.equal(f.tasks.get(taskId, f.project.id).status, 'active');
    }
    assert.equal(providerAttempts, 3);
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'writing');
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, ledger).get({projectId: f.project.id, taskId});
    assert.equal(diagnostics.executions.length, 5);
    assert.equal(diagnostics.budget.tokens.settled, 60);
    assert.equal(diagnostics.budget.calls.models.total, 3);
    assert.equal(diagnostics.budget.cost.state, 'unknown');
    assert.equal(f.tasks.projectBudgets.status(f.project.id).models.total, 3);
    assert.equal(f.repository.getArtifact(produced.figure.artifactId).status, 'approved');
    const figureRun = figures.getRun(f.project.id, produced.figure.runId);
    assert.equal(figureRun.files.find(file => file.area === 'input' && file.path === 'means.csv').sha256, produced.means.file.sha256);
    const events = f.tasks.events({projectId: f.project.id, taskId, afterSequence: 0, limit: 200}).events;
    assert.equal(events.filter(event => event.eventType === 'call_linked').length, 1);
    assert.equal(events.filter(event => event.eventType === 'call_settled').length, 2);
    assert.ok(events.some(event => event.executionKind === 'experiment'));
    assert.ok(events.some(event => event.executionKind === 'figure'));
    const artifactRoot = join(process.cwd(), '.artifacts/research-optimization/p0-production', taskId);
    await mkdir(artifactRoot, {recursive: true});
    await writeFile(join(artifactRoot, 'means.csv'), produced.means.bytes);
    for (const file of figureRun.files.filter(file => file.area === 'output' && /\.(png|pdf|svg)$/u.test(file.path))) {
      const bytes = await figures.source({projectId: f.project.id, figureId: produced.figure.figureId,
        format: file.path.split('.').at(-1), sha256: file.sha256});
      await writeFile(join(artifactRoot, file.path), bytes);
      assert.equal(hash(bytes), file.sha256);
    }
    await f.db.backup(join(artifactRoot, 'research.db'));
    await f.agentDb.backup(join(artifactRoot, 'agent.db'));
    await writeFile(join(artifactRoot, 'report.json'), JSON.stringify({
      scope: 'P0.1 fixed-data experiment and figure integration', provider: 'local fixture only',
      taskId, diagnostics, projectBudget: f.tasks.projectBudgets.status(f.project.id), events,
      files: {means: produced.means.file, figure: figureRun.files}, evidence: produced.evidence,
      runtime: {...description, environment: undefined},
      limits: 'Retrieval, PDF capture, manuscript/review/export and the remaining fault matrix are not exercised here.'
    }, null, 2));
    assert.deepEqual(persistenceErrors, []);
  } finally {
    await runtime.shutdown();
    await experiments.shutdown();
    await figures.shutdown();
    await templates.shutdown();
    await exports.shutdown();
    f.close();
    await rm(temporary, {recursive: true, force: true});
  }
});
