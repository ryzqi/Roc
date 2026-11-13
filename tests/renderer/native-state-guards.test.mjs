import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-native-state-guards-'));
  await buildViteRenderer({directory, style: 'body{padding:32px}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {SWRConfig} from 'swr';
    import {useWindowState} from './src/renderer/shell/use-window-state';
    import {useTraySummaryLabel} from './src/renderer/shell/use-tray-summary';
    import {useProjectWorkspace} from './src/renderer/project/use-project-workspace';
    import {ErrorBar} from './src/renderer/shell/ErrorBar';
    const ok=data=>({ok:true,data});
    const requests={window:[],tray:[],pick:[],update:[]};
    const invoke=kind=>{
      window.calls[kind]++;
      if(window.failures[kind]==='throw')throw new Error(kind+' bridge disconnected');
      if(window.failures[kind]==='reject')return Promise.reject(new Error(kind+' bridge rejected'));
      if(window.failures[kind]==='error')return Promise.resolve({ok:false,error:{message:kind+' service unavailable'}});
      return new Promise(resolve=>requests[kind].push(resolve));
    };
    const client={api:{
      window:{getState:()=>invoke('window'),onHidden:callback=>{window.hiddenListener=callback;return()=>{window.hiddenListener=null;};}},
      lifecycle:{getTraySummary:()=>invoke('tray')},
      workspace:{selectFromDialog:()=>invoke('pick')},
      research:{updateProject:input=>{window.updates.push(input);return invoke('update');}}
    }};
    function WindowProbe(){
      const state=useWindowState(client);
      return <><output data-testid="window-state">{JSON.stringify(state)}</output>
        {state.error?<ErrorBar error={{level:'page',message:state.error,retry:state.reload}}/>:null}</>;
    }
    function TrayProbe(){
      const [hidden,setHidden]=useState(false);window.setHidden=value=>flushSync(()=>setHidden(value));
      const tray=useTraySummaryLabel(client,hidden);
      const label=typeof tray==='string'?tray:tray?.label;
      return <><output data-testid="tray-state">{label}</output>
        {tray?.error?<ErrorBar error={{level:'page',message:tray.error,retry:tray.reload}}/>:null}</>;
    }
    function ProjectProbe(){
      const [projectId,setProjectId]=useState('a');window.selectProject=id=>flushSync(()=>setProjectId(id));
      const binding=useProjectWorkspace(client,{id:projectId},()=>window.bound.push(projectId));
      return <><output data-testid="project-state">{projectId}</output>
        <button data-testid="project-bind" disabled={binding.pending} onClick={binding.bind}>绑定工作目录</button>
        {binding.error?<ErrorBar error={{level:'page',message:binding.error}}/>:null}</>;
    }
    const root=createRoot(document.getElementById('root'));let nonce=0;
    window.unmount=()=>flushSync(()=>root.render(null));
    window.mount=(mode,failure=null)=>{
      window.unmount();window.calls={window:0,tray:0,pick:0,update:0};
      window.failures={window:null,tray:null,pick:null,update:null};window.failures[mode==='project'?'pick':mode]=failure;
      for(const kind of Object.keys(requests))requests[kind]=[];
      window.updates=[];window.bound=[];
      const child=mode==='window'?<WindowProbe/>:mode==='tray'?<TrayProbe/>:<ProjectProbe/>;
      flushSync(()=>root.render(<SWRConfig value={{provider:()=>new Map()}} key={++nonce}>{child}</SWRConfig>));
    };
    window.resolve=(kind,index,data)=>requests[kind][index](ok(data));
    window.mount('window');
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:700})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(3000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('window-state').waitFor();
  await page.clock.install();
});
after(async () => {
  await page?.evaluate(() => window.unmount()).catch(() => {});
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive:true, force:true});}
  assert.deepEqual(errors, []);
});

const snapshot = maximized => ({maximized, minimized:false, fullscreen:false});
const traySummary = running => ({backgroundPaused:false, backgroundTasks:{running, pendingConfirmation:0, failed:0},
  researchTasks:{running:0, pendingConfirmation:0, failed:0}});

