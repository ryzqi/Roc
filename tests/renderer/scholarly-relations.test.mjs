import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

let api, directory, app, page, active, hold;
const scenes = [], calls = [], errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/xeco-a2');
const doi = '10.1234/scholarly-ui';
const time = '2026-11-06T00:00:00.000Z';
const channels = {captureScholarlyRelations: 'roc:research:scholarly-capture', cancelScholarlyRelations: 'roc:research:scholarly-cancel',
  getScholarlyHistory: 'roc:research:scholarly-history', getScholarlyRelations: 'roc:research:scholarly-read'};
before(async () => {
  api = await loadResearchTestApi();
  directory = await mkdtemp(join(tmpdir(), 'roc-scholarly-ui-'));
  await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {PaperReader} from ${JSON.stringify(join(process.cwd(), 'src/renderer/literature/PaperReader'))};
    import {WorkspaceScopeProvider} from ${JSON.stringify(join(process.cwd(), 'src/renderer/app/workspace-scope'))};
    const methods=${JSON.stringify(Object.keys(channels))};
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>window.readHost(method,input)]))}};
    client.api.research.getModelsStatus=async()=>({ok:true,data:{ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}});
    const root=createRoot(document.getElementById('root'));let generation=0;
    function Harness({initial}){const [state,setState]=useState(initial);
      window.updateReader=state=>flushSync(()=>setState(state));
      const store={client,...state,documents:[],action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null};
      const scope={client,projectId:state.projectId,writable:state.writable,workspacePath:'/synthetic',workspaceStatus:'ready',workspaceError:null};
      return <WorkspaceScopeProvider value={scope}><PaperReader literature={store} openInFilesView={()=>{}} onClearFocus={()=>{}}/></WorkspaceScopeProvider>;
    }
    window.mountReader=initial=>flushSync(()=>root.render(<Harness key={++generation} initial={initial}/>));
  `, style: `html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}`});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:850}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('readHost', async (method, input) => {
    const f = active;
    calls.push({projectId: f.project.id, method, input});
    api.parseIpcRequestArgs(channels[method], [input]);
    if (f.holdHistory && method === 'getScholarlyHistory') {await hold.promise;}
    try {
      const result = method === 'captureScholarlyRelations' ? await f.service.capture(input) :
        method === 'cancelScholarlyRelations' ? f.service.cancel(input) :
        method === 'getScholarlyHistory' ? f.snapshots.history(input) : f.snapshots.read(input);
      if (method === 'captureScholarlyRelations') f.saved.release();
      if (method === 'captureScholarlyRelations' && f.holdCaptureReply) {await hold.promise;}
      if (method === 'cancelScholarlyRelations' && f.holdCancelReply) {await f.cancelReply.promise;}
      if (method === 'captureScholarlyRelations' && f.dropReply) {f.dropReply = false; return {ok: false, error: {message: 'Synthetic reply lost'}};}
      return {ok: true, data: result};
    } catch (error) {return {ok: false, error: {message: error.message}};}
  });
});
after(async () => {
  hold?.release();
  for (const f of scenes) f.cancelReply?.release();
  await app?.close();
  for (const f of scenes) await f.dispose();
  api?.dispose();
  if (directory) await rm(directory, {recursive: true, force: true});
});
function deferred() {
  let release;
  const promise = new Promise(resolve => {release = resolve;});
  return {promise, release};
}
function scene() {
  const f = createResearchFixture(api, 'reading');
  f.saved = deferred();
  scenes.push(f);
  const metadata = {id: 'synthetic-ui', source: 'local', externalId: 'synthetic-ui', doi, title: 'Synthetic scholarly source',
    authors: ['Synthetic Author'], abstract: null, publishedYear: 2026, citationCount: null, url: null,
    openAccessUrl: null, importedAt: time, updatedAt: time};
  const bibliography = {citationKey: 'synthetic2026', entryType: 'article', fields: {title: metadata.title}, preambles: [],
    csl: null, title: metadata.title, authors: metadata.authors, doi, publishedYear: 2026, abstract: null, url: null};
  f.item = f.repository.library.import([{metadata, bibliography}], f.project.id).items[0];
  let clock = Date.parse(time);
  const governor = new api.LiteratureProviderGovernor(Object.fromEntries(['api.openalex.org', 'api.crossref.org', 'api.semanticscholar.org']
    .map(host => [host, {minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 100, cooldownMs: 60000}])),
  () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.network = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.network.push(url);
    if (f.waitNetwork) {
      await new Promise((resolve, reject) => {
        init.signal.throwIfAborted();
        init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
      });
    }
    const parsed = new URL(url), offset = Number(parsed.searchParams.get('offset'));
    if (parsed.host === 'api.openalex.org') return Response.json({id: 'https://openalex.org/W1', doi,
      referenced_works: Array.from({length: 55}, (_, i) => `https://openalex.org/W${i + 2}`), is_retracted: false});
    if (parsed.host === 'api.crossref.org') {
      if (f.failCrossref) return Response.json({message: {DOI: '10.1234/incorrect'}});
      return Response.json({message: {DOI: doi, reference: [{key: 'no-doi'}], 'update-to': [
        {DOI: '10.1234/original', type: 'correction', updated: {'date-parts': [[2026, 11, 6]]}}
      ]}});
    }
    return Response.json({offset, ...(offset === 0 ? {next: 1} : {}), data: [{citedPaper: {paperId: 's2-native'}}]});
  }, governor);
  f.snapshots = new api.ScholarlyRelationsRepository(f.db, f.repository);
  f.service = new api.ScholarlyRelationsService(f.snapshots, f.transport, () => time);
  f.request = id => ({projectId: f.project.id, itemId: f.item.id, expectedRevision: f.item.revision, requestId: id,
    sources: ['openalex', 'crossref', 'semantic_scholar'], offset: 0, limit: 100});
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();};
  return f;
}
const state = (f, overrides = {}) => ({projectId: f.project.id, selected: f.item, writable: true, ...overrides});
async function mount(f, overrides = {}) {
  active = f;
  await page.evaluate(value => window.mountReader(value), state(f, overrides));
  await page.getByTestId('reader-title').waitFor();
}
async function open() {
  await page.getByTestId('reader-scholarly-toggle').click();
  await page.getByTestId('reader-scholarly-panel').waitFor();
}
async function capture() {
  await page.getByRole('button', {name: '查询并保存', exact: true}).click();
  await page.getByTestId('reader-scholarly-snapshot').waitFor();
  await page.getByTestId('reader-scholarly-relations').waitFor();
}
test('reader loads scholarly history only on opening, and source relations page through actual stored observations', async () => {
  const f = scene(); await mount(f);
  assert.equal(calls.filter(call => call.projectId === f.project.id).length, 0);
  await open(); await page.getByText('尚无保存记录', {exact: true}).waitFor();
  await capture();
  assert.equal(await page.getByTestId('reader-scholarly-relations').locator('li').count(), 50);
  await page.getByRole('button', {name: '关系下一页', exact: true}).click();
  await page.getByText('openalex: https://openalex.org/W1 → openalex: https://openalex.org/W56', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-scholarly-relations').locator('li').count(), 5);
  await page.getByRole('combobox', {name: '关系来源'}).selectOption('crossref');
  await page.getByText('doi: 10.1234/scholarly-ui → doi: 10.1234/original', {exact: true}).waitFor();
  const source = page.getByTestId('reader-scholarly-source-crossref');
  await source.locator('summary').click();
  await source.getByText('未知', {exact: true}).waitFor();
  assert.match(await source.innerText(), /未映射参考文献\s+1/);
  assert.match(await source.innerText(), /correction|获取时间/);
  assert.equal(f.network.length, 3);
  const readCalls = calls.filter(call => call.projectId === f.project.id && call.method === 'getScholarlyRelations');
  assert.deepEqual(readCalls.map(call => [call.input.source, call.input.offset, call.input.limit]), [['openalex', 0, 50], ['openalex', 50, 50], ['crossref', 0, 50]]);
});
test('saved partial failure exposes unknown fields and explicit continuation makes a separate S2 snapshot', async () => {
  const f = scene(); f.failCrossref = true; await mount(f); await open(); await capture();
  assert.equal(f.snapshots.history({projectId: f.project.id, itemId: f.item.id, offset: 0, limit: 20}).records[0].status, 'partial');
  const failed = page.getByTestId('reader-scholarly-source-crossref');
  await failed.locator('summary').click();
  await failed.getByText('literature_provider_response_invalid', {exact: true}).waitFor();
  assert.match(await failed.innerText(), /参考文献字段\s+未知/);
  assert.match(await failed.innerText(), /未映射参考文献\s+未知/);
  await page.getByTestId('reader-scholarly-source-semantic_scholar').locator('summary').click();
  await page.getByRole('button', {name: '查询来源下一页', exact: true}).click();
  await page.getByRole('combobox', {name: '关系来源'}).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="reader-scholarly-snapshot"] select')?.options.length === 1);
  const latest = f.snapshots.history({projectId: f.project.id, itemId: f.item.id, offset: 0, limit: 20});
  assert.equal(latest.total, 2); assert.equal(latest.records[0].request.offset, 1);
  assert.deepEqual(latest.records[0].request.sources, ['semantic_scholar']);
});
test('lost capture reply retries the exact saved request without another GET', async () => {
  const f = scene(); f.dropReply = true; await mount(f); await open();
  await page.getByRole('button', {name: '查询并保存', exact: true}).click();
  await page.getByText('Synthetic reply lost', {exact: true}).waitFor();
  await page.getByRole('button', {name: '重试原请求', exact: true}).click();
  await page.getByTestId('reader-scholarly-relations').waitFor();
  const captures = calls.filter(call => call.projectId === f.project.id && call.method === 'captureScholarlyRelations');
  assert.deepEqual(captures[0].input, captures[1].input);
  assert.equal(f.network.length, 3);
  assert.equal(f.snapshots.history({projectId: f.project.id, itemId: f.item.id, offset: 0, limit: 20}).total, 1);
});
test('cancel reaches the running service and cannot save a success or offer cancelled request replay', async () => {
  const f = scene(); f.waitNetwork = true; await mount(f); await open();
  await page.getByRole('button', {name: '查询并保存', exact: true}).click();
  await page.getByRole('button', {name: '取消查询', exact: true}).click();
  await page.getByText('scholarly_capture_cancelled', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '重试原请求', exact: true}).count(), 0);
  assert.equal(f.snapshots.history({projectId: f.project.id, itemId: f.item.id, offset: 0, limit: 20}).total, 0);
  assert.equal(await page.getByRole('button', {name: '查询并保存', exact: true}).isEnabled(), true);
});
test('scholarly capture prevents same-event duplicate requests and freezes the requested sources', async () => {
  const f = scene(); f.waitNetwork = true;
  await mount(f); await open();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '查询并保存');
    button.click(); button.click();
  });
  await expect(page.getByRole('button', {name: '取消查询', exact: true})).toBeVisible();
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'captureScholarlyRelations').length, 1);
  await expect(page.getByLabel('OpenAlex', {exact: true})).toBeDisabled();
  await page.getByRole('button', {name: '取消查询', exact: true}).click();
  await expect(page.getByRole('button', {name: '查询并保存', exact: true})).toBeEnabled();
});
test('scholarly cancellation has its own synchronous lock while capture is still running', async () => {
  const f = scene(); f.waitNetwork = true; f.holdCancelReply = true; f.cancelReply = deferred();
  await mount(f); await open();
  await page.getByRole('button', {name: '查询并保存', exact: true}).click();
  await page.getByRole('button', {name: '取消查询', exact: true}).waitFor();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '取消查询');
    button.click(); button.click();
  });
  await page.getByText('scholarly_capture_cancelled', {exact: true}).waitFor();
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'cancelScholarlyRelations').length, 1);
  await expect(page.getByRole('button', {name: '查询并保存', exact: true})).toBeDisabled();
  f.cancelReply.release();
  await expect(page.getByRole('button', {name: '查询并保存', exact: true})).toBeEnabled();
  assert.equal(await page.getByRole('button', {name: '重试原请求', exact: true}).count(), 0);
});
test('readonly and changed versions keep saved observations accessible while new capture is gated', async () => {
  const f = scene(); await f.service.capture(f.request('saved'));
  await mount(f, {writable: false}); await open();
  await page.getByRole('button', {name: new RegExp('文献版本')}).click();
  await page.getByTestId('reader-scholarly-relations').waitFor();
  assert.equal(await page.getByRole('button', {name: '查询并保存', exact: true}).isDisabled(), true);
  await page.evaluate(value => window.updateReader(value), state(f, {selected: {...f.item, revision: f.item.revision + 1}}));
  await page.getByText('文献版本已改变，此处展示历史来源观察', {exact: true}).waitFor();
  await page.evaluate(value => window.updateReader(value), state(f, {selected: {...f.item, archived: true}}));
  assert.equal(await page.getByRole('button', {name: '查询并保存', exact: true}).isDisabled(), true);
  await page.evaluate(value => window.updateReader(value), state(f, {selected: {...f.item, metadata: {...f.item.metadata, doi: null}}}));
  await page.getByText('文献缺少 DOI', {exact: true}).waitFor();
});
test('late history from a previous project never becomes the new scope history', async () => {
  const f = scene(), next = scene(); await f.service.capture(f.request('previous-project'));
  f.holdHistory = true; hold = deferred();
  await mount(f); await open();
  await page.getByText('读取历史中', {exact: true}).waitFor();
  active = next;
  await page.evaluate(value => window.updateReader(value), state(next));
  await page.getByText('尚无保存记录', {exact: true}).waitFor();
  hold.release();
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('button', {name: new RegExp('文献版本')}).count(), 0);
  assert.equal(await page.getByTestId('reader-scholarly-snapshot').count(), 0);
});
test('a capture reply from the previous project remains in its own history after scope changes', async () => {
  const f = scene(), next = scene(); f.holdCaptureReply = true; hold = deferred();
  await mount(f); await open();
  await page.getByRole('button', {name: '查询并保存', exact: true}).click();
  await f.saved.promise;
  active = next;
  await page.evaluate(value => window.updateReader(value), state(next));
  await page.getByText('尚无保存记录', {exact: true}).waitFor();
  hold.release();
  await page.waitForTimeout(50);
  assert.equal(await page.getByTestId('reader-scholarly-snapshot').count(), 0);
  assert.equal(await page.getByRole('button', {name: '查询并保存', exact: true}).isEnabled(), true);
  assert.equal(f.snapshots.history({projectId: f.project.id, itemId: f.item.id, offset: 0, limit: 20}).total, 1);
});
test('history paging and narrow light/dark layout preserve keyboard access without overflow or clipped shadows', async () => {
  const f = scene();
  for (let index = 0; index < 21; index++) await f.service.capture(f.request(`history-${index}`));
  await mount(f); await open();
  await page.getByRole('button', {name: '历史下一页', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reader-scholarly-history"] ul')?.children.length === 1);
  assert.equal(await page.getByRole('button', {name: '历史上一页', exact: true}).isEnabled(), true);
  await page.getByRole('button', {name: new RegExp('文献版本')}).click();
  await page.getByTestId('reader-scholarly-relations').waitFor();
  await page.setViewportSize({width: 650, height: 850});
  const audit = await readFile(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const observation = page.getByTestId('reader-scholarly-source-openalex');
    if (await observation.getAttribute('open') !== null) await observation.locator('summary').click();
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    for (const mode of ['default', 'hover', 'expanded', 'settled']) {
      if (mode === 'hover') await page.getByRole('button', {name: '查询并保存', exact: true}).hover();
      if (mode === 'expanded') await observation.locator('summary').click();
      if (mode === 'settled') await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="reader-scholarly-source-openalex"]');
        // CSSOM serializes to three decimals; DOMRect retains subpixel precision.
        return Number.parseFloat(getComputedStyle(element, '::details-content').blockSize) + 0.001 >= element.querySelector('dl').getBoundingClientRect().height
          && getComputedStyle(element, '::details-content').opacity === '1';
      });
      const result = await page.evaluate(`(${audit})({viewport:true})`);
      assert.equal(result.cut, 0, JSON.stringify(result));
      await writeFile(join(artifacts, `${theme}-${mode}-audit.json`), JSON.stringify(result));
    }
    await page.getByRole('button', {name: '查询并保存', exact: true}).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', {name: '查询并保存', exact: true}).evaluate(element => element.matches(':focus-visible')), true);
    assert.equal(await page.getByRole('button', {name: '查询并保存', exact: true}).evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) > 0), true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({path: join(artifacts, `${theme}-650.png`)});
    await observation.locator('summary').click();
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    await page.getByTestId('reader-scholarly-relations').scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-650-relations.png`)});
  }
  assert.deepEqual(errors, []);
});
