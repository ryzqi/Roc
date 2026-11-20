import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {auditReviewInspector} from './fixtures/audit-review-inspector.mjs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewSearchFixture, awaitReviewSearchFixture} from '../unit/fixtures/research-review-search.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7b-ui');
const channels = {
  listReviewProtocols: 'roc:research:review-protocol-list', getReviewProtocol: 'roc:research:review-protocol-get',
  getReviewProtocolHistory: 'roc:research:review-protocol-history', saveReviewProtocol: 'roc:research:review-protocol-save',
  freezeReviewProtocol: 'roc:research:review-protocol-freeze',
  listReviewSearches: 'roc:research:review-search-list', startReviewSearch: 'roc:research:review-search-start',
  getReviewSearch: 'roc:research:review-search-get', getReviewSearchPool: 'roc:research:review-search-pool',
  cancelReviewSearch: 'roc:research:review-search-cancel',
  listReviewCorpora: 'roc:research:review-corpus-list', createReviewCorpus: 'roc:research:review-corpus-create',
  getReviewCorpus: 'roc:research:review-corpus-get'
};
const tid = id => page.getByTestId(id);
const query = index => tid('artifact-review-query').nth(index);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-search-ui-')); mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({initialRequest,writable}) {
      const [request,setRequest]=useState(initialRequest);
      const [open,setOpen]=useState(true);
      const [readingLocations]=useState(()=>new Map()),[reviewDrafts]=useState(()=>new Map());
      window.selectReview=next=>flushSync(()=>setRequest(next));
      return <main><button data-testid="literature-review-inspect" onClick={()=>setOpen(true)}>综述核查</button>
        {!open?null:<ArtifactInspector key={JSON.stringify(request)} client={client} selection={{kind:'review',request}}
          writable={writable} readingLocations={readingLocations} reviewDrafts={reviewDrafts}
          onClose={()=>setOpen(false)} onOpenTask={()=>{}}/>}
      </main>;
    }
    let generation=0;
    window.mount=(initialRequest,writable=true)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initialRequest={initialRequest} writable={writable}/></LazyMotion></MotionConfig>));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{padding:16px}'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Encountered two children with the same key|Each child in a list should have a unique/u.test(message.text())) errors.push(message.text());
  });
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input});
    api.parseIpcRequestArgs(channels[method], [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
    if (method === f.loseReply) {
      f.loseReply = null; assert.equal(result.ok, true, JSON.stringify(result));
      return {ok: false, error: {message: 'Synthetic committed action reply lost'}};
    }
    if (method === 'getReviewSearchPool' && f.deferPool) {
      return new Promise(resolve => {f.releasePool = () => resolve(result); f.poolStarted();});
    }
    if (method === 'listReviewSearches' && f.deferSearches) {
      return new Promise(resolve => {f.releaseSearches = () => resolve(result); f.searchesStarted();});
    }
    return result;
  });
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {
    for (const f of fixtures) await f.dispose();
    api?.dispose(); if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
function fixture({queries = ['synthetic query one'], count = 4, pageSize = 2, maxPages = 2, mode = 'ok'} = {}) {
  const f = createReviewSearchFixture(api, {queries, maxPages, fetch: async (url, init) => {
    if (f.mode === 'hold') {
      f.fetchStarted();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
      });
    }
    if (f.mode === 'failed') return new Response('Synthetic offline provider failure', {status: 503});
    const parsed = new URL(url), pageNumber = Number(parsed.searchParams.get('page')), size = Number(parsed.searchParams.get('per_page'));
    const start = (pageNumber - 1) * size, remaining = Math.max(0, Math.min(size, f.count - start));
    return Response.json({meta: {count: f.count, per_page: size, page: pageNumber}, results: Array.from({length: remaining}, (_, index) => ({
      id: `https://openalex.org/W${start + index + 1}`, title: `Synthetic raw paper ${start + index + 1}`,
      doi: index === 0 ? null : `https://doi.org/10.1234/retained-${start + index + 1}`,
      publication_year: start + index === 0 ? null : 2023, authorships: [],
      ids: start + index === 0 ? {pmid: null, doi: null, retained_null: null} : null
    }))});
  }});
  f.mode = mode; f.count = count;
  if (pageSize !== 2) {
    const body = structuredClone(f.protocol.version.body); body.databases[0].pageSize = pageSize;
    const draft = f.repository.systematicReviews.save({projectId: f.project.id, requestId: 'larger-page',
      protocolId: f.protocol.version.protocolId, expectedVersionId: f.protocol.version.id, expectedVersionHash: f.protocol.versionHash,
      body, deviationReason: 'Synthetic explicit larger raw page'}, {kind: 'user', id: 'synthetic-page-reviewer'});
    f.protocol = f.repository.systematicReviews.freeze({projectId: f.project.id, requestId: 'confirm-page',
      versionId: draft.version.id, expectedVersionHash: draft.versionHash, reviewNote: 'Synthetic larger raw page scope reviewed'},
    {kind: 'user', id: 'synthetic-page-reviewer'});
    f.request = {...f.request, versionId: f.protocol.version.id, expectedFreezeHash: f.protocol.freezeHash};
  }
  f.corpora = new api.ResearchReviewCorpusRepository(f.db, f.repository, f.reviews, () => f.time);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of [...api.researchSystematicReviewCapabilities, ...api.researchReviewSearchCapabilities, ...api.researchReviewCorpusCapabilities])
    registry.declare('research', descriptor);
  const context = {pluginId: 'research', capabilities: registry};
  api.registerResearchSystematicReviewCapabilities(context, f.repository.systematicReviews);
  api.registerResearchReviewSearchCapabilities(context, f.reviews);
  api.registerResearchReviewCorpusCapabilities(context, f.corpora);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  fixtures.push(f); return f;
}
async function mount(f, writable = true) {
  active = f;
  await page.evaluate(({request, writable}) => window.mount(request, writable),
    {request: {mode: 'manage', projectId: f.project.id, versionId: f.protocol.version.id}, writable});
  await tid('artifact-review-search').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-review-search-refresh"]').disabled);
}
async function execute(index = 0, expected = '检索完成') {
  await query(index).getByTestId('artifact-review-query-start').click();
  await page.waitForFunction(({index, expected}) =>
    document.querySelectorAll('[data-testid="artifact-review-query-status"]')[index]?.textContent.includes(expected), {index, expected});
}
async function inspectPool(index = 0) {
  const details = query(index).locator('details').first();
  await details.locator('summary').click();
  await query(index).getByTestId('artifact-review-query-pool').first().click();
  await tid('artifact-review-pool-record').first().waitFor();
}
const audit = label => auditReviewInspector(page, artifacts, label);

