import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors=[];
const clipAudit=await readFile('scripts/ui-audit/clip-audit.js','utf8');
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-task-center-'));
  await buildViteRenderer({directory,plugins:[tailwindcss()],style:'html,body,#root{height:100%;margin:0}#root{width:720px;padding:16px;box-sizing:border-box}',script:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useTaskCenter} from './src/renderer/management/use-task-center';
    import {TaskCenterOverview} from './src/renderer/management/TaskCenterOverview';
    import './src/renderer/styles/index.css';
    import './src/renderer/management/management-layout.css';
    const ok=data=>({ok:true,data}), updatedAt='2026-11-20T00:00:00.000Z';
    const task=(id,status,projectId='a')=>({schemaVersion:3,id,projectId,goal:'Research '+id,status,statusReason:null,rootAgentRunId:null,createdAt:updatedAt,updatedAt});
    window.research=[task('running','active'),task('approval','waiting_approval'),task('done','completed')];
    const job=(id,status)=>({id,projectId:'a',libraryItemId:'paper-'+id,title:'Paper '+id,generation:'generation',stage:'parse',status,attempts:1,nextRetryAt:null,documentId:null,receipt:null,errorCode:null,updatedAt});
    const client={api:{research:{
      listTasks:async({projectId})=>{
        if(window.deferResearch && projectId==='a')return new Promise(resolve=>{window.finishResearch=()=>resolve(ok({tasks:[task('obsolete','active')],hasMore:false,nextTaskId:null}));});
        return ok({tasks:projectId==='a'?window.research:[task('new-project','active','b')],hasMore:projectId==='a',nextTaskId:projectId==='a'?'done':null});
      },
      listAcquisition:async({projectId})=>window.failLiterature?{ok:false,error:{message:'Literature source unavailable'}}:
        ok({jobs:projectId==='a'?[job('queue','queued'),job('blocked','blocked')]:[],total:projectId==='a'?58:0,nextOffset:projectId==='a'?50:null}),
      onTaskUpdated:listener=>{window.emitResearch=listener;return()=>{};},
      onLibraryChanged:listener=>{window.emitLibrary=listener;return()=>{};}
    },tasks:{listBackgroundTasks:async()=>ok([
      {id:'background-failure',goal:'Background failure',status:'failed',workspacePath:'/a',updatedAt},
      {id:'other-workspace',goal:'Foreign workspace',status:'running',workspacePath:'/foreign',updatedAt}
    ]),onUpdated:listener=>{window.emitBackground=listener;return()=>{};}}}};
    window.opened=[];
    function Harness(){
      const [project,setProject]=useState('a');window.switchProject=setProject;
      const center=useTaskCenter(client,project,'/'+project);window.center=center;
      return <TaskCenterOverview center={center} onOpen={row=>window.opened.push(row)}/>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `});
  await writeFile(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory,'data'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:1000}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>window.center?.loading===false);
});
after(async()=>{try{await app?.close();}finally{if(directory)await rm(directory,{recursive:true,force:true});}assert.deepEqual(errors,[]);});

test('task center groups authoritative sources, scopes background work and exposes partial counts',async()=>{
  assert.deepEqual(await page.evaluate(()=>window.center.counts),{current:2,pending:2,completed:1,failed:1});
  assert.equal(await page.evaluate(()=>window.center.label),'近期 执行 2 / 待批准 1');
  await expect(page.getByTestId('mgmt-task-open-background:other-workspace')).toHaveCount(0);
  await expect(page.getByTestId('mgmt-task-source-literature')).toContainText('近期 2 项 / 共 58 项');
  await expect(page.getByTestId('mgmt-task-source-background')).toContainText('当前工作区');
  for(const key of ['research:approval','background:background-failure','literature:blocked']) {
    await page.getByTestId('mgmt-task-open-'+key).focus();await page.keyboard.press('Enter');
  }
  assert.deepEqual(await page.evaluate(()=>window.opened.map(row=>[row.source,row.id,row.libraryItemId])),[
    ['research','approval',null],['background','background-failure',null],['literature','blocked','paper-blocked']
  ]);
  for(const theme of ['light','dark'])for(const width of [440,720]) {
    await page.evaluate(({theme,width})=>{document.documentElement.dataset.theme=theme;document.getElementById('root').style.width=width+'px';},{theme,width});
    const layout=await page.getByTestId('mgmt-task-center').evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth}));
    assert.ok(layout.scroll<=layout.width+1,JSON.stringify({theme,width,layout}));
    await page.getByTestId('mgmt-task-open-research:running').hover();
    const audit=await page.evaluate('('+clipAudit+')({root:"#root",viewport:true})');
    assert.equal(audit.cut,0,JSON.stringify({theme,width,audit}));
  }
});

test('source failure keeps other tasks usable and a project switch rejects late data',async()=>{
  await page.evaluate(()=>{window.failLiterature=true;window.emitLibrary({affectedProjectIds:['a']});});
  await expect(page.getByTestId('mgmt-task-source-literature')).toContainText('Literature source unavailable');
  await expect(page.getByTestId('mgmt-task-open-research:running')).toBeEnabled();
  assert.equal(await page.evaluate(()=>window.center.label),'任务未更新');
  await page.evaluate(()=>{window.deferResearch=true;window.emitResearch({projectId:'a'});});
  await page.waitForFunction(()=>typeof window.finishResearch==='function');
  await page.evaluate(()=>{window.failLiterature=false;window.switchProject('b');});
  await expect(page.getByTestId('mgmt-task-open-research:new-project')).toBeVisible();
  await page.evaluate(()=>window.finishResearch());
  await expect(page.getByTestId('mgmt-task-open-research:obsolete')).toHaveCount(0);
  await expect(page.getByTestId('mgmt-task-open-background:background-failure')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>window.center.counts)).toEqual({current:1,pending:0,completed:0,failed:0});
});
