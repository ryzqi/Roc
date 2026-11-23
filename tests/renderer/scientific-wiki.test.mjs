import {after, afterEach, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {build} from 'esbuild';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi} from '../unit/fixtures/scientific-search-fixture.mjs';
import {scientificWikiFixture, scientificWikiCandidates} from '../unit/fixtures/scientific-wiki-fixture.mjs';

let api, services, structured, directory, app, page, windowId, active;
const fixtures = [], errors = [], calls = [], holds = [];
const artifacts = join(process.cwd(), '.artifacts/scientific-rag/phase6-ui', new Date().toISOString().replace(/[:.]/gu, '-'));
const rows = () => page.getByTestId('wiki-scientific-row');
const source = () => page.getByTestId('wiki-scientific-source');
const record = () => page.getByTestId('wiki-scientific-record');
function deferred() {
  let release;
  const promise = new Promise(resolve => {release = resolve;});
  const result = {promise, release}; holds.push(result); return result;
}

before(async () => {
  [api, services, structured] = await Promise.all([loadScientificSearchApi(),
    ...['scientific-extraction-service', 'wiki-scientific-synthesis'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
        {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))]);
  directory = await mkdtemp(join(tmpdir(), 'roc-scientific-wiki-ui-'));
  await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ScientificKnowledgePanel} from './src/renderer/literature/ScientificKnowledgePanel';
    import {ScientificPaperKnowledge} from './src/renderer/literature/ScientificPaperKnowledge';
    import {WikiWorkspace} from './src/renderer/literature/WikiWorkspace';
    import {WikiView} from './src/renderer/literature/WikiView';
    import {KnowledgeGraphView} from './src/renderer/literature/KnowledgeGraphView';
    const root=createRoot(document.getElementById('root'));
    const methods=['searchWikiKnowledge','readWikiPaperKnowledge','resolveDocumentParse','getDocumentContent',
      'previewDocument','listReadingHighlights','searchWiki','readWiki','createWiki','saveWiki','compileWiki',
      'rollbackWiki','wikiHistory','wikiRevision','listClaims','compareClaims','readWikiSection','resynthesizeWiki','retryWikiPaper'];
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>window.fromMain(method,input)]))}};
    let generation=0;
    function Harness({surface,state}) {
      const [value,setValue]=React.useState(state);window.updateScope=patch=>flushSync(()=>setValue(v=>({...v,...patch})));
      if(surface==='object')return <ScientificPaperKnowledge client={client} projectId={value.projectId}
        reference={value.reference} record={value.record}/>;
      if(surface==='workspace')return <WikiWorkspace client={client} projectId={value.projectId} snapshot={value.snapshot}
        writable claims={value.snapshot.claims} evidence={value.snapshot.sources.map(s=>s.evidence)} libraryItems={[]}
        onOpenClaim={()=>{}}/>;
      if(surface==='graph')return <KnowledgeGraphView client={client} projectId={value.projectId}
        claims={[]} evidence={[]} libraryItems={[]}/>;
      if(surface==='claims')return <WikiView client={client} projectId={value.projectId} snapshot={value.snapshot}
        claims={value.snapshot.claims} evidence={value.snapshot.sources.map(s=>s.evidence)} libraryItems={[]}
        onOpenClaim={()=>{}}/>;
      return <ScientificKnowledgePanel client={client} projectId={value.projectId} documentIds={value.documentIds}/>;
    }
    window.mount=(surface,state)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict><Harness key={++generation} surface={surface} state={state}/></LazyMotion>
    </MotionConfig>));
    window.unmount=()=>flushSync(()=>root.render(null));
  `, style: `html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}
    #root{display:flex;min-width:0;flex-direction:column;overflow:auto}`,
  setup: `const NativeWorker=window.Worker;window.liveWorkers=0;window.createdWorkers=0;
    window.Worker=class extends NativeWorker {constructor(...args){super(...args);window.liveWorkers++;window.createdWorkers++;this.closed=false;}
      terminate(){if(!this.closed){this.closed=true;window.liveWorkers--;}super.terminate();}};`});
  // The protocol and its AsyncLocalStorage must share one bundled module instance.
  await writeFile(join(directory, 'protocol-entry.ts'), `
    export * from ${JSON.stringify(join(process.cwd(), 'src/main/pdf-preview-protocol.ts'))};
    export {documentSourceRequest} from ${JSON.stringify(join(process.cwd(), 'src/main/plugins/research/document-source-request.ts'))};
  `);
  await build({entryPoints: [join(directory, 'protocol-entry.ts')], outfile: join(directory, 'protocol.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'});
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');const protocol=require('./protocol.cjs');protocol.registerPdfPreviewScheme();
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>{
      protocol.registerPdfPreviewProtocol(()=>({invokeCapability:async(name,input)=>{
        const method=name==='research.document.source'?'source':name==='research.document.asset'?'asset':null;
        if(method===null)throw new Error('unsupported preview capability');
        const context=method==='source'?protocol.documentSourceRequest():null;
        const native=context===null?null:{method:context.method,range:context.range,session:context.session,release:context.release};
        const result=await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          'window.fromMain('+JSON.stringify(method)+','+JSON.stringify(input)+','+JSON.stringify(native)+')');
        if(!result.ok)throw new Error(result.message);
        return new Response(native?.method==='HEAD'||result.status===204?null:new Uint8Array(result.bytes),
          {status:result.status,headers:result.headers});
      }}),null);
      return new BrowserWindow({show:false,width:1100,height:850}).loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('fromMain', async (method, input, native = null) => {
    const f = fixtures.find(value => value.project.id === input.projectId) ?? active;
    const started = performance.now(), call = {projectId: input.projectId, method, input, native};
    calls.push(call);
    if (f.holdMethod === method) await f.hold.promise;
    if (f.failMethod === method) return {ok: false, error: {code: 'fixture_read_failure', message: '科研来源读取失败注入'}};
    if (method === 'source' || method === 'asset') {
      try {
        const run = () => f.registry.invoke(`research.document.${method}`, input);
        const url = new URL(`roc-preview://research/projects/${encodeURIComponent(input.projectId)}/documents/${encodeURIComponent(input.documentId)}/source/${input.sourceHash}`);
        if (native?.session != null) url.searchParams.set('session', native.session);
        if (native?.release) url.searchParams.set('release', '1');
        const response = native === null ? await run() : await api.withDocumentSourceRequest(new Request(url, {
          method: native.method, headers: native.range === null ? {} : {range: native.range}
        }), run);
        return {ok: true, bytes: Array.from(new Uint8Array(await response.arrayBuffer())), status: response.status,
          headers: Object.fromEntries(response.headers)};
      } catch (error) {return {ok: false, message: error.message};}
    }
    if (method === 'listReadingHighlights') return {ok: true, data: []};
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
    call.elapsedMs = performance.now() - started;
    call.ok = result.ok;
    if (f.corruptParse && method === 'getDocumentContent' && result.ok) result.data.content.blocks[0].text += ' changed';
    return result;
  });
});
afterEach(async context => {
  for (const hold of holds) hold.release();
  if (page && !page.isClosed()) {
    await writeFile(join(artifacts, `${context.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 95)}.txt`), await page.locator('body').ariaSnapshot());
    await page.evaluate(() => window.unmount());
    await page.waitForFunction(() => window.liveWorkers === 0);
  }
});
after(async () => {
  try {
    for (const hold of holds) hold.release();
    await app?.close();
    for (const f of fixtures) await f.finish();
    await writeFile(join(artifacts, 'runtime-reads.json'), JSON.stringify(calls, null, 2));
  } finally {
    api?.dispose();
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
async function scene(surface = 'panel', fields = {}) {
  const f = await scientificWikiFixture(api, services); fixtures.push(f); active = f;
  f.job = await f.publishKnowledge();
  f.reference = {documentId: f.document.id, generationId: f.job.id};
  f.registry = new api.CapabilityRegistry();
  for (const descriptor of [...api.researchWikiCapabilities, ...api.researchDocumentCapabilities, ...api.researchEvidenceCapabilities])
    f.registry.declare('research', descriptor);
  api.registerResearchWikiCapabilities({pluginId: 'research', capabilities: f.registry}, f.wiki,
    {readKnowledge: (input, signal) => f.service.readPaperCard(input, signal)}, f.service);
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: f.registry}, f.repository.documents,
    new api.ResearchDocumentService(f.repository, {}, f.root));
  api.registerResearchEvidenceCapabilities({pluginId: 'research', capabilities: f.registry}, f.repository.evidence);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (...args) => f.registry.invoke(...args)});
  f.wiki.start(); await f.wiki.idle();
  await mount(f, surface, fields);
  return f;
}
async function mount(f, surface, fields = {}) {
  await page.evaluate(({surface, state}) => window.mount(surface, state), {surface, state: {
    projectId: f.project.id, documentIds: [f.document.id], reference: f.reference,
    snapshot: f.repository.evidence.wikiSnapshot(f.project.id), ...fields
  }});
}
async function publish(f, candidates) {
  const pending = await f.service.enqueue({projectId: f.project.id, documentId: f.document.id});
  const job = f.repository.scientificExtraction.enqueue(pending.snapshot, f.ir, true);
  f.repository.scientificExtraction.claim(job.id, f.project.id);
  f.job = f.repository.scientificExtraction.publish(job.id, f.project.id, candidates, f.ir, () => job.snapshot);
  f.reference = {documentId: f.document.id, generationId: f.job.id};
}
const searched = f => calls.filter(call => call.projectId === f.project.id && call.method === 'searchWikiKnowledge');