test('actual per-query main execution keeps exact frozen parameters and manual all-query corpus references with repeated records', async () => {
  const f = fixture({queries: ['synthetic query one', 'synthetic query two']}); await mount(f);
  assert.equal(await tid('artifact-review-corpus-create').isDisabled(), true);
  await execute(0); await execute(1);
  const runs = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100});
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.equal(run.snapshot.actor.id, `window:${windowId}`);
    assert.equal(run.snapshot.request.expectedFreezeHash, f.protocol.freezeHash);
    assert.deepEqual(run.snapshot.parameters.sources, ['openalex']);
    assert.equal(run.snapshot.parameters.yearFrom, 2020); assert.equal(run.snapshot.parameters.limit, 2);
    assert.equal(run.rawRecordCount, 4); assert.equal(run.coverageComplete, true);
  }
  await page.getByLabel('语料来源 1-1').selectOption(runs.find(run => run.snapshot.request.queryIndex === 0).snapshot.id);
  assert.equal(await tid('artifact-review-corpus-create').isDisabled(), true);
  await page.getByLabel('语料来源 1-2').selectOption(runs.find(run => run.snapshot.request.queryIndex === 1).snapshot.id);
  await tid('artifact-review-corpus-create').click(); await tid('artifact-review-corpus').waitFor();
  const corpus = f.corpora.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0];
  assert.equal(corpus.identifiedRecords, 8); assert.equal(corpus.searchCoverageComplete, true);
  assert.equal(corpus.snapshot.actor.id, `window:${windowId}`);
  assert.equal(corpus.snapshot.hits.length, 8);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
  await audit('complete-corpus');
});

