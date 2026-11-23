import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors=[];
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-workspace-frame-'));
  await buildViteRenderer({directory,style:'html,body,#root{height:100%;margin:0}',script:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {WorkspaceLayout} from './src/renderer/app/WorkspaceLayout';
    import {useLayoutPersistence} from './src/renderer/app/useLayoutPersistence';
    import {clearUiState} from './src/renderer/app/ui-state';
    clearUiState();
    function Harness(){
      const [assistant,setAssistant]=useState(false);
      const layout=useLayoutPersistence('research');
      window.resizeContext=layout.resizeDrawer;
      return <div className="flex h-full flex-col">
        <header><button data-testid="titlebar-toggle-sidebar" onClick={layout.toggleDrawer}>上下文</button>
          <button data-testid="titlebar-toggle-assistant" onClick={()=>{layout.setDrawerOpen(!layout.drawerFloating);setAssistant(value=>!value);}}>助手</button></header>
        <WorkspaceLayout layout={layout} assistantOpen={assistant} onCloseAssistant={()=>setAssistant(false)}
          activityRail={<nav style={{width:52,flexShrink:0}}>导航</nav>}
          contextDrawer={<button data-testid="context-action">文件</button>}
          canvas={<input data-testid="canvas-draft" defaultValue="未保存正文"/>}
          assistant={<input data-testid="assistant-draft" defaultValue="研究问题"/>}/>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('canvas-draft').waitFor();
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});

test('canvas precedes right dock and its divider grows toward the left',async()=>{
  await page.getByTestId('titlebar-toggle-assistant').click();
  const sidebar=await page.getByTestId('sidebar-column').boundingBox();
  const canvas=await page.getByTestId('canvas-column').boundingBox();
  const assistant=await page.getByTestId('assistant-column').boundingBox();
  assert.ok(sidebar.x+sidebar.width<=canvas.x+1);
  assert.ok(canvas.x+canvas.width<=assistant.x+1);
  assert.ok(canvas.width>=760);
  const divider=page.getByTestId('divider-assistant');
  const start=Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow',String(start+8));
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow','344');
  const bounds=await divider.boundingBox();
  await page.mouse.move(bounds.x+4,bounds.y+100);await page.mouse.down();
  await page.mouse.move(bounds.x-20,bounds.y+100);
  await expect(divider).toHaveAttribute('aria-valuenow','368');
  await page.keyboard.press('Escape');await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow','344');
});

test('desktop and zoomed widths preserve drafts and move panels into overlays',async()=>{
  await page.getByTestId('canvas-draft').fill('修改后正文');
  await page.getByTestId('assistant-draft').fill('修改后问题');
  const clip=await readFile('scripts/ui-audit/clip-audit.js','utf8');
  for(const theme of ['light','dark']) for(const width of [1184,1280,1099,640,380,1440]){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.setViewportSize({width,height:900});
    await expect(page.getByTestId(width>=1440?'assistant-column':'assistant-drawer')).toBeVisible();
    if(width>=1100) await expect(page.getByTestId('sidebar-column')).toBeVisible();
    await expect(page.getByTestId('canvas-draft')).toHaveValue('修改后正文');
    await expect(page.getByTestId('assistant-draft')).toHaveValue('修改后问题');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const audit=await page.evaluate(source=>(0,eval)(source)({viewport:true}),clip);
    assert.equal(audit.cut,0);
    if(process.env.ROC_UI_AUDIT_DIR && [1184,1440].includes(width)){
      await mkdir(process.env.ROC_UI_AUDIT_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.ROC_UI_AUDIT_DIR,`workspace-${theme}-${width}.png`)});
    }
    if(width<1440){
      assert.equal(await page.getByTestId('canvas-column').evaluate(element=>element.inert),true);
      await page.getByTestId('assistant-draft').focus();await page.keyboard.press('Escape');
      await expect(page.getByTestId('assistant-drawer')).toHaveCount(0);
      await expect(page.getByTestId('titlebar-toggle-assistant')).toBeFocused();
      assert.equal(await page.getByTestId('canvas-column').evaluate(element=>element.inert),false);
      await page.getByTestId('titlebar-toggle-assistant').click();
    }
  }
});

test('wide context cannot squeeze the canvas below its inline dock budget',async()=>{
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>window.resizeContext(340));
  await expect(page.getByTestId('assistant-drawer')).toBeVisible();
  assert.ok((await page.getByTestId('canvas-column').boundingBox()).width>=760);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('assistant-drawer')).toHaveCount(0);
  await expect(page.getByTestId('context-action')).toBeEnabled();
});
