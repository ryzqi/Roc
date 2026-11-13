import {after, afterEach, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

let api, directory, app, page, active;
const scenes = [], calls = [], errors = [], holds = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/openreview-a5b');
const time = '2026-11-06T00:00:00.000Z';
const channels = {captureOpenReview: 'roc:research:openreview-capture', cancelOpenReviewCapture: 'roc:research:openreview-cancel',
  getOpenReviewHistory: 'roc:research:openreview-history', getOpenReviewObservation: 'roc:research:openreview-read',
  getResourceHistory: 'roc:research:resource-history', getScholarlyHistory: 'roc:research:scholarly-history'};
function deferred() {
  let release;
  const promise = new Promise(resolve => {release = resolve;});
  const value = {promise, release}; holds.push(value); return value;
}
before(async () => {
  api = await loadResearchTestApi(); directory = await mkdtemp(join(tmpdir(), 'roc-openreview-ui-')); await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {requestReadingChange} from ${JSON.stringify(join(process.cwd(), 'src/renderer/literature/reading-interactions'))};
    import {PaperReader} from ${JSON.stringify(join(process.cwd(), 'src/renderer/literature/PaperReader'))};
    import {WorkspaceScopeProvider} from ${JSON.stringify(join(process.cwd(), 'src/renderer/app/workspace-scope'))};
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    client.api.research.getModelsStatus=async()=>({ok:true,data:{ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}});
    const root=createRoot(document.getElementById('root'));let generation=0;
    window.unmountHarness=()=>flushSync(()=>root.unmount());
    function Harness({initial}){const [state,setState]=useState(initial);window.updateReader=state=>flushSync(()=>setState(state));
      window.requestReaderChange=next=>requestReadingChange(state.projectId,()=>flushSync(()=>setState(next)));
      const store={client,...state,documents:[],action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null};
      const scope={client,projectId:state.projectId,writable:state.writable,workspacePath:'/synthetic',workspaceStatus:'ready',workspaceError:null};
      return <WorkspaceScopeProvider value={scope}><PaperReader literature={store} openInFilesView={()=>{}} onClearFocus={()=>{}}/></WorkspaceScopeProvider>;
    }
    window.mountReader=initial=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initial={initial}/></LazyMotion></MotionConfig>));
  `, style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({projectId: f.project.id, method, input}); api.parseIpcRequestArgs(channels[method], [input]);
    if (f.holdRead === method) {f.readStarted.release(); await f.readHold.promise;}
    if (f.failRead === method) return {ok: false, error: {code: 'fixture_read_failure', message: '真实读取失败注入', category: 'degraded', retryable: true}};
    if (method === 'getScholarlyHistory') return {ok: true, data: f.scholarly.history(input)};
    if (method === 'getResourceHistory') return {ok: true, data: f.resources.history(input)};
    const result = await f.bridge.invoke(`research.${method}`, [input], 74);
    if (f.holdReply === method) {f.replyStarted.release(); await f.replyHold.promise;}
    if (f.dropReply === method && result.ok) {f.dropReply = null;
      return {ok: false, error: {code: 'synthetic_reply_lost', message: '已写入但测试回执丢失', category: 'degraded', retryable: true}};}
    return result;
  });
});
after(async () => {
  for (const hold of holds) hold.release();
  if (page && !page.isClosed()) await page.evaluate(() => window.unmountHarness());
  await app?.close();
  for (const f of scenes) await f.dispose(); api?.dispose(); await rm(directory, {recursive: true, force: true});
  assert.deepEqual(errors, []);
});
afterEach(async context => {await writeFile(join(artifacts, `${context.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 90)}.txt`), await page.locator('body').ariaSnapshot());});
async function scene() {
  const f = createResearchFixture(api, 'reading');
  const metadata = {id: 'openreview-ui-paper', source: 'local', externalId: 'openreview-ui-paper', doi: '10.1234/openreview-ui',
    title: 'Synthetic OpenReview article', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026,
    citationCount: null, url: null, openAccessUrl: null, importedAt: time, updatedAt: time};
  f.item = f.repository.library.import([{metadata, bibliography: {citationKey: 'syntheticopenreview2026', entryType: 'article',
    fields: {title: metadata.title}, preambles: [], csl: null, title: metadata.title, authors: metadata.authors,
    doi: metadata.doi, publishedYear: 2026, abstract: null, url: null}}], f.project.id).items[0];
  let clock = Date.parse(time);
  f.governor = new api.LiteratureProviderGovernor({'api2.openreview.net': {minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000,
    failureThreshold: 100, cooldownMs: 60000}}, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.network = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.network.push(url);
    if (f.waitNetwork) {f.networkStarted.release(); await new Promise((_resolve, reject) => {
      init.signal.throwIfAborted(); init.signal.addEventListener('abort', () => {
        f.abortObserved?.release();
        if (f.abortFinish) f.abortFinish.promise.then(() => reject(init.signal.reason));
        else reject(init.signal.reason);
      }, {once: true});
    });}
    if (f.errorStatus) return new Response('', {status: f.errorStatus});
    const endpoint = new URL(url);
    if (f.empty) return Response.json(endpoint.pathname.endsWith('/edits') ? {edits: []} : {notes: []});
    if (endpoint.pathname.endsWith('/edits')) return Response.json({edits: [{id: 'Edit1', invitation: 'Synthetic.org/2026/-/Revision',
      readers: ['everyone'], signatures: ['~Synthetic1'], tmdate: 4, replacement: false,
      note: {id: 'Paper1', content: {title: {value: 'Synthetic revised title'}, old_field: {delete: true}}}}]});
    const note = {id: 'Paper1', forum: 'Paper1', invitations: ['Synthetic.org/2026/-/Submission'], readers: ['everyone'],
      signatures: ['~Synthetic1'], tcdate: 1, tmdate: 2, domain: 'Synthetic.org/2026',
      content: {title: {value: 'Synthetic submission'}, authors: {value: ['Synthetic author'], readers: ['everyone']}}};
    if (endpoint.searchParams.has('id')) return Response.json({notes: [note]});
    if (endpoint.searchParams.has('invitation')) return Response.json({notes: [{...note, id: 'Reply01', replyto: 'Paper1',
      invitations: [endpoint.searchParams.get('invitation')], content: {comment: {value: 'Synthetic unverified opinion'}}}]});
    const after = endpoint.searchParams.get('after');
    const notes = Array.from({length: after === null ? 50 : 1}, (_, index) => ({...note,
      id: `Reply${String(after === null ? index : 50).padStart(2, '0')}`, replyto: 'Paper1',
      invitations: ['Synthetic.org/2026/-/Comment'], content: {comment: {value: `Synthetic comment ${after === null ? index : 50}`}}}));
    return Response.json({notes, count: 50});
  }, f.governor);
  f.observations = new api.OpenReviewRepository(f.db, f.repository);
  f.service = new api.OpenReviewService(f.observations, f.transport, () => time);
  f.scholarly = new api.ScholarlyRelationsRepository(f.db, f.repository);
  f.resources = new api.ResearchResourceRepository(f.db, f.repository);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchOpenReviewCapabilities) registry.declare('fixture', descriptor);
  api.registerResearchOpenReviewCapabilities({pluginId: 'fixture', capabilities: registry}, f.service, f.observations);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.capture = requestId => f.service.capture({projectId: f.project.id, requestId, query: {kind: 'note', target: 'Paper1', after: null, limit: 1}});
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();}; scenes.push(f); return f;
}
const state = (f, changes = {}) => ({projectId: f.project.id, selected: f.item, writable: true, ...changes});
async function mount(f, changes = {}) {active = f; await page.evaluate(value => window.mountReader(value), state(f, changes));}
async function open() {await page.getByTestId('reader-openreview-toggle').click(); await page.getByTestId('reader-openreview-panel').waitFor();}
async function query(kind = 'note', target = 'Paper1') {
  await page.getByRole('combobox', {name: '查询范围'}).selectOption(kind);
  await page.getByRole('textbox', {name: kind === 'invitation' ? 'Invitation 标识' : 'Note 或论坛 ID', exact: true}).fill(target);
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click();
  await page.getByTestId('reader-openreview-entries').locator('li').first().waitFor();
}
async function selectSaved() {
  await page.getByTestId('reader-openreview-history').getByRole('button', {name: /公开来源已保存/}).first().click();
  await page.getByTestId('reader-openreview-observation').waitFor();
}

test('OpenReview capture synchronously freezes its reader toggle and submits one immutable request', async () => {
  const f = await scene(); await mount(f); await open(); await page.getByLabel('Note 或论坛 ID', {exact: true}).fill('Paper1');
  f.holdReply = 'captureOpenReview'; f.replyStarted = deferred(); f.replyHold = deferred();
  await page.evaluate(() => {
    const submit = [...document.querySelectorAll('button')].find(button => button.textContent === '查询并保存公开来源');
    submit.click(); submit.click(); document.querySelector('[data-testid="reader-openreview-toggle"]').click();
  });
  await f.replyStarted.promise;
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'captureOpenReview').length, 1);
  await expect(page.getByTestId('reader-openreview-panel')).toBeVisible();
  await expect(page.getByLabel('Note 或论坛 ID', {exact: true})).toBeDisabled();
  f.holdReply = null; f.replyHold.release(); await page.getByTestId('reader-openreview-entry').waitFor();
});

test('OpenReview cancel is independent and retains the request until the actual capture exits', async () => {
  const f = await scene(); f.waitNetwork = true; f.networkStarted = deferred(); f.abortObserved = deferred(); f.abortFinish = deferred();
  await mount(f); await open(); await page.getByLabel('Note 或论坛 ID', {exact: true}).fill('Paper1');
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click(); await f.networkStarted.promise;
  f.holdReply = 'cancelOpenReviewCapture'; f.replyStarted = deferred(); f.replyHold = deferred();
  await page.evaluate(() => {
    const cancel = [...document.querySelectorAll('button')].find(button => button.textContent === '取消 OpenReview 查询');
    cancel.click(); cancel.click();
  });
  await f.replyStarted.promise;
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'cancelOpenReviewCapture').length, 1);
  f.holdReply = null; f.replyHold.release();
  await page.getByText('主进程已接收取消信号；等待查询结束。', {exact: true}).waitFor();
  await expect(page.getByLabel('Note 或论坛 ID', {exact: true})).toBeDisabled();
  f.abortFinish.release(); await page.getByRole('button', {name: '重试原 OpenReview 请求', exact: true}).waitFor();
  assert.equal(f.observations.history({projectId: f.project.id, offset: 0, limit: 20}).total, 0);
});

test('OpenReview query drafts protect native unload and require confirmation before reading changes or explicit discard', async () => {
  const f = await scene(); await mount(f); await open(); await page.getByLabel('Note 或论坛 ID', {exact: true}).fill('Paper1');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', {cancelable: true}))), true);
  const next = state(f, {selected: {...f.item, id: 'another-source'}});
  await page.evaluate(value => window.requestReaderChange(value), next);
  await page.getByTestId('literature-editor-discard-cancel').click();
  await expect(page.getByLabel('Note 或论坛 ID', {exact: true})).toHaveValue('Paper1');
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  await page.getByRole('button', {name: '放弃查询修改', exact: true}).click();
  await page.getByTestId('literature-editor-discard-cancel').click();
  await expect(page.getByLabel('Note 或论坛 ID', {exact: true})).toHaveValue('Paper1');
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  await page.evaluate(value => window.requestReaderChange(value), next);
  await page.getByTestId('literature-editor-discard-confirm').click();
  await expect(page.getByTestId('paper-reader')).toHaveAttribute('data-library-item', 'another-source');
});

test('lazy reader captures public Note wrappers, unknown venue/license and source dates with no workflow acceptance', async () => {
  const f = await scene(); const workflow = f.repository.getWorkflow(f.project.id);
  await mount(f); assert.equal(calls.filter(call => call.projectId === f.project.id).length, 0);
  await open(); await page.getByText('尚无 OpenReview 观察', {exact: true}).waitFor(); await query();
  await page.getByTestId('reader-openreview-entry').locator('summary').click();
  await expect(page.getByTestId('reader-openreview-content')).toContainText('Synthetic author');
  await page.getByText('字段读者：everyone', {exact: true}).waitFor();
  const fields = await page.getByTestId('reader-openreview-entry').locator('dd').allTextContents();
  assert.ok(fields.includes('Synthetic.org/2026')); assert.ok(fields.includes('2')); assert.ok(fields.includes('未报告'));
  await page.getByText('公开意见未核查；当前 Note 与修改差量分别保存。', {exact: true}).waitFor();
  assert.equal(f.network.length, 1); assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow);
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence').pluck().get(), 0);
});

test('explicit forum/invitation/Edit queries retain unclassified replies and exact modification delta', async () => {
  for (const kind of ['forum', 'invitation', 'edits']) {
    const f = await scene(); await mount(f); await open(); await query(kind, kind === 'invitation' ? 'Synthetic.org/2026/-/Comment' : 'Paper1');
    await page.getByTestId('reader-openreview-entry').first().locator('summary').click();
    if (kind === 'edits') {
      await page.getByTestId('reader-openreview-delta').waitFor();
      const delta = await page.getByTestId('reader-openreview-delta').innerText();
      assert.match(delta, /Synthetic revised title/); assert.match(delta, /"delete": true/);
      await page.getByText('差量包含修改操作，未重建完整历史 Note。', {exact: true}).waitFor();
    } else {
      await page.getByTestId('reader-openreview-content').waitFor();
      assert.match(await page.getByTestId('reader-openreview-entry').first().innerText(), /公开回复/);
      assert.equal(await page.getByText('已核查评审', {exact: true}).count(), 0);
    }
    const input = calls.filter(call => call.projectId === f.project.id && call.method === 'captureOpenReview')[0].input;
    assert.equal(input.query.kind, kind); assert.equal(input.query.after, null); assert.equal(input.query.limit, 50);
  }
});

test('saved20 entry pages and provider50 cursor pages remain independent even when provider count equals first page', async () => {
  const f = await scene(); await mount(f); await open(); await query('forum');
  assert.equal(await page.getByTestId('reader-openreview-entries').locator('li').count(), 20);
  await page.getByRole('button', {name: 'OpenReview 记录下一页', exact: true}).click();
  await page.getByTestId('reader-openreview-entry').first().getByText('Reply20', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'OpenReview 记录下一页', exact: true}).click();
  await page.getByTestId('reader-openreview-entry').first().getByText('Reply40', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-openreview-entries').locator('li').count(), 10);
  await page.getByRole('button', {name: '查询并保存下一来源页', exact: true}).click();
  await page.getByTestId('reader-openreview-entry').getByText('Reply50', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-openreview-entries').locator('li').count(), 1);
  assert.equal(await page.getByRole('button', {name: '查询并保存下一来源页', exact: true}).count(), 0);
  const captures = calls.filter(call => call.projectId === f.project.id && call.method === 'captureOpenReview');
  assert.equal(captures[1].input.query.after, 'Reply49'); assert.notEqual(captures[0].input.requestId, captures[1].input.requestId);
  assert.equal(f.observations.history({projectId: f.project.id, offset: 0, limit: 20}).total, 2);
});

test('empty page, provider failure and read errors retain distinct states and allow explicit readonly retry', async () => {
  const empty = await scene(); empty.empty = true; await mount(empty); await open();
  await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).fill('Paper1');
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click();
  await page.getByText('来源本页报告 0 条公开记录', {exact: true}).waitFor();
  const failed = await scene(); failed.errorStatus = 404; await mount(failed); await open();
  await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).fill('Paper1');
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click();
  await page.getByText('公开记录数量未知', {exact: true}).waitFor();
  await page.getByText('literature_provider_http_404', {exact: true}).waitFor();
  const broken = await scene(); await broken.capture('saved'); broken.failRead = 'getOpenReviewHistory'; await mount(broken, {writable: false}); await open();
  await page.getByRole('button', {name: '重试 OpenReview 历史', exact: true}).waitFor();
  broken.failRead = null; await page.getByRole('button', {name: '重试 OpenReview 历史', exact: true}).click();
  broken.failRead = 'getOpenReviewObservation'; await selectSaved();
  await page.getByRole('button', {name: '重试 OpenReview 来源读取', exact: true}).waitFor();
  broken.failRead = null; await page.getByRole('button', {name: '重试 OpenReview 来源读取', exact: true}).click();
  await page.getByTestId('reader-openreview-entry').waitFor();
  assert.equal(await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).isEnabled(), false);
  assert.equal(broken.network.length, 1);
});

test('lost capture reply locks original request and retries exactly once without duplicate provider reads', async () => {
  const f = await scene(); f.dropReply = 'captureOpenReview'; await mount(f); await open();
  await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).fill('Paper1');
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click();
  await page.getByRole('button', {name: '重试原 OpenReview 请求', exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-openreview-toggle').isEnabled(), false);
  assert.equal(await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).isEnabled(), false);
  await page.getByRole('button', {name: '重试原 OpenReview 请求', exact: true}).click(); await page.getByTestId('reader-openreview-entry').waitFor();
  const requests = calls.filter(call => call.projectId === f.project.id && call.method === 'captureOpenReview');
  assert.deepEqual(requests[0].input, requests[1].input); assert.equal(f.network.length, 1);
  f.dropReply = 'captureOpenReview'; await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click();
  await page.getByRole('button', {name: '重试原 OpenReview 请求', exact: true}).waitFor();
  await page.evaluate(value => window.updateReader(value), state(f, {writable: false}));
  assert.equal(await page.getByRole('button', {name: '重试原 OpenReview 请求', exact: true}).isEnabled(), false);
  await page.getByRole('button', {name: '放弃原 OpenReview 请求', exact: true}).click();
  await page.getByTestId('literature-editor-discard-confirm').click();
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  await expect(page.getByTestId('reader-openreview-toggle')).toBeEnabled();
});

test('dirty query locks history/collapse until explicit discard, while history pages remain readable after archive', async () => {
  const f = await scene(); for (let index = 0; index < 21; index++) await f.capture(`history${index}`);
  await mount(f); await open(); await page.getByTestId('reader-openreview-history').getByRole('button', {name: /公开来源已保存/}).first().waitFor();
  assert.equal(await page.getByTestId('reader-openreview-history').getByRole('button', {name: /公开来源已保存/}).count(), 20);
  await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).fill('https://openreview.net/forum?id=Paper1');
  assert.equal(await page.getByTestId('reader-openreview-toggle').isEnabled(), false);
  assert.equal(await page.getByRole('button', {name: 'OpenReview 历史下一页', exact: true}).isEnabled(), false);
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click();
  await page.getByText('填写合法的 OpenReview Note 或论坛 ID。', {exact: true}).waitFor();
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'captureOpenReview').length, 0);
  await page.evaluate(value => window.updateReader(value), state(f, {writable: false}));
  await page.getByRole('button', {name: '放弃查询修改', exact: true}).click();
  await page.getByTestId('literature-editor-discard-confirm').click();
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  await expect(page.getByTestId('reader-openreview-toggle')).toBeEnabled();
  await page.getByRole('button', {name: 'OpenReview 历史下一页', exact: true}).click();
  await expect(page.getByTestId('reader-openreview-history').getByRole('button', {name: /公开来源已保存/})).toHaveCount(1);
});

test('late history/capture replies cannot cross project scope and cancel uses actual transport abort', async () => {
  const first = await scene(), other = await scene(); await first.capture('saved'); first.holdRead = 'getOpenReviewHistory';
  first.readStarted = deferred(); first.readHold = deferred(); await mount(first); await open(); await first.readStarted.promise;
  active = other; await page.evaluate(value => window.updateReader(value), state(other)); await page.getByText('尚无 OpenReview 观察', {exact: true}).waitFor();
  first.readHold.release(); await page.getByText('尚无 OpenReview 观察', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-openreview-observation').count(), 0);
  const held = await scene(); held.waitNetwork = true; held.networkStarted = deferred(); await mount(held); await open();
  await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).fill('Paper1');
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click(); await held.networkStarted.promise;
  await page.getByRole('button', {name: '取消 OpenReview 查询', exact: true}).click();
  await page.getByRole('button', {name: '放弃原 OpenReview 请求', exact: true}).waitFor();
  assert.equal(held.observations.history({projectId: held.project.id, offset: 0, limit: 20}).total, 0);
  await page.getByRole('button', {name: '放弃原 OpenReview 请求', exact: true}).click();
  await page.getByTestId('literature-editor-discard-confirm').click();
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  const delayed = await scene(); delayed.holdReply = 'captureOpenReview'; delayed.replyStarted = deferred(); delayed.replyHold = deferred();
  await mount(delayed); await open(); await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).fill('Paper1');
  await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).click(); await delayed.replyStarted.promise;
  active = other; await page.evaluate(value => window.updateReader(value), state(other)); await page.getByText('尚无 OpenReview 观察', {exact: true}).waitFor();
  delayed.replyHold.release(); await page.getByText('尚无 OpenReview 观察', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-openreview-observation').count(), 0);
});

test('650px light/dark focus, source disclosure and eight clip states pass in the shared reader scroller', async () => {
  const f = await scene(); await mount(f); await open(); await query(); await page.setViewportSize({width: 650, height: 900});
  const audit = await readFile(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8'), receipts = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    const entry = page.getByTestId('reader-openreview-entry'); if (await entry.getAttribute('open') !== null) await entry.locator('summary').click();
    for (const mode of ['default', 'hover', 'expanded', 'settled']) {
      if (mode === 'hover') await page.getByRole('button', {name: '查询并保存公开来源', exact: true}).hover();
      if (mode === 'expanded') {
        await entry.locator('summary').click();
        await entry.locator(':scope > div').waitFor();
      }
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      if (mode === 'expanded' || mode === 'settled') await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="reader-openreview-entry"]');
        const style = getComputedStyle(element, '::details-content');
        const height = element.querySelector('div').getBoundingClientRect().height;
        // Computed CSS serializes fractional pixels to three decimal places.
        return style.opacity === '1' && Number.parseFloat(style.blockSize) + .001 >= height;
      });
      const result = await page.evaluate(code => (0, eval)(`(${code})`)({root: '[data-testid="reader-openreview-panel"]', viewport: true}), audit);
      assert.equal(result.cut, 0, JSON.stringify(result)); assert.equal(result.hidden, 0, JSON.stringify(result)); receipts.push({theme, mode, result});
    }
    await entry.scrollIntoViewIfNeeded(); await page.screenshot({path: join(artifacts, `${theme}-650-source.png`)});
    await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).focus();
    assert.notEqual(await page.getByRole('textbox', {name: 'Note 或论坛 ID', exact: true}).evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    const layout = await page.getByTestId('reader-openreview-panel').evaluate(node => ({width: node.clientWidth, scroll: node.scrollWidth}));
    assert.ok(layout.scroll <= layout.width); await page.screenshot({path: join(artifacts, `${theme}-650.png`)});
  }
  await writeFile(join(artifacts, 'clip-audits.json'), JSON.stringify(receipts, null, 2) + '\n');
  await page.getByTestId('reader-resources-toggle').click(); await page.getByText('尚无资源观察', {exact: true}).waitFor();
  const layout = await page.getByTestId('paper-reader').evaluate(reader => {
    const panel = reader.querySelector('[data-testid="reader-openreview-panel"]'), resources = reader.querySelector('[data-testid="reader-resources-panel"]');
    const scroller = panel.parentElement; return {same: resources.parentElement === scroller, height: scroller.clientHeight,
      reader: reader.clientHeight, overflow: getComputedStyle(scroller).overflowY};
  });
  assert.equal(layout.same, true); assert.equal(layout.overflow, 'auto'); assert.ok(layout.height <= layout.reader * .55 + 1);
});
