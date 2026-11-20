import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {api = await importTypeScriptModule('src/renderer/literature/literature-processing.ts');});
const job = (overrides = {}) => ({id: 'job-a', projectId: 'project-a', libraryItemId: 'item-a', title: 'Synthetic paper',
  generation: 'generation-a', stage: 'resolve', status: 'queued', attempts: 0, nextRetryAt: null,
  documentId: null, receipt: null, errorCode: null, updatedAt: '2026-11-19T00:00:00.000Z', ...overrides});
function client(response) {
  const calls = [];
  return {calls, api: {research: Object.fromEntries(['list', 'retry', 'cancel'].map(action => [`${action}Acquisition`, async input => {
    calls.push({action, input}); return response;
  }]))}};
}

test('renderer reads a bounded page scoped to the captured current project', async () => {
  const value = {jobs: [job()], total: 21, nextOffset: 20}, c = client({ok: true, data: value});
  assert.deepEqual(await api.listLiteratureProcessing(c, 'project-a', 0), {ok: true, data: value});
  assert.deepEqual(c.calls, [{action: 'list', input: {projectId: 'project-a', destination: 'current_project', offset: 0, limit: 20}}]);
});

test('retry/cancel use exact job generation and validate returned identity', async () => {
  for (const action of ['retry', 'cancel']) {
    const value = job({generation: 'generation-b', status: action === 'retry' ? 'queued' : 'cancelled'}), c = client({ok: true, data: value});
    assert.deepEqual(await api.changeLiteratureProcessing(c, 'project-a', job(), action), {ok: true, data: value});
    assert.deepEqual(c.calls, [{action, input: {projectId: 'project-a', destination: 'current_project', jobId: 'job-a', generation: 'generation-a'}}]);
    for (const overrides of [{id: 'other'}, {libraryItemId: 'other'}, {projectId: 'other'}]) {
      await assert.rejects(api.changeLiteratureProcessing(client({ok: true, data: job(overrides)}), 'project-a', job(), action), /与请求不一致/u);
    }
  }
});

test('replacement retry passes the selected document ID and omits it when undefined', async () => {
  const value = job({generation: 'generation-b', documentId: 'replacement-pdf'}), c = client({ok: true, data: value});
  assert.deepEqual(await api.changeLiteratureProcessing(c, 'project-a', job({stage: 'parse', status: 'failed'}), 'retry', 'replacement-pdf'),
    {ok: true, data: value});
  assert.deepEqual(c.calls[0], {action: 'retry', input: {projectId: 'project-a', destination: 'current_project',
    jobId: 'job-a', generation: 'generation-a', replacementDocumentId: 'replacement-pdf'}});
  await api.changeLiteratureProcessing(c, 'project-a', job(), 'retry', undefined);
  assert.equal(Object.hasOwn(c.calls[1].input, 'replacementDocumentId'), false);
});

test('cross-project jobs and malformed states are explicit failures', async () => {
  const c = client({ok: true, data: {jobs: [job({projectId: 'project-b'})], total: 1, nextOffset: null}});
  await assert.rejects(api.listLiteratureProcessing(c, 'project-a', 0), /其他项目/u);
  const write = client({ok: true, data: job()});
  await assert.rejects(api.changeLiteratureProcessing(write, 'project-b', job(), 'cancel'), /不属于当前项目/u);
  assert.equal(write.calls.length, 0);
  await assert.rejects(api.listLiteratureProcessing(client({ok: true, data: {jobs: [job({status: 'done'})], total: 1, nextOffset: null}}), 'project-a', 0));
});

test('backend failures preserve their codes/messages without blind replay', async () => {
  const failure = {ok: false, error: {code: 'research_acquisition_generation_conflict', message: 'Refresh before retry'}}, c = client(failure);
  assert.equal(await api.listLiteratureProcessing(c, 'project-a', 0), failure);
  assert.equal(await api.changeLiteratureProcessing(c, 'project-a', job(), 'retry'), failure);
  assert.equal(c.calls.length, 2);
});

test('page milestones do not claim blocked indexing or nonterminal Wiki work is ready', () => {
  const rows = [job(), job({stage: 'index', status: 'blocked', documentId: 'document-a'}),
    job({stage: 'wiki', status: 'failed', documentId: 'document-b'}), job({stage: 'wiki', status: 'ready', documentId: 'document-c'})];
  assert.deepEqual(api.acquisitionPageProgress(rows), {metadata: 4, pdf: 3, indexed: 2, wiki: 1});
  assert.deepEqual(api.acquisitionPageProgress([]), {metadata: 0, pdf: 0, indexed: 0, wiki: 0});
  for (const status of ['blocked', 'failed', 'unavailable', 'cancelled']) assert.equal(api.canRetryAcquisition(job({status})), true);
  for (const status of ['ready', 'queued', 'running']) assert.equal(api.canRetryAcquisition(job({status})), false);
  for (const status of ['ready', 'cancelled']) assert.equal(api.canCancelAcquisition(job({status})), false);
  for (const status of ['blocked', 'failed', 'unavailable', 'queued', 'running']) assert.equal(api.canCancelAcquisition(job({status})), true);
});
