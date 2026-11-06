import {after, afterEach, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

let api, directory, app, page, active;
const scenes = [], calls = [], errors = [], holds = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/hf-a4c');
const time = '2026-11-06T00:00:00.000Z', identity = {kind: 'dataset', repo: 'synthetic/ui', revision: 'a'.repeat(40)};
const contents = [Buffer.from('synthetic git bytes\n'), Buffer.from('synthetic LFS bytes\n')];
const sha = value => createHash('sha256').update(value).digest('hex');
const siblings = contents.map((content, index) => ({rfilename: index === 0 ? 'data/one.csv' : 'data/two.csv', size: content.length,
  blobId: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'),
  ...(index === 1 ? {lfs: {size: content.length, sha256: sha(content), pointerSize: 126}} : {})}));
const channels = {captureHuggingFace: 'roc:research:huggingface-capture', cancelHuggingFaceCapture: 'roc:research:huggingface-cancel',
  getHuggingFaceHistory: 'roc:research:huggingface-history', getHuggingFaceObservation: 'roc:research:huggingface-read',
  startHuggingFaceDownload: 'roc:research:huggingface-download-start', cancelHuggingFaceDownload: 'roc:research:huggingface-download-cancel',
  getHuggingFaceDownload: 'roc:research:huggingface-download-read', getHuggingFaceDownloads: 'roc:research:huggingface-download-history',
  getResourceHistory: 'roc:research:resource-history', getScholarlyHistory: 'roc:research:scholarly-history'};
function deferred() {
  let release;
  const promise = new Promise(resolve => {release = resolve;});
  const value = {promise, release}; holds.push(value); return value;
}
before(async () => {
  api = await loadResearchTestApi(); directory = await mkdtemp(join(tmpdir(), 'roc-hf-ui-')); await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {PaperReader} from ${JSON.stringify(join(process.cwd(), 'src/renderer/literature/PaperReader'))};
    import {WorkspaceScopeProvider} from ${JSON.stringify(join(process.cwd(), 'src/renderer/app/workspace-scope'))};
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    client.api.research.getModelsStatus=async()=>({ok:true,data:{ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}});
    const root=createRoot(document.getElementById('root'));let generation=0;
    function Harness({initial}){const [state,setState]=useState(initial);window.updateReader=state=>flushSync(()=>setState(state));
      const store={client,...state,documents:[],action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null};
      const scope={client,projectId:state.projectId,writable:state.writable,workspacePath:'/synthetic',workspaceStatus:'ready',workspaceError:null};
      return <WorkspaceScopeProvider value={scope}><PaperReader literature={store} openInFilesView={()=>{}} onClearFocus={()=>{}}/></WorkspaceScopeProvider>;
    }
    window.mountReader=initial=>flushSync(()=>root.render(<Harness key={++generation} initial={initial}/>));
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
  for (const hold of holds) hold.release(); await app?.close();
  for (const f of scenes) await f.dispose(); api?.dispose(); await rm(directory, {recursive: true, force: true});
  assert.deepEqual(errors, []);
});
afterEach(async context => {await writeFile(join(artifacts, `${context.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 90)}.txt`), await page.locator('body').ariaSnapshot());});
async function scene(metadataFields = {}) {
  const f = createResearchFixture(api, 'reading'); f.root = await mkdtemp(join(tmpdir(), 'roc-hf-ui-download-'));
  const metadata = {id: 'hf-ui-paper', source: 'local', externalId: 'hf-ui-paper', doi: '10.1234/hf-ui',
    title: 'Synthetic HF article', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026,
    citationCount: null, url: null, openAccessUrl: null, importedAt: time, updatedAt: time};
  f.item = f.repository.library.import([{metadata, bibliography: {citationKey: 'synthetichf2026', entryType: 'article',
    fields: {title: metadata.title}, preambles: [], csl: null, title: metadata.title, authors: metadata.authors,
    doi: metadata.doi, publishedYear: 2026, abstract: null, url: null}}], f.project.id).items[0];
  let clock = Date.parse(time);
  f.governor = new api.LiteratureProviderGovernor({'huggingface.co': {minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000,
    failureThreshold: 100, cooldownMs: 60000}}, () => clock, async (ms, signal) => {signal.throwIfAborted(); clock += ms;});
  f.network = []; f.downloadNetwork = [];
  f.transport = new api.LiteratureSearchService(async (url, init) => {
    f.network.push(url);
    if (f.waitNetwork) {f.networkStarted.release(); await new Promise((_resolve, reject) => {
      init.signal.throwIfAborted(); init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true});
    });}
    if (f.errorStatus) return new Response('', {status: f.errorStatus});
    return Response.json({id: identity.repo, sha: identity.revision, private: false, gated: false, disabled: false,
      cardData: {license: 'other', license_name: 'Synthetic test-only license', license_link: 'https://example.org/test-license'}, siblings, ...metadataFields});
  }, f.governor);
  f.observations = new api.HuggingFaceRepository(f.db, f.repository);
  f.metadataService = new api.HuggingFaceService(f.observations, f.transport, () => time);
  f.downloads = new api.HuggingFaceDownloadRepository(f.db, f.observations);
  f.downloader = new api.HuggingFaceDownloader(f.governor, async (url, init) => {
    f.downloadNetwork.push(url);
    const index = url.endsWith('one.csv') ? 0 : 1;
    if (f.holdDownloadIndex === index) {
      f.downloadStarted.release();
      return new Response(new ReadableStream({start(controller) {
        init.signal.throwIfAborted(); controller.enqueue(contents[index].subarray(0, 4));
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), {once: true});
      }}));
    }
    return new Response(contents[index]);
  });
  f.service = new api.HuggingFaceDownloadService(f.downloads, f.observations, f.downloader, f.root); await f.service.initialize();
  f.scholarly = new api.ScholarlyRelationsRepository(f.db, f.repository);
  f.resources = new api.ResearchResourceRepository(f.db, f.repository);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of [...api.researchHuggingFaceCapabilities, ...api.researchHuggingFaceDownloadCapabilities]) registry.declare('fixture', descriptor);
  const context = {pluginId: 'fixture', capabilities: registry};
  api.registerResearchHuggingFaceCapabilities(context, f.metadataService, f.observations);
  api.registerResearchHuggingFaceDownloadCapabilities(context, f.service);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.capture = requestId => f.metadataService.capture({projectId: f.project.id, requestId, ...identity});
  f.dispose = async () => {await f.service.shutdown(); await f.metadataService.shutdown(); await f.transport.shutdown(); f.close(); await rm(f.root, {recursive: true, force: true});};
  scenes.push(f); return f;
}
const state = (f, overrides = {}) => ({projectId: f.project.id, selected: f.item, writable: true, ...overrides});
async function mount(f, overrides = {}) {active = f; await page.evaluate(value => window.mountReader(value), state(f, overrides)); await page.getByTestId('reader-title').waitFor();}
async function open() {await page.getByTestId('reader-hf-toggle').click(); await page.getByTestId('reader-hf-panel').waitFor();}
async function capture() {
  await page.getByRole('textbox', {name: 'Hub 仓库', exact: true}).fill(identity.repo);
  await page.getByRole('textbox', {name: '提交 SHA', exact: true}).fill(identity.revision);
  await page.getByRole('button', {name: '查询并保存 Hub 元数据', exact: true}).focus(); await page.keyboard.press('Enter');
  await page.getByTestId('reader-hf-observation').waitFor(); await page.getByText('尚无下载记录', {exact: true}).waitFor();
}
async function select() {
  await page.getByRole('checkbox', {name: /data\/one.csv/}).check();
  await page.getByRole('checkbox', {name: /data\/two.csv/}).check();
  await page.getByRole('textbox', {name: '许可与文件审核', exact: true}).fill('人工核对合成测试许可和所选文件');
}
async function saved() {await page.getByTestId('reader-hf-history').getByRole('button', {name: /元数据已保存/}).first().click(); await page.getByTestId('reader-hf-observation').waitFor();}

