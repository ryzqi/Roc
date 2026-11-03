import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createResearchFixture, loadResearchWorkerTestApi } from '../unit/fixtures/research-test-kit.mjs';

let api;
before(async () => {
  api = await loadResearchWorkerTestApi();
});
after(() => api.dispose());
const hash = value => createHash('sha256').update(value).digest('hex');

async function runtimeDescription() {
  const executable = await realpath(process.execPath);
  const metadata = {nodeVersion: process.versions.node, electronVersion: process.versions.electron,
    platform: process.platform, architecture: process.arch, typescript: process.features.typescript};
  assert.ok(metadata.electronVersion, 'integration must run inside Electron');
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

async function runScenario(stages, reportFailure = false) {
  const fullWorkflow = stages[0] === 'discovery';
  const temporary = await mkdtemp(join(tmpdir(), 'roc-p0-production-'));
  const root = await realpath(temporary), workspace = join(root, 'workspace');
  await mkdir(workspace);
  for (const name of ['experiment.mts', 'measurements.csv']) {
    await copyFile(`tests/fixtures/research-workflow/${name}`, join(workspace, name));
  }
  const f = createResearchFixture(api, stages[0], workspace);
  const persistenceErrors = [];
  const logger = {error: (...args) => persistenceErrors.push(args), warn: (...args) => persistenceErrors.push(args)};
  const description = await runtimeDescription();
  const environments = new api.ResearchExperimentEnvironmentService({typescriptRuntime: async () => description});
  const experiments = new api.ResearchExperimentService(f.repository, environments, root, logger);
  const tools = new api.ResearchToolchain(await realpath('.runtime/research-toolchain/darwin-arm64'));
  const figures = new api.ResearchFigureService(f.repository, tools, root, logger);
  const files = new api.ResearchWorkspaceFileService(f.db, f.repository, () => new Date().toISOString());
  if (reportFailure) tools.compileTypst = async () => ({exitCode: 1, stdout: '', stderr: 'fixture_typst_failure'});
  const templates = new api.ResearchTemplateService(f.repository, tools);
  const exports = new api.ResearchExportService(f.repository,
    new api.ResearchExportSourceService(f.repository, figures, experiments, templates), tools, root, logger);
  const effects = new api.ResearchProductionEffectService(f.repository, files, experiments, figures, templates, exports);
  const documents = new api.ResearchDocumentService(f.repository, tools, root);
  const library = new api.ResearchLibraryService(f.repository.library, tools, root);
  const imports = new api.LiteratureImportService(f.db, f.repository.library,
    new api.LiteratureSearchService(async (_url, init) => {
      init.signal.throwIfAborted();
      return Response.json({results: [{
        id: 'https://openalex.org/ROC_SYNTHETIC_FIXTURE', title: 'Synthetic reproducibility fixture',
        authorships: [{author: {display_name: 'Roc fixture'}}], publication_year: 2026,
        abstract_inverted_index: {Synthetic: [0], group: [1, 7], A: [2], mean: [3, 9], is: [4, 10], '2.': [5], B: [8], '4.': [11]}
      }]});
    }), library, async () => {});
  const capabilities = {invoke(name, input) {
    switch (name) {
      case 'research.literature.search': return imports.search(input);
      case 'research.literature.getSearch': return imports.readSearch(input);
      case 'research.library.addLiterature': return imports.add(input);
      case 'research.library.getImportOperation': return imports.get(input);
      case 'research.library.cancelImportOperation': return imports.cancel(input.operationId);
      default: throw new Error(`unexpected P0 capability: ${name}`);
    }
  }};
  const gate = api.createResearchHumanGate({repository: f.repository, production: {verifyStage: projectId =>
    f.repository.getWorkflow(projectId).currentStage === 'figure' ? figures.verifyStage(projectId) : exports.verifyStage(projectId)}});
  const budget = {...api.createRunBudget({contextBudgetTokens: 1000, maxOutputTokens: 250}),
    maxCallTokens: 1400, maxTotalTokens: 40000, maxModelCalls: 20};
  f.tasks.projectBudgets.save({projectId: f.project.id, expectedRevision: 1,
    limits: {maxTotalTokens: 60000, maxModelCalls: 30, maxConcurrentModelCalls: 4, maxCostMicrousd: null}});
  const ledger = new api.RunBudgetLedger(f.agentDb);
  const chat = seedChat(f, budget);
  let providerAttempts = 0, currentRun;
  const produced = {};
  const executionErrors = [];
  const fixedOutput = stage => {
    const output = {title: `Fixed ${stage}`, markdown: 'Original synthetic engineering fixture.',
      claims: [], sections: [], verdict: 'ready'};
    if (stage === 'figure') output.claims.push({
      subjectType: 'figure', content: 'The fixed data means are A=2 and B=4.',
      status: 'supported', evidenceIds: [produced.evidence.id]
    });
    if (stage === 'writing') {
      output.claims.push(
        {subjectType: 'paragraph', content: 'The original fixture reports synthetic group means A=2 and B=4.',
          status: 'supported', evidenceIds: [produced.paperEvidence.id]},
        {subjectType: 'paragraph', content: 'The frozen experiment reproduces synthetic group means A=2 and B=4.',
          status: 'supported', evidenceIds: [produced.evidence.id]}
      );
      output.sections.push({title: 'Fixed data results', claimIndexes: [0, 1]});
    }
    if (stage === 'ideation') {
      const fields = {problem: 'Reproduce the synthetic means.', hypothesis: 'The frozen runner matches the fixture.',
        novelty: 'Engineering integration only.', supportingEvidence: '', counterevidence: '',
        experiment: 'Run the locked TypeScript interface.', risks: 'No scientific quality claim.'};
      output.ideaCanvas = {...fields, priority: 'medium', rationale: 'Check engineering reproducibility.',
        fields: Object.entries(fields).map(([key, content]) => ({key, content, status: 'pending', evidenceIds: []}))};
    }
    return output;
  };
  class Model extends BaseChatModel {
    _llmType() { return 'p0-fixed-provider'; }
    bindTools(tools) {
      const output = tools.find(tool => !currentRun.toolNames.includes(tool.function?.name ?? tool.name));
      assert.ok(output, 'structured response tool must be supplied by the actual SDK');
      this.responseToolName = output.function?.name ?? output.name;
      return this;
    }
    async _generate() {
      providerAttempts++;
      return {generations: [{text: '', message: new AIMessage({
        content: '', tool_calls: [{id: `output-${providerAttempts}`, name: this.responseToolName, type: 'tool_call',
          args: fixedOutput(currentRun.stage)}],
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
          if (input.run.stage === 'retrieval') {
            produced.search = await tool('search_literature').invoke({
              query: 'Synthetic reproducibility fixture', sources: ['openalex'], limit: 5
            });
            assert.equal(produced.search.status, 'complete');
            assert.equal(f.repository.library.list({projectId: f.project.id, query: '', limit: 20,
              includeArchived: false}).length, 0, 'search alone cannot import');
            produced.import = await tool('add_literature').invoke({requestId: 'p0-manual-import',
              destination: 'current_project', entries: [{
                kind: 'candidate', searchId: produced.search.searchId, candidateId: produced.search.candidates[0].candidateId
              }]});
            assert.equal(produced.import.status, 'completed');
            assert.equal(produced.import.counts.created, 1);
          } else if (input.run.stage === 'reading') {
            produced.document = await documents.import({target: 'library-item', projectId: f.project.id,
              libraryItemId: produced.import.items[0].libraryItemId,
              sourcePath: await realpath('tests/fixtures/research-workflow/source.pdf')});
            produced.document = await documents.parse(produced.document.id);
            assert.equal(produced.document.status, 'ready', produced.document.error);
            const parsed = documents.parsed(produced.document.id, produced.document.currentParseId);
            assert.equal(parsed.content.parseMode, 'native-text');
            const chunk = f.db.prepare(`SELECT c.id FROM research_knowledge_chunks c
              JOIN research_knowledge_documents d ON d.id=c.document_id
              WHERE d.id=? AND d.source_type='file' AND d.source_id=?
                AND c.content LIKE '%Synthetic group A mean is 2%'`)
              .get(`document:${produced.document.currentParseId}`, produced.document.libraryItemId);
            assert.ok(chunk, 'actual PDF parsing must index located source text');
            produced.paperEvidence = await tool('capture_evidence').invoke({chunkId: chunk.id});
            assert.match(produced.paperEvidence.locator, /page/iu);
          } else if (input.run.stage === 'experiment') {
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
          } else if (input.run.stage === 'export') {
            const started = await tool('prepare_export').invoke({requestId: 'fixed-export',
              title: 'Synthetic reproducibility fixture', manuscriptArtifactId: produced.manuscriptId,
              figureIds: [produced.figure.figureId], template: {kind: 'default', language: 'en'}});
            await until(() => f.repository.exports.get(f.project.id, started.exportId).status !== 'preparing');
            const status = await tool('get_export').invoke({exportId: started.exportId});
            if (reportFailure) {
              assert.equal(status.status, 'failed', 'report failure must fail the export job');
              produced.failedExport = f.repository.exports.get(f.project.id, started.exportId);
              const diagnostic = await exports.read(f.project.id, started.exportId, 'logs/export-error.txt');
              produced.exportError = diagnostic.content;
              assert.match(diagnostic.content, /research_typst_report_failed:fixture_typst_failure/u);
              throw new Error('research_p0_expected_report_failure');
            }
            if (status.status !== 'ready') {
              const diagnostic = await exports.read(f.project.id, started.exportId, 'logs/export-error.txt');
              assert.fail(`${status.error}\n${diagnostic.content}`);
            }
            produced.export = await tool('publish_export').invoke({exportId: started.exportId, replacesExportId: null});
          }
          const result = await prepared.execute(input);
          produced.lastRoleOutput = result.output;
          return result;
        } catch (error) {
          executionErrors.push(error);
          throw error;
        }
      }};
    }
  };
  const runtime = new api.ResearchStageRuntime(f.repository, capabilities, executor, gate, effects);
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
    for (const stage of stages) {
      const request = {projectId: f.project.id, expectedStage: stage, instruction: 'Reproduce the fixed synthetic means.', requestId: `p0-${stage}`};
      const token = chat.broker.issueResearchDispatch({runId: 'chat', threadId: 'thread', manifest: chat.manifest, request});
      const run = runtime.start(request, chat.broker.consumeResearchDispatch(token, request));
      taskId ??= run.taskId;
      assert.equal(run.taskId, taskId);
      await runtime.waitForIdle();
      if (reportFailure && stage === 'export') {
        assert.equal(executionErrors.length, 1);
        assert.equal(executionErrors[0].message, 'research_p0_expected_report_failure');
        assert.equal(f.repository.runs.get(run.id, f.project.id).status, 'failed');
        assert.equal(f.tasks.get(taskId, f.project.id).status, 'failed');
        assert.equal(produced.failedExport.artifactId, null);
        assert.equal(produced.failedExport.archive, null);
        assert.equal(produced.failedExport.approval, 'unpublished');
        await assert.rejects(exports.publish(f.project.id, produced.failedExport.id, null), /research_export_ready_required/u);
        const destinationPath = join(workspace, 'failed-export.zip');
        await assert.rejects(exports.write({projectId: f.project.id,
          exportId: produced.failedExport.id, destinationPath}), /research_export_approval_required/u);
        assert.equal(existsSync(destinationPath), false);
        const artifactRoot = join(process.cwd(), '.artifacts/research-optimization/p0-production', taskId);
        await mkdir(artifactRoot, {recursive: true});
        await writeFile(join(artifactRoot, 'report-failure.json'), JSON.stringify({
          taskId, injectedFailure: 'fixture_typst_failure', export: produced.failedExport,
          error: produced.exportError,
          diagnostics: new api.ResearchTaskDiagnosticsService(f.repository, ledger).get({projectId: f.project.id, taskId}),
          events: f.tasks.events({projectId: f.project.id, taskId, afterSequence: 0, limit: 200}).events
        }, null, 2));
        await f.db.backup(join(artifactRoot, 'research.db'));
        await f.agentDb.backup(join(artifactRoot, 'agent.db'));
        assert.deepEqual(persistenceErrors, []);
        return;
      }
      assert.deepEqual(executionErrors, []);
      assert.equal(f.repository.runs.get(run.id, f.project.id).status, 'completed',
        `${stage}: ${f.repository.runs.get(run.id, f.project.id).error}\n${JSON.stringify(produced.lastRoleOutput)}`);
      const completed = f.repository.runs.get(run.id, f.project.id);
      if (stage === 'writing') produced.manuscriptId = completed.outputArtifactIds[0];
      const task = f.tasks.get(taskId, f.project.id);
      if (stage === 'discovery') assert.equal(task.status, 'active');
      else {
        assert.equal(task.status, 'waiting_approval', `${stage}: ${task.statusReason}`);
        if (stage === 'export') await assert.rejects(exports.write({projectId: f.project.id,
          exportId: produced.export.exportId, destinationPath: join(workspace, 'before-approval.zip')}), /research_export_approval_required/u);
        await gate.approve({projectId: f.project.id, expectedStage: stage, action: 'approve',
          ...(stage === 'review' ? {reviewDecision: 'accept'} : {})});
      }
      runtime.synchronizeTaskState(taskId, f.project.id);
      assert.equal(f.tasks.get(taskId, f.project.id).status, stage === 'export' ? 'completed' : 'active');
    }
    const calls = fullWorkflow ? 14 : 3;
    assert.equal(providerAttempts, calls);
    assert.equal(f.repository.getWorkflow(f.project.id).currentStage, fullWorkflow ? 'export' : 'writing');
    const diagnostics = new api.ResearchTaskDiagnosticsService(f.repository, ledger).get({projectId: f.project.id, taskId});
    assert.equal(diagnostics.executions.length, fullWorkflow ? 17 : 5);
    assert.equal(diagnostics.budget.tokens.settled, calls * 20);
    assert.equal(diagnostics.budget.calls.models.total, calls);
    assert.equal(diagnostics.budget.cost.state, 'unknown');
    assert.equal(f.tasks.projectBudgets.status(f.project.id).models.total, calls);
    assert.equal(f.repository.getArtifact(produced.figure.artifactId).status, 'approved');
    const figureRun = figures.getRun(f.project.id, produced.figure.runId);
    assert.equal(figureRun.files.find(file => file.area === 'input' && file.path === 'means.csv').sha256, produced.means.file.sha256);
    const events = f.tasks.events({projectId: f.project.id, taskId, afterSequence: 0, limit: 200}).events;
    assert.equal(events.filter(event => event.eventType === 'call_linked').length, 1);
    assert.equal(events.filter(event => event.eventType === 'call_settled').length, calls - 1);
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
    if (fullWorkflow) {
      const record = f.repository.exports.get(f.project.id, produced.export.exportId);
      assert.equal(record.approval, 'approved');
      assert.equal(record.sources.review.status, 'accepted');
      assert.equal(record.sources.review.reportArtifactIds.length, 4);
      produced.delivery = await exports.write({projectId: f.project.id, exportId: record.id,
        destinationPath: join(artifactRoot, 'export.zip')});
      assert.equal(hash(await readFile(produced.delivery.destinationPath)), record.archive.sha256);
      for (const path of ['paper.pdf', 'report.pdf', 'source/roc-manuscript.tex', 'manifest.json']) {
        const file = await exports.read(f.project.id, record.id, path);
        const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
        assert.equal(hash(bytes), file.file.sha256);
        await mkdir(dirname(join(artifactRoot, path)), {recursive: true});
        await writeFile(join(artifactRoot, path), bytes);
      }
      const jobDir = join(artifactRoot, 'preview-job');
      await mkdir(jobDir);
      produced.previews = {};
      for (const name of ['paper', 'report']) {
        const preview = await tools.renderPdf({projectRoot: artifactRoot, sourcePath: join(artifactRoot, `${name}.pdf`),
          outputDir: join(jobDir, `${name}-preview`), jobDir, page: 1, scale: 1});
        assert.equal(preview.sourceHash, record.files.find(file => file.path === `${name}.pdf`).sha256);
        assert.ok(preview.text.length > 0);
        produced.previews[name] = preview;
      }
      assert.match(produced.previews.paper.text, /A\s*=\s*2.*B\s*=\s*4/isu);
      assert.match(produced.previews.report.text, /Synthetic reproducibility study/u);
    }
    await f.db.backup(join(artifactRoot, 'research.db'));
    await f.agentDb.backup(join(artifactRoot, 'agent.db'));
    await writeFile(join(artifactRoot, 'report.json'), JSON.stringify({
      scope: fullWorkflow ? 'P0.2 standard offline research workflow' : 'P0.1 fixed-data experiment and figure integration',
      provider: 'local fixture only',
      taskId, diagnostics, projectBudget: f.tasks.projectBudgets.status(f.project.id), events,
      files: {means: produced.means.file, figure: figureRun.files}, evidence: produced.evidence,
      literature: {search: produced.search, import: produced.import, document: produced.document, evidence: produced.paperEvidence},
      delivery: produced.delivery,
      previews: produced.previews,
      runtime: {...description, environment: undefined},
      limits: fullWorkflow ? 'No live model quality evaluation, OCR model run or remaining fault matrix.' :
        'Retrieval, PDF capture, manuscript/review/export and the remaining fault matrix are not exercised here.'
    }, null, 2));
    assert.deepEqual(persistenceErrors, []);
  } finally {
    await runtime.shutdown();
    await experiments.shutdown();
    await figures.shutdown();
    await templates.shutdown();
    await exports.shutdown();
    await documents.shutdown();
    await imports.shutdown();
    await library.shutdown();
    f.close();
    await rm(temporary, {recursive: true, force: true});
  }
}

test('trusted chat task spans real TypeScript data output, Skia figure publication and human approval',
  () => runScenario(['experiment', 'figure']));

test('standard offline task parses PDF evidence, plans, experiments, reviews and delivers real compiled PDFs',
  () => runScenario(['discovery', 'retrieval', 'reading', 'ideation', 'planning', 'experiment', 'figure', 'writing', 'review', 'export']));

test('a failed Typst report fails the real export job and prevents publication, approval and local delivery',
  () => runScenario(['discovery', 'retrieval', 'reading', 'ideation', 'planning', 'experiment', 'figure', 'writing', 'review', 'export'], true));