test('real knowledge search: kind/type/alias, raw values, complete conditions, debounce and project isolation', async () => {
  const f = await scene();
  await rows().filter({hasText: 'F1'}).click();
  await record().getByRole('heading', {name: 'F1', exact: true}).waitFor();
  assert.equal(searched(f).every(call => call.input.limit === 20), true);
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'previewDocument').length, 0);
  const input = page.getByLabel('搜索科研知识');
  await input.fill('baseline');
  assert.equal(await rows().count(), 0);
  await page.getByText('等待搜索输入…', {exact: true}).waitFor();
  await rows().first().waitFor();
  assert.equal(searched(f).at(-1).input.query, 'baseline');
  await input.fill('');
  await page.getByRole('button', {name: '事实', exact: true}).click();
  await rows().filter({hasText: 'Reported F1'}).click();
  assert.equal(await page.getByTestId('wiki-scientific-value').getByText('90', {exact: true}).innerText(), '90');
  assert.match(await page.getByTestId('wiki-scientific-conditions').innerText(), /数据集版本[\s\S]+划分[\s\S]+F1[\s\S]+训练 \/ 计算预算/);
  await page.getByTestId('wiki-scientific-table').waitFor();
  assert.equal(await page.getByTestId('wiki-scientific-table').locator('td[rowspan="2"]').innerText(), 'Original baseline');
  assert.deepEqual(await page.getByTestId('wiki-scientific-table').locator('td').allTextContents(), ['Original baseline', '90', '91']);
  await page.getByLabel('科研知识类型').selectOption('experimental_result');
  await rows().first().waitFor(); assert.equal(await rows().count(), 1);
  const other = f.repository.createProject({title: 'Isolated UI project', description: '', workspacePath: join(f.root, 'other')});
  await page.evaluate(projectId => window.updateScope({projectId, documentIds: []}), other.id);
  await page.getByText('没有当前有效的匹配记录。', {exact: true}).waitFor();
  assert.equal(await record().count(), 0); assert.equal(await page.getByLabel('科研知识类型').inputValue(), '');
  assert.equal(calls.filter(call => call.projectId === other.id && call.method === 'searchWikiKnowledge').at(-1).input.offset, 0);
});

