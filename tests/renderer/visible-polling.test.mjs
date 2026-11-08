import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {build} from 'esbuild';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-visible-polling-'));
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {ViewActivity,useVisiblePolling} from './src/renderer/shared/view-activity';
    import {useWindowState} from './src/renderer/shell/use-window-state';
    import {KnowledgeJobs} from './src/renderer/literature/KnowledgeJobs';
    const root=createRoot(document.getElementById('root'));
    window.calls=[];window.ticks=[];
    const client={api:{window:window.nativeWindow,research:{knowledgeJobs:async ({projectId})=>{window.calls.push(projectId);return {ok:true,data:[]};}}}};
    function Probe({enabled,project}) {
      useVisiblePolling(()=>window.ticks.push(project),3000,enabled);
      return <input aria-label="Retained draft" defaultValue="draft"/>;
    }
    function Harness() {
      const native=useWindowState(client);
      window.nativeHidden=native.hidden;
      const [state,setState]=useState({outer:true,inner:true,enabled:true,project:'a'});
      window.change=update=>flushSync(()=>setState(value=>({...value,...update})));
      return <ViewActivity active={!native.hidden}><ViewActivity active={state.outer}><ViewActivity active={state.inner}>
        <div style={{display:state.outer&&state.inner?'block':'none'}}>
          <Probe enabled={state.enabled} project={state.project}/><KnowledgeJobs client={client} projectId={state.project}/>
        </div>
      </ViewActivity></ViewActivity></ViewActivity>;
    }
    window.unmount=()=>flushSync(()=>root.unmount());
    flushSync(()=>root.render(<Harness/>));
  `, style: 'body{padding:16px}'});
  writeFileSync(join(directory, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('nativeWindow',{
      getState:()=>ipcRenderer.invoke('window-state'),
      onHidden:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('window-hidden',listener);
        return ()=>ipcRenderer.off('window-hidden',listener);}
    });`);
  await build({entryPoints:['src/main/window-shell.ts'],outfile:join(directory,'window-shell.cjs'),
    bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow,ipcMain}=require('electron');
    const {bindWindowHiddenBroadcast}=require('./window-shell.cjs');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>{
      const window=new BrowserWindow({show:true,width:900,height:700,webPreferences:{preload:${JSON.stringify(join(directory, 'preload.cjs'))}}});
      ipcMain.handle('window-state',()=>({ok:true,data:{maximized:window.isMaximized(),minimized:window.isMinimized(),fullscreen:window.isFullScreen()}}));
      bindWindowHiddenBroadcast(window,value=>window.webContents.send('window-hidden',value));
      window.loadFile(${JSON.stringify(join(directory, 'index.html'))});
    });`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.calls?.length === 1);
  // Control the real renderer's timers without waiting seconds for each polling cycle.
  await page.clock.install();
  // Restart polling under the clock, retaining mounted components and drafts.
  await page.evaluate(() => window.change({outer:false}));
  await page.evaluate(() => window.change({outer:true}));
});
after(async () => {
  try {await app?.close();} finally {if (directory) rmSync(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
const counts = () => page.evaluate(() => ({jobs:window.calls.length,ticks:window.ticks.length}));
async function change(value) {await page.evaluate(value => window.change(value), value);}

test('retained panels stop polling at either inactive ancestor, resume once, and preserve drafts', async () => {
  await page.getByLabel('Retained draft').fill('unsaved content');
  const initial = await counts();
  await page.clock.runFor(3100);
  assert.deepEqual(await counts(), {jobs:initial.jobs+1,ticks:initial.ticks+1});
  await change({inner:false});
  const hidden = await counts();
  await page.clock.runFor(9000);
  assert.deepEqual(await counts(), hidden);
  await change({outer:false,inner:true});
  await page.clock.runFor(9000);
  assert.deepEqual(await counts(), hidden);
  await change({outer:true});
  assert.deepEqual(await counts(), {jobs:hidden.jobs+1,ticks:hidden.ticks+1});
  assert.equal(await page.getByLabel('Retained draft').inputValue(), 'unsaved content');
  await change({project:'b'});
  await page.clock.runFor(3100);
  assert.equal(await page.evaluate(() => window.ticks.at(-1)), 'b');
  assert.equal(await page.evaluate(() => window.calls.at(-1)), 'b');
});

test('native macOS window hide releases polling and show refreshes; disabled jobs and unmount remain quiet', async () => {
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());
  await expect.poll(() => page.evaluate(() => window.nativeHidden)).toBe(true);
  const hidden = await counts();
  await page.clock.runFor(9000);
  assert.deepEqual(await counts(), hidden);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].show());
  await expect.poll(() => page.evaluate(() => window.nativeHidden)).toBe(false);
  assert.deepEqual(await counts(), {jobs:hidden.jobs+1,ticks:hidden.ticks+1});
  await change({enabled:false});
  const disabled = await counts();
  await page.clock.runFor(3100);
  assert.deepEqual(await counts(), {jobs:disabled.jobs+1,ticks:disabled.ticks});
  await page.evaluate(() => window.unmount());
  const unmounted = await counts();
  await page.clock.runFor(9000);
  assert.deepEqual(await counts(), unmounted);
});
