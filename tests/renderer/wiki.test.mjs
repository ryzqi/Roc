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
        searchKnowledge:async input=>{window.searchInput=input;return {ok:true,data:{query:input.query,hits:[],keywordCount:0,vectorCount:0,embeddingModel:null,generatedAt:'2026-11-08',ranking:{degradation:'rate_limit'}}};}}}};
      flushSync(()=>root.render(React.createElement(WorkspaceScopeProvider,{value:{client,writable:true}},
        React.createElement(RagStudio,{literature:{client,projectId:'p1',action:{error:null}},openInFilesView(){},onOpenInReader(){}}))));
    };
    window.mountIndexedRag = () => {
      const path='notes/narrow-canvas-review/long-reference-list-and-measured-results-for-the-current-index-generation.md';
      const timestamp='2026-11-12T16:35:54.960Z';
      const error='索引服务暂不可用（synthetic_runtime_fixture_with_long_error_code）';
      const status={phase:'failed',generation:2,workspacePath:'/tmp/roc-index-layout-fixture',
        error:null,lastScanAt:timestamp,counts:{total:1,ready:0,queued:0,running:0,failed:1},
        settings:{projectId:'p1',revision:7,kinds:['markdown'],include:['**/*'],exclude:[],
          watch:true,paused:false,embeddingConfigId:null}};
      const file={id:'layout-file',projectId:'p1',path,kind:'markdown',size:120,status:'failed',
        sourceHash:null,indexedHash:null,textIndexed:false,error,activeJobId:'layout-job',updatedAt:timestamp};
      const job={id:'layout-job',projectId:'p1',fileId:file.id,path,generation:2,status:'failed',
        error,createdAt:timestamp,startedAt:timestamp,finishedAt:timestamp};
      window.indexLayoutFixture={path,timestamp,error,controls:[]};
      const client={api:{research:{
        knowledgeJobs:async()=>({ok:true,data:[]}),
        listIndexedFiles:async()=>({ok:true,data:[file]}),
        listIndexJobs:async()=>({ok:true,data:[job]}),
        getIndexStatus:async()=>({ok:true,data:status}),
        controlIndex:async input=>{window.indexLayoutFixture.controls.push(input);return {ok:true,data:status};}
      }}};
      flushSync(()=>root.render(React.createElement(WorkspaceScopeProvider,{value:{client,writable:true}},
        React.createElement(RagStudio,{literature:{client,projectId:'p1',action:{error:null}},
          openInFilesView(){},onOpenInReader(){}}))));
    };
    window.mountJobs = () => {
      let status='failed';
      const jobsClient={api:{research:{knowledgeJobs:async()=>({ok:true,data:[{documentId:'doc',generation:'v1',title:'Synthetic document',status,error:status==='failed'?'向量索引失败，请检查网络后重试。':null}]}),
        retryKnowledgeJob:async input=>{window.retried=input;status='ready';return {ok:true,data:{queued:true}};}}}};
      flushSync(()=>root.render(React.createElement(KnowledgeJobs,{client:jobsClient,projectId:'p1'})));
    };
    window.mountHeldJobs = () => {
      const fixture={status:'failed',inputs:[],releases:[]};
      window.heldJobs=fixture;
      const jobsClient={api:{research:{
        knowledgeJobs:async()=>({ok:true,data:[{documentId:'held-doc',generation:'held-v1',
          title:'Held document',status:fixture.status,error:null}]}),
        retryKnowledgeJob:input=>{
          fixture.inputs.push(input);
          return new Promise(resolve=>fixture.releases.push(result=>{
            if(result.ok)fixture.status='ready';
            resolve(result);
          }));
        }
      }}};
      flushSync(()=>root.render(React.createElement(KnowledgeJobs,{client:jobsClient,projectId:'p1'})));
    };
    window.mountStore = () => flushSync(() => root.render(React.createElement(StoreHarness)));
    const root = createRoot(document.getElementById('root'));
    window.unmount=()=>flushSync(()=>root.render(null));
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
  const job=panel.getByRole('listitem').filter({hasText:'Synthetic document'});
  await job.getByText('已完成',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.retried),{documentId:'doc',generation:'v1'});
  await page.screenshot({path:join(artifacts,'embedding-jobs.png')});
});

