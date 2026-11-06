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
const artifacts = join(process.cwd(), '.artifacts/research-optimization/xeco-a3c');
const doi = '10.1234/resource-ui', time = '2026-11-06T00:00:00.000Z', hash = 'a'.repeat(64);
const channels = {captureResource: 'roc:research:resource-capture', cancelResourceCapture: 'roc:research:resource-cancel',
  getResourceHistory: 'roc:research:resource-history', getResource: 'roc:research:resource-read',
  associateResource: 'roc:research:resource-associate', getResourceAssociation: 'roc:research:resource-association-read',
  getResourceAssociationHistory: 'roc:research:resource-association-history', getResourceTargets: 'roc:research:resource-targets',
  getScholarlyHistory: 'roc:research:scholarly-history'};
function deferred() {
  let release;
  const promise = new Promise(resolve => {release = resolve;});
  const value = {promise, release}; holds.push(value); return value;
}
before(async () => {
  api = await loadResearchTestApi();
  directory = await mkdtemp(join(tmpdir(), 'roc-resource-ui-'));
  await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {PaperReader} from ${JSON.stringify(join(process.cwd(), 'src/renderer/literature/PaperReader'))};
    import {WorkspaceScopeProvider} from ${JSON.stringify(join(process.cwd(), 'src/renderer/app/workspace-scope'))};
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    client.api.research.getModelsStatus=async()=>({ok:true,data:{ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}});
    const root=createRoot(document.getElementById('root'));let generation=0;
    function Harness({initial}){const [state,setState]=useState(initial);
      window.updateReader=state=>flushSync(()=>setState(state));
      const store={client,...state,documents:[],action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null};
      const scope={client,projectId:state.projectId,writable:state.writable,workspacePath:'/synthetic',workspaceStatus:'ready',workspaceError:null};
      return <WorkspaceScopeProvider value={scope}><PaperReader literature={store} openInFilesView={()=>{}} onClearFocus={()=>{}}/></WorkspaceScopeProvider>;
    }
    window.mountReader=initial=>flushSync(()=>root.render(<Harness key={++generation} initial={initial}/>));
  `, style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active;
    calls.push({projectId: f.project.id, method, input});
    api.parseIpcRequestArgs(channels[method], [input]);
    if (method === 'getScholarlyHistory') return {ok: true, data: f.scholarly.history(input)};
    if (f.holdRead === method) {f.readStarted.release(); await f.readHold.promise;}
    const result = await f.bridge.invoke(`research.${method}`, [input], 74);
    if (f.holdReply === method) {f.replyStarted.release(); await f.replyHold.promise;}
    if (f.dropReply === method && result.ok) {
      f.dropReply = null;
      return {ok: false, error: {code: 'synthetic_reply_lost', message: '已写入但测试回执丢失', category: 'degraded', retryable: true}};
    }
    return result;
  });
});
after(async () => {
  for (const hold of holds) hold.release();
  await app?.close();
  for (const f of scenes) await f.dispose();
  api?.dispose();
  if (directory) await rm(directory, {recursive: true, force: true});
  assert.deepEqual(errors, []);
});
afterEach(async context => {
  await writeFile(join(artifacts, `${context.name.slice(0, 64).replace(/[^a-z0-9]+/giu, '-')}-accessibility.txt`),
    await page.locator('body').ariaSnapshot());
});
function scene() {
  const f = createResearchFixture(api, 'experiment'); scenes.push(f);
  const metadata = {id: 'resource-ui-paper', source: 'local', externalId: 'resource-ui-paper', doi: '10.1234/article',
    title: 'Synthetic resource article', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026,
    citationCount: null, url: null, openAccessUrl: null, importedAt: time, updatedAt: time};
  f.item = f.repository.library.import([{metadata, bibliography: {citationKey: 'synthetic2026', entryType: 'article',
    fields: {title: metadata.title}, preambles: [], csl: null, title: metadata.title, authors: metadata.authors,
    doi: metadata.doi, publishedYear: 2026, abstract: null, url: null}}], f.project.id).items[0];
  f.network = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.network.push(url);
    if (f.waitNetwork) {
      f.networkStarted.release();
      await new Promise((_resolve, reject) => {
        init.signal.throwIfAborted(); init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
      });
    }
    if (f.errorStatus) return new Response('', {status: f.errorStatus});
    return Response.json({data: {id: doi, type: 'dois', attributes: {
      doi, state: 'findable', types: {resourceTypeGeneral: 'Dataset'}, titles: [{title: 'Synthetic resource metadata'}],
      version: '2.1', rightsList: [{rights: 'Synthetic rights only', rightsUri: 'https://example.org/license'}],
      relatedIdentifiers: Array.from({length: 51}, (_, index) => ({relatedIdentifier: `10.1234/related-${index}`,
        relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo', relationTypeInformation: 'Exact provider annotation'})),
      ...f.metadataFields
    }}});
  });
  f.resources = new api.ResearchResourceRepository(f.db, f.repository);
  f.scholarly = new api.ScholarlyRelationsRepository(f.db, f.repository);
  f.service = new api.ResearchResourceService(f.resources, f.transport, () => time);
  f.associations = new api.ResearchResourceAssociationRepository(f.db, f.repository, f.resources, () => time);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of [...api.researchResourceCapabilities, ...api.researchResourceAssociationCapabilities]) registry.declare('fixture', descriptor);
  const context = {pluginId: 'fixture', capabilities: registry};
  api.registerResearchResourceCapabilities(context, f.service, f.resources);
  api.registerResearchResourceAssociationCapabilities(context, f.associations);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.capture = requestId => f.service.capture({projectId: f.project.id, requestId, doi});
  f.targets = kind => f.associations.targets({projectId: f.project.id, kind, offset: 0, limit: 20});
  f.link = (resource, requestId = 'saved-link', target = f.targets('literature').records[0].target) =>
    api.withResearchHumanContext({capability: 'research.resourceAssociations.save', projectId: f.project.id, windowId: 74},
      () => f.associations.save({projectId: f.project.id, requestId, resourceId: resource.id, resourceHash: resource.contentHash,
        target, rationale: 'Explicit synthetic relevance statement'}));
  f.dispose = async () => {await f.service.shutdown(); await f.transport.shutdown(); f.close();};
  return f;
}
const state = (f, overrides = {}) => ({projectId: f.project.id, selected: f.item, writable: true, ...overrides});
async function mount(f, overrides = {}) {
  active = f; await page.evaluate(value => window.mountReader(value), state(f, overrides));
  await page.getByTestId('reader-title').waitFor();
}
async function open() {
  await page.getByTestId('reader-resources-toggle').click(); await page.getByTestId('reader-resources-panel').waitFor();
}
async function capture() {
  await page.getByLabel('资源 DOI', {exact: true}).fill(doi);
  await page.getByRole('button', {name: '查询并保存资源', exact: true}).focus(); await page.keyboard.press('Enter');
  await page.getByTestId('reader-resource-observation').waitFor();
  await page.getByText('尚无人工关联', {exact: true}).waitFor();
}
async function selectSaved() {
  await page.getByTestId('reader-resource-history').getByRole('button', {name: /元数据已保存/}).first().click();
  await page.getByTestId('reader-resource-observation').waitFor();
}
async function fillLink() {
  await page.getByRole('combobox', {name: '目标版本', exact: true}).selectOption({label: 'Synthetic resource article 论文版本 1'});
  await page.getByRole('textbox', {name: '关联依据', exact: true}).fill('人工确认该资源与本论文相关');
}

test('reader lazily queries real metadata and preserves version, rights and paged relation direction without downloading', async () => {
  const f = scene(); await mount(f);
  assert.equal(calls.filter(call => call.projectId === f.project.id).length, 0);
  await open(); await page.getByText('尚无资源观察', {exact: true}).waitFor(); await capture();
  await page.getByText('2.1', {exact: true}).waitFor();
  await page.getByTestId('reader-resource-rights').locator('summary').click();
  await page.getByText('Synthetic rights only', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-resource-rights').locator('dt').count(), 6);
  await page.getByTestId('reader-resource-relations-disclosure').locator('summary').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reader-resource-relations"]')?.children.length === 50);
  await page.getByRole('button', {name: '资源关系下一页', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reader-resource-relations"]')?.children.length === 1);
  await page.getByText(`${doi} → 10.1234/related-50`, {exact: true}).waitFor();
  assert.equal(f.network.length, 1);
  assert.equal(calls.some(call => call.projectId === f.project.id && /download/i.test(call.method)), false);
});

test('unreported fields, explicitly empty sets and failed observations remain distinct', async () => {
  const unknown = scene(); unknown.metadataFields = {version: undefined, rightsList: undefined, relatedIdentifiers: undefined};
  await mount(unknown); await open(); await capture();
  await page.getByTestId('reader-resource-rights').locator('summary').click();
  await page.getByText('来源未报告许可', {exact: true}).waitFor();
  await page.getByTestId('reader-resource-relations-disclosure').locator('summary').click();
  await page.getByText('来源未报告关系集合', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-resource-observation').locator('dt').filter({hasText: '报告版本'})
    .evaluate(node => node.nextElementSibling.textContent), '未报告');
  const empty = scene(); empty.metadataFields = {rightsList: [], relatedIdentifiers: []};
  await mount(empty); await open(); await capture();
  await page.getByTestId('reader-resource-rights').locator('summary').click();
  await page.getByText('来源报告的许可集合为空', {exact: true}).waitFor();
  await page.getByTestId('reader-resource-relations-disclosure').locator('summary').click();
  await page.getByText('来源报告 0 条关系', {exact: true}).waitFor();
  const failed = scene(); failed.errorStatus = 404; await mount(failed); await open();
  await page.getByLabel('资源 DOI', {exact: true}).fill(doi);
  await page.getByRole('button', {name: '查询并保存资源', exact: true}).click();
  await page.getByText('失败观察不能关联到论文或实验', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '保存人工关联', exact: true}).count(), 0);
  assert.equal(failed.resources.history({projectId: failed.project.id, doi: null, offset: 0, limit: 20}).records[0].status, 'error');
});

test('an uncertain capture fixes request identity until exact retry or explicit discard, including readonly mode', async () => {
  const f = scene(); f.dropReply = 'captureResource'; await mount(f); await open();
  await page.getByLabel('资源 DOI', {exact: true}).fill(doi);
  await page.getByRole('button', {name: '查询并保存资源', exact: true}).click();
  await page.getByRole('button', {name: '重试原资源请求', exact: true}).waitFor();
  assert.equal(await page.getByLabel('资源 DOI', {exact: true}).isEnabled(), false);
  assert.equal(await page.getByTestId('reader-resources-toggle').isEnabled(), false);
  await page.getByRole('button', {name: '重试原资源请求', exact: true}).click();
  await page.getByTestId('reader-resource-observation').waitFor();
  const requests = calls.filter(call => call.projectId === f.project.id && call.method === 'captureResource');
  assert.deepEqual(requests[0].input, requests[1].input);
  assert.equal(f.network.length, 1);
  assert.equal(f.resources.history({projectId: f.project.id, doi: null, offset: 0, limit: 20}).total, 1);
  f.dropReply = 'captureResource';
  await page.getByRole('button', {name: '查询并保存资源', exact: true}).click();
  await page.getByRole('button', {name: '重试原资源请求', exact: true}).waitFor();
  await page.evaluate(value => window.updateReader(value), state(f, {writable: false}));
  assert.equal(await page.getByRole('button', {name: '重试原资源请求', exact: true}).isEnabled(), false);
  await page.getByRole('button', {name: '开始新资源请求', exact: true}).click();
  await expect(page.getByTestId('reader-resources-toggle')).toBeEnabled();
  assert.equal(f.resources.history({projectId: f.project.id, doi: null, offset: 0, limit: 20}).total, 2);
});

test('keyboard association uses actual main identity, locks pending controls and retries an exact lost reply once', async () => {
  const f = scene(); await mount(f); await open(); await capture(); await fillLink();
  f.holdReply = 'associateResource'; f.replyStarted = deferred(); f.replyHold = deferred(); f.dropReply = 'associateResource';
  const workflow = f.repository.getWorkflow(f.project.id);
  await page.getByRole('button', {name: '保存人工关联', exact: true}).focus(); await page.keyboard.press('Enter');
  await f.replyStarted.promise;
  assert.equal(await page.getByTestId('reader-resources-toggle').isEnabled(), false);
  assert.equal(await page.getByRole('textbox', {name: '关联依据', exact: true}).isEnabled(), false);
  assert.equal(await page.getByRole('button', {name: '查询并保存资源', exact: true}).isEnabled(), false);
  f.holdReply = null; f.replyHold.release();
  await page.getByRole('button', {name: '重试原关联请求', exact: true}).waitFor();
  await page.getByRole('button', {name: '重试原关联请求', exact: true}).click();
  await page.getByText('关联已保存：目标版本一致', {exact: true}).waitFor();
  const requests = calls.filter(call => call.projectId === f.project.id && call.method === 'associateResource');
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].input, requests[1].input);
  const history = f.associations.history({projectId: f.project.id, resourceId: null, target: null, offset: 0, limit: 20});
  assert.equal(history.total, 1);
  assert.deepEqual(history.records[0].association.actor, {kind: 'user', id: 'window:74'});
  assert.deepEqual(f.repository.getWorkflow(f.project.id), workflow);
});

test('target drift refuses new association, discard recaptures candidates and saved history exposes changed or unavailable targets', async () => {
  const f = scene(); await mount(f); await open(); await capture(); await fillLink();
  f.db.prepare('UPDATE research_library SET revision=revision+1 WHERE id=?').run(f.item.id);
  await page.getByRole('button', {name: '保存人工关联', exact: true}).click();
  await page.getByRole('alert').filter({hasText: '版本已变化'}).waitFor();
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_resource_associations').pluck().get(), 0);
  await page.getByRole('button', {name: '放弃关联草稿并刷新', exact: true}).click();
  await page.getByRole('combobox', {name: '目标版本', exact: true}).selectOption({label: 'Synthetic resource article 论文版本 2'});
  await page.getByRole('textbox', {name: '关联依据', exact: true}).fill('明确选择新的论文版本');
  await page.getByRole('button', {name: '保存人工关联', exact: true}).click();
  await page.getByText('关联已保存：目标版本一致', {exact: true}).waitFor();
  f.db.prepare('UPDATE research_library SET revision=revision+1 WHERE id=?').run(f.item.id);
  await page.getByRole('button', {name: '刷新关联历史', exact: true}).click();
  await page.getByText('目标版本已变化', {exact: true}).waitFor();
  f.repository.library.link(f.item.id, f.project.id, false, {notify: false});
  await page.getByRole('button', {name: '刷新关联历史', exact: true}).click();
  await page.getByText('目标已不可用', {exact: true}).waitFor();
});

test('readonly keeps observations and associations accessible, and a readonly uncertain request only permits discard or history', async () => {
  const f = scene(), resource = await f.capture('readonly'); f.link(resource);
  await mount(f, {writable: false}); await open(); await selectSaved();
  await page.getByText('目标版本一致', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '保存人工关联', exact: true}).isEnabled(), false);
  assert.equal(await page.getByRole('button', {name: '查询并保存资源', exact: true}).isEnabled(), false);
  await mount(f); await open(); await selectSaved(); await fillLink();
  f.dropReply = 'associateResource';
  await page.getByRole('button', {name: '保存人工关联', exact: true}).click();
  await page.getByRole('button', {name: '重试原关联请求', exact: true}).waitFor();
  await page.evaluate(value => window.updateReader(value), state(f, {writable: false}));
  assert.equal(await page.getByRole('button', {name: '重试原关联请求', exact: true}).isEnabled(), false);
  assert.equal(await page.getByRole('button', {name: '放弃关联草稿并刷新', exact: true}).isEnabled(), true);
  await page.getByRole('button', {name: '放弃关联草稿并刷新', exact: true}).click();
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_resource_associations').pluck().get(), 2);
});

test('cancel reaches the real service; late capture and history cannot cross project keys', async () => {
  const f = scene(); f.waitNetwork = true; f.networkStarted = deferred();
  await mount(f); await open(); await page.getByLabel('资源 DOI', {exact: true}).fill(doi);
  await page.getByRole('button', {name: '查询并保存资源', exact: true}).click(); await f.networkStarted.promise;
  await page.getByRole('button', {name: '取消资源查询', exact: true}).click();
  await page.getByText('主进程已接收取消信号', {exact: true}).waitFor();
  assert.equal(f.resources.history({projectId: f.project.id, doi: null, offset: 0, limit: 20}).total, 0);
  assert.equal(await page.getByRole('button', {name: '重试原资源请求', exact: true}).count(), 0);
  const held = scene(), next = scene(); held.holdReply = 'captureResource'; held.replyStarted = deferred(); held.replyHold = deferred();
  await mount(held); await open(); await page.getByLabel('资源 DOI', {exact: true}).fill(doi);
  await page.getByRole('button', {name: '查询并保存资源', exact: true}).click(); await held.replyStarted.promise;
  active = next; await page.evaluate(value => window.updateReader(value), state(next));
  await page.getByText('尚无资源观察', {exact: true}).waitFor(); held.replyHold.release();
  await page.waitForTimeout(50);
  assert.equal(await page.getByTestId('reader-resource-observation').count(), 0);
  assert.equal(held.resources.history({projectId: held.project.id, doi: null, offset: 0, limit: 20}).total, 1);
  const old = scene(); await old.capture('held-history');
  old.holdRead = 'getResourceHistory'; old.readStarted = deferred(); old.readHold = deferred();
  await mount(old); await open(); await old.readStarted.promise;
  active = next; await page.evaluate(value => window.updateReader(value), state(next));
  await page.getByText('尚无资源观察', {exact: true}).waitFor(); old.readHold.release();
  await page.waitForTimeout(50);
  assert.equal(await page.getByTestId('reader-resource-history').locator('li').count(), 0);
});

test('explicit managed experiment selection stores full execution identity, and paged resource and association history remain bounded', async () => {
  const f = scene(), resource = await f.capture('experiment-resource');
  const request = {projectId: f.project.id, ownerRunId: null, requestId: 'completed', label: 'Synthetic managed experiment',
    engine: 'typescript', runtime: {kind: 'bundled-node'}, sourceVersion: 1, sourcePath: 'analysis.mts',
    inputPaths: [], parameters: {}, timeoutMs: 1000, network: 'disabled'};
  const run = f.repository.experiments.create(request, f.project.workspacePath, f.project.workspacePath, '/tmp/roc-resource-ui');
  f.repository.experiments.start(f.project.id, run.id, {runtime: request.runtime, executable: '/usr/bin/true',
    prefix: '/usr/bin', basePrefix: '/usr/bin', version: 'synthetic', platform: 'darwin', architecture: 'arm64',
    toolchainHash: hash, metadataHash: hash, packages: [], lockFiles: [], hash}, [], hash);
  const completed = f.repository.experiments.finish(f.project.id, run.id, {status: 'completed', files: [], exitCode: 0, error: null});
  for (let index = 0; index < 21; index++) f.link(resource, `association-${index}`);
  for (let index = 0; index < 20; index++) await f.capture(`resource-${index}`);
  await mount(f); await open();
  await page.getByRole('button', {name: '资源历史下一页', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reader-resource-history"] ul')?.children.length === 1);
  await selectSaved();
  await page.getByRole('button', {name: '关联历史下一页', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="reader-resource-association-history"] ul')?.children.length === 1);
  await page.getByRole('combobox', {name: '目标类型', exact: true}).selectOption('experiment');
  await page.getByRole('combobox', {name: '目标版本', exact: true}).selectOption({label: `Synthetic managed experiment ${completed.id}`});
  await page.getByRole('textbox', {name: '关联依据', exact: true}).fill('显式关联到已完成的托管执行');
  await page.getByRole('button', {name: '保存人工关联', exact: true}).click();
  await page.getByText('关联已保存：目标版本一致', {exact: true}).waitFor();
  const stored = f.associations.history({projectId: f.project.id, resourceId: resource.id, target: {kind: 'experiment', id: completed.id},
    offset: 0, limit: 20}).records[0];
  assert.equal(stored.association.request.target.expectedExecutionHash, api.resourceContentHash(completed));
});

test('narrow light/dark resource controls preserve keyboard focus and all disclosure states without overflow or clipped shadows', async () => {
  const f = scene(); await mount(f); await open(); await capture();
  await page.setViewportSize({width: 650, height: 900});
  const audit = await readFile(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const receipts = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const rights = page.getByTestId('reader-resource-rights');
    if (await rights.getAttribute('open') !== null) await rights.locator('summary').click();
    for (const mode of ['default', 'hover', 'expanded', 'settled']) {
      if (mode === 'hover') await page.getByRole('button', {name: '查询并保存资源', exact: true}).hover();
      if (mode === 'expanded') await rights.locator('summary').click();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      if (mode === 'expanded' || mode === 'settled') await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="reader-resource-rights"]');
        const style = getComputedStyle(element, '::details-content');
        return style.opacity === '1' && Number.parseFloat(style.blockSize) >= element.querySelector('ul').getBoundingClientRect().height;
      });
      const result = await page.evaluate(code => {
        const audit = (0, eval)(`(${code})`);
        return audit({root: '[data-testid="reader-resources-panel"]', viewport: true});
      }, audit);
      assert.equal(result.cut, 0, JSON.stringify(result)); assert.equal(result.hidden, 0, JSON.stringify(result));
      receipts.push({theme, mode, result});
    }
    await page.getByRole('combobox', {name: '目标版本', exact: true}).focus();
    const outline = await page.getByRole('combobox', {name: '目标版本', exact: true}).evaluate(node => getComputedStyle(node).outlineStyle);
    assert.notEqual(outline, 'none');
    const layout = await page.getByTestId('reader-resources-panel').evaluate(node => ({width: node.clientWidth, scroll: node.scrollWidth}));
    assert.ok(layout.scroll <= layout.width);
    await page.screenshot({path: join(artifacts, `${theme}-650.png`)});
  }
  await writeFile(join(artifacts, 'clip-audits.json'), JSON.stringify(receipts, null, 2) + '\n');
});

test('both reader disclosures share one bounded scroller and leave document content reachable', async () => {
  const f = scene(); await mount(f); await open(); await capture();
  await page.getByTestId('reader-scholarly-toggle').click();
  await page.getByTestId('reader-scholarly-panel').getByText('尚无保存记录', {exact: true}).waitFor();
  const layout = await page.getByTestId('paper-reader').evaluate(reader => {
    const resources = reader.querySelector('[data-testid="reader-resources-panel"]');
    const scholarly = reader.querySelector('[data-testid="reader-scholarly-panel"]');
    const scroller = resources.parentElement;
    return {sameParent: scholarly.parentElement === scroller, height: scroller.clientHeight, readerHeight: reader.clientHeight,
      overflow: getComputedStyle(scroller).overflowY, scroll: scroller.scrollHeight};
  });
  assert.equal(layout.sameParent, true);
  assert.equal(layout.overflow, 'auto');
  assert.ok(layout.height <= layout.readerHeight * 0.55 + 1);
  assert.ok(layout.scroll > layout.height);
  await page.getByText('这条文献还没有文档', {exact: true}).waitFor();
  assert.equal(f.network.length, 1);
});
