import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-retrieval-workspace-'));
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {RagStudio} from './src/renderer/literature/RagStudio';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    import {researchKnowledgeSearchResultSchema} from './src/shared/schemas/research';
    const root=createRoot(document.getElementById('root'));
    let session=0;
    function Retained({children}) {
      const [active,setActive]=useState(true);
      window.setRetrievalActive=value=>flushSync(()=>setActive(value));
      return <><button data-testid="outside-retrieval" style={{position:'fixed',top:0,right:0}}>Other workspace</button>
        <ViewActivity active={active}><div hidden={!active} style={{height:'100%'}}>{children}</div></ViewActivity></>;
    }
    window.mount=()=>{
      window.calls={files:0,jobs:0,sourceJobs:0,search:[],opened:[],selected:[],notes:[],evidence:[],controls:[],questions:[]};
      window.emptyResults=false;
      window.failSearch=false;
      window.holdAssistant=false;
      const status={phase:'idle',generation:2,workspacePath:'/tmp/synthetic-retrieval',error:null,lastScanAt:null,
        counts:{total:2,ready:2,queued:0,running:0,failed:0},
        settings:{projectId:'p1',revision:7,kinds:['markdown'],include:['**/*'],exclude:[],watch:true,paused:false,embeddingConfigId:null}};
      const client={api:{research:{
        getIndexStatus:async()=>({ok:true,data:status}),
        listIndexedFiles:async()=>{window.calls.files++;return {ok:true,data:[]};},
        listIndexJobs:async()=>{window.calls.jobs++;return {ok:true,data:[]};},
        knowledgeJobs:async()=>{window.calls.sourceJobs++;return {ok:true,data:[]};},
        controlIndex:async input=>{window.calls.controls.push(input);return {ok:true,data:status};},
        searchKnowledge:async input=>{window.calls.search.push(input);if(window.failSearch)return {ok:false,error:{message:'Synthetic retrieval failure'}};return {ok:true,data:researchKnowledgeSearchResultSchema.parse({
          query:input.query,hits:window.emptyResults?[]:[
            {chunkId:'paper-hit',documentId:'document:parse-one',sourceId:'paper-one',sourceType:'literature',
              title:'Attention methods: '+ 'A long scientific title '.repeat(5),
              content:'The energy relation is $E=mc^2$. '+ 'Evidence from the measured scientific experiment. '.repeat(28),
              locator:'page:2',semantic:null,rrfScore:0.035,keywordRank:1,vectorRank:2},
            {chunkId:'file-hit',documentId:'project-index:file-one',sourceId:'notes/experiment.md',sourceType:'file',
              title:'Experiment notes',content:'A concise observation.',locator:null,semantic:null,rrfScore:0.02,keywordRank:2,vectorRank:null},
            {chunkId:'note-hit',documentId:'note:note-one',sourceId:'note-one',sourceType:'note',
              title:'Knowledge note',content:'A recorded observation.',locator:null,semantic:null,rrfScore:0.01,keywordRank:3,vectorRank:null}
          ],keywordCount:2,vectorCount:1,embeddingModel:null,generatedAt:'2026-11-20T12:00:00.000Z',
          ranking:{schemaVersion:3,ranker:'rrf-v1-k60',candidateLimit:80,route:{intent:'general',documentId:null,diversify:false},
            reranker:{status:'not_requested',model:null,configHash:null,elapsedMs:0},degradation:null,inputHash:'0'.repeat(64),
            projectId:'p1',limit:20,embedding:null,coverage:{keyword:'results',vector:'not_searched'},candidates:[]}
        })};}
      }}};
      const literature={client,projectId:'p1',status:'ready',items:[],assistant:{pending:false,error:null,threadId:null},action:{error:null,pending:false},
        select:id=>window.calls.selected.push(id),clearActionError:()=>{},
        askAssistant:async prompt=>{window.calls.questions.push(prompt);if(window.holdAssistant)await new Promise(resolve=>{window.finishAssistant=resolve;});},
        captureChunkEvidence:async id=>{window.calls.evidence.push(id);return true;},
        saveKnowledgeNote:async input=>{window.calls.notes.push(input);return true;}};
      const scope={client,projectId:'p1',writable:true,workspacePath:'/tmp/synthetic-retrieval',openSettings:()=>{}};
      flushSync(()=>root.render(<Retained key={++session}><WorkspaceScopeProvider value={scope}><RagStudio literature={literature}
        openInFilesView={path=>window.calls.opened.push({path})} onOpenInReader={target=>window.calls.opened.push(target)}/></WorkspaceScopeProvider></Retained>));
    };
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedText=text;}}});
    window.mount();
  `, style:'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink)}'});
  await writeFile(join(directory,'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:760}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.getByTestId('rag-query').waitFor();
});
after(async()=>{
  try {await app?.close();} finally {if(directory)await rm(directory,{recursive:true,force:true});}
});

test('query is primary, management loads on demand and returning keeps search results and focus',async()=>{
  assert.deepEqual(await page.evaluate(()=>[window.calls.files,window.calls.jobs,window.calls.sourceJobs]),[0,0,0]);
  await expect(page.getByTestId('rag-index-panel')).toHaveCount(0);
  await page.getByTestId('rag-search-options').locator('summary').click();
  await page.getByRole('radio',{name:'关键词与语义融合'}).check();
  await page.getByTestId('rag-search-options').locator('summary').click();
  await page.getByTestId('rag-query').fill('attention energy');
  await page.getByTestId('rag-query').press('Enter');
  await expect(page.getByTestId('rag-hit-paper-hit')).toBeVisible();
  await expect(page.getByTestId('rag-hit-paper-hit').locator('.katex').first()).toBeVisible();
  assert.equal(await page.evaluate(()=>window.calls.search[0].rerank),'none');
  await page.waitForFunction(()=>window.calls.questions.length===1);
  assert.match(await page.evaluate(()=>window.calls.questions[0]),/attention energy/);
  assert.match(await page.evaluate(()=>window.calls.questions[0]),/parse-one/);
  await expect(page.getByTestId('rag-availability')).toContainText('工作区文件可检索 2 个');
  await page.getByTestId('rag-index-toggle').click();
  await expect(page.getByRole('button',{name:'返回检索'})).toBeFocused();
  await page.waitForFunction(()=>window.calls.files===1&&window.calls.jobs===1&&window.calls.sourceJobs===1);
  await page.getByTestId('rag-scan').click();
  assert.deepEqual(await page.evaluate(()=>window.calls.controls),[{projectId:'p1',action:'scan',expectedRevision:7}]);
  await page.getByRole('button',{name:'返回检索'}).click();
  await expect(page.getByTestId('rag-query')).toHaveValue('attention energy');
  await expect(page.getByTestId('rag-query')).toBeFocused();
  await expect(page.getByTestId('rag-hit-paper-hit')).toBeVisible();
  assert.equal(await page.evaluate(()=>window.calls.search.length),1);
});

test('source actions preserve parse and locator identity and support both paper and file hits',async()=>{
  await expect(page.getByTestId('rag-hit-open-note-hit')).toHaveCount(0);
  await expect(page.getByTestId('rag-hit-note-hit')).toContainText('此来源暂无可定位原文');
  await page.getByTestId('rag-hit-open-paper-hit').click();
  await page.getByTestId('rag-hit-open-file-hit').click();
  const opened=await page.evaluate(()=>window.calls.opened);
  assert.deepEqual(await page.evaluate(()=>window.calls.selected),[],'reader navigation owns selection atomically');
  assert.equal(opened[0].parseId,'parse-one');
  assert.equal(opened[0].libraryItemId,'paper-one');
  assert.equal(opened[0].locator,'page:2');
  assert.match(opened[0].text,/energy relation/u);
  assert.deepEqual(opened[1],{path:'notes/experiment.md'});
  await page.getByTestId('rag-hit-copy-file-hit').click();
  assert.equal(await page.evaluate(()=>window.copiedText),'A concise observation.');
  await page.getByTestId('rag-hit-capture-file-hit').click();
  await page.getByTestId('rag-hit-save-file-hit').click();
  assert.deepEqual(await page.evaluate(()=>window.calls.evidence),['file-hit']);
  assert.equal(await page.evaluate(()=>window.calls.notes[0].sourceId),'file-hit');
});

test('question submission stays locked until assistant handoff and preserves evidence for the question',async()=>{
  await page.evaluate(()=>{window.holdAssistant=true;});
  await page.getByTestId('rag-query').press('Enter');
  await page.waitForFunction(()=>window.calls.questions.length===2);
  await expect(page.getByTestId('rag-ask')).toBeDisabled();
  await page.getByTestId('rag-query').press('Enter');
  assert.equal(await page.evaluate(()=>window.calls.questions.length),2);
  await page.evaluate(()=>{window.finishAssistant();window.holdAssistant=false;});
  await expect(page.getByTestId('rag-ask')).toBeEnabled();
  await expect(page.getByTestId('rag-query')).toHaveValue('attention energy');
  await expect(page.getByTestId('rag-hit-paper-hit')).toBeVisible();
});

test('evidence directory follows keyboard selection, preserves the question and never assigns support', async () => {
  const sidebar = page.getByTestId('rag-evidence-sidebar');
  await expect(sidebar).toContainText('检索命中，支持关系待核验');
  const bounds = await sidebar.boundingBox();
  const results = await page.getByTestId('rag-results').boundingBox();
  assert.ok(bounds.x >= results.x + results.width - 1);
  assert.ok(bounds.width / (bounds.width + results.width) >= 0.29);
  await page.getByTestId('rag-evidence-file-hit').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('rag-hit-file-hit')).toBeFocused();
  await expect(page.getByTestId('rag-evidence-file-hit')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('rag-query')).toHaveValue('attention energy');
  await page.setViewportSize({width: 420, height: 720});
  const toggle = sidebar.getByRole('button', {name: '证据目录（3 条）', exact: true});
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('rag-evidence-paper-hit')).toBeHidden();
  await toggle.click();
  await page.getByTestId('rag-evidence-paper-hit').click();
  await expect(page.getByTestId('rag-hit-paper-hit')).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({width: 1100, height: 760});
});

test('failed retrieval keeps the last evidence and its original query visible', async () => {
  await page.evaluate(() => {window.failSearch = true;});
  await page.getByTestId('rag-query').fill('a different question');
  await page.getByTestId('rag-search').click();
  await expect(page.getByTestId('rag-search-error')).toContainText('Synthetic retrieval failure');
  await expect(page.getByTestId('rag-results')).toContainText('attention energy');
  await expect(page.getByTestId('rag-hit-paper-hit')).toBeVisible();
  await expect(page.getByTestId('rag-evidence-paper-hit')).toHaveAttribute('aria-current', 'true');
  await page.evaluate(() => {window.failSearch = false;});
  await page.getByTestId('rag-query').fill('attention energy');
  await page.getByTestId('rag-search').click();
  await expect(page.getByTestId('rag-search-error')).toHaveCount(0);
});

test('hidden retrieval releases readonly markup while retaining query, selection, expansion, details and scroll', async () => {
  await page.setViewportSize({width:1100,height:760});
  await page.getByTestId('rag-evidence-file-hit').click();
  await page.getByTestId('rag-hit-paper-hit').getByRole('button',{name:'展开原文',exact:true}).click();
  await page.getByTestId('rag-result-details').locator('summary').click();
  await page.getByTestId('rag-hit-paper-hit').locator('.rag-hit-ranking summary').click();
  const top=await page.getByTestId('rag-results').evaluate(node=>{node.scrollTop=160;return node.scrollTop;});
  assert.ok(top>0);
  const before=await page.evaluate(()=>window.calls.search.length);
  await page.evaluate(()=>window.setRetrievalActive(false));
  await expect(page.getByTestId('rag-hits')).toHaveCount(0);
  await expect(page.getByTestId('rag-evidence-file-hit')).toHaveCount(0);
  await page.getByTestId('outside-retrieval').focus();
  await page.evaluate(()=>window.setRetrievalActive(true));
  await expect(page.getByTestId('rag-hit-paper-hit').locator('.katex').first()).toBeVisible();
  await expect(page.getByTestId('rag-hit-paper-hit').getByRole('button',{name:'收起原文',exact:true})).toBeVisible();
  await expect(page.getByTestId('rag-evidence-file-hit')).toHaveAttribute('aria-current','true');
  await expect(page.getByTestId('rag-result-details')).toHaveAttribute('open','');
  await expect(page.getByTestId('rag-hit-paper-hit').locator('.rag-hit-ranking')).toHaveAttribute('open','');
  await expect.poll(()=>page.getByTestId('rag-results').evaluate(node=>node.scrollTop)).toBe(top);
  await expect(page.getByTestId('outside-retrieval')).toBeFocused();
  await expect(page.getByTestId('rag-query')).toHaveValue('attention energy');
  assert.equal(await page.evaluate(()=>window.calls.search.length),before);
  await page.getByTestId('rag-hit-paper-hit').getByRole('button',{name:'收起原文',exact:true}).click();
  await page.getByTestId('rag-result-details').locator('summary').click();
});

test('search results retain usable space in narrow and wide canvases with both themes',async()=>{
  const auditSource=await readFile('scripts/ui-audit/clip-audit.js','utf8');
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [1100,420]){
      await page.setViewportSize({width,height:720});
      await page.getByTestId('rag-query').click();
      const geometry=await page.evaluate(()=>{
        const results=document.querySelector('[data-testid="rag-results"]');
        const query=document.querySelector('[data-testid="rag-query"]');
        return {resultsHeight:results.clientHeight,resultsWidth:results.clientWidth,scrollWidth:results.scrollWidth,
          queryWidth:query.getBoundingClientRect().width,viewportWidth:document.documentElement.scrollWidth};
      });
      assert.ok(geometry.resultsHeight>420,`${theme}/${width}: results need useful vertical space`);
      assert.ok(geometry.queryWidth>200,`${theme}/${width}: query remains usable`);
      assert.ok(geometry.scrollWidth<=geometry.resultsWidth+1);
      assert.ok(geometry.viewportWidth<=width);
      await page.getByTestId('rag-hit-open-paper-hit').hover();
      let audit=await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      assert.equal(audit.cut,0,`${theme}/${width}: hover clipping`);
      const expand=page.getByTestId('rag-hit-paper-hit').getByRole('button',{name:'展开原文'});
      await expand.click();
      const content=page.getByTestId('rag-hit-content-paper-hit');
      assert.equal(await content.evaluate(el=>el.scrollHeight<=el.clientHeight+1),true);
      audit=await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      assert.equal(audit.cut,0,`${theme}/${width}: expanded clipping`);
      await page.getByTestId('rag-hit-paper-hit').getByRole('button',{name:'收起原文'}).click();
      if(process.env.ROC_UI_CAPTURE_DIR)await page.screenshot({path:join(process.env.ROC_UI_CAPTURE_DIR,`retrieval-${theme}-${width}.png`)});
    }
  }
  assert.deepEqual(errors,[]);
});

test('empty results give a next step without exposing technical diagnostics by default',async()=>{
  await page.evaluate(()=>{window.emptyResults=true;});
  await page.getByTestId('rag-query').fill('no matching result');
  await page.getByTestId('rag-search').click();
  await expect(page.getByTestId('rag-no-hits')).toContainText('管理索引');
  await expect(page.getByTestId('rag-search-meta')).toBeHidden();
  assert.deepEqual(errors,[]);
});
