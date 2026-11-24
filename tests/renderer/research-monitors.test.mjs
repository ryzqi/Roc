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
const artifacts = join(process.cwd(), '.artifacts/research-optimization/monitor-a6b');
const timestamp = '2026-11-06T00:00:00.000Z';
const channels = {saveMonitor: 'roc:research:monitor-save', controlMonitor: 'roc:research:monitor-control',
  checkMonitor: 'roc:research:monitor-check', cancelMonitorCheck: 'roc:research:monitor-cancel',
  acknowledgeMonitorAlert: 'roc:research:monitor-acknowledge', getMonitor: 'roc:research:monitor-read',
  getMonitors: 'roc:research:monitor-list', getMonitorVersions: 'roc:research:monitor-versions',
  getMonitorChecks: 'roc:research:monitor-checks', getMonitorAlerts: 'roc:research:monitor-alerts',
  getMonitorCheck: 'roc:research:monitor-readcheck', getLibraryItem: 'roc:research:library-get'};
function deferred() {
  let release;
  const promise = new Promise(resolve => {release = resolve;});
  const result = {promise, release}; holds.push(result); return result;
}
before(async () => {
  api = await loadResearchTestApi(); directory = await mkdtemp(join(tmpdir(), 'roc-monitors-ui-'));
  await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {requestNavigation} from ${JSON.stringify(join(process.cwd(), 'src/renderer/app/navigation-guard'))};
    import {LiteratureHubView} from ${JSON.stringify(join(process.cwd(), 'src/renderer/literature/LiteratureHubView'))};
    import {LiteratureScopeProvider} from ${JSON.stringify(join(process.cwd(), 'src/renderer/literature/literature-scope'))};
    import {WorkspaceScopeProvider} from ${JSON.stringify(join(process.cwd(), 'src/renderer/app/workspace-scope'))};
    import {ViewActivity} from ${JSON.stringify(join(process.cwd(), 'src/renderer/shared/view-activity'))};
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    client.api.research.getModelsStatus=async()=>({ok:true,data:{ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}});
    // The shared hub also mounts the processing panel; this monitor fixture has no acquisition jobs.
    client.api.research.listAcquisition=async()=>({ok:true,data:{jobs:[],total:0,nextOffset:null}});
    client.api.research.onLibraryChanged=()=>()=>{};
    client.api.research.listRadarFeeds=async()=>({ok:true,data:[]});
    client.api.research.listRadarArticles=async()=>({ok:true,data:[]});
    const root=createRoot(document.getElementById('root'));let generation=0;
    window.unmountHarness=()=>flushSync(()=>root.unmount());
    window.navigateAway=()=>requestNavigation({page:'project',projectId:'another-project'},()=>window.navigations++);
    function Harness({initial}){const [state,setState]=useState(initial);window.updateHub=state=>flushSync(()=>setState(state));
      const [visible,setVisible]=useState(true);window.setMonitorVisible=value=>flushSync(()=>setVisible(value));
      const store={client,...state,selected:null,selectedId:null,status:'ready',query:'',includeArchived:false,documents:[],
        action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null,importRequestId:0,
        claims:[],evidence:[],derivedStatus:'ready',derivedError:null,reload(){},reloadDerived(){},select(){},setQuery(){},setIncludeArchived(){}};
      const scope={client,projectId:state.projectId,writable:state.writable,workspacePath:'/synthetic',workspaceStatus:'ready',workspaceError:null};
      return <ViewActivity active={visible}><div hidden={!visible} style={{height:'100%'}}><WorkspaceScopeProvider value={scope}><LiteratureScopeProvider value={store}>
        <LiteratureHubView view="discover" projectId={state.projectId}/></LiteratureScopeProvider></WorkspaceScopeProvider></div></ViewActivity>;
    }
    window.mountHub=initial=>{window.navigations=0;flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initial={initial}/></LazyMotion></MotionConfig>));};
  `, style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({projectId: f.project.id, method, input});
    api.parseIpcRequestArgs(channels[method], [input]);
    if (f.holdRead === method) {f.readStarted.release(); await f.readHold.promise;}
    if (f.failRead === method) return {ok: false, error: {code: 'fixture_read_failure', message: '读取失败注入', category: 'degraded', retryable: true}};
    if (method === 'getLibraryItem') return {ok: true, data: f.repository.library.get(input.id)};
    const result = await f.bridge.invoke(`research.${method}`, [input], 74);
    if (f.holdReply === method) {f.replyStarted.release(); await f.replyHold.promise;}
    if (f.dropReply === method && result.ok) {f.dropReply = null;
      return {ok: false, error: {code: 'synthetic_reply_lost', message: '已写入但回执丢失', category: 'degraded', retryable: true}};}
    return result;
  });
  await page.waitForFunction(() => typeof window.mountHub === 'function');
});
after(async () => {
  for (const hold of holds) hold.release();
  if (page && !page.isClosed()) await page.evaluate(() => window.unmountHarness());
  await app?.close();
  for (const f of scenes) await f.dispose(); api?.dispose();
  if (directory) await rm(directory, {recursive: true, force: true});
  assert.deepEqual(errors, []);
});
afterEach(async context => {
  if (page) await writeFile(join(artifacts, `${context.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 90)}.txt`), await page.locator('body').ariaSnapshot());
});
function scene() {
  const f = createResearchFixture(api, 'reading');
  let clock = Date.parse(timestamp);
  f.now = () => new Date(clock).toISOString(); f.tick = () => {clock += 1000;};
  f.ids = ['baseline']; f.items = []; f.network = []; f.transports = [];
  const governor = new api.LiteratureProviderGovernor({
    'api.crossref.org': {minIntervalMs: 1, maxRequests: 1000, windowMs: 3600000, failureThreshold: 100, cooldownMs: 1000},
    'api.openalex.org': {minIntervalMs: 1, maxRequests: 1000, windowMs: 3600000, failureThreshold: 100, cooldownMs: 1000}
  }, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  const transport = () => {
    const value = new api.LiteratureSearchService(async (url, init) => {
      f.network.push(url);
      if (f.waitNetwork) {
        f.networkStarted.release();
        await new Promise((_resolve, reject) => {
          init.signal.throwIfAborted();
          init.signal.addEventListener('abort', () => {
            f.abortObserved.release(); f.abortFinish.promise.then(() => reject(init.signal.reason));
          }, {once: true});
        });
      }
      const endpoint = new URL(url);
      if (f.errorHost === endpoint.host) return new Response('', {status: 429});
      if (endpoint.searchParams.get('filter')?.startsWith('updates:')) return Response.json({message: {
        'total-results': f.noNotice ? 0 : 1, items: f.noNotice ? [] : [{DOI: '10.1234/notice', title: ['Synthetic correction'],
          'update-to': [{DOI: '10.1234/target', type: 'correction', updated: {'date-parts': [[2026, 11, 6]]}}]}]
      }});
      if (endpoint.host === 'api.openalex.org') return Response.json({
        id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1234/target', title: 'Synthetic target', is_retracted: true
      });
      return Response.json({message: {'total-results': f.ids.length,
        items: f.ids.map(id => ({DOI: `10.1234/${id}`, title: [`Synthetic ${id}`], author: [{given: 'Synthetic', family: 'Author'}]}))}});
    }, governor);
    f.transports.push(value); return value;
  };
  f.imports = new api.LiteratureImportService(f.db, f.repository.library,
    {searchDetailed: (...args) => transport().searchDetailed(...args)}, {
      prepareRecord() {throw new Error('unexpected_import');}, prepareDoi() {throw new Error('unexpected_import');}
    }, () => {throw new Error('unexpected_library_change');}, f.now);
  f.monitors = new api.ResearchMonitorRepository(f.db, f.repository, f.now);
  f.service = new api.ResearchMonitorService(f.monitors, f.imports, {readProviderJson: (...args) => transport().readProviderJson(...args)},
    error => {throw error;}, f.now);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchMonitorCapabilities) registry.declare('fixture', descriptor);
  api.registerResearchMonitorCapabilities({pluginId: 'fixture', capabilities: registry}, f.service, f.monitors);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.human = (capability, run) => api.withResearchHumanContext({capability: `research.monitors.${capability}`, projectId: f.project.id, windowId: 74}, run);
  f.save = (title = 'Synthetic monitor', previous = null, query = {kind: 'search', search: {query: 'Synthetic fixture', sources: ['crossref'], limit: 30, maxPages: 1}}) => {
    f.tick(); return f.human('save', () => f.service.save({projectId: f.project.id, requestId: crypto.randomUUID(),
      monitorId: previous?.id ?? null, expectedRevision: previous?.revision ?? 0, title, cadence: 'weekly', query}));
  };
  f.check = monitor => {f.tick(); return f.human('check', () => f.service.check({
    projectId: f.project.id, monitorId: monitor.id, expectedRevision: monitor.revision, requestId: crypto.randomUUID()}));};
  f.target = (title = 'Synthetic target', doi = '10.1234/target', projectId = f.project.id) => {
    const record = {id: `local:${title}`, source: 'local', externalId: title, doi, title, authors: ['Synthetic Author'],
      abstract: null, publishedYear: 2026, citationCount: null, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp};
    const item = f.repository.library.import([{metadata: record, bibliography: api.bibliographyFromRecord(record, new Set())}], projectId).items[0];
    f.items.push(item); return item;
  };
  f.dispose = async () => {await f.service.shutdown(); await f.imports.shutdown(); for (const transport of f.transports) await transport.shutdown(); f.close();};
  scenes.push(f); return f;
}
const state = (f, changes = {}) => ({projectId: f.project.id, items: f.items, writable: true, ...changes});
async function mount(f, changes = {}) {active = f; await page.evaluate(value => window.mountHub(value), state(f, changes));}
async function open() {await page.getByTestId('literature-subview-monitors').click(); await page.getByTestId('literature-monitors').waitFor();}
async function select(title = 'Synthetic monitor') {
  await page.getByTestId('literature-monitor-list').getByRole('button', {name: new RegExp(title)}).click();
  await page.getByTestId('literature-monitor-editor').waitFor(); await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue(title);
}
async function create(title = 'UI monitor') {
  await page.getByRole('button', {name: '新建监控', exact: true}).click();
  await page.getByRole('textbox', {name: '监控名称', exact: true}).fill(title);
  await page.getByRole('textbox', {name: '检索式', exact: true}).fill('Synthetic fixture');
  await page.getByRole('checkbox', {name: 'OpenAlex', exact: true}).uncheck();
  await page.getByRole('button', {name: '保存查询版本', exact: true}).click();
}
async function check() {
  await page.getByRole('button', {name: '立即检查', exact: true}).click();
  await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeEnabled();
  await page.getByText('检查完成', {exact: true}).waitFor();
}
async function retrySame(f, method) {
  await page.getByRole('button', {name: '重试原监控请求', exact: true}).waitFor();
  await expect(page.getByRole('button', {name: '新建监控', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: '重试原监控请求', exact: true}).click();
  await expect(page.getByRole('button', {name: '新建监控', exact: true})).toBeEnabled();
  const requests = calls.filter(call => call.projectId === f.project.id && call.method === method).slice(-2);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].input, requests[1].input);
}

test('editing monitor metadata preserves frozen dates and explicit or omitted reranking in SQLite and history', async () => {
  for (const rerank of [undefined, 'none', 'lexical']) {
    const f = scene(), query = {kind: 'search', search: {query: 'Synthetic fixture', sources: ['crossref', 'acl', 'cvf'],
      collections: {acl: '2025.acl', cvf: 'CVPR2025'},
      limit: 10, maxPages: 2, yearFrom: 2024, yearTo: 2026, dateFrom: '2024-11-19', dateTo: '2026-11-19',
      ...(rerank === undefined ? {} : {rerank})}};
    const monitor = f.save('Dated monitor', null, query);
    await mount(f); await open(); await select('Dated monitor');
    const diagnostics=page.getByTestId('literature-monitor-diagnostics');
    assert.equal(await diagnostics.evaluate(node=>node.open),false);
    await expect(diagnostics.locator('dd').first()).toBeHidden();
    await diagnostics.locator('summary').focus();await page.keyboard.press('Enter');
    await expect(diagnostics.locator('dd').first()).toBeVisible();
    await expect(diagnostics.locator('dd')).toHaveText([String(monitor.queryVersion),String(monitor.revision)]);
    await page.keyboard.press('Enter');
    await page.getByText('检索范围', {exact: true}).click();
    await expect(page.getByLabel('起始日期', {exact: true})).toHaveValue('2024-11-19');
    await expect(page.getByLabel('截止日期', {exact: true})).toHaveValue('2026-11-19');
    await expect(page.getByLabel('结果排序', {exact: true})).toHaveValue(rerank ?? '');
    await expect(page.getByLabel('ACL 集合（必填，如 2025.acl）', {exact: true})).toHaveValue('2025.acl');
    await expect(page.getByLabel('CVF 集合（必填，如 CVPR2025）', {exact: true})).toHaveValue('CVPR2025');
    await page.getByRole('textbox', {name: '监控名称', exact: true}).fill('Renamed dated monitor');
    await page.getByRole('button', {name: '保存查询版本', exact: true}).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeEnabled();
    assert.deepEqual(f.monitors.version(f.project.id, monitor.id, 2).query, query);
    const versions = page.getByTestId('literature-monitor-versions');
    await versions.locator('summary').click();
    await expect(versions.locator('li')).toHaveCount(2);
    await expect(versions.locator('li').first()).toContainText('2024-11-19 至 2026-11-19');
    await expect(versions.locator('li').first()).toContainText(rerank === 'lexical' ? '词项相关性与多样性' : '融合排序');
  }
});

test('monitor date controls reject disjoint year bounds and save corrected dates with selected reranking', async () => {
  const f = scene(), monitor = f.save();
  await mount(f); await open(); await select();
  await page.getByText('检索范围', {exact: true}).click();
  await page.getByLabel('起始年份', {exact: true}).fill('2026');
  await page.getByLabel('截止日期', {exact: true}).fill('2024-11-19');
  await page.getByRole('button', {name: '保存查询版本', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('日期与年份范围是否重叠');
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'saveMonitor').length, 0);
  await page.getByLabel('截止日期', {exact: true}).fill('2026-11-19');
  await page.getByLabel('起始日期', {exact: true}).fill('2026-01-19');
  await page.getByLabel('结果排序', {exact: true}).selectOption('lexical');
  await page.getByRole('button', {name: '保存查询版本', exact: true}).click();
  await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeEnabled();
  assert.deepEqual(f.monitors.version(f.project.id, monitor.id, 2).query.search, {
    query: 'Synthetic fixture', sources: ['crossref'], limit: 30, maxPages: 1, yearFrom: 2026,
    dateFrom: '2026-01-19', dateTo: '2026-11-19', rerank: 'lexical'
  });
});

test('monitor submission freezes its actual parent selection in the same event and sends one durable command', async () => {
  const f = scene(); f.save('Existing monitor');
  await mount(f); await open(); await page.getByRole('button', {name: '新建监控', exact: true}).click();
  await page.getByRole('textbox', {name: '监控名称', exact: true}).fill('One new monitor');
  await page.getByRole('textbox', {name: '检索式', exact: true}).fill('Synthetic fixture');
  f.holdReply = 'saveMonitor'; f.replyStarted = deferred(); f.replyHold = deferred();
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === '保存查询版本');
    const existing = document.querySelector('[data-testid="literature-monitor-list"] button');
    save.click(); save.click(); existing.click();
  });
  await f.replyStarted.promise;
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'saveMonitor').length, 1);
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue('One new monitor');
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toBeDisabled();
  f.holdReply = null; f.replyHold.release();
  await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeEnabled();
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_monitors').pluck().get(), 2);
});

test('monitor cancellation has an independent synchronous boundary while the real check is still running', async () => {
  const f = scene(); f.save(); await mount(f); await open(); await select();
  f.waitNetwork = true; f.networkStarted = deferred(); f.abortObserved = deferred(); f.abortFinish = deferred();
  await page.getByRole('button', {name: '立即检查', exact: true}).click(); await f.networkStarted.promise;
  f.holdReply = 'cancelMonitorCheck'; f.replyStarted = deferred(); f.replyHold = deferred();
  await page.getByRole('button', {name: '取消当前检查', exact: true}).waitFor();
  await page.evaluate(() => {
    const cancel = [...document.querySelectorAll('button')].find(button => button.textContent === '取消当前检查');
    cancel.click(); cancel.click();
  });
  await f.replyStarted.promise;
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'cancelMonitorCheck').length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_monitor_checks WHERE status='running'").pluck().get(), 1);
  f.holdReply = null; f.replyHold.release();
  await page.getByText('主进程已接收取消信号；等待检查终态。', {exact: true}).waitFor();
  f.abortFinish.release(); await page.getByText('已取消', {exact: true}).waitFor();
});

test('monitor drafts protect native unload and project navigation and explicit discard requires a decision', async () => {
  const f = scene(); await mount(f); await open(); await page.getByRole('button', {name: '新建监控', exact: true}).click();
  await page.getByRole('textbox', {name: '监控名称', exact: true}).fill('未保存的监控');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', {cancelable: true}))), true);
  await page.getByRole('button', {name: '放弃监控修改', exact: true}).click();
  await page.getByTestId('literature-editor-discard').waitFor();
  await page.getByTestId('literature-editor-discard-cancel').click();
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue('未保存的监控');
  await expect(page.getByTestId('literature-editor-discard')).toHaveCount(0);
  await page.evaluate(() => window.navigateAway());
  await page.getByTestId('literature-editor-discard').waitFor();
  assert.equal(await page.evaluate(() => window.navigations), 0);
  await page.getByTestId('literature-editor-discard-confirm').click();
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue('');
  assert.equal(await page.evaluate(() => window.navigations), 1);
});

test('existing hub loads monitor reads only on first visit and creates real search baseline and new-paper alerts', async () => {
  const f = scene(), workflow = f.repository.getWorkflow(f.project.id);
  await mount(f); assert.equal(calls.filter(call => call.projectId === f.project.id).length, 0);
  await page.getByTestId('literature-subview-search').focus(); await page.keyboard.press('End');
  await page.getByText('尚无文献监控', {exact: true}).waitFor();
  await expect(page.getByTestId('literature-subview-monitors')).toBeFocused();
  await create(); await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeEnabled(); await check();
  await page.getByText('暂无提醒', {exact: true}).waitFor();
  f.ids.push('newpaper'); f.tick(); await check();
  await page.getByTestId('literature-monitor-alert').getByText('新论文 / Synthetic newpaper', {exact: true}).waitFor();
  await page.getByRole('button', {name: '标为已读', exact: true}).click();
  await page.getByTestId('literature-monitor-alert').getByText(/^已读/).waitFor();
  const checkView = page.getByTestId('literature-monitor-check').first();
  assert.doesNotMatch(await checkView.locator('summary').first().innerText(),/查询版本/);
  await checkView.locator('summary').first().click();
  await checkView.getByTestId('literature-monitor-source').locator('summary').first().click();
  await expect(checkView).toContainText('来源报告结束');
  await checkView.getByText('请求回执与来源快照',{exact:true}).click();
  await expect(checkView.locator('pre')).toContainText('crossref');
  const location=await page.locator('.monitor-detail').evaluate(node=>{node.scrollTop=170;return node.scrollTop;});
  await page.evaluate(()=>window.setMonitorVisible(false));
  await expect(checkView.locator('pre')).toHaveCount(0);
  await page.evaluate(()=>window.setMonitorVisible(true));
  await expect(checkView.locator('pre')).toContainText('crossref');
  await expect.poll(()=>page.locator('.monitor-detail').evaluate(node=>node.scrollTop)).toBe(location);
  assert.equal(f.network.length, 2); assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow);
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence').pluck().get(), 0);
});

test('DOI target selection binds project item revision and first retraction/correction immediately alert without approval', async () => {
  const f = scene(), item = f.target(); f.target('No DOI', null); f.target('Unlinked', '10.1234/unlinked', null);
  const archived = f.target('Archived', '10.1234/archived'); f.repository.library.archive(archived.id, archived.revision, true);
  f.items = f.items.map(value => f.repository.library.get(value.id));
  await mount(f); await open(); await page.getByRole('button', {name: '新建监控', exact: true}).click();
  await page.getByRole('textbox', {name: '监控名称', exact: true}).fill('Safety');
  await page.getByRole('combobox', {name: '监控类型'}).selectOption('updates');
  const target = page.getByRole('combobox', {name: '目标文献'}); assert.equal(await target.locator('option').count(), 2);
  await target.selectOption(`${item.id}:${item.revision}`); await page.getByRole('button', {name: '保存查询版本', exact: true}).click(); await check();
  assert.equal(await page.getByTestId('literature-monitor-alert').count(), 2);
  const saved = calls.find(call => call.projectId === f.project.id && call.method === 'saveMonitor').input;
  assert.deepEqual(saved.query, {kind: 'updates', itemId: item.id, itemRevision: item.revision, doi: item.metadata.doi});
  const changed = f.repository.library.setCitationKey(item.id, item.revision, 'changed2026');
  f.items = [changed]; await page.evaluate(value => window.updateHub(value), state(f));
  await page.getByText('目标文献已变化；重新选择后保存新的查询版本。', {exact: true}).waitFor();
  await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeDisabled();
  await target.selectOption(`${changed.id}:${changed.revision}`);
  await page.getByRole('button', {name: '保存查询版本', exact: true}).click();
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue('Safety');
  const diagnostics = page.getByTestId('literature-monitor-diagnostics');
  await diagnostics.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(diagnostics.getByText('2', {exact: true}).first()).toBeVisible();
});

test('lost save/control/check/ack replies retry exact commands without duplicate durable writes or provider reads', async () => {
  const f = scene(); await mount(f); await open();
  f.dropReply = 'saveMonitor'; await create(); await retrySame(f, 'saveMonitor');
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_monitors').pluck().get(), 1);
  f.dropReply = 'controlMonitor'; await page.getByRole('button', {name: '暂停监控', exact: true}).click(); await retrySame(f, 'controlMonitor');
  await page.getByRole('button', {name: '恢复监控', exact: true}).click(); await page.getByRole('button', {name: '暂停监控', exact: true}).waitFor();
  await check(); f.ids.push('newpaper'); f.tick();
  f.dropReply = 'checkMonitor'; await page.getByRole('button', {name: '立即检查', exact: true}).click(); await retrySame(f, 'checkMonitor');
  assert.equal(f.network.length, 2);
  await page.getByTestId('literature-monitor-alert').waitFor();
  f.dropReply = 'acknowledgeMonitorAlert'; await page.getByRole('button', {name: '标为已读', exact: true}).click(); await retrySame(f, 'acknowledgeMonitorAlert');
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_monitor_alerts WHERE ack_json IS NOT NULL').pluck().get(), 1);
});

test('saved DOI target is read by identity even when the library list is filtered and failed target reads block writes', async () => {
  const f = scene(), target = f.target();
  f.save('Bound monitor', null, {kind: 'updates', itemId: target.id, itemRevision: target.revision, doi: target.metadata.doi});
  await mount(f, {items: []}); await open(); await select('Bound monitor');
  await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeEnabled();
  await check(); assert.equal(await page.getByTestId('literature-monitor-alert').count(), 2);
  f.failRead = 'getLibraryItem'; await mount(f, {items: []}); await open(); await select('Bound monitor');
  await page.getByText('读取失败注入', {exact: true}).waitFor();
  await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeDisabled();
  f.failRead = null; await page.getByRole('button', {name: '重试目标文献', exact: true}).click();
  await expect(page.getByRole('button', {name: '立即检查', exact: true})).toBeEnabled();
});

test('running checks expose real durable ID and cancellation signal before terminal cancellation', async () => {
  const f = scene(); f.save();
  await mount(f); await open(); await select();
  f.waitNetwork = true; f.networkStarted = deferred(); f.abortObserved = deferred(); f.abortFinish = deferred();
  await page.getByRole('button', {name: '立即检查', exact: true}).click(); await f.networkStarted.promise;
  await page.getByRole('button', {name: '取消当前检查', exact: true}).waitFor();
  const checkId = f.db.prepare("SELECT id FROM research_monitor_checks WHERE status='running'").pluck().get();
  await expect(page.getByText('检查中',{exact:true})).toBeVisible();
  const diagnostics=page.getByTestId('literature-monitor-diagnostics');
  assert.equal(await diagnostics.getByText(checkId,{exact:true}).isVisible(),false);
  await diagnostics.locator('summary').focus();await page.keyboard.press('Enter');
  await expect(diagnostics.getByText(checkId,{exact:true})).toBeVisible();
  await page.getByRole('button', {name: '取消当前检查', exact: true}).click(); await f.abortObserved.promise;
  await page.getByText('主进程已接收取消信号；等待检查终态。', {exact: true}).waitFor();
  assert.equal(f.db.prepare('SELECT status FROM research_monitor_checks WHERE id=?').pluck().get(checkId), 'running');
  const request = calls.find(call => call.projectId === f.project.id && call.method === 'cancelMonitorCheck').input;
  assert.equal(request.checkId, checkId);
  f.abortFinish.release(); await page.getByText('已取消', {exact: true}).waitFor();
  await expect(page.getByRole('button', {name: '新建监控', exact: true})).toBeEnabled();
  assert.equal(f.db.prepare('SELECT status FROM research_monitor_checks WHERE id=?').pluck().get(checkId), 'cancelled');
});

test('independent20-item list/version/check/alert pages use authoritative counts and expose read failures', async () => {
  const f = scene(); let monitor = f.save('Paged monitor'); await f.check(monitor);
  for (let index = 0; index < 21; index++) {f.ids.push(`paper${index}`); await f.check(monitor);}
  for (let index = 0; index < 20; index++) monitor = f.save('Paged monitor', monitor);
  for (let index = 0; index < 20; index++) f.save(`Other ${index}`);
  await mount(f); await open();
  assert.equal(await page.getByTestId('literature-monitor-list').locator('li').count(), 20);
  await page.getByRole('button', {name: '监控列表下一页', exact: true}).click();
  await page.getByTestId('literature-monitor-list').getByRole('button', {name: /Paged monitor/}).waitFor(); await select('Paged monitor');
  await page.getByTestId('literature-monitor-versions').locator('summary').click();
  assert.equal(await page.getByTestId('literature-monitor-versions').locator('li').count(), 20);
  await page.getByRole('button', {name: '查询版本下一页', exact: true}).click();
  await expect(page.getByTestId('literature-monitor-versions').locator('li')).toHaveCount(1);
  await page.getByRole('button', {name: '检查历史下一页', exact: true}).click();
  await expect(page.getByTestId('literature-monitor-checks').getByTestId('literature-monitor-check')).toHaveCount(2);
  await page.getByRole('button', {name: '提醒历史下一页', exact: true}).click();
  await expect(page.getByTestId('literature-monitor-alert')).toHaveCount(1);
  const paged = calls.filter(call => call.projectId === f.project.id && /getMonitor/.test(call.method));
  assert.ok(paged.filter(call => call.input.offset === 20).length >= 4);
  assert.ok(paged.filter(call => call.input.limit !== undefined).every(call => call.input.limit === 20));
  f.failRead = 'getMonitorAlerts'; await page.getByRole('button', {name: '刷新检查与提醒', exact: true}).click();
  await page.getByTestId('literature-monitor-alerts').getByText('读取失败注入', {exact: true}).waitFor();
  f.failRead = null; await page.getByRole('button', {name: '重试提醒历史', exact: true}).click();
  await expect(page.getByTestId('literature-monitor-alert')).toHaveCount(1);
});

test('dirty and uncertain editors lock selection/tabs and retain drafts when project becomes readonly', async () => {
  const f = scene(); f.save(); f.save('Other monitor');
  await mount(f); await open(); await select('Synthetic monitor');
  await page.getByRole('textbox', {name: '监控名称', exact: true}).fill('Retained draft');
  await expect(page.getByTestId('literature-subview-search')).toBeDisabled();
  await expect(page.getByTestId('literature-monitor-list').getByRole('button', {name: /Other monitor/})).toBeDisabled();
  await page.evaluate(value => window.updateHub(value), state(f, {writable: false}));
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue('Retained draft');
  await expect(page.getByRole('button', {name: '保存查询版本', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: '放弃监控修改', exact: true}).click();
  await page.getByTestId('literature-editor-discard-confirm').click();
  await expect(page.getByTestId('literature-subview-search')).toBeEnabled();
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue('Synthetic monitor');
  await page.getByTestId('literature-subview-monitors').focus(); await page.keyboard.press('Home');
  await expect(page.getByTestId('literature-subview-search')).toBeFocused();
});

test('late project reads and successful writes cannot overwrite current project selection or history', async () => {
  const old = scene(), current = scene(); old.save('Old monitor'); current.save('Current monitor');
  old.holdRead = 'getMonitors'; old.readStarted = deferred(); old.readHold = deferred();
  await mount(old); await open(); await old.readStarted.promise;
  active = current; await page.evaluate(value => window.updateHub(value), state(current));
  await page.getByTestId('literature-monitor-list').getByRole('button', {name: /Current monitor/}).waitFor();
  old.readHold.release();
  await select('Current monitor');
  assert.equal(await page.getByTestId('literature-monitor-list').getByText('Old monitor', {exact: true}).count(), 0);
  await mount(old); await open(); await select('Old monitor');
  old.holdRead = null; old.holdReply = 'saveMonitor'; old.replyStarted = deferred(); old.replyHold = deferred();
  await page.getByRole('textbox', {name: '监控名称', exact: true}).fill('Old saved draft');
  await page.getByRole('button', {name: '保存查询版本', exact: true}).click(); await old.replyStarted.promise;
  active = current; await page.evaluate(value => window.updateHub(value), state(current));
  await page.getByTestId('literature-monitor-list').getByRole('button', {name: /Current monitor/}).waitFor();
  old.replyHold.release(); await select('Current monitor');
  await expect(page.getByRole('textbox', {name: '监控名称', exact: true})).toHaveValue('Current monitor');
  assert.equal(old.monitors.list({projectId: old.project.id, offset: 0, limit: 20}).records[0].title, 'Old saved draft');
});

test('partial provider errors retain real unknown observations and old safety alerts', async () => {
  const f = scene(), target = f.target();
  const monitor = f.save('Safety monitor', null, {kind: 'updates', itemId: target.id, itemRevision: target.revision, doi: target.metadata.doi});
  await f.check(monitor); f.errorHost = 'api.openalex.org'; f.noNotice = true; f.tick(); await f.check(monitor);
  await mount(f); await open(); await select('Safety monitor');
  const latest = page.getByTestId('literature-monitor-check').first(); await latest.locator('summary').first().click();
  await expect(latest).toContainText('部分完成'); await latest.getByTestId('literature-monitor-source').first().locator('summary').first().click();
  await expect(latest).toContainText('literature_provider_http_429');
  assert.equal(await page.getByTestId('literature-monitor-alert').count(), 2);
  assert.equal(await page.getByText('正常', {exact: true}).count(), 0);
  await page.evaluate(value => window.updateHub(value), state(f, {writable: false}));
  await expect(page.getByRole('button', {name: '标为已读', exact: true}).first()).toBeDisabled();
});

test('wide and narrow light/dark monitor layouts preserve drafts, keyboard and disclosure without clipped shadows', async () => {
  const f = scene(); const monitor = f.save(); await f.check(monitor);
  await mount(f); await open(); await select();
  await page.getByText('检索范围', {exact: true}).click();
  const audit = await readFile(join(process.cwd(), 'scripts/ui-audit/clip-audit.js'), 'utf8');
  const receipts = [];
  await page.getByRole('textbox',{name:'监控名称',exact:true}).fill('Retained monitor draft');
  for (const theme of ['light', 'dark']) for(const width of [1100,650,420]) {
    await page.setViewportSize({width, height: 800});
    await expect(page.getByRole('textbox',{name:'监控名称',exact:true})).toHaveValue('Retained monitor draft');
    if(width<=650) {
      await expect(page.getByTestId('literature-monitor-list')).toBeHidden();
      await expect(page.getByRole('button',{name:'返回监控列表',exact:true})).toBeDisabled();
    }
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const phase of ['default', 'hover', 'disclosure', 'settled']) {
      if (phase === 'hover') await page.getByRole('button', {name: '立即检查', exact: true}).hover();
      if (phase === 'disclosure') await page.getByTestId('literature-monitor-check').first().locator('summary').first().click();
      if (phase === 'settled') await page.getByRole('button', {name: '刷新检查与提醒', exact: true}).click();
      await page.locator('.monitor-detail').evaluate(element => element.scrollTop = 0);
      const receipt = await page.evaluate(source => (0, eval)(`(${source})`)({root: '[data-testid="literature-hub"]', viewport: true}), audit);
      assert.equal(receipt.cut, 0, JSON.stringify(receipt)); receipts.push({theme, phase, receipt});
    }
    const dimensions = await page.getByTestId('literature-monitors').evaluate(element => ({width: element.clientWidth, scroll: element.scrollWidth}));
    assert.ok(dimensions.scroll <= dimensions.width);
    await page.getByLabel('起始日期', {exact: true}).focus();
    assert.notEqual(await page.getByLabel('起始日期', {exact: true}).evaluate(element => getComputedStyle(element).outlineWidth), '0px');
    await page.getByLabel('结果排序', {exact: true}).scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-${width}.png`)});
  }
  await page.getByRole('button',{name:'放弃监控修改',exact:true}).click();
  await page.getByTestId('literature-editor-discard-confirm').click();
  await page.getByRole('button',{name:'返回监控列表',exact:true}).click();
  await expect(page.getByTestId('literature-monitor-list')).toBeVisible();
  await expect(page.getByTestId('literature-monitor-list').getByRole('heading')).toBeFocused();
  await select();
  await expect(page.getByRole('textbox',{name:'监控名称',exact:true})).toHaveValue('Synthetic monitor');
  await writeFile(join(artifacts, 'clip-audits.json'), JSON.stringify(receipts, null, 2) + '\n');
});
