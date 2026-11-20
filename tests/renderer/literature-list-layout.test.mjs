import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

test('narrow literature navigation contains its list and leaves adjacent reader controls clickable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-library-layout-'));
  let app;
  try {
    await build({stdin: {contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {LibraryList} from './src/renderer/literature/LibraryList';
      import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
      const item={id:'paper-layout',metadata:{title:'AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases',
        authors:['Zhaorun Chen','Zhen Xiang','Chaowei Xiao','Dawn Song','Bo Li'],publishedYear:2024,citationCount:null,source:'doi'},
        bibliography:{citationKey:'chen2024ageredtea',fields:{}},projectIds:['project-layout'],archived:false};
      const store={items:[item],status:'ready',query:'',selectedId:item.id,projectId:'project-layout',includeArchived:false,
        action:{error:null},setQuery:()=>{},reload:()=>{},setIncludeArchived:()=>{},select:()=>{}};
      createRoot(document.getElementById('root')).render(<LiteratureScopeProvider value={store}>
        <div className="flex h-full" style={{width:427}}>
          <aside data-testid="navigation" className="flex shrink-0" style={{width:170}}>
            <LibraryList onRequestImport={()=>{}}/>
          </aside>
          <main className="flex-1 min-w-0"><button data-testid="adjacent-control"
            style={{marginTop:220,marginLeft:80}} onClick={()=>window.readerClicked=true}>取消</button></main>
        </div>
      </LiteratureScopeProvider>);
    `, resolveDir:process.cwd(), loader:'tsx'}, outfile:join(directory,'app.js'),
      bundle:true, platform:'browser', format:'iife', logLevel:'silent'});
    const assets=join(process.cwd(),'dist/renderer/assets');
    await writeFile(join(directory,'app.css'),(await Promise.all((await readdir(assets))
      .filter(name=>name.endsWith('.css')).map(name=>readFile(join(assets,name),'utf8')))).join('\n'));
    await writeFile(join(directory,'index.html'),'<html data-theme="light"><link rel="stylesheet" href="app.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="app.js"></script></html>');
    await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
      app.setPath('userData',${JSON.stringify(join(directory,'data'))});
      app.whenReady().then(()=>new BrowserWindow({show:false,width:800,height:700}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
    app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
    const page=await app.firstWindow();page.setDefaultTimeout(5000);
    page.on('pageerror',error=>{throw error;});
    await page.getByTestId('literature-row-paper-layout').waitFor();
    for (const width of [170,240]) {
      await page.getByTestId('navigation').evaluate((element,width)=>element.style.width=width+'px',width);
      const bounds=await page.getByTestId('literature-list').evaluate(element=>({
        width:element.getBoundingClientRect().width,parentWidth:element.parentElement.getBoundingClientRect().width}));
      assert.ok(bounds.width<=bounds.parentWidth+1,JSON.stringify(bounds));
      await page.getByTestId('adjacent-control').click();
      assert.equal(await page.evaluate(()=>window.readerClicked),true);
    }
  } finally {
    try {await app?.close();} finally {await rm(directory,{recursive:true,force:true});}
  }
});
