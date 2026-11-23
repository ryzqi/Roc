import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-literature-workspace-'));
  await buildViteRenderer({directory, plugins: [tailwindcss(), {
    name: 'knowledge-lifecycle-probes',
    enforce: 'pre',
    transform(source, id) {
      const entry = id.match(/\/(WikiWorkspace|KnowledgeGraphView)\.tsx$/u)?.[1];
      if (entry) return {code: `globalThis.knowledgeModuleLoads ??= []; globalThis.knowledgeModuleLoads.push('${entry}');\n${source}`, map: null};
      if (id.endsWith('/derive-graph.ts')) return {code: source.replace('): KnowledgeGraph {',
        '): KnowledgeGraph { globalThis.graphDerivations = (globalThis.graphDerivations ?? 0) + 1;'), map: null};
      return null;
    }
  }], script: `
    import React,{useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LiteratureHubView} from './src/renderer/literature/LiteratureHubView';
    import {LibraryList} from './src/renderer/literature/LibraryList';
    import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
    import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import {ViewActivity} from './src/renderer/shared/view-activity';
    import './src/renderer/styles/index.css';
    const ok=data=>({ok:true,data});
    const item={id:'paper',revision:1,archived:false,projectIds:['fixture'],updatedAt:'2026-11-20T00:00:00.000Z',
      metadata:{title:'Understanding how scientific evidence supports a research claim',authors:['Fixture Author'],publishedYear:2026,citationCount:null,doi:null,url:null,openAccessUrl:null,source:'local'},
      bibliography:{title:'Understanding scientific evidence',citationKey:'fixture2026',fields:{}}};
    const second={...item,id:'second',metadata:{...item.metadata,title:'Second paper for navigation'}};
    const paperDocument={id:'document',libraryItemId:'paper',filename:'scientific-evidence.pdf',mediaType:'application/pdf',status:'ready',sourceHash:'source',currentParseId:'parse',activeParseId:null};
    const blocks=[{id:'heading',kind:'heading',label:'Introduction',text:'Evidence and understanding',locator:'page:1',locations:[],imageAssetId:null},
      {id:'paragraph',kind:'paragraph',label:'Introduction',text:'A useful reading workspace keeps the paper in focus. '.repeat(100),locator:'page:1',locations:[],imageAssetId:null}];
    const client={api:{research:{
      listLibraryPage:async()=>ok({items:[item,second],total:2,hasMore:false,nextCursor:null}),wikiSnapshot:async()=>ok({claims:[],sources:[]}),
      getModelsStatus:async()=>ok({ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}),
      listAcquisition:async()=>ok({jobs:[],total:0,nextOffset:null}),onLibraryChanged:()=>()=>{},
      resolveDocumentParse:async()=>ok(paperDocument),
      listReadingNotes:async()=>ok([]),searchWiki:async()=>ok({pages:[],nextOffset:null,mode:'keyword',degradation:null}),
      knowledgeJobs:async()=>ok([]),listIndexedFiles:async()=>ok([]),listIndexJobs:async()=>ok([]),
      getIndexStatus:async()=>ok({phase:'idle',generation:1,error:null,workspacePath:'/synthetic',lastScanAt:null,
        counts:{total:0,ready:0,queued:0,running:0,failed:0},settings:{revision:1,projectId:'fixture',paused:false,watch:false,kinds:[],include:[],exclude:[],embeddingConfigId:null}}),
      searchKnowledge:async input=>ok({query:input.query,hits:[{chunkId:'source-hit',documentId:'document:parse',sourceId:'paper',sourceType:'literature',
        title:item.metadata.title,content:'Evidence and understanding',locator:'page:1',rrfScore:0.03,keywordRank:1,vectorRank:null}],
        keywordCount:1,vectorCount:0,embeddingModel:null,generatedAt:'2026-11-23T00:00:00.000Z',ranking:{degradation:null,reranker:{status:'not_requested'}}})
    }}};
    const scope={client,projectId:'fixture',workspacePath:'/synthetic',writable:true,workspaceStatus:'ready',workspaceError:null,openFileInCanvas(){}};
    function Harness(){
      const sharedStore=useLiteratureStore(client,'fixture');
      const [selectedId,setSelected]=useState('paper');
      const [view,setView]=useState('library');
      const [hubMounted,setHubMounted]=useState(true);
      const [hubActive,setHubActive]=useState(true);
      const [contextDrawerOpen,setContextDrawerOpen]=useState(false);
      const [literatureRequest,setLiteratureRequest]=useState(null);
      const requestNonce=useRef(0);
      window.selectWorkspace=setView;
      window.setHubMounted=setHubMounted;
      window.setHubActive=setHubActive;
      window.requestImport=sharedStore.requestImport;
      window.setContextDrawerOpen=setContextDrawerOpen;
      const openLiterature=target=>{
        if(target.kind==='reader')setSelected(target.libraryItemId??selectedId);
        setView(target.kind==='concept'?'knowledge':'library');
        setLiteratureRequest({projectId:'fixture',nonce:++requestNonce.current,target});
      };
      window.openObject=openLiterature;
      const selected=selectedId==='paper'?item:second;
      const store={...sharedStore,client,projectId:'fixture',items:[item,second],selected,selectedId,documents:selectedId==='paper'?[paperDocument]:[],
        status:'ready',selectedStatus:'ready',query:'',includeArchived:false,
        claims:Array.from({length:3},(_,i)=>({id:'c-'+i,content:'Claim '+i,status:'supported',evidenceIds:['shared']})),
        evidence:[{id:'shared',title:'Shared evidence',locator:'page:1',sourceType:'file',sourceId:'unloaded'}],derivedStatus:'ready',derivedError:null,
        action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null,
        select:(id,whenReady)=>whenReady?whenReady(()=>setSelected(id)):setSelected(id),reload(){},reloadDocuments(){},reloadDerived(){},setQuery(){},setIncludeArchived(){},
        loadDocumentContent:async()=>ok({run:{id:'parse',documentId:'document'},content:{sourceHash:'source',pageCount:1,parseMode:'native-text',warnings:[],assets:[],blocks}})};
      return <WorkspaceScopeProvider value={{...scope,contextDrawerOpen,openView:(view,onNavigated)=>{setView(view);onNavigated?.();},openLiterature,literatureRequest,
        consumeLiteratureRequest:nonce=>setLiteratureRequest(current=>current?.nonce===nonce?null:current)}}><LiteratureScopeProvider value={store}>
          <div style={{display:'flex',height:'100%',minWidth:0}}>
            {contextDrawerOpen?<aside data-testid="fixture-context-library" style={{width:220,flexShrink:0}}><LibraryList compact
              onOpenItem={id=>openLiterature({kind:'reader',libraryItemId:id})} onRequestImport={()=>sharedStore.requestImport()}/></aside>:null}
            <div style={{flex:1,minWidth:0}}>{hubMounted?<ViewActivity active={hubActive}><LiteratureHubView view={view} projectId="fixture"/></ViewActivity>:null}</div>
          </div>
        </LiteratureScopeProvider></WorkspaceScopeProvider>;
    }
    const root=createRoot(document.getElementById('root'));
    window.mount=()=>flushSync(()=>root.render(<Harness/>));
  `, style:'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}#root{width:820px}'});
  await writeFile(join(directory,'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1450,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);
  page.on('pageerror', error=>errors.push(error.message));
  await page.waitForFunction(()=>typeof window.mount==='function');
  await page.evaluate(()=>window.mount());
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});