test('20-candidate pages keep distinct alias-bound proposals and reject changed generation digests', async () => {
  const f = await scene(), candidates = scientificWikiCandidates(f.ir);
  const target = (await f.readKnowledge()).knowledge.entities.find(entity => entity.entityType === 'Method');
  f.repository.scientificExtraction.putAlias({id: 'ui-explicit-alias', projectId: f.project.id, entityType: 'Method',
    alias: 'Original baseline', targetEntityId: target.id, canonicalName: target.canonicalName, revision: 1, createdBy: 'fixture-human'}, target);
  candidates.entities = Array.from({length: 25}, (_, index) => ({...structuredClone(candidates.entities[0]), id: `method-${String(index).padStart(2, '0')}`}));
  candidates.facts = []; candidates.relations = [];
  await publish(f, candidates); await mount(f, 'panel'); await rows().first().waitFor();
  assert.equal(await rows().count(), 20);
  await rows().nth(1).click(); await record().waitFor();
  assert.equal(await rows().nth(0).getAttribute('aria-pressed'), 'false');
  assert.equal(await rows().nth(1).getAttribute('aria-pressed'), 'true');
  await record().getByText('人工别名绑定', {exact: true}).waitFor();
  await page.getByRole('button', {name: '后 20 条', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="wiki-scientific-row"]').length === 5);
  const second = searched(f).at(-1).input;
  assert.equal(second.offset, 20); assert.match(second.basisDigest, /^[a-f0-9]{64}$/u);
  await f.publishKnowledge(true);
  await page.getByRole('button', {name: '前 20 条', exact: true}).click();
  await page.getByTestId('error-blocked').waitFor(); assert.equal(await rows().count(), 0);
  assert.equal(searched(f).at(-1).ok, false);
  await page.getByTestId('error-blocked').getByRole('button', {name: '重试', exact: true}).click(); await rows().first().waitFor();
  assert.equal(searched(f).at(-1).input.offset, 0); assert.equal(searched(f).at(-1).input.basisDigest, null);
});

test('typed neighbors are lazy, use 10-row pages and select actual endpoints', async () => {
  const f = await scene(), candidates = scientificWikiCandidates(f.ir);
  candidates.relations = Array.from({length: 12}, (_, index) => ({...structuredClone(candidates.relations[0]), id: `relation-${index}`}));
  await publish(f, candidates); await mount(f, 'panel');
  await page.getByLabel('科研知识类型').selectOption('Experiment');
  await rows().first().click(); await record().waitFor();
  assert.equal(searched(f).filter(call => call.input.kind === 'relation').length, 0);
  await page.getByRole('button', {name: '展开科研关系', exact: true}).focus(); await page.keyboard.press('Enter');
  const neighbors = page.getByTestId('wiki-scientific-neighbors');
  await neighbors.locator('li').first().waitFor(); assert.equal(await neighbors.locator('li').count(), 10);
  assert.equal(searched(f).at(-1).input.limit, 10); assert.ok(searched(f).at(-1).input.entityId);
  await neighbors.getByRole('button', {name: '后 10 条关系', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="wiki-scientific-neighbors"] li').length === 2);
  assert.equal(searched(f).at(-1).input.offset, 10); assert.ok(searched(f).at(-1).input.basisDigest);
  await page.getByLabel('科研邻居关系类型').selectOption('USES');
  await page.getByText('没有当前有效的科研关系。', {exact: true}).waitFor();
  assert.equal(searched(f).at(-1).input.offset, 0); assert.equal(searched(f).at(-1).input.basisDigest, null);
  await page.getByLabel('科研邻居关系类型').selectOption('EVALUATES_WITH');
  await neighbors.getByRole('button', {name: 'F1', exact: true}).first().click();
  await record().getByRole('heading', {name: 'F1', exact: true}).waitFor();
});

test('fixed table-cell source opens actual PDF via protocol with exact quote and source geometry', async () => {
  const f = await scene();
  await page.getByRole('button', {name: '事实', exact: true}).click();
  await rows().filter({hasText: 'Reported F1'}).click(); await record().waitFor();
  const details = record().locator('details').filter({has: page.locator('summary', {hasText: '表格单元格'})});
  await details.last().locator(':scope > summary').click();
  await source().getByTestId('wiki-scientific-source-quote').waitFor();
  assert.equal(await source().getByTestId('wiki-scientific-source-quote').innerText(), 'Original baseline');
  await source().getByTestId('reader-pdf-canvas').waitFor();
  assert.equal(await source().getByTestId('reader-pdf-canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0), true);
  assert.equal(calls.some(call => call.projectId === f.project.id && call.method === 'source' && call.native?.session), true);
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence').pluck().get(), 0);
  await source().getByText('未记录精确区域，仅定位原始页。', {exact: true}).waitFor();
  await page.screenshot({path: join(artifacts, 'table-cell-source.png')});
  await details.last().locator(':scope > summary').click();
  await page.waitForFunction(() => window.liveWorkers === 0);
  assert.equal(calls.some(call => call.projectId === f.project.id && call.method === 'source' &&
    call.native?.method === 'HEAD' && call.native.release), true);
});

test('complete equation/figure inspectors preserve raw LaTeX, original captions and lazily read PNG', async () => {
  const f = await scene('object', {record: {kind: 'object', id: 'pending'}});
  await mount(f, 'object', {record: {kind: 'object', id: f.ir.equations[0].id, objectType: 'Equation'}});
  const object = page.getByTestId('wiki-scientific-object');
  await page.getByTestId('wiki-scientific-latex').waitFor();
  assert.equal(await page.getByTestId('wiki-scientific-latex').innerText(), f.ir.equations[0].data.rawLatex);
  await page.getByTestId('wiki-scientific-formula').locator('.katex').waitFor();
  await object.getByText('规范化 LaTeX', {exact: true}).click();
  await object.locator('details').filter({has: page.locator('summary', {hasText: '规范化 LaTeX'})})
    .getByText(f.ir.equations[0].data.normalizedLatex, {exact: true}).waitFor();
  await mount(f, 'object', {record: {kind: 'object', id: f.ir.figures[0].id, objectType: 'Figure'}});
  await object.getByText(/图注（/u).click();
  await object.getByText('Figure 2: Original architecture.', {exact: true}).waitFor();
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'asset').length, 0);
  await object.getByRole('button', {name: '核对原始 PDF 与图像', exact: true}).click();
  await source().getByTestId('reader-pdf-canvas').waitFor();
  await source().getByRole('button', {name: '核对固定解析图像', exact: true}).click();
  await source().locator('img').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="wiki-scientific-source"] img')].some(img => img.complete && img.naturalWidth === 96));
  assert.equal(calls.some(call => call.projectId === f.project.id && call.method === 'asset'), true);
});

test('scientific search failures expose one retry action and recover through it', async () => {
  const f = await scene();
  await rows().first().waitFor();
  f.failMethod = 'searchWikiKnowledge';
  await page.getByRole('button', {name: '重新检索科研知识', exact: true}).click();
  await page.getByTestId('error-blocked').getByText('科研来源读取失败注入', {exact: true}).waitFor();
  assert.equal(await page.getByRole('button', {name: /^(重试|重新检索科研知识)$/}).count(), 1);
  f.failMethod = null;
  await page.getByRole('button', {name: '重试', exact: true}).click();
  await rows().first().waitFor();
  assert.equal(await page.getByRole('button', {name: /^(重试|重新检索科研知识)$/}).count(), 1);
});

test('reload, parse corruption, read errors and retired scientific source hide previously loaded data', async () => {
  const f = await scene('object', {record: {kind: 'object', id: 'pending'}});
  await mount(f, 'object', {record: {kind: 'object', id: f.ir.equations[0].id}});
  await page.getByTestId('wiki-scientific-latex').waitFor();
  f.hold = deferred(); f.holdMethod = 'readWikiPaperKnowledge';
  await page.getByRole('button', {name: '刷新科研来源', exact: true}).click();
  await page.getByText('核对科研知识来源…', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('wiki-scientific-latex').count(), 0);
  f.failMethod = 'readWikiPaperKnowledge'; f.hold.release();
  await page.getByTestId('error-blocked').getByText('科研来源读取失败注入', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('wiki-scientific-latex').count(), 0);
  f.failMethod = null; f.holdMethod = null;
  await page.getByRole('button', {name: '刷新科研来源', exact: true}).click();
  await page.getByTestId('wiki-scientific-latex').waitFor();
  f.corruptParse = true;
  await page.getByRole('button', {name: '核对原始 PDF 与图像', exact: true}).click();
  await source().getByTestId('error-blocked').getByText('科研原文解析内容已改变。', {exact: true}).waitFor();
  assert.equal(await source().getByTestId('wiki-scientific-source-quote').count(), 0);
  f.switchModel();
  await page.getByRole('button', {name: '刷新科研来源', exact: true}).click();
  await page.getByText('科研来源已失效', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('wiki-scientific-object').count(), 0);
});

test('persisted scientific sections expose references; human rewrites retain dependencies without canonical statements', async () => {
  const f = await scene();
  const knowledge = await f.readKnowledge(), fact = knowledge.knowledge.facts.find(value => value.factType === 'experimental_result');
  let value = await f.wiki.createCurrent({projectId: f.project.id, title: 'UI scientific topic', kind: 'topic',
    evidenceIds: [], claimIds: [], paperKnowledgeSources: [f.reference]});
  await f.wiki.idle(); value = await f.wiki.readCurrent(f.project.id, value.page.id);
  value = await f.wiki.saveCurrent(f.saveInput(value, structured.scientificWikiSection({id: 'results', title: 'UI results'},
    [{kind: 'fact', source: f.reference, id: fact.id}], {knowledge: [knowledge]})), 'assistant');
  const before = f.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
    .pluck().get(value.page.id, value.page.revision);
  await mount(f, 'workspace');
  await page.getByTestId('wiki-page-row').filter({hasText: 'UI scientific topic'}).click();
  await page.getByRole('button', {name: '后 10 节', exact: true}).click();
  const detail = page.getByTestId('wiki-page-detail'), section = detail.locator('section').filter({has: page.getByRole('heading', {name: 'UI results', exact: true})});
  await section.getByText('科研事实与原始来源', {exact: true}).click();
  await section.getByTestId('wiki-scientific-value').getByText('90', {exact: true}).waitFor();
  await section.getByRole('button', {name: '编辑章节', exact: true}).click();
  await page.getByRole('button', {name: '保存人工章节', exact: true}).click();
  await section.getByText('人工维护', {exact: true}).waitFor();
  let stored = (await f.wiki.readCurrent(f.project.id, value.page.id)).current.sections.find(item => item.id === 'results');
  assert.equal(stored.scientificStatements.length, 1); assert.deepEqual(stored.paperKnowledgeSources, [f.reference]);
  await section.getByRole('button', {name: '编辑章节', exact: true}).click();
  await page.getByLabel('章节正文', {exact: true}).fill('Human interpretation 090.00, not an automatically validated result.');
  await page.getByRole('button', {name: '保存人工章节', exact: true}).click();
  await section.getByTestId('wiki-section-body').getByText(/Human interpretation 090/u).waitFor();
  stored = (await f.wiki.readCurrent(f.project.id, value.page.id)).current.sections.find(item => item.id === 'results');
  assert.equal(stored.scientificStatements, undefined); assert.deepEqual(stored.paperKnowledgeSources, [f.reference]);
  assert.equal(f.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
    .pluck().get(value.page.id, value.page.revision), before);
});

test('existing claim Wiki opens an actual immutable Evidence source and rejects changed parse content', async () => {
  const f = await scene();
  const block = f.data.content.blocks.find(value => value.id === 'body');
  const chunk = f.db.prepare('SELECT id FROM research_knowledge_chunks WHERE content=? AND locator=?')
    .get(block.text, block.locator);
  assert.ok(chunk);
  const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: chunk.id});
  const snapshot = f.repository.evidence.wikiSnapshot(f.project.id);
  assert.ok(snapshot.sources[0].sourceLocator);
  snapshot.claims = [{id: 'ui-source-claim', content: 'Source-bound UI claim', evidenceIds: [evidence.id],
    status: 'hypothesis', version: 1}];
  await mount(f, 'claims', {snapshot});
  const toggle = page.getByText('完整摘录与原始来源', {exact: true});
  assert.equal(calls.filter(call => call.projectId === f.project.id && call.method === 'previewDocument').length, 0);
  await toggle.click();
  const original = page.getByTestId('artifact-document-source');
  await original.getByTestId('artifact-document-source-block').getByText(evidence.excerpt, {exact: true}).waitFor();
  await original.getByTestId('reader-pdf-canvas').waitFor();
  await page.screenshot({path: join(artifacts, 'evidence-source.png')});
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence').pluck().get(), 1);
  await toggle.click();
  await page.waitForFunction(() => window.liveWorkers === 0);
  f.corruptParse = true;
  await toggle.click();
  await original.getByTestId('error-blocked').getByText('保存的解析版本与返回内容不一致。', {exact: true}).waitFor();
  assert.equal(await original.getByTestId('artifact-document-source-block').count(), 0);
  assert.equal(f.repository.evidence.inspectEvidence(evidence.id, f.project.id).evidence.excerpt, evidence.excerpt);
});