test('reader lazy capture preserves immutable revision, unknown and explicit access fields and never downloads metadata', async () => {
  const f = await scene(); await mount(f); assert.equal(calls.filter(call => call.projectId === f.project.id).length, 0);
  await open(); await page.getByText('尚无 Hub 观察', {exact: true}).waitFor(); await capture();
  await page.getByTestId('reader-hf-access').locator('summary').click(); await page.getByText('Synthetic test-only license', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-hf-access').locator('dt').count(), 7); assert.equal(f.downloadNetwork.length, 0);
  assert.equal(await page.getByTestId('reader-hf-files').locator('li').count(), 2);
  const unknown = await scene({private: undefined, gated: undefined, disabled: undefined, cardData: undefined});
  await mount(unknown); await open(); await capture(); await page.getByTestId('reader-hf-access').locator('summary').click();
  assert.equal(await page.getByTestId('reader-hf-access').locator('dd').allTextContents().then(values => values.filter(value => value === '未报告').length), 7);
  await page.getByText('访问条件不允许匿名下载', {exact: true}).waitFor(); assert.equal(await page.getByRole('checkbox').first().isEnabled(), false);
  const gated = await scene({gated: 'manual'}); await mount(gated); await open(); await capture();
  await page.getByText('访问条件不允许匿名下载', {exact: true}).waitFor(); assert.equal(gated.downloadNetwork.length, 0);
});

test('explicit empty inventory, failed observations and failed reads retain distinct real states', async () => {
  const empty = await scene({siblings: []}); await mount(empty); await open(); await capture();
  await page.getByText('来源报告 0 个文件', {exact: true}).waitFor(); assert.equal(await page.getByRole('checkbox').count(), 0);
  const failed = await scene(); failed.errorStatus = 404; await mount(failed); await open(); await capture();
  await page.getByText('元数据不可用', {exact: true}).first().waitFor(); await page.getByText('文件数量未知', {exact: true}).waitFor();
  assert.equal(failed.downloadNetwork.length, 0);
  const broken = await scene(); await mount(broken); await open(); await capture(); broken.failRead = 'getHuggingFaceObservation';
  await page.getByRole('button', {name: 'Hub 文件下一页', exact: true}).isDisabled();
  await page.getByTestId('reader-hf-toggle').click(); await page.getByTestId('reader-hf-toggle').click(); await saved();
  await page.getByRole('button', {name: '重试 Hub 文件读取', exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: '批准并下载所选文件', exact: true}).isEnabled(), false);
  broken.failRead = null; await page.getByRole('button', {name: '重试 Hub 文件读取', exact: true}).click();
  await page.getByRole('checkbox', {name: /data\/one.csv/}).waitFor();
});

