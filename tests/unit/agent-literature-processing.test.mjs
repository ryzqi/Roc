import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

let directory, api;
before(async () => {
  directory = await mkdtemp(join(process.cwd(), '.runtime/tmp/p5-agent-literature-'));
  const outfile = join(directory, 'fixture.mjs');
  await build({stdin: {contents: `
    export {createLiteratureTools, createLiteratureProcessingTools, literatureProcessingToolNames} from './src/main/plugins/agent/literature-tools';
    export {literatureContext} from './src/main/services/literature-context';
    export {createResearchTools, RESEARCH_TOOL_DESCRIPTORS} from './src/main/plugins/agent/research-tools';
    export {compileRunCapabilityManifest} from './src/main/plugins/agent/run-capability-manifest';
  `, resolveDir: process.cwd()}, outfile, bundle: true, format: 'esm', platform: 'node',
    packages: 'external', loader: {'.md': 'text'}, logLevel: 'silent'});
  api = await import(pathToFileURL(outfile).href);
});
after(async () => {if (directory) await rm(directory, {recursive: true, force: true});});

const names = {search: 'research_search_literature', read: 'research_read_literature_search', add: 'research_add_literature',
  get: 'research_get_literature_import', cancel: 'research_cancel_literature_import'};
const job = (overrides = {}) => ({id: 'job-a', projectId: 'project-a', libraryItemId: 'item-a', title: 'Synthetic paper',
  generation: 'generation-a', stage: 'resolve', status: 'queued', attempts: 0, nextRetryAt: null,
  documentId: null, receipt: null, errorCode: null, updatedAt: '2026-11-19T00:00:00.000Z', ...overrides});
const receipt = (overrides = {}) => ({operationId: 'metadata-a', requestId: 'request-a', status: 'completed',
  acquisitionBatchId: 'batch-a', processingQueued: 3, destinationProjectId: 'project-a', requestedCount: 4, processedCount: 4,
  counts: {created: 1, linked: 1, alreadyPresent: 1, skippedArchived: 1, failed: 0, cancelled: 0, notProcessed: 0},
  items: [], nextOffset: null, ...overrides});
function setup(response = receipt(), overrides = {}) {
  const calls = [], controller = new AbortController();
  const context = {owner: 'thread:thread-a', projectId: 'project-a', runId: 'run-a', signal: controller.signal, ...overrides};
  const capabilities = {invoke: async (...args) => {
    calls.push({args, context: api.literatureContext()});
    return typeof response === 'function' ? response(...args) : response;
  }};
  const tools = [...api.createLiteratureTools(capabilities, context, names), ...api.createLiteratureProcessingTools(capabilities, context)];
  return {calls, controller, context, capabilities, tools, get: name => tools.find(tool => tool.name === name)};
}

test('add defaults to fulltext_auto, returns metadata receipt promptly and preserves explicit metadata_only', async () => {
  const f = setup(), entries = [{kind: 'doi', doi: '10.1234/p5'}];
  const output = await f.get(names.add).invoke({entries, requestId: 'request-a'});
  assert.equal(f.calls[0].args[0], 'research.library.addLiterature');
  assert.equal(f.calls[0].args[1].ingestionPolicy, 'fulltext_auto');
  assert.equal(f.calls[0].args[1].destination, 'current_project');
  assert.deepEqual(f.calls[0].context, f.context);
  assert.equal(output.statusScope, 'metadata_import');
  assert.equal(output.status, 'completed');
  assert.equal(output.metadataImported, 3);
  assert.equal(output.processingQueued, 3);
  assert.equal(output.acquisitionBatchId, 'batch-a');
  assert.match(output.reportingInstruction, /不是完成数/u);
  assert.equal(f.calls.length, 1, 'enqueue receipt must not poll or wait for background completion');
  // A completed conversation cannot retroactively cancel already accepted background work.
  f.controller.abort();
  assert.equal(f.calls.length, 1);
  const metadata = setup(receipt({processingQueued: 0}));
  await metadata.get(names.add).invoke({entries, requestId: 'metadata-only', ingestionPolicy: 'metadata_only'});
  assert.equal(metadata.calls[0].args[1].ingestionPolicy, 'metadata_only');
  assert.equal(metadata.calls.length, 1);
});

test('metadata get/cancel keep original counts and scope the completed status to metadata', async () => {
  const value = receipt(), f = setup(value);
  for (const [name, input, capability] of [[names.get, {requestId: 'request-a'}, 'research.library.getImportOperation'],
    [names.cancel, {operationId: 'metadata-a'}, 'research.library.cancelImportOperation']]) {
    const output = await f.get(name).invoke(input);
    assert.deepEqual(output.counts, value.counts);
    assert.equal(output.statusScope, 'metadata_import');
    assert.equal(output.metadataImported, 3);
    assert.equal(f.calls.at(-1).args[0], capability);
  }
  assert.equal(f.calls.some(call => call.args[0] === 'research.library.cancelAcquisition'), false);
});

