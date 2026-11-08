import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/knowledge-wiki');
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-wiki-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await build({stdin: {contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
    import {RagStudio} from './src/renderer/literature/RagStudio';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {KnowledgeJobs} from './src/renderer/literature/KnowledgeJobs';
    import {WikiView} from './src/renderer/literature/WikiView';
    const client = {api:{research:{
      listLibrary: async () => ({ok:true,data:[]}),
      getLibraryItem: async ({id}) => id === 'missing' ? ({ok:false,error:{message:'Item missing'}}) :
        ({ok:true,data:{id,metadata:{title:'Loaded outside library page'}}}),
      listDocuments: async () => ({ok:true,data:[]}),
      wikiSnapshot: async () => ({ok:true,data:{claims:[],sources:[],relations:[],papers:[]}}),
      onLibraryChanged: () => () => {}
    }}};
    function StoreHarness() {
      const store = useLiteratureStore(client, 'p1');
      window.store = store;
      return React.createElement('div', {id:'store-state'}, JSON.stringify({selected:store.selected,status:store.selectedStatus,error:store.selectedError}));
    }
    window.mountRag = () => {
      const list=async()=>({ok:true,data:[]});
      const client={api:{research:{knowledgeJobs:list,listIndexedFiles:list,listIndexJobs:list,
        getIndexStatus:async()=>({ok:false,error:{message:'Synthetic index unavailable'}}),
        searchKnowledge:async input=>{window.searchInput=input;return {ok:true,data:{query:input.query,hits:[],keywordCount:0,vectorCount:0,embeddingModel:null,generatedAt:'2026-11-08'}};}}}};
      flushSync(()=>root.render(React.createElement(WorkspaceScopeProvider,{value:{client,writable:true}},
        React.createElement(RagStudio,{literature:{client,projectId:'p1',action:{error:null}},openInFilesView(){},onOpenInReader(){}}))));
    };
    window.mountJobs = () => {
      let status='failed';
      const jobsClient={api:{research:{knowledgeJobs:async()=>({ok:true,data:[{documentId:'doc',generation:'v1',title:'Synthetic document',status,error:status==='failed'?'向量索引失败，请检查网络后重试。':null}]}),
        retryKnowledgeJob:async input=>{window.retried=input;status='ready';return {ok:true,data:{queued:true}};}}}};
      flushSync(()=>root.render(React.createElement(KnowledgeJobs,{client:jobsClient,projectId:'p1'})));
    };
    window.mountStore = () => flushSync(() => root.render(React.createElement(StoreHarness)));
    const root = createRoot(document.getElementById('root'));
    window.mount = props => flushSync(() => root.render(React.createElement(WikiView,
      {...props, onOpenClaim: id => window.opened = id, onOpenPaper: id => window.paper = id, onRefresh: () => window.refreshed = true})));
  `, resolveDir: process.cwd(), loader: 'js'}, outfile: join(directory, 'app.js'),
    bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}#root{height:100vh}</style>
    <div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow} = require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show:false,width:1100,height:720}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {if (directory) rmSync(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
function fixture() {
  const evidence = [{id:'e1', projectId:'p1', title:'Synthetic measured evidence', excerpt:'Original immutable excerpt.',
    locator:'results.csv:row:1', sourceType:'experiment', sourceId:'s1', chunkId:'chunk-1'}];
  const claims = [{id:'c1', content:'Synthetic supported declaration', evidenceIds:['e1'], status:'supported', version:1}];
  return {claims, evidence, libraryItems:[], snapshot:{claims, sources:evidence.map(evidence => ({evidence,
    referenceStatus:'recorded', invalidatedAt:null, sourceLocator:null})), relations:[]}};
}
test('Wiki renders current review and invalidation honestly, and refresh and graph remain keyboard accessible', async () => {
  const props = fixture();
  const mount = () => page.evaluate(props => window.mount(props), props);
  await mount();
  const body = page.locator('[data-testid="wiki-body"]');
  assert.match(await body.innerText(), /待人工审核/u);
  props.snapshot.relations = [{id:'r1',claimId:'c1',claimVersion:1,evidenceId:'e1',kind:'qualifies',status:'confirmed',
    condition:'Only for this sample',reviewer:{id:'Synthetic reviewer',kind:'user'}}];
  await mount();
  assert.match(await body.innerText(), /人工确认有条件支持/u);
  assert.match(await body.innerText(), /Only for this sample/u);
  props.snapshot.relations[0].kind = 'contradicts';
  await mount();
  assert.match(await body.innerText(), /存在已确认反对/u);
  props.snapshot.relations[0].status = 'invalidated';
  props.snapshot.sources[0].referenceStatus = 'superseded';
  await mount();
  assert.match(await body.innerText(), /来源或审核已失效/u);
  assert.match(await body.innerText(), /Original immutable excerpt/u);
  assert.match(await body.innerText(), /来源已失效，保留历史摘录/u);
  await page.locator('[data-testid="wiki-refresh"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.refreshed), true);
  await page.locator('[data-testid="wiki-page-graph-c1"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.opened), 'c1');
  const auditSource = readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1100, 800]) {
      await page.setViewportSize({width,height:720});
      await page.locator('[data-testid="wiki-refresh"]').hover();
      const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      writeFileSync(join(artifacts, `review-${theme}-${width}.json`), JSON.stringify(audit));
      assert.equal(audit.cut, 0);
      assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
      await page.screenshot({path:join(artifacts, `review-${theme}-${width}.png`)});
    }
  }
});

test('PDF paper navigation and publication years survive an empty filtered library list', async () => {
  const props = fixture();
  props.evidence[0].sourceType = 'file';
  props.snapshot.papers = [{evidenceId:'e1',libraryItemId:'paper-1',title:'Associated managed PDF',year:2025}];
  await page.evaluate(props => window.mount(props), props);
  assert.match(await page.locator('[data-testid="wiki-timeline"]').innerText(), /2025/u);
  await page.locator('[data-testid="wiki-page-paper-paper-1"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.paper), 'paper-1');
});

test('the reader selection loads by ID independently of a filtered or capped library list and exposes errors', async () => {
  await page.evaluate(() => window.mountStore());
  await page.waitForFunction(() => window.store.status === 'ready');
  await page.evaluate(() => window.store.select('outside-page'));
  await page.waitForFunction(() => window.store.selected?.id === 'outside-page');
  assert.equal(await page.evaluate(() => window.store.items.length), 0);
  await page.evaluate(() => window.store.select('missing'));
  await page.waitForFunction(() => window.store.selectedStatus === 'error');
  assert.equal(await page.evaluate(() => window.store.selected), null);
  assert.equal(await page.evaluate(() => window.store.selectedError), 'Item missing');
});

test('large Wiki lists and shared neighborhoods are paged, searchable and navigable without mounting a clique', async () => {
  const props = fixture();
  props.claims = Array.from({length:1000}, (_,i) => ({...props.claims[0],id:`c-${i}`,content:`Concept ${i}`}));
  props.snapshot.claims = props.claims;
  await page.evaluate(props => window.mount(props), props);
  const list = page.locator('[data-testid="wiki-concept-list"]');
  assert.equal(await list.locator('li').count(),50);
  assert.equal(await page.locator('[data-testid="wiki-backlinks"] li').count(),50);
  await page.locator('[data-testid="wiki-pager-neighbors"]').getByText('下一页').focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('[data-testid="wiki-pager-neighbors"]').innerText(), /51–100 \/ 999/u);
  await page.locator('[data-testid="wiki-backlinks"]').getByRole('button', {name:'Concept 100',exact:true}).click();
  assert.equal(await page.locator('[data-testid="wiki-page-title-c-100"]').innerText(),'Concept 100');
  assert.equal(await page.locator('[data-testid="wiki-concept-c-100"]').getAttribute('aria-current'),'true');
  await page.locator('[data-testid="wiki-search"]').fill('Concept 999');
  assert.equal(await list.locator('li').count(),1);
  assert.equal(await page.locator('[data-testid="wiki-page-title-c-999"]').innerText(),'Concept 999');
});

test('source embedding jobs expose errors and keyboard retry refreshes status',async()=>{
  await page.evaluate(()=>window.mountJobs());
  const panel=page.getByTestId('rag-source-jobs');
  await panel.getByText('向量索引失败，请检查网络后重试。').waitFor();
  await panel.getByRole('button',{name:'重试',exact:true}).focus();await page.keyboard.press('Enter');
  await panel.getByText('Synthetic document · 已完成').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.retried),{documentId:'doc',generation:'v1'});
  await page.screenshot({path:join(artifacts,'embedding-jobs.png')});
});

test('retrieval exposes optional reranking and sends the selected mode through IPC',async()=>{
  await page.evaluate(()=>window.mountRag());
  await page.getByLabel('排序方式').selectOption('lexical-v1');
  await page.getByTestId('rag-query').fill('注意力机制');
  await page.getByTestId('rag-search').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.searchInput?.rerank==='lexical-v1');
  assert.equal(await page.evaluate(()=>window.searchInput.limit),20);
});
