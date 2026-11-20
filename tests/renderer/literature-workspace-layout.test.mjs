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
  await buildViteRenderer({directory, plugins: [tailwindcss()], script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LiteratureHubView} from './src/renderer/literature/LiteratureHubView';
    import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
    import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
    import './src/renderer/styles/index.css';
    const ok=data=>({ok:true,data});
    const item={id:'paper',revision:1,archived:false,projectIds:['fixture'],
      metadata:{title:'Understanding how scientific evidence supports a research claim',authors:['Fixture Author'],publishedYear:2026,citationCount:null,doi:null,url:null,openAccessUrl:null,source:'local'},
      bibliography:{title:'Understanding scientific evidence',citationKey:'fixture2026',fields:{}}};
    const second={...item,id:'second',metadata:{...item.metadata,title:'Second paper for navigation'}};
    const paperDocument={id:'document',libraryItemId:'paper',filename:'scientific-evidence.pdf',mediaType:'application/pdf',status:'ready',sourceHash:'source',currentParseId:'parse',activeParseId:null};
    const blocks=[{id:'heading',kind:'heading',label:'Introduction',text:'Evidence and understanding',locator:'page:1',locations:[],imageAssetId:null},
      {id:'paragraph',kind:'paragraph',label:'Introduction',text:'A useful reading workspace keeps the paper in focus. '.repeat(100),locator:'page:1',locations:[],imageAssetId:null}];
    const client={api:{research:{
      getModelsStatus:async()=>ok({ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}),
      listAcquisition:async()=>ok({jobs:[],total:0,nextOffset:null}),onLibraryChanged:()=>()=>{},
      listReadingNotes:async()=>ok([]),searchWiki:async()=>ok({pages:[],nextOffset:null,mode:'keyword',degradation:null}),
      knowledgeJobs:async()=>ok([]),listIndexedFiles:async()=>ok([]),listIndexJobs:async()=>ok([]),
      getIndexStatus:async()=>ok({phase:'idle',generation:1,error:null,workspacePath:'/synthetic',lastScanAt:null,
        counts:{total:0,ready:0,queued:0,running:0,failed:0},settings:{revision:1,projectId:'fixture',paused:false,watch:false,kinds:[],include:[],exclude:[],embeddingConfigId:null}})
    }}};
    const scope={client,projectId:'fixture',workspacePath:'/synthetic',writable:true,workspaceStatus:'ready',workspaceError:null,openFileInCanvas(){}};
    function Harness(){
      const [selectedId,setSelected]=useState('paper');
      const selected=selectedId==='paper'?item:second;
      const store={client,projectId:'fixture',items:[item,second],selected,selectedId,documents:selectedId==='paper'?[paperDocument]:[],
        status:'ready',selectedStatus:'ready',query:'',includeArchived:false,importRequestId:0,
        claims:[],evidence:[],derivedStatus:'ready',derivedError:null,
        action:{pending:false,error:null},assistant:{pending:false,error:null},parseInFlight:null,
        select:setSelected,reload(){},reloadDocuments(){},reloadDerived(){},setQuery(){},setIncludeArchived(){},
        loadDocumentContent:async()=>ok({run:{id:'parse',documentId:'document'},content:{sourceHash:'source',pageCount:1,parseMode:'native-text',warnings:[],assets:[],blocks}})};
      return <WorkspaceScopeProvider value={scope}><LiteratureScopeProvider value={store}><LiteratureHubView/></LiteratureScopeProvider></WorkspaceScopeProvider>;
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

test('literature keeps full reading width, with reachable navigation at narrow and wide canvas sizes',async()=>{
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
        await page.getByTestId('literature-subview-'+tab).click();
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