test('source embedding retry admits one synchronous request, retains a refusal and unlocks an exact retry',async()=>{
  await page.evaluate(()=>window.mountHeldJobs());
  const panel=page.getByTestId('rag-source-jobs');
  const retry=panel.getByRole('button',{name:'重试',exact:true});
  await retry.waitFor();
  try {
    await page.evaluate(()=>{
      const button=document.querySelector('[data-testid="rag-source-jobs"] li button');
      button.click();button.click();button.click();
    });
    assert.deepEqual(await page.evaluate(()=>window.heldJobs.inputs),[{documentId:'held-doc',generation:'held-v1'}]);
    assert.equal(await retry.isDisabled(),true);
    await page.evaluate(()=>window.heldJobs.releases.shift()({ok:false,error:{message:'Synthetic generation retry refused'}}));
    await panel.getByRole('alert').filter({hasText:'Synthetic generation retry refused'}).waitFor();
    assert.equal(await retry.isDisabled(),false);
    await retry.focus();await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(()=>window.heldJobs.inputs),[
      {documentId:'held-doc',generation:'held-v1'},{documentId:'held-doc',generation:'held-v1'}
    ]);
    await page.evaluate(()=>window.heldJobs.releases.shift()({ok:true,data:{queued:true}}));
    await panel.getByRole('listitem').filter({hasText:'Held document'}).getByText('已完成',{exact:true}).waitFor();
    assert.equal(await panel.getByRole('alert').count(),0);
  } finally {
    await page.evaluate(()=>{
      for(const release of window.heldJobs.releases.splice(0))release({ok:false,error:{message:'Fixture disposed'}});
      window.unmount();
    });
  }
});

test('retrieval exposes optional reranking and sends the selected mode through IPC',async()=>{
  await page.evaluate(()=>window.mountRag());
  await page.getByLabel('排序方式').selectOption('semantic');
  await page.getByTestId('rag-query').fill('注意力机制');
  await page.getByTestId('rag-search').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.searchInput?.rerank==='semantic');
  assert.equal(await page.evaluate(()=>window.searchInput.limit),20);
  await page.getByTestId('rag-degraded').getByText(/仅返回关键词结果/).waitFor();
});