test('light/dark, wide/narrow, keyboard focus and clip audit cover collapsed/expanded scientific surfaces', async () => {
  const f = await scene(); await page.getByRole('button', {name: '事实', exact: true}).click();
  await rows().filter({hasText: 'Reported F1'}).click(); await page.getByTestId('wiki-scientific-table').waitFor();
  const auditSource = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  for (const theme of ['light', 'dark']) for (const width of [380, 560, 1100]) {
    await page.setViewportSize({width, height: 850});
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.getByLabel('搜索科研知识').focus();
    assert.equal(await page.getByLabel('搜索科研知识').evaluate(input => {
      const rect = input.getBoundingClientRect(); return document.activeElement === input && rect.left >= 0 && rect.right <= innerWidth;
    }), true);
    if (width <= 680) {
      assert.equal(await rows().first().isVisible(), false);
      await page.getByRole('button', {name: '返回知识目录', exact: true}).click();
      await rows().first().hover();
      await rows().filter({hasText: 'Reported F1'}).click();
      await page.getByTestId('wiki-scientific-table').waitFor();
    } else await rows().first().hover();
    const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
    assert.equal(audit.cut, 0); assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
    await writeFile(join(artifacts, `${theme}-${width}.json`), JSON.stringify(audit));
    await page.screenshot({path: join(artifacts, `${theme}-${width}.png`)});
    await page.getByTestId('wiki-scientific-table').scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-${width}-table.png`)});
  }
  await page.setViewportSize({width: 1100, height: 850});
  await mount(f, 'graph');
  await page.getByRole('button', {name: '科研实体关系', exact: true}).click();
  await page.getByTestId('wiki-scientific-panel').waitFor(); await rows().first().waitFor();
});
