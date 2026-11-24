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
    import {flushSync} from 'react-dom';
    import {WorkspaceLayout} from './src/renderer/app/WorkspaceLayout';
    import {useLayoutPersistence} from './src/renderer/app/useLayoutPersistence';
    import {clearUiState,readWorkspaceLayout} from './src/renderer/app/ui-state';
    clearUiState();
    const setItem=Storage.prototype.setItem;
    window.layoutWrites=[];
    Storage.prototype.setItem=function(key,value){
      if(key==='roc.ui.workspace.layouts')window.layoutWrites.push(value);
      return setItem.call(this,key,value);
    };
    window.readLayout=readWorkspaceLayout;
    function Harness(){
      const [assistant,setAssistant]=useState(false);
      const [project,setProject]=useState('project-a');
      const [preset,setPreset]=useState('research');
      const layout=useLayoutPersistence(preset,project);
      window.setWorkspace=({project,preset})=>{setProject(project);setPreset(preset);};
      window.resetLayout=layout.reset;
      window.resizeContext=layout.resizeDrawer;
      window.setAssistant=open=>flushSync(()=>setAssistant(open));
      window.setContext=open=>flushSync(()=>layout.setDrawerOpen(open));
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

test('manual widths and context visibility remain isolated by project and mode',async()=>{
  await page.evaluate(()=>window.resizeContext(300));
  await page.getByTestId('titlebar-toggle-sidebar').click();
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await page.evaluate(()=>window.setWorkspace({project:'project-a',preset:'writing'}));
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await page.getByTestId('titlebar-toggle-sidebar').click();
  await page.evaluate(()=>window.resizeContext(220));
  await expect(page.getByTestId('sidebar-column')).toHaveCSS('width','220px');
  await page.evaluate(()=>window.setWorkspace({project:'project-b',preset:'research'}));
  await expect(page.getByTestId('sidebar-column')).toHaveCSS('width','232px');
  await page.evaluate(()=>window.setWorkspace({project:'project-a',preset:'research'}));
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await page.getByTestId('titlebar-toggle-sidebar').click();
  await expect(page.getByTestId('sidebar-column')).toHaveCSS('width','300px');
  await page.evaluate(()=>window.setWorkspace({project:'project-a',preset:'writing'}));
  await expect(page.getByTestId('sidebar-column')).toHaveCSS('width','220px');
  await page.evaluate(()=>window.resetLayout());
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await page.getByTestId('titlebar-toggle-sidebar').click();
  await expect(page.getByTestId('sidebar-column')).toHaveCSS('width','232px');
  await expect(page.getByTestId('canvas-draft')).toHaveValue('修改后正文');
  await page.getByTestId('titlebar-toggle-assistant').click();
  await expect(page.getByTestId('assistant-draft')).toHaveValue('修改后问题');
});

test('drag persists only the released width and rolls back cancellation, scope change and divider unmount',async()=>{
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{
    window.setWorkspace({project:'drag-project-a',preset:'research'});
    window.setAssistant(false);
  });
  const divider=page.getByTestId('divider-sidebar');
  await expect(divider).toHaveAttribute('aria-valuenow','232');
  const drag=async delta=>{
    const bounds=await divider.boundingBox();
    await page.evaluate(()=>window.layoutWrites.length=0);
    await page.mouse.move(bounds.x+4,bounds.y+100);await page.mouse.down();
    await page.mouse.move(bounds.x+4+delta,bounds.y+100,{steps:5});
    await expect(divider).toHaveAttribute('data-dragging','true');
  };
  await drag(40);
  await expect(divider).toHaveAttribute('aria-valuenow','272');
  assert.equal(await page.evaluate(()=>window.layoutWrites.length),0);
  await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.layoutWrites.length),1);
  assert.equal(await page.evaluate(()=>window.readLayout('drag-project-a','research').sidebarWidth),272);
  for(const cancellation of ['Escape','pointercancel']){
    await drag(40);
    await expect(divider).toHaveAttribute('aria-valuenow','312');
    if(cancellation==='Escape')await page.keyboard.press('Escape');
    else await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1})));
    await page.mouse.up();
    await expect(divider).toHaveAttribute('aria-valuenow','272');
    assert.equal(await page.evaluate(()=>window.layoutWrites.length),0);
  }
  await divider.focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>window.layoutWrites.length),1);
  assert.equal(await page.evaluate(()=>window.readLayout('drag-project-a','research').sidebarWidth),280);
  await drag(40);
  await page.evaluate(()=>window.setWorkspace({project:'drag-project-b',preset:'research'}));
  await expect(divider).toHaveAttribute('aria-valuenow','232');
  await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.layoutWrites.length),0);
  assert.equal(await page.evaluate(()=>window.readLayout('drag-project-a','research').sidebarWidth),280);
  assert.equal(await page.evaluate(()=>window.readLayout('drag-project-b','research').sidebarWidth),232);
  await page.evaluate(()=>window.setWorkspace({project:'drag-project-a',preset:'research'}));
  await expect(divider).toHaveAttribute('aria-valuenow','280');
  await drag(30);
  await page.setViewportSize({width:1099,height:900});
  await expect(divider).toHaveCount(0);
  await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.layoutWrites.length),0);
  await page.setViewportSize({width:1440,height:900});
  await expect(divider).toHaveAttribute('aria-valuenow','280');
  await drag(30);
  await page.evaluate(()=>window.setContext(false));
  await expect(divider).toHaveCount(0);
  await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.layoutWrites.length),1);
  assert.deepEqual(await page.evaluate(()=>window.readLayout('drag-project-a','research')),
    {sidebarWidth:280,assistantWidth:344,collapsed:true});
  await page.getByTestId('titlebar-toggle-sidebar').click();
  await expect(divider).toHaveAttribute('aria-valuenow','280');
});