test('knowledge modules load on first entry and hidden graphs release the projection while preserving its selection', async () => {
  assert.deepEqual(await page.evaluate(() => window.knowledgeModuleLoads ?? []), []);
  await page.evaluate(() => window.selectWorkspace('knowledge'));
  await expect(page.getByTestId('rag-query')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.knowledgeModuleLoads ?? []), []);
  await page.getByTestId('literature-subview-wiki').click();
  await expect(page.getByTestId('wiki-pages')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.knowledgeModuleLoads), ['WikiWorkspace']);
  await page.getByRole('button', {name: '新建主题页', exact: true}).click();
  await page.getByLabel('页面标题', {exact: true}).fill('Retained knowledge draft');
  await page.getByTestId('literature-subview-rag').click();
  await page.getByTestId('literature-subview-wiki').click();
  await expect(page.getByLabel('页面标题', {exact: true})).toHaveValue('Retained knowledge draft');
  await page.getByLabel('页面标题', {exact: true}).fill('');
  await page.getByRole('button', {name: '取消', exact: true}).click();
  await page.getByTestId('literature-open-graph').click();
  await expect(page.getByTestId('knowledge-graph')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.knowledgeModuleLoads), ['WikiWorkspace', 'KnowledgeGraphView']);
  await page.getByTestId('graph-node-claim:c-1').click();
  const beforeHide = await page.evaluate(() => window.graphDerivations);
  assert.ok(Number.isInteger(beforeHide) && beforeHide > 0, 'graph derivation probe must execute');
  await page.evaluate(() => window.setHubActive(false));
  await expect(page.getByTestId('knowledge-graph')).toHaveCount(0);
  await page.evaluate(() => window.setContextDrawerOpen(true));
  assert.equal(await page.evaluate(() => window.graphDerivations), beforeHide);
  await page.evaluate(() => {window.setContextDrawerOpen(false); window.setHubActive(true);});
  await expect(page.getByTestId('graph-detail-id')).toHaveText('claim:c-1');
  assert.ok(await page.evaluate(() => window.graphDerivations) > beforeHide);
  await page.getByTestId('literature-return-wiki').click();
  await expect(page.getByTestId('knowledge-graph')).toHaveCount(0);
  await page.evaluate(() => window.selectWorkspace('library'));
});

