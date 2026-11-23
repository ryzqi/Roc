import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors=[];
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-library-layout-'));
  await buildViteRenderer({directory,plugins:[tailwindcss()],
    style:'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink)}',script:`
      import React,{useMemo,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {LibraryList} from './src/renderer/literature/LibraryList';
      import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
      import {ContextDrawer} from './src/renderer/shell/ContextDrawer';
      import {ViewActivity} from './src/renderer/shared/view-activity';
      import './src/renderer/styles/index.css';
      const record=(id,index,entryType='article',source='doi')=>({id,metadata:{title:('000'+index).slice(-3)+' AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases',
        authors:['Zhaorun Chen','Zhen Xiang','Chaowei Xiao','Dawn Song','Bo Li'],publishedYear:2024,citationCount:null,source},sources:[],
        bibliography:{citationKey:'chen2024'+index,get entryType(){window.categoryReads++;return entryType;},fields:{}},projectIds:['project-layout'],archived:false,
        updatedAt:new Date(Date.UTC(2026,0,200-index)).toISOString()});
      function Harness({count,initialSelection,context=false}){
        const [all,setAll]=useState(()=>Array.from({length:count},(_,index)=>record(count===1?'paper-layout':'paper-'+index,index)));
        const [category,setCategory]=useState(null),[selectedId,setSelected]=useState(initialSelection),[query,setQuery]=useState(''),[includeArchived,setIncludeArchived]=useState(false),[status,setStatus]=useState('ready');
        const [projectId,setProjectId]=useState('project-layout'),[shown,setShown]=useState(true);
        const items=useMemo(()=>all.filter(item=>item.metadata.title.includes(query)),[all,query]);
        window.setCategory=setCategory;window.selectExternally=setSelected;
        window.setLibraryStatus=setStatus;
        window.showNavigation=setShown;window.setLibraryQuery=setQuery;window.setLibraryProject=setProjectId;
        window.appendLibraryItem=()=>setAll(current=>[...current,record('paper-added',current.length,'book','zotero')]);
        const store={items,status,error:status==='error'?'Library unavailable':null,query,selectedId,projectId,includeArchived,
          total:items.length,hasMore:false,loadingMore:false,loadMoreError:null,loadMore:()=>{},requestImport:()=>{window.importRequested=true;},
          documentsStatus:'ready',documents:[{libraryItemId:selectedId,currentParseId:'parse',status:'ready'}],
          action:{error:null},setQuery,reload:()=>{window.reloads++;setStatus('ready');},setIncludeArchived,select:id=>{window.opened.push(id);setSelected(id);},
          client:{api:{research:{exportBibliography:async()=>({ok:true,data:{content:'bibtex'}})}}}};
        return <LiteratureScopeProvider value={store}>
          <div className="flex h-full" style={{width:650}}>
            <aside data-testid="navigation" className="flex shrink-0" style={{width:240}} hidden={!shown} inert={!shown}>
              <ViewActivity active={shown}>{context
                ? <ContextDrawer view="library" onOpenLiterature={id=>{if(id!==null)store.select(id);}} onOpenHelp={()=>{}}/>
                : <LibraryList entryType={category} compact onRequestImport={()=>{window.importRequested=true;}}/>}</ViewActivity>
            </aside>
            <main className="flex-1 min-w-0"><button data-testid="adjacent-control" style={{marginTop:220,marginLeft:80}}
              onClick={()=>window.readerClicked=true}>取消</button></main>
          </div>
        </LiteratureScopeProvider>;
      }
      const root=createRoot(document.getElementById('root'));let key=0;
      window.mount=(count=1,initialSelection='paper-layout',context=false)=>{window.opened=[];window.reloads=0;window.importRequested=false;window.categoryReads=0;
        flushSync(()=>root.render(<Harness key={++key} count={count} initialSelection={initialSelection} context={context}/>));};
    `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:850,height:700}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>typeof window.mount==='function');
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});