test('processing query carries filters/pagination and trusted project, even across conversation ownership', async () => {
  const value = {jobs: [job({status: 'blocked', stage: 'index', errorCode: 'embedding_unconfigured'})], total: 21, nextOffset: 20};
  const f = setup(value);
  const result = await f.get(api.literatureProcessingToolNames.get).invoke({operationId: 'batch-a', libraryItemId: 'item-a', offset: 0, limit: 20});
  assert.deepEqual(result, value);
  assert.deepEqual(f.calls[0].args, ['research.library.listAcquisition', {
    operationId: 'batch-a', libraryItemId: 'item-a', offset: 0, limit: 20, projectId: 'project-a'
  }]);
  assert.equal(f.calls[0].context.owner, 'thread:thread-a');
  // The read has no runId/owner filter: project durable jobs survive the creating chat.
  assert.equal('runId' in f.calls[0].args[1], false);
  const global = setup({jobs: [job({projectId: null})], total: 1, nextOffset: null});
  await global.get(api.literatureProcessingToolNames.get).invoke({destination: 'library_only'});
  assert.deepEqual(global.calls[0].args[1], {destination: 'library_only', offset: 0, limit: 20, projectId: 'project-a'});
});

test('retry/cancel pass the exact generation once and return authoritative states without awaiting workers', async () => {
  for (const action of ['retry', 'cancel']) {
    const value = job({generation: action === 'retry' ? 'generation-b' : 'generation-a', status: action === 'retry' ? 'queued' : 'cancelled'});
    const f = setup(value);
    assert.deepEqual(await f.get(api.literatureProcessingToolNames[action]).invoke({jobId: 'job-a', generation: 'generation-a'}), value);
    assert.deepEqual(f.calls[0].args, [`research.library.${action}Acquisition`, {jobId: 'job-a', generation: 'generation-a', projectId: 'project-a'}]);
    assert.equal(f.calls.length, 1);
  }
});

test('strict model inputs cannot forge project/context, select replacement PDFs or omit the generation fence', async () => {
  const f = setup({jobs: [], total: 0, nextOffset: null});
  for (const tool of f.tools.filter(tool => Object.values(api.literatureProcessingToolNames).includes(tool.name))) {
    const input = tool.name === api.literatureProcessingToolNames.get ? {} : {jobId: 'job-a', generation: 'generation-a'};
    for (const forbidden of ['projectId', 'owner', 'runId', 'signal', 'replacementDocumentId']) await assert.rejects(tool.invoke({...input, [forbidden]: 'forged'}));
  }
  await assert.rejects(f.get(api.literatureProcessingToolNames.retry).invoke({jobId: 'job-a'}));
  await assert.rejects(f.get(api.literatureProcessingToolNames.get).invoke({limit: 51}));
  assert.equal(f.calls.length, 0);
});

test('aborted or revoked calls cannot invoke capabilities; generation conflicts and malformed outputs stay errors', async () => {
  const aborted = setup(); aborted.controller.abort(new Error('stopped'));
  await assert.rejects(aborted.get(api.literatureProcessingToolNames.get).invoke({}), /stopped/u);
  assert.equal(aborted.calls.length, 0);
  const revoked = setup(undefined, {assertActive: () => {throw new Error('revoked');}});
  await assert.rejects(revoked.get(api.literatureProcessingToolNames.cancel).invoke({jobId: 'job-a', generation: 'generation-a'}), /revoked/u);
  assert.equal(revoked.calls.length, 0);
  const conflict = setup(() => {throw new Error('research_acquisition_generation_conflict');});
  await assert.rejects(conflict.get(api.literatureProcessingToolNames.retry).invoke({jobId: 'job-a', generation: 'generation-a'}), /generation_conflict/u);
  assert.equal(conflict.calls.length, 1, 'never blindly replay a stale generation');
  const invalid = setup({jobs: [job({stage: 'invented'})], total: 1, nextOffset: null});
  await assert.rejects(invalid.get(api.literatureProcessingToolNames.get).invoke({}));
});

test('main tool assembly and frozen manifest mount all three tools main-only with exact effects', () => {
  const f = setup(), tools = api.createResearchTools({capabilities: f.capabilities, projectId: 'project-a', threadId: 'thread-a',
    runId: 'run-a', signal: f.controller.signal, dispatchStage: async () => assert.fail('unexpected dispatch'),
    dispatchReviewQuery: async () => assert.fail('unexpected review query')});
  const manifestInput = {deleteFileApprovalMode: 'fully_automatic', mcpApprovalMode: 'fully_automatic', mcpServers: [],
    mode: 'chat', requestedCapabilities: {mcpServers: [], skills: []}, selfConfigAvailable: false,
    shellAllowedCommands: undefined, trustedHostAvailable: false, skills: [], workflowHint: null, researchProjectId: 'project-a'};
  const manifest = api.compileRunCapabilityManifest(manifestInput).manifest;
  assert.deepEqual(tools.map(tool => tool.name).sort(), api.RESEARCH_TOOL_DESCRIPTORS.map(tool => tool.name).sort());
  for (const [action, name] of Object.entries(api.literatureProcessingToolNames)) {
    const descriptor = api.RESEARCH_TOOL_DESCRIPTORS.find(tool => tool.name === name);
    const frozen = manifest.tools.find(tool => tool.modelVisibleName === name);
    assert.deepEqual(descriptor.executionScopes, ['main']);
    assert.equal(descriptor.effectClass, action === 'get' ? 'none' : 'external_call');
    assert.deepEqual(frozen.executionScopes, ['main']);
    assert.equal(frozen.effectClass, descriptor.effectClass);
    if (action !== 'get') assert.equal(frozen.reconcileStrategy, 'retry_safe');
  }
  assert.equal(api.compileRunCapabilityManifest({...manifestInput, researchProjectId: null}).manifest.tools
    .some(tool => Object.values(api.literatureProcessingToolNames).includes(tool.modelVisibleName)), false);
});