test('raw pool pagination preserves actual metadata/nulls and does not import another library', async () => {
  const f = fixture({count: 25, pageSize: 15}); await mount(f); await execute();
  await inspectPool();
  assert.equal(await tid('artifact-review-pool-record').count(), 10);
  assert.match(await tid('artifact-review-pool-record').first().innerText(), /发表年份未知/u);
  const first = tid('artifact-review-pool-record').first();
  await first.locator('summary').click();
  assert.equal(await first.locator('details').evaluate(element => element.open), true);
  await first.locator('pre').waitFor({state: 'visible'});
  assert.match(await first.locator('pre').innerText(), /"retained_null": null/u);
  await tid('artifact-review-pool-next').click(); await tid('artifact-review-pool-record').first().waitFor();
  assert.match(await tid('artifact-review-pool-record').first().innerText(), /Synthetic raw paper 11/u);
  await tid('artifact-review-pool-next').click(); await tid('artifact-review-pool-record').first().waitFor();
  assert.equal(await tid('artifact-review-pool-record').count(), 5);
  assert.equal(await tid('artifact-review-pool-next').isDisabled(), true);
  await tid('artifact-review-pool-previous').click(); await tid('artifact-review-pool-record').first().waitFor();
  assert.match(await tid('artifact-review-pool-record').first().innerText(), /Synthetic raw paper 11/u);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
  await audit('pool-page');
});

test('partial coverage remains visible; explicit retry binds predecessor and fixed query without changing old receipt', async () => {
  const f = fixture({count: 4, maxPages: 1}); await mount(f); await execute(0, '结果不完整');
  const original = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0];
  assert.match(await query(0).innerText(), /检索覆盖不完整/u);
  await page.getByLabel('语料来源 1-1').selectOption(original.snapshot.id);
  assert.match(await tid('artifact-review-search').innerText(), /所选检索覆盖不完整/u);
  await tid('artifact-review-corpus-create').click(); await tid('artifact-review-corpus').waitFor();
  assert.equal(f.corpora.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0].searchCoverageComplete, false);
  await execute(0, '结果不完整');
  const next = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0];
  assert.equal(next.snapshot.request.retryOf, original.snapshot.id);
  assert.equal(next.snapshot.request.expectedRetrySnapshotHash, original.snapshotHash);
  assert.deepEqual(next.snapshot.parameters, original.snapshot.parameters);
  assert.deepEqual(f.reviews.get({projectId: f.project.id, reviewSearchId: original.snapshot.id}), original);
  assert.equal(next.coverageComplete, false);
  assert.notEqual(next.receipt.executionId, original.receipt.executionId);
  assert.equal(next.sources[0].pages[0].cache.state, 'hit');
  assert.equal(f.calls.length, 1);
  assert.match(await query(0).innerText(), /检索覆盖不完整/u);
  await audit('retried');
});

test('real running query cancels through exact revision/human note and never turns requested cancellation into a fake terminal state', async () => {
  const f = fixture({mode: 'hold'});
  const started = new Promise(resolve => {f.fetchStarted = resolve;});
  await mount(f); await query(0).getByTestId('artifact-review-query-start').click(); await started;
  await query(0).getByLabel('取消原因', {exact: true}).fill('Synthetic user cancelled held Provider query');
  const before = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0];
  assert.equal(before.status, 'running');
  assert.match(await query(0).innerText(), /记录数待终态回执/u);
  await query(0).getByTestId('artifact-review-query-cancel').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-query-status"]')?.textContent.includes('已取消'));
  const stopped = f.reviews.get({projectId: f.project.id, reviewSearchId: before.snapshot.id});
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.cancellation.actor.id, `window:${windowId}`);
  assert.equal(stopped.cancellation.request.expectedRevision, before.revision);
  assert.equal(stopped.receipt.status, 'cancelled');
  assert.equal(stopped.coverageComplete, false);
});

test('lost start and corpus replies reuse exact requests after actual commits without repeating network execution or corpus rows', async () => {
  const f = fixture(); await mount(f); f.loseReply = 'startReviewSearch';
  const beginning = calls.length;
  await query(0).getByTestId('artifact-review-query-start').click();
  await page.getByRole('alert').filter({hasText: 'reply lost'}).waitFor();
  await execute();
  const starts = calls.slice(beginning).filter(call => call.method === 'startReviewSearch');
  assert.equal(starts.length, 2); assert.deepEqual(starts[1].input, starts[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_searches').pluck().get(), 1);
  assert.equal(f.calls.length, 2);
  const run = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0];
  await page.getByLabel('语料来源 1-1').selectOption(run.snapshot.id);
  f.loseReply = 'createReviewCorpus'; await tid('artifact-review-corpus-create').click();
  await page.getByRole('alert').filter({hasText: 'reply lost'}).waitFor();
  await tid('artifact-review-corpus-create').click(); await tid('artifact-review-corpus').waitFor();
  const seals = calls.slice(beginning).filter(call => call.method === 'createReviewCorpus');
  assert.equal(seals.length, 2); assert.deepEqual(seals[1].input, seals[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_corpora').pluck().get(), 1);
});

test('failed Provider remains a failed source, archived/history reads preserve receipts and suppress human writes', async () => {
  const f = fixture({mode: 'failed'}); await mount(f); await execute(0, '检索失败');
  const run = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0];
  assert.equal(run.receipt.errorCode, null);
  assert.ok(run.sources[0].errorCode);
  assert.equal(run.rawRecordCount, 0);
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  const unchanged = f.changes(); await mount(f, false);
  assert.equal(await query(0).getByTestId('artifact-review-query-start').count(), 0);
  assert.equal(await tid('artifact-review-corpus-create').count(), 0);
  assert.equal(f.changes(), unchanged);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(860, 650));
  await audit('failed-archived-dark-narrow');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1100, 900));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});