test('uncertain metadata reply retains the exact request and scope lock through retry or readonly discard', async () => {
  const f = await scene(); f.dropReply = 'captureHuggingFace'; await mount(f); await open();
  await page.getByRole('textbox', {name: 'Hub 仓库', exact: true}).fill(identity.repo);
  await page.getByRole('textbox', {name: '提交 SHA', exact: true}).fill(identity.revision);
  await page.getByRole('button', {name: '查询并保存 Hub 元数据', exact: true}).click();
  await page.getByRole('button', {name: '重试原 Hub 请求', exact: true}).waitFor();
  assert.equal(await page.getByTestId('reader-hf-toggle').isEnabled(), false);
  await page.getByRole('button', {name: '重试原 Hub 请求', exact: true}).click(); await page.getByTestId('reader-hf-observation').waitFor();
  const entries = calls.filter(call => call.projectId === f.project.id && call.method === 'captureHuggingFace');
  assert.deepEqual(entries[0].input, entries[1].input); assert.equal(f.network.length, 1);
  f.dropReply = 'captureHuggingFace'; await page.getByRole('button', {name: '查询并保存 Hub 元数据', exact: true}).click();
  await page.getByRole('button', {name: '重试原 Hub 请求', exact: true}).waitFor();
  await page.evaluate(value => window.updateReader(value), state(f, {writable: false}));
  assert.equal(await page.getByRole('button', {name: '重试原 Hub 请求', exact: true}).isEnabled(), false);
  await page.getByRole('button', {name: '放弃原 Hub 请求', exact: true}).click(); await expect(page.getByTestId('reader-hf-toggle')).toBeEnabled();
});