test('reader pipeline opens the actual index task manager and knowledge pages in the existing workspace', async () => {
  await page.evaluate(() => window.openObject({kind:'reader',libraryItemId:'paper'}));
  await page.getByTestId('reader-pipeline-toggle').click();
  await expect(page.getByTestId('reader-resource-status')).toHaveJSProperty('open', true);
  await expect(page.getByTestId('pipeline-stage-index')).toBeVisible();
  await page.getByTestId('pipeline-stage-index').focus();
  await expect(page.getByTestId('pipeline-stage-index')).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('reader-pipeline-details')).toContainText('向量索引：待核验');
  await page.getByRole('button',{name:'查看索引任务',exact:true}).click();
  await expect(page.getByTestId('literature-subview-rag')).toHaveAttribute('aria-selected','true');
  await expect(page.getByTestId('rag-index-panel')).toBeVisible();
  await expect(page.getByTestId('rag-no-jobs')).toBeVisible();
  await page.getByRole('button',{name:'返回检索',exact:true}).click();
  await page.evaluate(() => window.openObject({kind:'reader',libraryItemId:'paper'}));
  await page.getByTestId('pipeline-stage-wiki').click();
  await expect(page.getByTestId('reader-pipeline-details')).toContainText('知识页：未确认生成');
  await page.getByRole('button',{name:'查看知识页',exact:true}).click();
  await expect(page.getByTestId('literature-subview-wiki')).toHaveAttribute('aria-selected','true');
  await expect(page.getByTestId('wiki-pages')).toBeVisible();
  await page.evaluate(() => window.selectWorkspace('library'));
});

test('literature keeps full reading width, with reachable navigation at narrow and wide canvas sizes',async()=>{
  await page.evaluate(() => {window.setHubActive(true); window.setContextDrawerOpen(false); window.openObject({kind:'reader',libraryItemId:'paper'});});
  for(const width of [440,820,1280]) {
    await page.evaluate(width=>document.getElementById('root').style.width=width+'px',width);
    await page.getByTestId('reader-title').waitFor();
    await expect(page.getByTestId('literature-toggle-navigation')).toHaveAttribute('aria-expanded','false');
    const bounds=await page.getByTestId('paper-reader').boundingBox();
    assert.ok(bounds.width>=width-2,`reader ${bounds.width}, canvas ${width}`);
    await expect(page.getByLabel('选择当前文献')).toBeVisible();
    await page.getByTestId('literature-toggle-navigation').click();
    await expect(page.getByRole('complementary',{name:'文献列表'})).toBeVisible();
    if(width<1024) await expect(page.getByTestId('paper-reader')).toBeHidden();
    await page.getByTestId('literature-row-second').click();
    await expect(page.getByTestId('reader-title')).toHaveText('Second paper for navigation');
    await expect(page.getByTestId('literature-toggle-navigation')).toHaveAttribute('aria-expanded','false');
    await expect(page.getByLabel('选择当前文献')).toBeFocused();
    await page.getByLabel('选择当前文献').selectOption('paper');
    await expect(page.getByTestId('reader-title')).toContainText('Understanding');
  }
});

