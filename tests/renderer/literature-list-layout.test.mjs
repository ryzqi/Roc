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
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {LibraryList} from './src/renderer/literature/LibraryList';
      import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
      import './src/renderer/styles/index.css';
      const record=(id,index)=>({id,metadata:{title:('000'+index).slice(-3)+' AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases',
        authors:['Zhaorun Chen','Zhen Xiang','Chaowei Xiao','Dawn Song','Bo Li'],publishedYear:2024,citationCount:null,source:'doi'},
        bibliography:{citationKey:'chen2024'+index,entryType:'article',fields:{}},projectIds:['project-layout'],archived:false,
        updatedAt:new Date(Date.UTC(2026,0,200-index)).toISOString()});
      function Harness({count,initialSelection}){
        const [all]=useState(()=>Array.from({length:count},(_,index)=>record(count===1?'paper-layout':'paper-'+index,index)));
        const [category,setCategory]=useState(null),[selectedId,setSelected]=useState(initialSelection),[query,setQuery]=useState(''),[includeArchived,setIncludeArchived]=useState(false);
        window.setCategory=setCategory;window.selectExternally=setSelected;
        const store={items:all.filter(item=>item.metadata.title.includes(query)),status:'ready',query,selectedId,projectId:'project-layout',includeArchived,
          documentsStatus:'ready',documents:[{libraryItemId:selectedId,currentParseId:'parse',status:'ready'}],
          action:{error:null},setQuery,reload:()=>{},setIncludeArchived,select:id=>{window.opened.push(id);setSelected(id);},
          client:{api:{research:{exportBibliography:async()=>({ok:true,data:{content:'bibtex'}})}}}};
        return <LiteratureScopeProvider value={store}>
          <div className="flex h-full" style={{width:650}}>
            <aside data-testid="navigation" className="flex shrink-0" style={{width:240}}>
              <LibraryList entryType={category} compact onRequestImport={()=>{window.importRequested=true;}}/>
            </aside>
            <main className="flex-1 min-w-0"><button data-testid="adjacent-control" style={{marginTop:220,marginLeft:80}}
              onClick={()=>window.readerClicked=true}>取消</button></main>
          </div>
        </LiteratureScopeProvider>;
      }
      const root=createRoot(document.getElementById('root'));let key=0;
      window.mount=(count=1,initialSelection='paper-layout')=>{window.opened=[];
        flushSync(()=>root.render(<Harness key={++key} count={count} initialSelection={initialSelection}/>));};
    `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:850,height:700}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>typeof window.mount==='function');
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});

test('narrow literature navigation contains its filters and leaves reader controls clickable',async()=>{
  await page.evaluate(()=>mount());
  await page.getByTestId('literature-row-paper-layout').waitFor();
  const audit=await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
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
  await page.getByTestId('literature-empty').getByRole('button',{name:'导入文献',exact:true}).click();
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
  await expect(page.getByTestId('literature-count')).toHaveText('200 条');
  await expect(page.getByTestId('literature-fulltext-paper-150')).toHaveText('全文已解析');
  await page.getByTestId('literature-row-paper-150').focus();
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
  await page.getByTestId('literature-sort').selectOption('title');
  await expect(page.getByTestId('literature-row-paper-120')).toBeVisible();
  await expect(page.getByTestId('literature-row-paper-120')).toHaveAttribute('aria-current','true');
  await page.getByTestId('literature-multiselect').click();
  await page.getByRole('checkbox',{name:'选择当前结果'}).check();
  await expect(page.getByTestId('literature-bulk-actions')).toContainText('已选 200 篇');
  await page.getByTestId('literature-search').fill('120 Agent');
  await expect(page.getByTestId('literature-count')).toHaveText('1 条');
  await expect(page.getByTestId('literature-row-paper-120')).toHaveAttribute('aria-current','true');
  await expect(page.getByTestId('literature-bulk-actions')).toHaveCount(0);
  await expect(page.getByTestId('literature-row-paper-120')).toHaveAttribute('tabindex','0');
});