test('paged file selection survives pages, enforces20 files and dirty review cannot be discarded by history or collapse', async () => {
  const many = Array.from({length: 51}, (_, index) => ({...siblings[0], rfilename: `data/file-${index}.csv`}));
  const f = await scene({siblings: many}); await mount(f); await open(); await capture();
  await page.getByRole('checkbox', {name: /data\/file-0.csv/}).check();
  await page.getByRole('button', {name: 'Hub 文件下一页', exact: true}).click();
  await page.getByRole('checkbox', {name: /data\/file-50.csv/}).check();
  assert.match(await page.getByTestId('reader-hf-selected').innerText(), /file-0.csv.*file-50.csv/);
  assert.equal(await page.getByTestId('reader-hf-toggle').isEnabled(), false);
  await page.getByTestId('reader-hf-history').locator('summary').click();
  assert.equal(await page.getByTestId('reader-hf-history').getByRole('button', {name: /元数据已保存/}).isEnabled(), false);
  await page.getByRole('button', {name: 'Hub 文件上一页', exact: true}).click();
  for (let index = 1; index <= 18; index++) await page.getByRole('checkbox', {name: new RegExp(`data/file-${index}\\.csv`)}).check();
  assert.equal(await page.getByRole('checkbox', {name: /data\/file-19.csv/}).isEnabled(), false);
  await page.getByRole('button', {name: '放弃下载审核', exact: true}).click();
  await expect(page.getByTestId('reader-hf-toggle')).toBeEnabled();
});

test('reviewed keyboard start binds main actor and real verified bytes while a lost reply replays exactly without duplicate GET', async () => {
  const f = await scene(); f.dropReply = 'startHuggingFaceDownload'; await mount(f); await open(); await capture(); await select();
  await page.getByRole('button', {name: '批准并下载所选文件', exact: true}).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', {name: '重试原下载请求', exact: true}).waitFor();
  assert.equal(await page.getByRole('textbox', {name: '许可与文件审核', exact: true}).isEnabled(), false);
  assert.equal(await page.getByRole('checkbox', {name: /data\/one.csv/}).isEnabled(), false);
  await page.getByRole('button', {name: '重试原下载请求', exact: true}).click();
  await page.getByTestId('reader-hf-download-receipt').getByText('下载完成', {exact: true}).waitFor();
  await page.getByTestId('reader-hf-download-authorization').locator('summary').click(); await page.getByText('window:74', {exact: true}).waitFor();
  const entries = calls.filter(call => call.projectId === f.project.id && call.method === 'startHuggingFaceDownload');
  assert.deepEqual(entries[0].input, entries[1].input); assert.equal(f.downloadNetwork.length, 2);
  const records = f.service.history({projectId: f.project.id, observationId: null, offset: 0, limit: 20}).records;
  assert.equal(records.length, 1); assert.equal(records[0].state, 'completed'); assert.equal(records[0].files.length, 2);
  for (const [index, file] of records[0].files.entries()) assert.deepEqual(await readFile(join(f.root,
    api.huggingFaceDownloadDirectory(f.project.id, records[0].id), file.storageName)), contents[index]);
});

test('actual cancellation retains the first verified file, reports real terminal state and readonly history issues no new download', async () => {
  const f = await scene(); f.holdDownloadIndex = 1; f.downloadStarted = deferred(); await mount(f); await open(); await capture(); await select();
  await page.getByRole('button', {name: '批准并下载所选文件', exact: true}).click(); await f.downloadStarted.promise;
  await page.getByRole('button', {name: '取消 Hub 下载', exact: true}).click();
  await page.getByTestId('reader-hf-download-receipt').getByText('下载已取消', {exact: true}).waitFor();
  const receipt = f.service.history({projectId: f.project.id, observationId: null, offset: 0, limit: 20}).records[0];
  assert.equal(receipt.files.length, 1); assert.ok(receipt.lastRecordedTransferredBytes > receipt.verifiedBytes);
  assert.equal(await page.getByTestId('reader-hf-verified-files').locator('li').count(), 1);
  await page.evaluate(value => window.updateReader(value), state(f, {writable: false}));
  assert.equal(await page.getByRole('button', {name: '批准并下载所选文件', exact: true}).isEnabled(), false);
  await page.getByTestId('reader-hf-toggle').click(); await page.getByTestId('reader-hf-toggle').click(); await saved();
  await page.getByTestId('reader-hf-download-history').getByRole('button', {name: /下载已取消/}).click();
  await page.getByTestId('reader-hf-download-receipt').getByText('下载已取消', {exact: true}).waitFor(); assert.equal(f.downloadNetwork.length, 2);
});

