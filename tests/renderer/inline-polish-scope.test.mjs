import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron,expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory,app,page;
const errors=[];
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'roc-polish-scope-'));
  await buildViteRenderer({directory,style:'body{margin:24px}',script:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useInlinePolish} from './src/renderer/latex/use-inline-polish';
    import {useRunAttentionController} from './src/renderer/app/run-attention-controller';
    const ok=data=>({ok:true,data});
    const listeners=new Set();
    let currentWorkspace='/a',startResponse;
    const client={api:{
      research:{listTasks:async()=>ok({tasks:[],hasMore:false}),listAcquisition:async()=>ok({jobs:[],total:0,nextOffset:null}),
        onTaskUpdated:()=>()=>{},onLibraryChanged:()=>()=>{}},
      tasks:{listBackgroundTasks:async()=>ok([]),onUpdated:()=>()=>{}},
      workspace:{getCurrent:async()=>ok({path:currentWorkspace})},
      files:{preview:async()=>ok({relativePath:'main.tex',kind:'text',content:'Original',truncated:false})},
      chat:{onRunEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
        startRun:request=>{window.request=request;return new Promise(resolve=>{startResponse=resolve;});},
        replayRunEvents:async request=>ok({kind:'events',runId:request.runId,events:[]})}
    }};
    const literature={assistant:{threadId:null}};
    window.resolvePolish=()=>startResponse(ok({runId:'accepted-run',threadId:'accepted-thread',mode:'plan'}));
    window.emitTerminal=()=>{for(const listener of listeners)listener({type:'run_completed',runId:'accepted-run',threadId:'accepted-thread',
      assistantMessage:'Read-only narration. JSON follows.',validatedResponse:JSON.stringify({requestId:window.request.dispatchKey,replacement:'Better'})});};
    window.listenerCount=()=>listeners.size;
    function Fixture(){
      const [route,setRoute]=useState({projectId:'a',assistantOpen:false});
      const [workspacePath,setWorkspacePath]=useState('/a');
      const [writable,setWritable]=useState(true);
      const [note,setNote]=useState('');
      const attention=useRunAttentionController(client,{route,navigate:setRoute},workspacePath,literature);
      const scope={client,projectId:route.projectId,workspacePath,writable,workspaceStatus:'bound',adoptAcceptedRun:attention.adoptAcceptedRun};
      const polish=useInlinePolish({scope,canEdit:writable,filePath:'main.tex',draft:'Original',baseline:'Original',
        selection:{from:0,to:8,text:'Original',truncated:false},note:setNote});
      window.changeProject=projectId=>setRoute(current=>({...current,projectId}));
      window.changeWorkspace=path=>{currentWorkspace=path;setWorkspacePath(path);};
      window.changeWritable=setWritable;
      return <><button onClick={()=>void polish.start()}>Start</button><button onClick={polish.invalidate}>Discard</button>
        <output data-testid="thread">{attention.assistantThreadId??'none'}</output>
        <output data-testid="proposal">{polish.proposal?.replacement??'none'}</output>
        <output data-testid="note">{note}</output></>;
    }
    const root=createRoot(document.getElementById('root'));
    let epoch=0;
    window.reset=()=>{window.request=null;currentWorkspace='/a';root.render(<Fixture key={++epoch}/>);};
    window.reset();
  `});
  await writeFile(join(directory,'main.cjs'),`
    const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1200,height:800}).loadFile(${JSON.stringify(join(directory,'index.html'))}));
  `);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
});
after(async()=>{await app?.close();if(directory)await rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);});

async function startPending(){
  await page.evaluate(()=>window.reset());
  await expect(page.getByTestId('thread')).toHaveText('none');
  await page.getByRole('button',{name:'Start',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.request!==null)).toBe(true);
}

test('DOM events cannot adopt a thread; only the current internal start receipt opens its conversation',async()=>{
  await startPending();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('roc:inline-polish-started',{detail:{
    projectId:'a',workspacePath:'/a',requestId:window.request.dispatchKey,runId:'forged',threadId:'forged'}})));
  await expect(page.getByTestId('thread')).toHaveText('none');
  await page.evaluate(()=>window.resolvePolish());
  await expect(page.getByTestId('thread')).toHaveText('accepted-thread');
  await page.evaluate(()=>{window.emitTerminal();window.emitTerminal();});
  await expect(page.getByTestId('proposal')).toHaveText('Better');
  assert.equal(await page.evaluate(()=>window.listenerCount()),0);
});

for(const kind of ['project','workspace','readonly','discard']) {
  test(`${kind} invalidation rejects a late receipt, including switching away and back`,async()=>{
    await startPending();
    if(kind==='project') {
      await page.evaluate(()=>window.changeProject('b'));
      await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(0);
      await page.evaluate(()=>window.changeProject('a'));
    } else if(kind==='workspace') {
      await page.evaluate(()=>window.changeWorkspace('/b'));
      await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(0);
      await page.evaluate(()=>window.changeWorkspace('/a'));
    } else if(kind==='readonly') await page.evaluate(()=>window.changeWritable(false));
    else await page.getByRole('button',{name:'Discard'}).click();
    await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(0);
    await page.evaluate(()=>{window.resolvePolish();window.emitTerminal();});
    await expect(page.getByTestId('thread')).toHaveText('none');
    await expect(page.getByTestId('proposal')).toHaveText('none');
  });
}

test('an accepted request cannot propose edits after project or workspace scope changes',async()=>{
  await startPending();await page.evaluate(()=>window.resolvePolish());
  await expect(page.getByTestId('thread')).toHaveText('accepted-thread');
  await page.evaluate(()=>window.changeProject('b'));
  await expect.poll(()=>page.evaluate(()=>window.listenerCount())).toBe(0);
  await page.evaluate(()=>{window.changeProject('a');window.emitTerminal();});
  await expect(page.getByTestId('thread')).toHaveText('none');
  await expect(page.getByTestId('proposal')).toHaveText('none');
});
