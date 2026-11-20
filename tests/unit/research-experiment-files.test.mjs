import assert from 'node:assert/strict';
import {BaseChatModel} from '@langchain/core/language_models/chat_models';
import {AIMessage} from '@langchain/core/messages';
import {before, after, test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResearchTestRoleTools, createResearchFixture, loadResearchTestApi, withResearchTestWorker} from './fixtures/research-test-kit.mjs';

let api;
before(async () => { api = await loadResearchTestApi(); });
after(() => api.dispose());

async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'roc-owned-experiment-files-')));
  const f = createResearchFixture(api, 'experiment', directory);
  const request = {projectId: f.project.id, ownerRunId: f.run.id, requestId: 'failed-fixture',
    label: 'Failed fixture', engine: 'typescript', runtime: {kind: 'bundled-node'}, sourceVersion: 1,
    sourcePath: 'fixture.mts', inputPaths: [], parameters: {}, timeoutMs: 1000, network: 'disabled'};
  const execution = f.withWorker(() => f.repository.experiments.create(request, directory, directory, directory));
  const stderr = 'golden assertion G18: expected -1/12 actual +1/12\n'.repeat(200);
  const files = [];
  for (const [area, path, content] of [['log', 'stderr.txt', Buffer.from(stderr)],
    ['output', 'metrics.json', Buffer.from('{"provenance":"fixture"}')],
    ['output', 'binary.dat', Buffer.from([0xff, 0xfe])]]) {
    await mkdir(join(directory, execution.id, area), {recursive: true});
    await writeFile(join(directory, execution.id, area, path), content);
    files.push({area, path, size: content.length, sha256: createHash('sha256').update(content).digest('hex')});
  }
  for (let i = 0; i < 50; i++) files.push({...files[0], path: `other-${i}.txt`});
  f.repository.experiments.finish(f.project.id, execution.id,
    {status: 'failed', files, exitCode: 1, error: 'research_experiment_process_failed'});
  const service = new api.ResearchExperimentService(f.repository, undefined, directory, {error() {}});
  const controller = new AbortController();
  const get = (readService = service) => createResearchTestRoleTools(api, {
    run: f.run, context: f.repository.runs.getContext(f.run.id), repository: f.repository,
    capabilities: {}, effects: new api.ResearchProductionEffectService(f.repository, undefined, readService),
    signal: controller.signal
  }).find(tool => tool.name === 'get_experiment');
  return {...f, request, execution, stderr, files, service, controller, get,
    async cleanup() { f.close(); await rm(directory, {recursive: true, force: true}); }};
}

test('actual role tool discovers failed experiment files and reads real stderr and output in bounded pages', async () => {
  const f = await setup();
  try {
    const get = f.get(), experimentId = f.execution.id;
    const summary = await get.invoke({experimentId});
    assert.equal(summary.status, 'failed');
    assert.equal(summary.error, 'research_experiment_process_failed');
    assert.equal(summary.files.length, 50);
    assert.equal(summary.nextFileOffset, 50);
    assert.deepEqual(summary.files[0], f.files[0]);
    const remaining = await get.invoke({experimentId, fileOffset: 50});
    assert.equal(remaining.files.length, 3); assert.equal(remaining.nextFileOffset, null);
    const first = await get.invoke({experimentId, file: {area: 'log', path: 'stderr.txt', offset: 0, limit: 8000}});
    assert.equal(first.file.content, f.stderr.slice(0, 8000));
    assert.equal(first.file.totalChars, f.stderr.length); assert.equal(first.file.nextOffset, 8000);
    const rest = await get.invoke({experimentId, file: {area: 'log', path: 'stderr.txt', offset: 8000, limit: 8000}});
    assert.equal(first.file.content + rest.file.content, f.stderr); assert.equal(rest.file.nextOffset, null);
    const output = await get.invoke({experimentId, file: {area: 'output', path: 'metrics.json', offset: 0, limit: 100}});
    assert.equal(output.file.content, '{"provenance":"fixture"}');
    await assert.rejects(get.invoke({experimentId, file: {area: 'log', path: 'stderr.txt', offset: 0, limit: 8001}}));
    await assert.rejects(get.invoke({experimentId, file: {area: 'log', path: '../stderr.txt', offset: 0, limit: 10}}));
    await assert.rejects(get.invoke({experimentId, projectId: 'foreign'}));
    await assert.rejects(get.invoke({experimentId, file: {area: 'output', path: 'binary.dat', offset: 0, limit: 10}}), /text_required/u);
  } finally { await f.cleanup(); }
});