test('late scoped reads cannot show another project and metadata cancel uses the actual abort signal', async () => {
  const first = await scene(), other = await scene(); await first.capture('saved'); first.holdRead = 'getHuggingFaceHistory';
  first.readStarted = deferred(); first.readHold = deferred(); await mount(first); await open(); await first.readStarted.promise;
  active = other; await page.evaluate(value => window.updateReader(value), state(other)); await page.getByText('尚无 Hub 观察', {exact: true}).waitFor();
  first.readHold.release(); await page.getByText('尚无 Hub 观察', {exact: true}).waitFor(); assert.equal(await page.getByTestId('reader-hf-observation').count(), 0);
  const held = await scene(); held.waitNetwork = true; held.networkStarted = deferred(); await mount(held); await open();
  await page.getByRole('textbox', {name: 'Hub 仓库', exact: true}).fill(identity.repo);
  await page.getByRole('textbox', {name: '提交 SHA', exact: true}).fill(identity.revision);
  await page.getByRole('button', {name: '查询并保存 Hub 元数据', exact: true}).click(); await held.networkStarted.promise;
  await page.getByRole('button', {name: '取消 Hub 查询', exact: true}).click();
  await page.getByRole('button', {name: '放弃原 Hub 请求', exact: true}).waitFor();
  assert.equal(held.observations.history({projectId: held.project.id, identity: null, offset: 0, limit: 20}).total, 0);
  await page.getByRole('button', {name: '放弃原 Hub 请求', exact: true}).click();
});

test('650px light/dark keyboard focus and8 clip states pass inside the shared bounded reader scroller', async () => {
  const f = await scene(); await mount(f); await open(); await capture(); await page.setViewportSize({width: 650, height: 900});
  const audit = await readFile(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8'), receipts = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    const access = page.getByTestId('reader-hf-access'); if (await access.getAttribute('open') !== null) await access.locator('summary').click();
    for (const mode of ['default', 'hover', 'expanded', 'settled']) {
      if (mode === 'hover') await page.getByRole('button', {name: '查询并保存 Hub 元数据', exact: true}).hover();
      if (mode === 'expanded') await access.locator('summary').click();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      if (mode === 'expanded' || mode === 'settled') await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="reader-hf-access"]');
        const style = getComputedStyle(element, '::details-content');
        // Computed CSS serializes to three decimals; compare the DOM height at the same precision.
        const height = Math.round(element.querySelector('dl').getBoundingClientRect().height * 1000) / 1000;
        return style.opacity === '1' && Number.parseFloat(style.blockSize) >= height;
      });
      const result = await page.evaluate(code => (0, eval)(`(${code})`)({root: '[data-testid="reader-hf-panel"]', viewport: true}), audit);
      assert.equal(result.cut, 0, JSON.stringify(result)); assert.equal(result.hidden, 0, JSON.stringify(result)); receipts.push({theme, mode, result});
    }
    await access.scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-650-access.png`)});
    await page.getByRole('textbox', {name: '许可与文件审核', exact: true}).focus();
    assert.notEqual(await page.getByRole('textbox', {name: '许可与文件审核', exact: true}).evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    const layout = await page.getByTestId('reader-hf-panel').evaluate(node => ({width: node.clientWidth, scroll: node.scrollWidth}));
    assert.ok(layout.scroll <= layout.width);
    await page.getByRole('button', {name: '批准并下载所选文件', exact: true}).scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-650.png`)});
  }
  await writeFile(join(artifacts, 'clip-audits.json'), JSON.stringify(receipts, null, 2) + '\n');
  await page.getByTestId('reader-resources-toggle').click(); await page.getByText('尚无资源观察', {exact: true}).waitFor();
  const layout = await page.getByTestId('paper-reader').evaluate(reader => {
    const hf = reader.querySelector('[data-testid="reader-hf-panel"]'), resources = reader.querySelector('[data-testid="reader-resources-panel"]');
    const scroller = hf.parentElement; return {same: resources.parentElement === scroller, height: scroller.clientHeight,
      reader: reader.clientHeight, overflow: getComputedStyle(scroller).overflowY};
  });
  assert.equal(layout.same, true); assert.equal(layout.overflow, 'auto'); assert.ok(layout.height <= layout.reader * .55 + 1);
});