test('other tasks occupy full canvas without unrelated paper selection, in both themes',async()=>{
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [440,820,1280]) {
      await page.evaluate(width=>document.getElementById('root').style.width=width+'px',width);
      for(const tab of ['notes','rag','wiki','graph','reader']) {
        await page.evaluate(view=>window.selectWorkspace(view), ['rag','wiki','graph'].includes(tab)?'knowledge':'library');
        if(tab==='graph') await page.getByTestId('literature-open-graph').click();
        else await page.getByTestId('literature-subview-'+tab).click();
        await expect(page.getByTestId('literature-panel-'+tab)).toBeVisible();
        if(tab!=='reader') {
          await expect(page.getByLabel('选择当前文献')).toBeHidden();
          await expect(page.getByRole('complementary',{name:'文献列表'})).toBeHidden();
        }
        const layout=await page.getByTestId('literature-hub').evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth}));
        assert.ok(layout.scroll<=layout.width+1,JSON.stringify({tab,width,theme,layout}));
        if(process.env.ROC_LITERATURE_CAPTURE) {
          await mkdir(process.env.ROC_LITERATURE_CAPTURE,{recursive:true});
          await page.getByTestId('literature-hub').screenshot({path:join(process.env.ROC_LITERATURE_CAPTURE,theme+'-'+width+'-'+tab+'.png')});
        }
      }
    }
  }
});

test('object navigation opens the requested paper or claim and returns to the retained query',async()=>{
  await page.evaluate(()=>window.selectWorkspace('library'));
  await page.getByTestId('literature-subview-notes').click();
  await page.evaluate(()=>window.openObject({kind:'reader',libraryItemId:'second'}));
  await expect(page.getByTestId('literature-hub')).toHaveAttribute('data-sub-view','reader');
  await expect(page.getByTestId('reader-title')).toHaveText('Second paper for navigation');

  await page.evaluate(()=>window.openObject({kind:'concept',claimId:'c-0'}));
  await expect(page.getByTestId('literature-hub')).toHaveAttribute('data-sub-view','graph');
  await expect(page.getByTestId('literature-subview-wiki')).toHaveAttribute('aria-selected','true');
  await expect(page.getByTestId('literature-subview-graph')).toHaveCount(0);
  await expect(page.getByTestId('graph-detail-id')).toHaveText('claim:c-0');
  await page.getByTestId('graph-neighbour-claim:c-1').click();
  await expect(page.getByTestId('graph-detail-id')).toHaveText('claim:c-1');
  await page.evaluate(()=>window.openObject({kind:'concept',claimId:'c-0'}));
  await expect(page.getByTestId('graph-detail-id')).toHaveText('claim:c-0');
  await page.getByTestId('literature-return-wiki').click();
  await expect(page.getByTestId('literature-panel-wiki')).toBeVisible();

  await page.getByTestId('literature-subview-rag').click();
  await page.getByTestId('rag-query').fill('How does the evidence support this claim?');
  await page.evaluate(()=>window.openObject({kind:'reader',libraryItemId:'paper',parseId:'parse',locator:'page:1',text:'Evidence and understanding',returnToSearch:true}));
  await expect(page.getByTestId('reader-title')).toContainText('Understanding');
  await expect(page.locator('[data-block-id="heading"]')).toHaveAttribute('data-focused','true');
  await expect(page.getByTestId('reader-jump-missed')).toHaveCount(0);
  await page.getByTestId('reader-content-area').evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await page.evaluate(()=>window.openObject({kind:'reader',libraryItemId:'paper',parseId:'parse',locator:'page:1',text:'Evidence and understanding',returnToSearch:true}));
  await expect.poll(()=>page.getByTestId('reader-content-area').evaluate(element=>element.scrollTop)).toBe(0);
  await page.getByTestId('literature-return-search').click();
  await expect(page.getByTestId('literature-hub')).toHaveAttribute('data-workspace','knowledge');
  await expect(page.getByTestId('rag-query')).toHaveValue('How does the evidence support this claim?');
  await page.getByTestId('rag-search').click();
  await page.getByTestId('rag-hit-open-source-hit').click();
  await expect(page.locator('[data-block-id="heading"]')).toHaveAttribute('data-focused','true');
  await page.getByTestId('literature-return-search').click();
  await expect(page.getByTestId('rag-hit-open-source-hit')).toBeFocused();
  await expect(page.getByTestId('rag-query')).toHaveValue('How does the evidence support this claim?');
});