test('indexed retrieval isolates table scrolling and keeps long paths, failure details and keyboard retry readable in narrow panes',async()=>{
  const auditSource=readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
  const measurements=[];
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{window.unmount();window.mountIndexedRag();});
  await page.getByTestId('rag-file-layout-file').waitFor();
  await page.getByTestId('rag-job-layout-job').waitFor();
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [1100,380]){
      await page.setViewportSize({width,height:720});
      const measurement=await page.evaluate(()=>{
        const studio=document.querySelector('[data-testid="rag-studio"]');
        const pane=studio.lastElementChild;
        const table=document.querySelector('[data-testid="rag-files"]');
        const file=document.querySelector('[data-testid="rag-file-layout-file"]');
        const filePath=file.cells[0];
        const fileStatus=file.cells[2];
        const job=document.querySelector('[data-testid="rag-job-layout-job"]');
        const path=Array.from(job.querySelectorAll('span')).find(el=>el.textContent===window.indexLayoutFixture.path);
        const pathRect=path.getBoundingClientRect();
        const metadata=Array.from(job.querySelectorAll('span')).find(el=>el.textContent.includes('gen '));
        const metadataRect=metadata.getBoundingClientRect();
        return {paneWidth:pane.clientWidth,paneScrollWidth:pane.scrollWidth,
          tableWidth:table.getBoundingClientRect().width,
          tableParentOverflow:getComputedStyle(table.parentElement).overflowX,
          filePathHasFullText:filePath.scrollWidth<=filePath.clientWidth+1,
          fileErrorFitsCell:fileStatus.scrollWidth<=fileStatus.clientWidth+1,
          pathWidth:pathRect.width,pathHasFullText:path.scrollWidth<=path.clientWidth+1,
          pathHasTitle:path.title===window.indexLayoutFixture.path,
          pathMetadataOverlap:pathRect.left<metadataRect.right&&pathRect.right>metadataRect.left&&
            pathRect.top<metadataRect.bottom&&pathRect.bottom>metadataRect.top,
          viewportScrollWidth:document.documentElement.scrollWidth};
      });
      const clip=await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      measurements.push({theme,width,...measurement,clip});
      await page.getByTestId('rag-files').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(artifacts,`index-table-${theme}-${width}.png`)});
      await page.getByTestId('rag-job-layout-job').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(artifacts,`index-job-${theme}-${width}.png`)});
    }
  }
  writeFileSync(join(artifacts,'index-layout.json'),JSON.stringify(measurements,null,2));
  for(const measurement of measurements){
    const label=`${measurement.theme}/${measurement.width}`;
    assert.ok(measurement.paneScrollWidth<=measurement.paneWidth+1,`${label}: the index pane must not scroll horizontally`);
    assert.ok(measurement.viewportScrollWidth<=measurement.width,`${label}: the viewport must not scroll horizontally`);
    assert.ok(measurement.pathWidth>0,`${label}: the job path must retain visible space`);
    assert.ok(measurement.pathHasFullText,`${label}: the full job path must be readable without hovering`);
    assert.ok(measurement.filePathHasFullText,`${label}: the table path must wrap inside its cell`);
    assert.ok(measurement.fileErrorFitsCell,`${label}: the failure details must wrap inside their cell`);
    assert.equal(measurement.pathMetadataOverlap,false,`${label}: the path and generation must occupy separate space`);
    assert.equal(measurement.clip.cut,0,`${label}: focus and surface shadows must survive clipping`);
    if(measurement.tableWidth>measurement.paneWidth){
      assert.match(measurement.tableParentOverflow,/auto|scroll/u,`${label}: only the table owns its horizontal scrolling`);
    }
  }
  const region=page.getByRole('region',{name:'已索引文件',exact:true});
  await region.focus();
  const scrollBefore=await region.evaluate(el=>el.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.activeElement?.scrollLeft>0);
  assert.ok(await region.evaluate(el=>el.scrollLeft)>scrollBefore);
  const fixture=await page.evaluate(()=>window.indexLayoutFixture);
  const file=page.getByTestId('rag-file-layout-file');
  assert.equal(await file.locator('td').first().getAttribute('title'),fixture.path);
  assert.match(await file.innerText(),/synthetic_runtime_fixture_with_long_error_code/u);
  const retry=page.getByTestId('rag-job-retry-layout-job');
  await retry.focus();
  assert.equal(await retry.evaluate(el=>document.activeElement===el),true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.indexLayoutFixture.controls.length===1);
  assert.deepEqual(await page.evaluate(()=>window.indexLayoutFixture.controls),[
    {projectId:'p1',action:'retry',fileId:'layout-file',expectedRevision:7}
  ]);
  await page.evaluate(()=>window.unmount());
});

test('copied Markdown keeps declaration separate from human review status',async()=>{
  await page.evaluate(props=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedWiki=text;}}});window.mount(props);},fixture());
  await page.getByTestId('wiki-copy-markdown').click();await page.waitForFunction(()=>typeof window.copiedWiki==='string');
  const markdown=await page.evaluate(()=>window.copiedWiki);
  assert.match(markdown,/声明状态：声明有支撑/);assert.match(markdown,/审核状态：待人工审核/);
});