test('empty and failed literature lists keep one import and one reload action',async()=>{
  await page.evaluate(()=>mount(0,null));
  await expect(page.getByTestId('literature-empty')).toBeVisible();
  const importer=page.getByRole('button',{name:'导入文献',exact:true});
  await expect(importer).toHaveCount(1);
  await importer.focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.importRequested),true);
  await page.evaluate(()=>window.setLibraryStatus('error'));
  await expect(page.getByRole('alert')).toContainText('Library unavailable');
  const reload=page.getByRole('button',{name:/重试|重新读取文献库/});
  await expect(reload).toHaveCount(1);
  await reload.click();
  assert.equal(await page.evaluate(()=>window.reloads),1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('narrow literature navigation contains its filters and leaves reader controls clickable',async()=>{
  await page.evaluate(()=>mount());
  await page.getByTestId('literature-row-paper-layout').waitFor();
  const audit=await readFile('scripts/ui-audit/clip-audit.js','utf8');
  for(const theme of ['light','dark']) for(const width of [170,240,420]) {
    await page.evaluate(({theme,width})=>{document.documentElement.dataset.theme=theme;
      document.querySelector('[data-testid="navigation"]').style.width=width+'px';},{theme,width});
    await page.getByTestId('literature-filter-toggle').click();
    await expect(page.getByTestId('literature-archived-toggle')).toBeVisible();
    await page.getByTestId('literature-archived-toggle').check();
    await expect(page.getByTestId('literature-list')).toContainText('含已归档');
    await page.getByTestId('literature-filter-toggle').click();
    const bounds=await page.getByTestId('literature-list').evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth}));
    assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify({theme,width,bounds}));
    await page.getByTestId('literature-import-open').hover();
    const result=await page.evaluate(source=>(0,eval)(source)({root:'#root',viewport:true}),audit);
    assert.equal(result.cut,0,JSON.stringify(result.issues));
    if(process.env.ROC_WORKSPACE_CAPTURE) {
      await mkdir(process.env.ROC_WORKSPACE_CAPTURE,{recursive:true});
      await page.getByTestId('literature-list').screenshot({path:join(process.env.ROC_WORKSPACE_CAPTURE,`library-${theme}-${width}.png`)});
    }
    await page.getByTestId('adjacent-control').click();
    assert.equal(await page.evaluate(()=>window.readerClicked),true);
  }
  await page.evaluate(()=>window.setCategory('book'));
  await expect(page.getByTestId('literature-empty')).toContainText('当前分类没有文献');
  await page.getByTestId('literature-import-open').click();
  assert.equal(await page.evaluate(()=>window.importRequested),true);
  await page.evaluate(()=>window.setCategory('article'));
  await expect(page.getByTestId('literature-row-paper-layout')).toBeVisible();
});

test('large result sets window their rows and preserve selected items and keyboard navigation',async(t)=>{
  await page.evaluate(()=>mount(200,'paper-150'));
  await expect(page.getByTestId('literature-row-paper-150')).toBeVisible();
  const mounted=await page.locator('[data-testid^="literature-row-"]').count();
  assert.ok(mounted>0 && mounted<40,`Expected bounded DOM for 200 results, received ${mounted}`);
  t.diagnostic(`${mounted} mounted rows for 200 literature results`);
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 200 / 200 条');
  await expect(page.getByTestId('literature-fulltext-paper-150')).toHaveText('全文已解析');
  await page.getByTestId('literature-row-paper-150').focus();
  await page.locator('.library-virtual-list').evaluate(element=>element.scrollTo({top:0}));
  await expect(page.getByTestId('literature-row-paper-150')).toHaveCount(0);
  await expect(page.getByTestId('literature-list-body')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('literature-row-paper-199')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('literature-row-paper-0')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('literature-row-paper-1')).toBeFocused();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.opened.at(-1)),'paper-1');
  await expect(page.getByTestId('literature-row-paper-1')).toHaveAttribute('aria-current','true');
  await page.evaluate(()=>window.selectExternally('paper-120'));
  await expect(page.getByTestId('literature-row-paper-120')).toBeVisible();
  await expect(page.getByTestId('literature-row-paper-120')).toHaveAttribute('tabindex','0');
  await page.getByTestId('literature-row-paper-120').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('literature-citekey-copy-paper-120')).toBeFocused();
  await page.locator('.library-virtual-list').evaluate(element=>element.scrollTo({top:0}));
  await expect(page.getByTestId('literature-row-paper-120')).toHaveCount(0);
  await expect(page.getByTestId('literature-list-body')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('literature-row-paper-121')).toBeFocused();
  await page.getByTestId('literature-sort').selectOption('title');
  await expect(page.getByTestId('literature-row-paper-120')).toBeVisible();
  await expect(page.getByTestId('literature-row-paper-120')).toHaveAttribute('aria-current','true');
  await page.getByTestId('literature-multiselect').click();
  await page.getByRole('checkbox',{name:'选择已加载结果'}).check();
  await expect(page.getByTestId('literature-bulk-actions')).toContainText('已选 200 篇');
  await page.getByTestId('literature-search').fill('120 Agent');
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 1 / 1 条');
  await expect(page.getByTestId('literature-row-paper-120')).toHaveAttribute('aria-current','true');
  await expect(page.getByTestId('literature-bulk-actions')).toHaveCount(0);
  await expect(page.getByTestId('literature-row-paper-120')).toHaveAttribute('tabindex','0');
});

test('context literature counts follow item changes without rescanning on status changes',async()=>{
  await page.evaluate(()=>mount(200,'paper-150',true));
  await expect(page.getByTestId('literature-row-paper-150')).toBeVisible();
  const categories=page.getByTestId('context-drawer').locator('details');
  await categories.locator('summary').click();
  await expect(categories.getByRole('button',{name:'期刊论文 200 条'})).toBeVisible();
  await expect(page.getByTestId('context-zotero')).toContainText('0 条已收录');
  await page.evaluate(()=>{window.categoryReads=0;window.setLibraryStatus('error');});
  await expect(page.getByRole('alert')).toContainText('Library unavailable');
  await page.evaluate(()=>window.setLibraryStatus('ready'));
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.categoryReads),0,'Status updates must not rescan every bibliography category');
  await page.evaluate(()=>window.appendLibraryItem());
  await expect(categories.getByRole('button',{name:'图书 1 条'})).toBeVisible();
  await expect(page.getByTestId('context-zotero')).toContainText('1 条已收录');
  await expect(page.getByTestId('literature-count')).toHaveText('已加载 201 / 201 条');
  await categories.getByRole('button',{name:'图书 1 条'}).click();
  await expect(page.getByTestId('literature-row-paper-added')).toBeVisible();
  await expect(page.locator('[data-testid^="literature-row-"]')).toHaveCount(1);
});