test('late pool response from a previous project stays absent after project selection changes', async () => {
  const f = fixture(); await mount(f); await execute();
  const readStarted = new Promise(resolve => {f.poolStarted = resolve;}); f.deferPool = true;
  await query(0).locator('summary').first().click();
  await query(0).getByTestId('artifact-review-query-pool').click(); await readStarted;
  const next = fixture({queries: ['new selected project only']}); active = next;
  await page.evaluate(request => window.selectReview(request), {projectId: next.project.id, versionId: next.protocol.version.id});
  f.deferPool = false; f.releasePool();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-query"]')?.textContent.includes('new selected project only'));
  assert.equal(await tid('artifact-review-pool').count(), 0);
  assert.equal(await tid('artifact-review-pool-record').count(), 0);
  assert.equal(next.calls.length, 0);
});

test('original pool corruption is a visible refusal; refresh cannot permit a corpus write against invalid records', async () => {
  const f = fixture(); await mount(f); await execute(); await inspectPool();
  const run = f.reviews.list({projectId: f.project.id, versionId: f.protocol.version.id, limit: 100})[0];
  const original = f.db.prepare('SELECT pool_json FROM research_literature_search_pools WHERE execution_id=?').pluck().get(run.receipt.executionId);
  const changed = JSON.parse(original); changed.records[0].record.title = 'Tampered original record';
  f.db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?').run(JSON.stringify(changed), run.receipt.executionId);
  const unchanged = f.changes();
  await tid('artifact-review-pool').getByRole('button', {name: '重读原始记录'}).click();
  await tid('artifact-review-pool').getByRole('alert').waitFor();
  assert.equal(await tid('artifact-review-pool-record').count(), 0);
  const refreshStarted = new Promise(resolve => {f.searchesStarted = resolve;});
  f.deferSearches = true;
  await tid('artifact-review-search-refresh').click();
  await refreshStarted;
  await tid('artifact-review-search').getByRole('status').filter({hasText: '正在读取实际检索状态'}).waitFor();
  assert.equal(await tid('artifact-review-corpus-create').count(), 0);
  f.deferSearches = false;
  f.releaseSearches();
  await tid('artifact-review-search').locator(':scope > [role="alert"]').waitFor();
  assert.equal(await tid('artifact-review-corpus-create').count(), 0);
  assert.equal(f.changes(), unchanged);
  f.db.prepare('UPDATE research_literature_search_pools SET pool_json=? WHERE execution_id=?').run(original, run.receipt.executionId);
});

test('bounded recent history never labels an omitted old query unexecuted or starts it without its real predecessor', async () => {
  const f = fixture({queries: ['old exact first query', 'repeated recent second query'], maxPages: 1});
  const actor = {kind: 'user', id: 'synthetic-recent-history-reviewer'};
  const first = await awaitReviewSearchFixture(f, f.reviews.start({...f.request, requestId: 'old-first'}, actor));
  let previous = null;
  for (let index = 0; index < 100; index++) {
    const started = f.reviews.start({...f.request, queryIndex: 1, requestId: `recent-${index}`,
      retryOf: previous?.snapshot.id ?? null, expectedRetrySnapshotHash: previous?.snapshotHash ?? null}, actor);
    previous = await awaitReviewSearchFixture(f, started);
  }
  await mount(f);
  assert.match(await query(0).innerText(), /执行状态尚未核查/u);
  assert.doesNotMatch(await query(0).innerText(), /尚未执行/u);
  assert.equal(await query(0).getByTestId('artifact-review-query-start').count(), 0);
  assert.equal(await tid('artifact-review-corpus-create').isDisabled(), true);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_searches').pluck().get(), 101);
  assert.deepEqual(f.reviews.get({projectId: f.project.id, reviewSearchId: first.snapshot.id}), first);
});
