import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as esbuild from 'esbuild';

let directory, api;
before(async()=>{
  directory=mkdtempSync(join(tmpdir(),'roc-zotero-dialog-contract-'));
  const file=join(directory,'api.mjs');
  await esbuild.build({stdin:{contents:`
    export {pickZoteroAttachment} from './src/main/plugins/research/zotero-attachment-dialog';
    export {calls, setResult, setWindow, resolveChoice, waitForChoice} from 'electron';
  `,resolveDir:process.cwd()},outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent',
  plugins:[{name:'explicit-native-dialog-contract',setup(build){
    build.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'native-dialog-contract'}));
    build.onLoad({filter:/.*/,namespace:'native-dialog-contract'},()=>({loader:'js',contents:`
      export const calls=[];
      let result={canceled:false,filePaths:['/selected/input.pdf']}, pending=null, missing=false, notify, started;
      const window={isDestroyed:()=>false};
      export const webContents={fromId:id=>id===401 ? {id} : undefined};
      export const BrowserWindow={fromWebContents:sender=>sender.id===401 && !missing ? window : null};
      export const dialog={showOpenDialog:(parent,options)=>{
        calls.push({owner:parent===window,options});
        notify();
        return result==='pending' ? new Promise(resolve=>pending=resolve) : Promise.resolve(result);
      }};
      export const setResult=value=>{result=value;calls.length=0;started=new Promise(resolve=>notify=resolve);};
      export const waitForChoice=()=>started;
      export const setWindow=value=>{missing=value;};
      export const resolveChoice=value=>pending(value);
    `}));
  }}]});
  api=await import(file);
});
after(()=>rmSync(directory,{recursive:true,force:true}));
const context={owner:'window:401',projectId:'project-a'};

test('native chooser contract binds trusted renderer window and one explicit default file; cancellation stays cancellation',async()=>{
  api.setResult({canceled:false,filePaths:['/selected/input.pdf']});
  const path='/inspection/input.pdf', signal=new AbortController().signal;
  assert.equal(await api.pickZoteroAttachment(context,path,signal),'/selected/input.pdf');
  assert.deepEqual(api.calls,[{owner:true,options:{title:'授权读取 Zotero 附件',buttonLabel:'授权读取',
    defaultPath:path,message:`仅授权读取此附件文件：${path}`,properties:['openFile']}}]);
  api.setResult({canceled:true,filePaths:[]});
  assert.equal(await api.pickZoteroAttachment(context,path,signal),null);
  for(const paths of [[],['/one.pdf','/two.pdf']]){
    api.setResult({canceled:false,filePaths:paths});
    await assert.rejects(api.pickZoteroAttachment(context,path,signal),/zotero_attachment_single_file_required/u);
  }
  api.setResult({canceled:false,filePaths:['/selected/input.pdf']});
  for(const owner of ['thread:agent','window:402']){
    await assert.rejects(api.pickZoteroAttachment({...context,owner},path,signal),/zotero_attachment_window_required/u);
  }
  api.setWindow(true);
  await assert.rejects(api.pickZoteroAttachment(context,path,signal),/zotero_attachment_window_required/u);
  api.setWindow(false);
  assert.equal(api.calls.length,0);
});

test('cancelled task stops waiting on the native chooser and late native selection cannot become an accepted choice',async()=>{
  api.setResult('pending');
  const controller=new AbortController();
  const pending=api.pickZoteroAttachment(context,'/inspection/input.pdf',controller.signal);
  const refusal=assert.rejects(pending,/synthetic task stopped/u);
  await api.waitForChoice();
  controller.abort(new Error('synthetic task stopped'));
  await refusal;
  api.resolveChoice({canceled:false,filePaths:['/selected/input.pdf']});
  api.setResult({canceled:false,filePaths:['/selected/input.pdf']});
  await assert.rejects(api.pickZoteroAttachment(context,'/inspection/input.pdf',controller.signal),/synthetic task stopped/u);
  assert.equal(api.calls.length,0);
});