test('experiment file reads enforce project and owner before I/O, cancellation and late-result fencing', async () => {
  const f = await setup();
  try {
    let reads = 0;
    const get = f.get({async read(input) { reads++; return f.service.read(input); }});
    const foreignProject = f.repository.createProject({title: 'Foreign project', description: '', workspacePath: '/tmp/foreign-files'});
    const foreign = f.repository.experiments.create({...f.request, projectId: foreignProject.id, ownerRunId: null},
      foreignProject.workspacePath, foreignProject.workspacePath, '/tmp/foreign-files');
    const unowned = f.repository.experiments.create({...f.request, ownerRunId: null, requestId: 'unowned'},
      f.project.workspacePath, f.project.workspacePath, '/tmp/foreign-files');
    const file = {area: 'log', path: 'stderr.txt', offset: 0, limit: 100};
    await assert.rejects(get.invoke({experimentId: foreign.id, file}), /research_experiment_project_mismatch/u);
    await assert.rejects(get.invoke({experimentId: unowned.id, file}), /research_production_owner_mismatch/u);
    assert.equal(reads, 0);
    const late = f.get({async read(input) {
      const result = await f.service.read(input);
      f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture_cancelled');
      return result;
    }});
    await assert.rejects(late.invoke({experimentId: f.execution.id, file}), /research_run_not_current/u);
    await assert.rejects(get.invoke({experimentId: f.execution.id, file}), /research_run_not_current/u);
    f.controller.abort(new Error('fixture_abort'));
    await assert.rejects(get.invoke({experimentId: f.execution.id, file}), /fixture_abort/u);
  } finally { await f.cleanup(); }
});

test('explicit retry of the same logical node can diagnose its previous failed experiment', async () => {
  const f = await setup();
  try {
    const old = f.get();
    f.repository.runs.terminate(f.run.id, f.project.id, 'failed', 'fixture_retry');
    const queued = f.repository.runs.retry({projectId: f.project.id, runId: f.run.id, requestId: 'retry-files'});
    const run = withResearchTestWorker(api, f.repository, queued.id, f.project.id, id =>
      f.repository.runs.markRunning(id, f.project.id, {providerId: 'fixture', modelId: 'fixture'}));
    const get = createResearchTestRoleTools(api, {run, context: f.repository.runs.getContext(run.id),
      repository: f.repository, capabilities: {},
      effects: new api.ResearchProductionEffectService(f.repository, undefined, f.service),
      signal: new AbortController().signal}).find(tool => tool.name === 'get_experiment');
    const request = {experimentId: f.execution.id, file: {area: 'log', path: 'stderr.txt', offset: 0, limit: 100}};
    const result = await get.invoke(request);
    assert.equal(result.file.content, f.stderr.slice(0, 100));
    assert.equal(result.ownerRunId, f.run.id);
    await assert.rejects(old.invoke(request), /research_run_not_current/u);
  } finally { await f.cleanup(); }
});

test('actual stage createAgent corrects a truncated experiment ID and reads its real log', async () => {
  const f = await setup();
  const output = {title: 'Experiment failure diagnosed', markdown: 'The real stderr contains a failed golden assertion.',
    claims: [], sections: [], verdict: 'uncertain'};
  let responseToolName, requests = 0;
  class Model extends BaseChatModel {
    _llmType() { return 'experiment-reference-recovery-fixture'; }
    bindTools(tools) {
      const response = tools.find(tool => (tool.function?.name ?? tool.name) !== 'get_experiment');
      responseToolName = response.function?.name ?? response.name;
      return this;
    }
    async _generate(messages) {
      requests++;
      if (requests === 2) {
        const error = messages.find(message => message.tool_call_id === 'short-id');
        assert.equal(error?.status, 'error');
        assert.match(String(error.content), /research_experiment_not_found/);
        assert.match(String(error.content), /full.*experimentId.*start_experiment/i);
      }
      if (requests === 3) {
        const corrected = messages.find(message => message.tool_call_id === 'full-id');
        assert.notEqual(corrected?.status, 'error');
        const result = JSON.parse(String(corrected.content));
        assert.equal(result.experimentId, f.execution.id);
        assert.equal(result.file.content, f.stderr.slice(0, 100));
      }
      assert.ok(requests <= 3, 'Correct the reference and finish without polling');
      return {generations: [{text: '', message: new AIMessage({content: '', tool_calls: [requests === 1
        ? {id: 'short-id', name: 'get_experiment', args: {experimentId: f.execution.id.slice(0, 19)}, type: 'tool_call'}
        : requests === 2 ? {id: 'full-id', name: 'get_experiment', args: {experimentId: f.execution.id,
          file: {area: 'log', path: 'stderr.txt', offset: 0, limit: 100}}, type: 'tool_call'}
        : {id: 'diagnosed', name: responseToolName, args: output, type: 'tool_call'}]})}]};
    }
  }
  try {
    const context = f.repository.runs.getContext(f.run.id);
    const tools = [f.get()];
    const modelConfig = api.createRunModelConfig({contextWindowTokens: 10000, maxOutputTokens: 1000});
    const executor = api.createResearchRoleExecutor({async createDefaultModelHandle() {
      return {providerId: 'fixture-provider', modelId: 'fixture-model', langChainHandle: {model: new Model({maxRetries: 0})}};
    }}, new api.RunUsageLedger(f.agentDb));
    const prepared = await executor.prepare({kind: 'app_default'}, modelConfig);
    const result = await f.withWorker(() => prepared.execute({run: f.run, context, tools, signal: f.controller.signal,
      loadTaskContext: () => ({task: f.tasks.get(f.run.taskId, f.project.id),
        facts: new api.ResearchTaskFactsService(f.repository).get({taskId: f.run.taskId, projectId: f.project.id})})}));
    assert.deepEqual(result.output, output);
    assert.equal(requests, 3);
  } finally {await f.cleanup();}
});