test('floating panes reverse during exit, isolate input immediately and retain drafts across modes and reduced motion',async()=>{
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{
    window.setWorkspace({project:'reverse-project',preset:'research'});
    window.setAssistant(true);window.setContext(true);
  });
  await expect(page.getByTestId('assistant-column')).toBeVisible();
  await page.getByTestId('canvas-draft').fill('修改后正文');
  await page.getByTestId('assistant-draft').fill('修改后问题');
  await page.setViewportSize({width:720,height:450});
  await expect(page.getByTestId('workspace-layout')).toHaveAttribute('data-layout-mode','drawers');
  await page.evaluate(()=>{window.setAssistant(false);window.setContext(true);});
  const pane=page.locator('[data-workspace-pane="sidebar"]');
  await expect(pane).toHaveAttribute('data-open','true');
  await expect(page.getByTestId('sidebar-drawer-close')).toBeFocused();
  await page.getByTestId('context-action').focus();
  const closing=await pane.evaluate(async element=>{
    window.retainedPane=element;
    window.setContext(false);
    await new Promise(requestAnimationFrame);
    const animation=element.getAnimations().find(value=>value.transitionProperty==='transform');
    return {inert:element.inert,hidden:element.getAttribute('aria-hidden'),
      display:getComputedStyle(element).display,animating:animation?.playState==='running'};
  });
  assert.deepEqual(closing,{inert:true,hidden:'true',display:'flex',animating:true});
  await expect(page.getByTestId('titlebar-toggle-sidebar')).toBeFocused();
  const scrim=page.locator('.workspace-scrim');
  assert.equal(await scrim.evaluate(element=>element.inert),true);
  assert.equal(await scrim.evaluate(element=>getComputedStyle(element).pointerEvents),'none');
  await pane.evaluate(async element=>{
    const animation=element.getAnimations().find(value=>value.transitionProperty==='transform');
    while(animation?.playState==='running' && Number(animation.currentTime)<60)await new Promise(requestAnimationFrame);
    window.setContext(true);
  });
  await expect(pane).toHaveAttribute('data-open','true');
  assert.equal(await pane.evaluate(element=>element===window.retainedPane && !element.inert),true);
  await expect(page.getByTestId('sidebar-drawer-close')).toBeFocused();
  await expect(pane).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('titlebar-toggle-sidebar')).toBeFocused();
  await page.evaluate(()=>window.setAssistant(true));
  await expect(page.getByTestId('assistant-draft')).toHaveValue('修改后问题');
  await page.getByTestId('assistant-draft').focus();
  await page.setViewportSize({width:1440,height:900});
  await expect(page.getByTestId('canvas-draft')).toHaveValue('修改后正文');
  await expect(page.getByTestId('assistant-draft')).toHaveValue('修改后问题');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:720,height:450});
  await expect(page.getByTestId('assistant-drawer')).toBeVisible();
  await page.getByTestId('assistant-draft').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-workspace-pane="assistant"]')).toHaveCSS('display','none');
  await page.getByTestId('titlebar-toggle-assistant').click();
  await expect(page.getByTestId('assistant-drawer')).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
  await expect(page.getByTestId('assistant-draft')).toHaveValue('修改后问题');
  await page.keyboard.press('Escape');
  await page.emulateMedia({reducedMotion:'no-preference'});
});
