import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/zotero-import-ui');
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-zotero-import-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await esbuild.build({stdin: {contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, MotionConfig, domAnimation} from 'motion/react';
    import {ImportDialog} from './src/renderer/literature/ImportDialog';
    const root = createRoot(document.getElementById('root'));
    const at = '2026-11-04T00:00:00.000Z';
    const ok = data => ({ok:true,data});
    const fail = message => ({ok:false,error:{message}});
    let generation = 0;
    const originals = Array.from({length:43}, (_,i) => {
      const key = 'ITEM' + String(i).padStart(4,'0');
      const itemType = i===2 ? 'attachment' : i===3 ? 'note' : 'journalArticle';
      return {key,version:8,data:{key,version:8,itemType,title:i===4 ? null : 'Synthetic object '+i,
        DOI:'10.1234/synthetic',creators:[{creatorType:'author',name:'Synthetic Author'}],
        tags:[{tag:'external-tag'}],collections:['COLL0000'],...(i===2 ? {parentItem:'ITEM0000'} : {}),
        unknownFutureField:{retained:true}},csljson:JSON.stringify([{id:key,type:'article-journal',title:'Synthetic object '+i}])};
    });
    function result(input, mode) {
      const items = input.entries.map((entry,i) => ({entryKey:entry.itemKey,inputPositions:[i],
        libraryItemId:mode==='cancelled' ? null : 'paper-'+i,citationKey:mode==='cancelled' ? null : 'Key'+i,
        disposition:mode==='cancelled' ? 'cancelled' : mode==='partial' && i===1 ? 'failed' : 'created',
        metadataUpdated:false,errorCode:mode==='partial' && i===1 ? 'literature_metadata_import_failed' : null,
        retryable:mode==='partial' && i===1,metadata:mode==='cancelled' ? 'not_requested' : mode==='partial' && i===1 ? 'failed' : 'ready',
        attachment:'not_requested',parse:'not_requested',index:{scope:'metadata',keyword:'ready',vector:'not_requested'}}));
      const failed = items.filter(i=>i.disposition==='failed').length;
      return {operationId:'operation-'+input.requestId,requestId:input.requestId,status:mode==='cancelled' ? 'cancelled' : failed ? 'partial' : 'completed',
        destinationProjectId:input.projectId,requestedCount:items.length,processedCount:items.length,nextOffset:null,items,
        counts:{created:items.filter(i=>i.disposition==='created').length,linked:0,alreadyPresent:0,skippedArchived:0,failed,
          cancelled:items.filter(i=>i.disposition==='cancelled').length,notProcessed:0}};
    }
    function createClient(scenario) {
      const snapshots = new Map();
      const imported = new Map();
      let sync = null;
      const call = (method,input,work) => {window.calls.push({method,input});return work();};
      const client = {api:{research:{
        findZoteroSync: input => call('syncFind',input,async()=>{
          if(scenario.staleSyncFind && input.collectionKey===null) return new Promise(resolve=>{
            window.finishSyncFind=()=>resolve(ok({syncId:'old-find',scope:{serverId:input.serverId,library:input.library},
              collectionKey:null,mode:'incremental',limit:20,revision:1,status:'paused',checkpointVersion:null,
              since:null,targetVersion:20,total:43,nextOffset:0,pendingPreviewId:null,errorCode:null,createdAt:at,updatedAt:at}));
          });
          return ok(sync);
        }),
        readZoteroSync: input => call('syncReadState',input,async()=>ok(sync)),
        startZoteroSync: input => call('syncStart',input,async()=>{
          sync={syncId:'synthetic-sync',scope:{serverId:input.serverId,library:input.library},collectionKey:input.collectionKey,
            mode:input.mode,limit:input.limit,revision:0,status:'active',checkpointVersion:null,since:null,
            targetVersion:null,total:null,nextOffset:0,pendingPreviewId:null,errorCode:null,createdAt:at,updatedAt:at};
          return ok(sync);
        }),
        captureZoteroSyncPage: input => call('syncPage',input,async()=>{
          if(scenario.syncPageError) {
            if(scenario.syncPageError==='reset') sync={...sync,revision:sync.revision+1,status:'reset_required',errorCode:'zotero_library_version_changed'};
            return fail('Synthetic interrupted source read');
          }
          const result=await client.api.research.previewZotero({...sync.scope,projectId:input.projectId,
            expectedLibraryVersion:sync.targetVersion,collectionKey:sync.collectionKey,since:sync.since,offset:sync.nextOffset,limit:sync.limit});
          sync={...sync,revision:sync.revision+1,targetVersion:20,total:43,pendingPreviewId:result.data.previewId};
          return ok({sync,preview:result.data,importedKeys:[]});
        }),
        readZoteroSyncPage: input => call('syncReadPage',input,async()=>{
          if(scenario.syncReadError) return fail('Synthetic saved preview expired');
          const snapshot=snapshots.get(sync.pendingPreviewId);
          return ok({sync,preview:{...snapshot,nextPreviewOffset:snapshot.capturedTotal>30 ? 30 : null,
            sourcePage:{...snapshot.sourcePage,records:snapshot.sourcePage.records.slice(0,30)}},
            importedKeys:[...(imported.get(sync.pendingPreviewId) || [])]});
        }),
        controlZoteroSync: input => call('syncControl',input,async()=>{
          sync={...sync,revision:sync.revision+1,status:input.action==='pause' ? 'paused' : input.action==='resume' ? 'active' : 'reset_required',
            errorCode:input.action==='abandon' ? 'zotero_sync_abandoned' : null};
          return ok(sync);
        }),
        acknowledgeZoteroSync: input => call('syncAck',input,async()=>{
          if(scenario.syncAckError) return fail('Synthetic checkpoint transaction failed');
          const snapshot=snapshots.get(input.previewId);
          sync={...sync,revision:sync.revision+1,status:snapshot.sourcePage.nextOffset===null ? 'completed' : 'active',
            checkpointVersion:snapshot.sourcePage.nextOffset===null ? 20 : sync.checkpointVersion,
            nextOffset:snapshot.sourcePage.nextOffset ?? snapshot.sourcePage.offset+snapshot.capturedTotal,pendingPreviewId:null};
          return ok(sync);
        }),
        probeZotero: input => call('probe',input,async()=>ok(scenario.connection ?
          {status:scenario.connection,errorCode:'synthetic_'+scenario.connection,checkedAt:at} :
          {status:'connected',serverId:'synthetic-instance',apiVersion:3,schemaVersion:40,checkedAt:at})),
        getZoteroGroups: input => call('groups',input,async()=>ok({serverId:input.serverId,offset:input.offset,total:23,
          records:Array.from({length:Math.min(20,23-input.offset)},(_,i)=>({id:100+input.offset+i,version:1,
            data:{id:100+input.offset+i,name:'Synthetic group '+(input.offset+i)}})),
          nextOffset:input.offset===0 ? 20 : null,responseHash:'a'.repeat(64),fetchedAt:at})),
        getZoteroCollections: input => call('collections',input,async()=>scenario.collectionError && input.offset>0 ?
          fail('Zotero library version changed; reread the source') :
          ok({serverId:input.serverId,library:input.library,offset:input.offset,libraryVersion:20,total:23,nextOffset:input.offset===0 ? 20 : null,responseHash:'b'.repeat(64),fetchedAt:at,
            records:Array.from({length:Math.min(20,23-input.offset)},(_,i)=>{const key='COLL'+String(input.offset+i).padStart(4,'0');
              return {key,version:8,data:{key,version:8,name:'Synthetic collection '+(input.offset+i),parentCollection:false}};})})),
        previewZotero: input => call('preview',input,async()=>{
          if (scenario.previewError || scenario.nextSourceError && input.offset>0) return fail('Synthetic Zotero source disconnected');
          const records = structuredClone(originals.slice(input.offset,input.offset+input.limit));
          if (scenario.long && records.length) records[0].data.title = '长题名与来源字段'.repeat(80);
          const {projectId, ...request} = input;
          const snapshot = {schemaVersion:2,projection:'data,csljson',previewId:'preview-'+window.calls.length,
            request,createdAt:at,expiresAt:'2026-11-11T00:00:00.000Z',contentHash:'c'.repeat(64),
            capturedTotal:records.length,nextPreviewOffset:records.length>20 ? 20 : null,
            sourcePage:{serverId:input.serverId,library:input.library,libraryVersion:20,offset:input.offset,
              total:43,nextOffset:input.offset+records.length<43 ? input.offset+records.length : null,
              responseHash:'d'.repeat(64),fetchedAt:at,records}};
          snapshots.set(snapshot.previewId,snapshot);
          return ok({...snapshot,sourcePage:{...snapshot.sourcePage,records:records.slice(0,20)}});
        }),
        getZoteroPreview: input => call('readPreview',input,async()=>{
          const snapshot = snapshots.get(input.previewId);
          const end = input.offset+input.limit;
          return ok({...snapshot,nextPreviewOffset:end<snapshot.capturedTotal ? end : null,
            sourcePage:{...snapshot.sourcePage,records:snapshot.sourcePage.records.slice(input.offset,end)}});
        }),
        reviewZotero: input => call('review',input,async()=>{
          if(scenario.reviewError) return fail('Synthetic scoped source review failed');
          const snapshot=snapshots.get(input.previewId);
          const items=input.itemKeys.map(key=>{
            const item=snapshot.sourcePage.records.find(item=>item.key===key);
            const metadata={id:'zotero:'+key,externalId:key,source:'zotero',doi:'10.1234/synthetic',title:item.data.title,
              authors:['Synthetic Author'],abstract:null,publishedYear:null,citationCount:null,url:null,openAccessUrl:null,
              importedAt:at,updatedAt:at};
            const local=scenario.reviewDifference || scenario.reviewState || scenario.archived ? {
              id:'local-paper',revision:3,archived:scenario.archived===true,updatedAt:at,
              metadata:{...metadata,title:'Existing canonical title'},
              bibliography:{citationKey:'LocalKey',entryType:'article',title:'Existing canonical title',authors:metadata.authors,
                doi:metadata.doi,abstract:null,publishedYear:2024,url:null,preambles:[],csl:null,
                fields:{note:'User local note',keywords:'user-local-tag'}}
            } : null;
            return {source:{previewId:input.previewId,scope:{serverId:snapshot.sourcePage.serverId,library:snapshot.sourcePage.library},
                libraryVersion:20,item,itemHash:'e'.repeat(64),metadata,cslJson:item.csljson,capturedAt:at},
              objectState:scenario.reviewState || (local===null ? 'new' : 'new_version'),
              mappedVersion:local===null ? null : scenario.reviewState==='version_regressed' ? 9 : scenario.reviewState==='version_conflict' ? 8 : 7,local,
              previousScopedSource:local===null ? null : {scope:{serverId:snapshot.sourcePage.serverId,library:snapshot.sourcePage.library},
                itemKey:key,version:7,libraryVersion:19,operationId:'prior-operation',libraryItemId:local.id,itemHash:'f'.repeat(64),
                previewId:'prior-preview',capturedAt:at,importedAt:at,item:{...item,version:7,data:{...item.data,version:7}}},
              differences:local===null ? [] : [{field:'title',source:item.data.title,local:local.metadata.title}]};
          });
          const output={previewId:input.previewId,scope:{serverId:snapshot.sourcePage.serverId,library:snapshot.sourcePage.library},
            libraryVersion:20,reviewedAt:at,policy:'retain_existing_fill_missing',items};
          if(scenario.staleReview && input.itemKeys.length===1 && window.calls.filter(call=>call.method==='review').length===1) {
            return new Promise(resolve=>window.finishReview=()=>resolve(ok({...output,items:output.items.map(item=>({...item,objectState:'version_conflict'}))})));
          }
          return ok(output);
        }),
        addLiterature: input => call('add',input,async()=>{
          window.lastAdd = input;
          if(scenario.failOnce && window.calls.filter(call=>call.method==='add').length===1) return fail('Synthetic bridge response lost');
          if(scenario.defer) return new Promise(resolve=>window.finishAdd = mode=>resolve(ok(result(input,mode))));
          const completed=result(input,scenario.partial && input.entries.length>1 ? 'partial' : 'completed');
          completed.items.filter(item=>['created','linked','already_present'].includes(item.disposition)).forEach(item=>{
            const entry=input.entries[item.inputPositions[0]];
            if(!imported.has(entry.previewId)) imported.set(entry.previewId,new Set());
            imported.get(entry.previewId).add(entry.itemKey);
          });
          return ok(completed);
        }),
        getLiteratureImport: input => call('getImport',input,async()=>ok({...result(window.lastAdd,'completed'),status:'running'})),
        cancelLiteratureImport: input => call('cancel',input,async()=>ok({...result(window.lastAdd,'completed'),status:'running'}))
      }}};
      return client;
    }
    function Harness({scenario}) {
      const [open,setOpen] = useState(false);
      const [client] = useState(()=>createClient(scenario));
      return <><button id="open" onClick={()=>setOpen(true)}>导入</button>
        <ImportDialog open={open} initialTab="document" onClose={()=>setOpen(false)}
          client={client} projectId={scenario.projectId === undefined ? 'project-a' : scenario.projectId} onZoteroImported={()=>window.reloads++}
          selectedItem={null} canAttachToSelection={false} pickFile={async()=>null}
          importDoi={async()=>({ok:true,createdCount:0,duplicateCount:0})}
          importBibliographyFile={async()=>({ok:true,createdCount:0,duplicateCount:0})}
          importRecord={async()=>({ok:true,createdCount:0,duplicateCount:0})}
          searchLiterature={async()=>({ok:false,message:'not used'})} addCandidate={async()=>({ok:false,message:'not used'})}
          addDocumentToNewItem={async()=>({ok:false,message:'not used'})} addDocumentToItem={async()=>({ok:false,message:'not used'})}/>
      </>;
    }
    window.mount = scenario=>{
      window.calls=[];window.reloads=0;
      flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
        <Harness key={++generation} scenario={scenario}/></LazyMotion></MotionConfig>));
    };
  `, resolveDir: process.cwd(), loader: 'tsx'}, outfile: join(directory, 'app.js'),
    bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(file => file.endsWith('.css'))
    .map(file => readFileSync(join(assets, file), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}</style>
    <div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow} = require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory,'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForFunction(()=>typeof window.mount==='function');
});
after(async()=>{
  try {await app?.close();} finally {if(directory) rmSync(directory,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
});
async function open(scenario = {}) {
  await page.evaluate(scenario=>mount(scenario),scenario);
  await reopen();
}
async function reopen() {
  await page.locator('#open').click();
  await page.getByTestId('literature-import-tab-document').focus();
  await page.keyboard.press('End');
  await page.getByTestId('literature-import-panel-zotero').waitFor();
  await page.waitForFunction(()=>{
    const panel=document.querySelector('[data-testid="literature-import-dialog-panel"]');
    return panel && getComputedStyle(panel).opacity==='1' && getComputedStyle(panel).transform==='none';
  });
}
async function connect() {
  await page.getByTestId('literature-zotero-connect').click();
  await page.getByTestId('literature-zotero-preview').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('[data-testid="literature-zotero-preview"]').disabled);
}
const row = key => page.locator(`[data-testid="literature-zotero-object"][data-item-key="${key}"]`);
async function preview(limit = '30') {
  await connect();
  await page.getByTestId('literature-zotero-limit').selectOption(limit);
  await page.getByTestId('literature-zotero-preview').click();
  await page.getByTestId('literature-zotero-object').first().waitFor();
}
async function inspect(label) {
  const source=readFileSync(join(process.cwd(),'.agents/skills/desktop-agent-ui/scripts/clip-audit.js'),'utf8');
  const audit=await page.evaluate(`(${source})({root:'body',viewport:true})`);
  writeFileSync(join(artifacts,`${label}-audit.json`),JSON.stringify(audit,null,2));
  assert.equal(audit.cut,0);
  assert.equal(audit.hidden,0);
  await page.screenshot({path:join(artifacts,`${label}.png`)});
}
test('Zotero import keyboard path reviews paginated groups collections and source objects before selected import and partial retry',async()=>{
  await open({partial:true});
  assert.deepEqual(await page.evaluate(()=>calls),[]);
  await connect();
  await page.getByRole('button',{name:'下一页群组',exact:true}).click();
  await page.getByTestId('literature-zotero-library-group-120').check();
  await page.getByRole('button',{name:'下一页集合',exact:true}).click();
  await page.getByTestId('literature-zotero-collection').selectOption('COLL0020');
  await page.getByTestId('literature-zotero-limit').selectOption('30');
  await page.getByTestId('literature-zotero-preview').click();
  await row('ITEM0000').waitFor();
  const input=await page.evaluate(()=>calls.find(call=>call.method==='preview').input);
  assert.deepEqual(input,{serverId:'synthetic-instance',library:{kind:'group',id:120},projectId:'project-a',
    expectedLibraryVersion:20,collectionKey:'COLL0020',since:null,offset:0,limit:30});
  assert.equal(await page.getByTestId('literature-zotero-object').count(),20);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='add').length),0);
  assert.equal(await row('ITEM0002').locator('input').isDisabled(),true);
  assert.match(await row('ITEM0002').innerText(),/附件引用，尚未授权/u);
  assert.equal(await row('ITEM0003').locator('input').isDisabled(),true);
  assert.equal(await row('ITEM0004').locator('input').isDisabled(),true);
  await inspect('default');
  await row('ITEM0000').locator('summary').focus();
  await page.keyboard.press('Enter');
  await row('ITEM0000').locator('pre').waitFor({state:'visible'});
  assert.match(await row('ITEM0000').innerText(),/external-tag/u);
  assert.match(await row('ITEM0000').innerText(),/unknownFutureField/u);
  await inspect('expanded');
  await row('ITEM0000').locator('input').check();
  await row('ITEM0001').locator('input').check();
  await page.getByTestId('literature-zotero-more-preview').click();
  await row('ITEM0029').waitFor();
  assert.equal(await page.getByTestId('literature-zotero-object').count(),30);
  await row('ITEM0029').locator('input').check();
  await page.getByTestId('literature-zotero-import').hover();
  await inspect('hover');
  await page.getByTestId('literature-zotero-import').click();
  await page.getByTestId('literature-zotero-import-result').waitFor();
  const adds=await page.evaluate(()=>calls.filter(call=>call.method==='add').map(call=>call.input));
  assert.deepEqual(adds[0].entries.map(entry=>entry.itemKey),['ITEM0000','ITEM0001','ITEM0029']);
  assert.equal(adds[0].destination,'current_project');
  assert.match(await page.getByTestId('literature-zotero-import-result').innerText(),/literature_metadata_import_failed/u);
  await page.getByTestId('literature-zotero-retry').click();
  await page.waitForFunction(()=>calls.filter(call=>call.method==='add').length===2);
  await page.waitForFunction(()=>reloads===2);
  const retry=await page.evaluate(()=>calls.filter(call=>call.method==='add')[1].input);
  assert.deepEqual(retry.entries,[adds[0].entries[1]]);
  assert.notEqual(retry.requestId,adds[0].requestId);
  await page.getByTestId('literature-zotero-next-source').click();
  await row('ITEM0030').waitFor();
  assert.match(await page.getByTestId('literature-zotero-page-summary').innerText(),/31–43 \/ 43/u);
  const next=await page.evaluate(()=>calls.filter(call=>call.method==='preview')[1].input);
  assert.equal(next.offset,30);
  assert.equal(next.expectedLibraryVersion,20);
});
test('active import survives dialog close, cancels by its request lookup and waits for the final receipt',async()=>{
  await open({defer:true});
  await preview();
  await row('ITEM0000').locator('input').check();
  await page.getByTestId('literature-zotero-import').click();
  await page.getByTestId('literature-zotero-import-running').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('literature-import-dialog-panel').waitFor({state:'detached'});
  await reopen();
  await page.getByTestId('literature-zotero-cancel-import').click();
  await page.waitForFunction(()=>calls.some(call=>call.method==='cancel'));
  await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-cancel-import"]').textContent.includes('已请求取消'));
  assert.equal(await page.getByTestId('literature-zotero-import-result').count(),0);
  const calls=await page.evaluate(()=>window.calls);
  const added=calls.find(call=>call.method==='add').input;
  assert.deepEqual(calls.find(call=>call.method==='getImport').input,{projectId:'project-a',requestId:added.requestId,offset:0,limit:30});
  assert.deepEqual(calls.find(call=>call.method==='cancel').input,{projectId:'project-a',operationId:'operation-'+added.requestId});
  await page.evaluate(()=>finishAdd('cancelled'));
  await page.getByTestId('literature-zotero-import-result').waitFor();
  assert.match(await page.getByTestId('literature-zotero-import-result').innerText(),/已取消/u);
  assert.equal(await page.getByTestId('literature-zotero-import-running').count(),0);
});
test('failed reads show explicit source errors and clear old preview; changed collections cannot authorize a stale import',async()=>{
  await open({connection:'disabled'});
  await page.getByTestId('literature-zotero-connect').click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(),/未启用通信/u);
  assert.equal(await page.getByTestId('literature-zotero-preview').count(),0);
  await open({collectionError:true});
  await connect();
  await page.getByRole('button',{name:'下一页集合',exact:true}).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('literature-zotero-preview').isDisabled(),true);
  await open({nextSourceError:true});
  await preview();
  await page.getByTestId('literature-zotero-next-source').click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('literature-zotero-object').count(),0);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='add').length),0);
});
test('transport retry keeps the same request, library-only scope is explicit and old project output cannot reach a new dialog',async()=>{
  await open({failOnce:true,projectId:null});
  await preview();
  await row('ITEM0000').locator('input').check();
  await page.getByTestId('literature-zotero-import').click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(),/Synthetic bridge response lost/u);
  assert.equal(await row('ITEM0000').locator('input').isChecked(),true);
  await page.getByTestId('literature-zotero-import').click();
  await page.getByTestId('literature-zotero-import-result').waitFor();
  const adds=await page.evaluate(()=>calls.filter(call=>call.method==='add').map(call=>call.input));
  assert.equal(adds[0].projectId,null);
  assert.equal(adds[0].destination,'library_only');
  assert.equal(adds[0].requestId,adds[1].requestId);
  assert.equal(await page.evaluate(()=>reloads),1);
  await open({defer:true,projectId:'project-a'});
  await preview();
  await row('ITEM0000').locator('input').check();
  await page.getByTestId('literature-zotero-import').click();
  await page.getByTestId('literature-zotero-import-running').waitFor();
  await page.evaluate(()=>window.finishOld=window.finishAdd);
  await open({projectId:'project-b'});
  await page.evaluate(()=>finishOld('completed'));
  assert.equal(await page.getByTestId('literature-zotero-import-result').count(),0);
  assert.equal(await page.evaluate(()=>reloads),0);
  assert.deepEqual(await page.evaluate(()=>calls),[]);
});
test('local/source differences retain both sides and stale or failed comparison never authorizes selected import',async()=>{
  await open({reviewDifference:true});
  await preview();
  await row('ITEM0000').locator('input').check();
  await page.getByTestId('literature-zotero-source-review').waitFor();
  const reviewed=page.getByTestId('literature-zotero-reviewed-object');
  await reviewed.locator(':scope > summary').click();
  await reviewed.getByRole('table').waitFor({state:'visible'});
  const text=await reviewed.innerText();
  assert.match(text,/Synthetic object 0/u);
  assert.match(text,/Existing canonical title/u);
  assert.match(text,/本地版本 3/u);
  await reviewed.getByText('本地书目字段',{exact:true}).click();
  await page.getByTestId('literature-zotero-local-fields').locator('pre').waitFor({state:'visible'});
  assert.match(await reviewed.innerText(),/User local note/u);
  await reviewed.getByText('已收录的原始来源',{exact:true}).click();
  await page.getByTestId('literature-zotero-previous-source').locator('pre').waitFor({state:'visible'});
  assert.match(await reviewed.innerText(),/来源版本 7/u);
  const scrollLayout=await page.getByRole('dialog').evaluate(panel=>{
    const body=panel.children[1];
    const header=panel.children[0];
    return {panelScroll:panel.scrollTop,bodyScroll:body.scrollTop,
      panelTop:panel.getBoundingClientRect().top,headerTop:header.getBoundingClientRect().top,
      panelHeight:panel.clientHeight,panelContent:panel.scrollHeight,bodyHeight:body.clientHeight,bodyContent:body.scrollHeight,
      bodyStyle:{overflow:getComputedStyle(body).overflowY,minHeight:getComputedStyle(body).minHeight,flex:getComputedStyle(body).flex},
      children:[...panel.children].map(child=>({class:child.className,height:child.clientHeight,scroll:child.scrollHeight}))};
  });
  writeFileSync(join(artifacts,'source-local-scroll.json'),JSON.stringify(scrollLayout,null,2));
  assert.equal(scrollLayout.panelScroll,0);
  assert.equal(scrollLayout.headerTop,scrollLayout.panelTop+1);
  assert.ok(scrollLayout.bodyScroll>0);
  const dialogBody=page.getByRole('dialog').locator(':scope > div').nth(1);
  await dialogBody.evaluate(body=>{body.scrollTop=0;});
  const bodyBox=await dialogBody.boundingBox();
  await page.mouse.move(bodyBox.x+2,bodyBox.y+40);
  await page.mouse.wheel(0,300);
  await page.waitForFunction(()=>document.querySelector('[role="dialog"]').children[1].scrollTop>0);
  assert.equal(await page.getByRole('dialog').evaluate(panel=>panel.scrollTop),0);
  await reviewed.locator(':scope > summary').focus();
  await page.getByTestId('literature-import-dialog-close').isVisible().then(visible=>assert.equal(visible,true));
  await inspect('source-local-differences');
  assert.equal(await page.getByTestId('literature-zotero-import').isDisabled(),false);
  for(const scenario of [{reviewState:'version_conflict'},{reviewState:'identity_changed'},{reviewState:'version_regressed'},{archived:true},{reviewError:true}]){
    await open(scenario);
    await preview();
    await row('ITEM0000').locator('input').check();
    await page.waitForFunction(()=>calls.some(call=>call.method==='review'));
    assert.equal(await page.getByTestId('literature-zotero-import').isDisabled(),true);
    assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='add').length),0);
  }
  await open({staleReview:true});
  await preview();
  await row('ITEM0000').locator('input').check();
  await page.waitForFunction(()=>typeof finishReview==='function');
  assert.equal(await page.getByTestId('literature-zotero-import').isDisabled(),true);
  await row('ITEM0001').locator('input').check();
  await page.waitForFunction(()=>document.querySelectorAll('[data-testid="literature-zotero-reviewed-object"]').length===2);
  await page.evaluate(()=>finishReview());
  assert.equal(await page.getByTestId('literature-zotero-reviewed-object').count(),2);
  assert.equal(await page.getByTestId('literature-zotero-import').isDisabled(),false);
});
test('source page and selection caps are distinct and long originals remain usable across light dark drawer widths',async()=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await open({long:true});
  await preview('50');
  await page.getByTestId('literature-zotero-more-preview').click();
  await row('ITEM0039').waitFor();
  await page.getByTestId('literature-zotero-more-preview').click();
  await row('ITEM0042').waitFor();
  const keys=Array.from({length:33},(_,i)=>'ITEM'+String(i).padStart(4,'0')).filter(key=>!['ITEM0002','ITEM0003','ITEM0004'].includes(key));
  for(const key of keys) await row(key).locator('input').check();
  assert.equal(await row('ITEM0033').locator('input').isDisabled(),true);
  assert.match(await page.getByTestId('literature-zotero-import').innerText(),/30 篇/u);
  await row('ITEM0000').locator('summary').click();
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [1100,1099,800]){
      await page.setViewportSize({width,height:900});
      const list=page.getByRole('list',{name:'Zotero 预览对象'});
      await list.focus();
      await page.keyboard.press('End');
      await page.waitForFunction(()=>document.querySelector('ul[aria-label="Zotero 预览对象"]').scrollTop>0);
      const layout=await list.evaluate(element=>({
        overflow:element.scrollWidth>element.clientWidth,scrolled:element.scrollTop>0,
        outline:getComputedStyle(element).outlineWidth,
        minFont:Math.min(...[...document.querySelector('[data-testid="literature-import-panel-zotero"]').querySelectorAll('button,span,p,summary,pre,legend,label,select')].map(node=>parseFloat(getComputedStyle(node).fontSize)))
      }));
      assert.equal(layout.overflow,false);
      assert.equal(layout.scrolled,true);
      assert.notEqual(layout.outline,'0px');
      assert.ok(layout.minFont>=12);
      await inspect(theme+'-'+width);
    }
  }
});

test('sync UI restores a paused pending page and actual import receipts before explicit skips and next checkpoint',async()=>{
  await page.setViewportSize({width:1100,height:900});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await open();
  await connect();
  await page.getByTestId('literature-zotero-limit').selectOption('30');
  await page.getByTestId('literature-zotero-sync-start').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('核对中'));
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='syncPage').length),0);
  await page.getByTestId('literature-zotero-preview').click();
  await row('ITEM0000').waitFor();
  assert.equal(await page.getByTestId('literature-zotero-sync-confirm').isDisabled(),true);
  await row('ITEM0000').locator('input').check();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="literature-zotero-import"]').disabled);
  await page.getByTestId('literature-zotero-import').click();
  await page.waitForFunction(()=>document.querySelector('[data-item-key="ITEM0000"]').textContent.includes('本页已收录'));
  assert.equal(await row('ITEM0000').locator('input').isDisabled(),true);
  await page.getByTestId('literature-zotero-sync-pause').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('已暂停'));
  await page.getByTestId('literature-zotero-sync').scrollIntoViewIfNeeded();
  await inspect('sync-paused');
  await page.setViewportSize({width:1099,height:900});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await inspect('sync-paused-dark-1099');
  await page.setViewportSize({width:1100,height:900});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.getByTestId('literature-import-dialog-close').click();
  await page.getByTestId('literature-import-dialog-panel').waitFor({state:'detached'});
  await reopen();
  await page.getByTestId('literature-zotero-connect').click();
  await page.getByTestId('literature-zotero-sync-resume').waitFor();
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='syncPage').length),1);
  assert.equal(await page.getByTestId('literature-zotero-preview').isDisabled(),true);
  await page.getByTestId('literature-zotero-sync-open').click();
  await row('ITEM0029').waitFor();
  assert.equal(await row('ITEM0000').locator('input').isDisabled(),true);
  await page.getByTestId('literature-zotero-sync-resume').click();
  await page.getByTestId('literature-zotero-sync-confirm').waitFor();
  await page.getByTestId('literature-zotero-sync-skip-reason').fill('Excluded after reading this source page');
  await page.getByTestId('literature-zotero-sync-confirm').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('已确认 30'));
  const firstAck=await page.evaluate(()=>calls.find(call=>call.method==='syncAck').input);
  assert.deepEqual(firstAck.importedKeys,['ITEM0000']);
  assert.equal(firstAck.skipped.length,29);
  assert.ok(firstAck.skipped.every(item=>item.reason==='Excluded after reading this source page'));
  assert.equal(await page.getByTestId('literature-zotero-object').count(),0);
  await page.getByTestId('literature-zotero-preview').click();
  await row('ITEM0042').waitFor();
  await page.getByTestId('literature-zotero-sync-skip-reason').fill('Excluded after reading the final page');
  await page.getByTestId('literature-zotero-sync-confirm').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('本次核对完成'));
  assert.match(await page.getByTestId('literature-zotero-sync').innerText(),/已确认 43.*完整版本 20/u);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='add').length),1);
  await inspect('sync-complete');
});

test('sync cannot acknowledge undisplayed objects or failed reads and checkpoint writes',async()=>{
  for(const scenario of [{syncPageError:true},{syncPageError:'reset'},{syncReadError:true},{syncAckError:true},{}]){
    await open(scenario);
    await connect();
    await page.getByTestId('literature-zotero-limit').selectOption('50');
    await page.getByTestId('literature-zotero-sync-start').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('核对中'));
    await page.getByTestId('literature-zotero-preview').click();
    if(scenario.syncPageError){
      await page.getByText('Synthetic interrupted source read',{exact:true}).waitFor();
      assert.equal(await page.getByTestId('literature-zotero-object').count(),0);
      if(scenario.syncPageError==='reset'){
        await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('需要重新建立核对'));
        assert.equal(await page.getByTestId('literature-zotero-sync-start').isDisabled(),false);
        assert.equal(await page.getByTestId('literature-zotero-sync-rebaseline').count(),1);
        await page.getByTestId('literature-zotero-sync-rebaseline').click();
        await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('本次按当前来源版本'));
        assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='syncStart').at(-1).input.mode),'rebaseline');
      }
    }else if(scenario.syncReadError){
      await row('ITEM0000').waitFor();
      await page.getByTestId('literature-zotero-sync-open').click();
      await page.getByText('Synthetic saved preview expired',{exact:true}).waitFor();
      assert.equal(await page.getByTestId('literature-zotero-object').count(),0);
    }else{
      await row('ITEM0000').waitFor();
      await page.getByTestId('literature-zotero-sync-skip-reason').fill('Excluded');
      assert.equal(await page.getByTestId('literature-zotero-sync-confirm').isDisabled(),true);
      while(await page.getByTestId('literature-zotero-more-preview').count()) await page.getByTestId('literature-zotero-more-preview').click();
      await row('ITEM0042').waitFor();
      if(scenario.syncAckError){
        await page.getByTestId('literature-zotero-sync-confirm').click();
        await page.getByText('Synthetic checkpoint transaction failed',{exact:true}).waitFor();
        assert.equal(await page.getByTestId('literature-zotero-object').count(),43);
        assert.match(await page.getByTestId('literature-zotero-sync').innerText(),/已确认 0/u);
      }else{
        await page.getByTestId('literature-zotero-sync-pause').click();
        await page.getByTestId('literature-zotero-sync-abandon').click();
        await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('需要重新建立核对'));
        assert.equal(await page.getByTestId('literature-zotero-object').count(),0);
      }
    }
    assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='add').length),0);
  }
});

test('late sync lookup from the previous collection cannot replace the current scope',async()=>{
  await open({staleSyncFind:true});
  await connect();
  await page.waitForFunction(()=>typeof finishSyncFind==='function');
  await page.getByTestId('literature-zotero-collection').selectOption('COLL0001');
  await page.waitForFunction(()=>calls.some(call=>call.method==='syncFind' && call.input.collectionKey==='COLL0001'));
  await page.evaluate(()=>finishSyncFind());
  assert.equal(await page.getByTestId('literature-zotero-sync-resume').count(),0);
  await page.getByTestId('literature-zotero-sync-start').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="literature-zotero-sync"]').textContent.includes('核对中'));
  assert.equal(await page.evaluate(()=>calls.find(call=>call.method==='syncStart').input.collectionKey),'COLL0001');
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.method==='add' || call.method==='syncPage').length),0);
});