test('sidebar and canvas share one visible literature list without losing local navigation state',async()=>{
  for(const width of [820,1280]) {
    await page.evaluate(width=>{
      document.getElementById('root').style.width=width+'px';
      window.setContextDrawerOpen(false);
      window.openObject({kind:'reader',libraryItemId:'paper'});
    },width);
    await expect(page.getByTestId('reader-title')).toContainText('Understanding');
    const toggle=page.getByTestId('literature-toggle-navigation');
    const localList=page.locator('#literature-navigation');
    const importer=page.getByRole('button',{name:/^(添加文献|导入文献)$/});
    await expect(importer).toHaveCount(1);
    await expect(page.getByTestId('literature-hub-import')).toBeVisible();
    await toggle.click();
    await expect(localList).toBeVisible();
    await expect(importer).toHaveCount(1);
    await expect(localList.getByTestId('literature-import-open')).toBeVisible();
    await localList.getByLabel('已加载结果排序').selectOption('title');
    await page.evaluate(()=>window.setContextDrawerOpen(true));
    await expect(page.getByTestId('fixture-context-library')).toBeVisible();
    await expect(toggle).toBeHidden();
    await expect(localList).toBeHidden();
    await expect(importer).toHaveCount(1);
    await expect(page.getByTestId('fixture-context-library').getByTestId('literature-import-open')).toBeVisible();
    await expect(page.getByLabel('搜索文献').filter({visible:true})).toHaveCount(1);
    await expect(page.getByTestId('reader-title')).toContainText('Understanding');
    await page.evaluate(()=>window.setContextDrawerOpen(false));
    await expect(toggle).toHaveAttribute('aria-expanded','true');
    await expect(localList).toBeVisible();
    await expect(importer).toHaveCount(1);
    await expect(localList.getByLabel('已加载结果排序')).toHaveValue('title');
    await localList.getByTestId('literature-row-second').click();
    await expect(page.getByTestId('reader-title')).toHaveText('Second paper for navigation');
    await expect(toggle).toHaveAttribute('aria-expanded','false');
    await expect(importer).toHaveCount(1);
    await expect(page.getByTestId('literature-hub-import')).toBeVisible();
  }
});

test('sidebar import requests open once across hub remounts and wait for an active canvas',async()=>{
  const dialog=page.getByTestId('literature-import-dialog');
  await page.evaluate(()=>window.setContextDrawerOpen(true));
  await page.getByTestId('fixture-context-library').getByTestId('literature-import-open').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The shell retains the shared store while leaving and reentering a project.
  await page.evaluate(()=>window.setHubMounted(false));
  await expect(page.getByTestId('literature-hub')).toHaveCount(0);
  await page.evaluate(()=>{window.selectWorkspace('discover');window.setHubMounted(true);});
  await expect(page.getByTestId('literature-hub')).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.getByTestId('literature-subview-search').click();

  // A sidebar request can precede the lazy canvas's first mount.
  await page.evaluate(()=>window.setHubMounted(false));
  await expect(page.getByTestId('literature-hub')).toHaveCount(0);
  await page.evaluate(()=>window.requestImport('doi'));
  await page.evaluate(()=>window.setHubMounted(true));
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('literature-import-tab-doi')).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.evaluate(()=>window.setHubActive(false));
  await page.evaluate(()=>window.requestImport('document'));
  await expect(dialog).toBeHidden();
  await page.evaluate(()=>window.setHubActive(true));
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('literature-import-tab-document')).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