test('hidden context navigation retains reading state while query and project changes invalidate selection',async()=>{
  await page.evaluate(()=>mount(200,'paper-150',true));
  await expect(page.getByTestId('literature-row-paper-150')).toBeVisible();
  const categories=page.getByTestId('context-drawer').locator('details');
  await categories.locator('summary').click();
  await categories.getByRole('button',{name:'期刊论文 200 条'}).click();
  await page.getByTestId('literature-search').fill('Agent');
  await page.getByTestId('literature-sort').selectOption('title');
  await page.getByTestId('literature-filter-toggle').click();
  await page.getByTestId('literature-archived-toggle').check();
  await page.getByTestId('literature-multiselect').click();
  await page.getByTestId('literature-row-paper-150').locator('..').getByRole('checkbox').check();
  await expect(page.getByTestId('literature-bulk-actions')).toContainText('已选 1 篇');
  await page.locator('.library-virtual-list').evaluate(element=>element.scrollTo({top:1000}));
  await expect.poll(()=>page.locator('.library-virtual-list').evaluate(element=>element.scrollTop)).toBeGreaterThan(900);
  await page.getByTestId('adjacent-control').focus();
  const before=await page.locator('.library-virtual-list').evaluate(element=>new Promise((resolve,reject)=>{
    let previous=element.scrollTop,stable=0,frame=0;
    const timeout=window.setTimeout(()=>{
      cancelAnimationFrame(frame);
      reject(new Error('Literature virtualized scroll did not stabilize within 2 seconds'));
    },2000);
    const settled=()=>{const current=element.scrollTop;stable=current===previous?stable+1:0;previous=current;
      if(stable===5){window.clearTimeout(timeout);resolve(current);}else frame=requestAnimationFrame(settled);};
    frame=requestAnimationFrame(settled);
  }));
  await page.evaluate(()=>window.showNavigation(false));
  await expect(page.getByTestId('navigation')).toBeHidden();
  await page.evaluate(()=>window.setLibraryStatus('loading'));
  await expect(page.getByTestId('literature-refresh')).toBeDisabled();
  await page.evaluate(()=>window.setLibraryStatus('ready'));
  await expect(page.getByTestId('literature-refresh')).toBeEnabled();
  await page.evaluate(()=>window.showNavigation(true));
  await expect(page.getByTestId('navigation')).toBeVisible();
  await expect(page.getByTestId('adjacent-control')).toBeFocused();
  await expect(page.getByTestId('literature-search')).toHaveValue('Agent');
  await expect(page.getByTestId('literature-sort')).toHaveValue('title');
  await expect(page.getByTestId('literature-archived-toggle')).toBeChecked();
  await expect(categories).toHaveAttribute('open','');
  await expect(categories.getByRole('button',{name:'期刊论文 200 条'})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByTestId('literature-bulk-actions')).toContainText('已选 1 篇');
  await expect.poll(async()=>Math.abs(await page.locator('.library-virtual-list').evaluate(element=>element.scrollTop)-before)).toBeLessThan(2);

  await page.evaluate(()=>window.showNavigation(false));
  await page.evaluate(()=>window.setLibraryQuery('no-result'));
  await expect(page.getByTestId('literature-search')).toHaveValue('no-result');
  await expect(page.getByTestId('literature-bulk-actions')).toHaveCount(0);
  await page.evaluate(()=>window.setLibraryQuery('Agent'));
  await expect(page.getByTestId('literature-search')).toHaveValue('Agent');
  await page.evaluate(()=>window.showNavigation(true));
  await expect(page.getByTestId('literature-multiselect')).toHaveAttribute('aria-pressed','true');
  await expect(page.getByTestId('literature-bulk-actions')).toHaveCount(0);
  await expect(page.getByTestId('literature-row-paper-150')).toBeVisible();
  await page.getByTestId('literature-row-paper-150').locator('..').getByRole('checkbox').check();
  await expect(page.getByTestId('literature-bulk-actions')).toContainText('已选 1 篇');
  await page.getByTestId('adjacent-control').focus();
  await page.evaluate(()=>window.showNavigation(false));
  await page.evaluate(()=>window.setLibraryProject('project-next'));
  await expect(page.getByTestId('literature-bulk-actions')).toHaveCount(0);
  await page.evaluate(()=>window.showNavigation(true));
  await expect(page.getByTestId('adjacent-control')).toBeFocused();
  await expect(page.getByTestId('literature-bulk-actions')).toHaveCount(0);
});