test('window state keeps the newest native response when resize reads resolve out of order', async () => {
  await page.evaluate(() => window.mount('window'));
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.clock.runFor(151);
  assert.equal(await page.evaluate(() => window.calls.window), 2);
  await page.evaluate(value => window.resolve('window', 1, value), snapshot(true));
  await expect(page.getByTestId('window-state')).toContainText('"maximized":true');
  await page.evaluate(value => window.resolve('window', 0, value), snapshot(false));
  await expect(page.getByTestId('window-state')).toContainText('"maximized":true');
});

for (const mode of ['window', 'tray']) {
  for (const failure of ['throw', 'reject', 'error']) {
    test(`${mode} state reports ${failure} failures and retries without an unhandled rejection`, async () => {
      await page.evaluate(({mode, failure}) => window.mount(mode, failure), {mode, failure});
      await expect(page.getByRole('alert')).toContainText(
        `${mode} ${failure === 'throw' ? 'bridge disconnected' : failure === 'reject' ? 'bridge rejected' : 'service unavailable'}`);
      await page.evaluate(mode => {window.failures[mode]=null;}, mode);
      await page.getByRole('button', {name:'重试'}).click();
      await expect.poll(() => page.evaluate(mode => window.calls[mode], mode)).toBe(2);
      await page.evaluate(({mode, value}) => window.resolve(mode, 0, value), {
        mode, value:mode === 'window' ? snapshot(true) : traySummary(2)
      });
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByTestId(`${mode}-state`)).toContainText(mode === 'window' ? '"maximized":true' : '后台 2 项运行中');
    });
  }
}

test('tray state ignores superseded polls and stops periodic reads while hidden', async () => {
  await page.evaluate(() => window.mount('tray'));
  await page.clock.runFor(30_001);
  assert.equal(await page.evaluate(() => window.calls.tray), 2);
  await page.evaluate(value => window.resolve('tray', 1, value), traySummary(2));
  await expect(page.getByTestId('tray-state')).toHaveText('后台 2 项运行中');
  await page.evaluate(value => window.resolve('tray', 0, value), traySummary(1));
  await expect(page.getByTestId('tray-state')).toHaveText('后台 2 项运行中');
  await page.evaluate(() => window.setHidden(true));
  const hidden = await page.evaluate(() => window.calls.tray);
  await page.clock.runFor(90_001);
  assert.equal(await page.evaluate(() => window.calls.tray), hidden);
});

test('project binding catches a synchronous native picker failure and allows another selection', async () => {
  await page.evaluate(() => window.mount('project', 'throw'));
  await page.getByTestId('project-bind').click();
  await expect(page.getByRole('alert')).toContainText('pick bridge disconnected');
  await expect(page.getByTestId('project-bind')).toBeEnabled();
  await page.evaluate(() => {window.failures.pick=null;});
  await page.getByTestId('project-bind').click();
  await page.evaluate(() => window.resolve('pick', 0, null));
  await expect(page.getByTestId('project-bind')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('project binding discards a directory selection made for the previous project', async () => {
  await page.evaluate(() => window.mount('project'));
  await page.getByTestId('project-bind').evaluate(button => {button.click();button.click();});
  assert.equal(await page.evaluate(() => window.calls.pick), 1);
  await page.evaluate(() => window.selectProject('b'));
  await page.evaluate(async () => {window.resolve('pick', 0, {path:'/previous-project'});await Promise.resolve();});
  assert.deepEqual(await page.evaluate(() => window.updates), []);
  assert.deepEqual(await page.evaluate(() => window.bound), []);
});

test('project binding keeps submitted writes but drops callbacks and errors after a project switch', async () => {
  await page.evaluate(() => window.mount('project'));
  await page.getByTestId('project-bind').click();
  await page.evaluate(() => window.resolve('pick', 0, {path:'/project-a'}));
  await expect.poll(() => page.evaluate(() => window.updates.length)).toBe(1);
  await page.evaluate(() => window.selectProject('b'));
  await page.evaluate(async () => {window.resolve('update', 0, {id:'a',workspacePath:'/project-a'});await Promise.resolve();});
  assert.deepEqual(await page.evaluate(() => window.bound), []);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
