import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-literature-automatic-workflow-'));
  await buildViteRenderer({
    directory,
    plugins: [tailwindcss()],
    style: 'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--ink)}#root{width:1280px;max-width:100%}',
    script: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
      import {LiteratureHubView} from './src/renderer/literature/LiteratureHubView';
      import {useLiteratureStore} from './src/renderer/literature/use-literature-store';
      import {useLiteratureImportActions} from './src/renderer/literature/use-literature-import-actions';
      import {LiteratureScopeProvider} from './src/renderer/literature/literature-scope';
      import {WorkspaceScopeProvider} from './src/renderer/app/workspace-scope';
      import {ViewActivity} from './src/renderer/shared/view-activity';
      import './src/renderer/styles/index.css';

      const ok=data=>({ok:true,data});
      const clone=value=>structuredClone(value);
      const timestamp='2026-11-27T00:00:00.000Z';
      const record=(index,extra={})=>({
        id:'paper-'+index,revision:1,archived:false,projectIds:['project-a','project-b'],
        updatedAt:new Date(Date.UTC(2026,10,27)-index*1000).toISOString(),
        metadata:{title:String(index).padStart(4,'0')+' Scientific evidence for a retained desktop reading workspace',
          authors:['Alexandria Researcher','Second Researcher'],publishedYear:2026,citationCount:null,
          doi:null,url:null,openAccessUrl:null,source:'local'},
        bibliography:{title:'Scientific evidence',citationKey:'researcher2026'+index,entryType:'article',
          fields:{journal:'Proceedings of Scientific Evidence'}},
        sources:[],...extra
      });
      const documentFor=(libraryItemId,status='ready',extra={})=>({
        id:'document-'+libraryItemId,libraryItemId,filename:'scientific-evidence.pdf',mediaType:'application/pdf',
        sourceHash:'a'.repeat(64),size:1024,status,currentParseId:status==='ready'?'parse-'+libraryItemId:null,
        activeParseId:status==='parsing'?'pending-'+libraryItemId:null,error:null,createdAt:timestamp,
        updatedAt:timestamp,...extra
      });
      const blocks=[
        {id:'heading',kind:'heading',label:'Introduction',text:'Evidence and understanding',
          locator:'page:1',locations:[],imageAssetId:null},
        {id:'paragraph',kind:'paragraph',label:'Introduction',
          text:'The source paper remains associated with its own reading and assistant actions. '.repeat(20),
          locator:'page:1',locations:[],imageAssetId:null}
      ];
      const root=createRoot(document.getElementById('root'));
      let world=null,nonce=0;

      function makeWorld(options={}){
        const current={
          options,calls:[],plans:new Map(),gates:new Map(),results:{},listeners:new Set(),captured:new Map(),
          records:new Map(Array.from({length:options.count??6},(_,index)=>{
            const item=record(index);return [item.id,item];
          })),
          documents:new Map(),sources:new Map(),indexStatuses:new Map(Object.entries(options.indexStatuses??{})),
          indexErrors:new Map(),
          jobs:[],store:null,importActions:null,renderCount:0,importCount:0,
          importReceipts:new Map(),importApplications:[],searches:new Map(),
          pickerPath:options.pickerPath??'/synthetic/Automatic study.pdf'
        };
        for(const [id,status] of Object.entries(options.documents??{'paper-0':'ready','paper-1':'ready'})){
          const document=documentFor(id,status);current.documents.set(document.id,document);
          current.sources.set(document.id,'original-source:'+id);
        }
        const gateFor=key=>{
          let gate=current.gates.get(key);
          if(!gate){
            let release;const promise=new Promise(resolve=>{release=resolve;});
            gate={promise,release,started:false,released:false};current.gates.set(key,gate);
          }
          return gate;
        };
        current.queue=(method,plan)=>{
          const plans=current.plans.get(method)??[];plans.push(plan);current.plans.set(method,plans);
          if(plan.gate)gateFor(plan.gate);
          if(plan.replyGate)gateFor(plan.replyGate);
        };
        current.release=key=>{
          const gate=gateFor(key);gate.released=true;gate.release();
        };
        const invoke=async(method,input,apply,before)=>{
          const plan=current.plans.get(method)?.shift()??{};
          current.calls.push({method,input:clone(input??null)});
          before?.(plan);
          if(plan.gate){const gate=gateFor(plan.gate);gate.started=true;await gate.promise;}
          if(plan.reject)throw new Error(plan.reject);
          if(plan.error)return {ok:false,error:{code:'fixture_failure',message:plan.error}};
          return ok(apply(plan));
        };
        const importSource=(input,plan,filename)=>{
          const libraryItemId=plan.libraryItemId??(input.target==='library-item'?input.libraryItemId:'imported-'+(++current.importCount));
          if(!current.records.has(libraryItemId)){
            const item=record(-current.importCount,{id:libraryItemId,projectIds:input.projectId?[input.projectId]:[],
              metadata:{...record(0).metadata,title:plan.title??input.title??filename},
              bibliography:{...record(0).bibliography,citationKey:input.citationKey??'imported-source'}});
            current.records.set(item.id,item);
          }
          const status=plan.status??'imported';
          const document=documentFor(libraryItemId,status,{
            id:plan.documentId??'document-'+libraryItemId,filename,
            ...(plan.currentParseId===null?{currentParseId:null}:{}),
            ...(plan.documentError?{error:plan.documentError}:{})
          });
          current.documents.set(document.id,document);
          if(!current.sources.has(document.id))current.sources.set(document.id,'original-source:'+libraryItemId);
          return clone(document);
        };
        const waitImportGate=async key=>{
          const gate=gateFor(key);gate.started=true;await gate.promise;
        };
        const addLiterature=async input=>{
          const plan=current.plans.get('addLiterature')?.shift()??{};
          current.calls.push({method:'addLiterature',input:clone(input)});
          const destinationProjectId=input.destination==='current_project'?input.projectId:null;
          const normalizedEntries=input.entries.map(entry=>entry.kind==='doi'
            ?{...entry,doi:entry.doi.trim().toLowerCase()}:entry);
          const fingerprint=JSON.stringify({destinationProjectId,entries:normalizedEntries,
            ingestionPolicy:input.ingestionPolicy});
          const key=JSON.stringify(['fixture-owner',input.projectId??null,input.requestId]);
          let operation=current.importReceipts.get(key);
          if(operation){
            if(operation.fingerprint!==fingerprint)throw new Error('fixture-import-request-conflict');
          }else{
            operation={fingerprint,input:clone(input),operationId:'operation-'+(current.importReceipts.size+1),
              result:null,promise:null};
            current.importReceipts.set(key,operation);
            const pending=operation;
            pending.promise=(async()=>{
              if(plan.gate)await waitImportGate(plan.gate);
              const counts={created:0,linked:0,alreadyPresent:0,skippedArchived:0,failed:0,cancelled:0,notProcessed:0};
              const items=normalizedEntries.map((entry,position)=>{
                let previous,entryKey;
                if(entry.kind==='doi'){
                  entryKey='doi:'+entry.doi;
                  previous=[...current.records.values()].find(item=>item.metadata.doi?.toLowerCase()===entry.doi);
                }else if(entry.kind==='candidate'){
                  const search=current.searches.get(entry.searchId);
                  if(!search||search.projectId!==input.projectId||Date.parse(search.result.expiresAt)<=Date.now()){
                    throw new Error('fixture-search-reference-expired');
                  }
                  const candidate=search.result.candidates.find(candidate=>candidate.candidateId===entry.candidateId);
                  if(!candidate)throw new Error('fixture-candidate-not-found');
                  entryKey=candidate.identity;
                  previous=current.records.get(candidate.matchedLibraryItemId);
                }else throw new Error('Unsupported fixture import entry: '+entry.kind);
                const disposition=plan.disposition??(previous?.archived?'skipped_archived':previous===undefined?'created'
                  :destinationProjectId!==null&&!previous.projectIds.includes(destinationProjectId)?'linked':'already_present');
                if(disposition==='created'){
                  const id='paper-doi-'+(++current.importCount);
                  previous=record(-current.importCount,{id,projectIds:destinationProjectId===null?[]:[destinationProjectId],
                    metadata:{...record(0).metadata,doi:entry.kind==='doi'?entry.doi:null}});
                  current.records.set(id,previous);
                }else if(disposition==='linked'){
                  previous={...previous,projectIds:[...new Set([...previous.projectIds,destinationProjectId])],
                    revision:previous.revision+1};
                  current.records.set(previous.id,previous);
                }
                const countKey={created:'created',linked:'linked',already_present:'alreadyPresent',
                  skipped_archived:'skippedArchived',failed:'failed',cancelled:'cancelled',not_processed:'notProcessed'}[disposition];
                if(countKey===undefined)throw new Error('Unsupported fixture import disposition: '+disposition);
                counts[countKey]++;
                return {entryKey,inputPositions:[position],libraryItemId:previous?.id??null,
                  citationKey:previous?.bibliography.citationKey??null,disposition,metadataUpdated:false,
                  errorCode:disposition==='failed'?'fixture-known-import-failed':null,retryable:disposition==='failed',
                  metadata:disposition==='failed'?'failed':'ready',attachment:'not_requested',parse:'not_requested',
                  index:{scope:'metadata',keyword:disposition==='failed'?'failed':'ready',vector:'not_requested'}};
              });
              pending.result={operationId:pending.operationId,requestId:input.requestId,
                status:plan.status??(counts.failed>0?'failed':'completed'),destinationProjectId,
                requestedCount:input.entries.length,processedCount:items.length,counts,items,nextOffset:null};
              current.importApplications.push({requestId:input.requestId,projectId:input.projectId,
                itemIds:items.map(item=>item.libraryItemId),counts:clone(counts)});
              return pending.result;
            })();
          }
          // The ledger shares an active promise or its durable receipt. Cache hits never relink.
          const result=await operation.promise;
          if(plan.replyGate)await waitImportGate(plan.replyGate);
          // A transport failure can arrive after the backend committed this cached operation.
          if(plan.reject)throw new Error(plan.reject);
          if(plan.error)return {ok:false,error:{code:'fixture_failure',message:plan.error}};
          return ok(clone(result));
        };
        const research={
          addLiterature,
          searchLiterature:input=>invoke('searchLiterature',input,()=>{
            const item=current.records.get('paper-1'),doi=item.metadata.doi??'10.1234/workflow-candidate';
            const metadata={...item.metadata,id:'crossref:'+doi,externalId:doi,source:'crossref',
              doi,abstract:null,importedAt:timestamp,updatedAt:timestamp};
            const candidate={candidateId:'candidate-paper-1',identity:'doi:'+doi,record:metadata,
              score:1/61,aliases:['doi:'+doi],identityConflicts:[],
              selectionReason:'source_priority_then_rank_then_metadata_hash',
              origins:[{source:'crossref',externalId:doi,rank:1,retrievedAt:timestamp,metadataHash:'a'.repeat(64),
                record:metadata,identifiers:[],rawIdentifiers:null,
                review:{publicationType:'journal-article',copies:[],retraction:{status:'unknown',field:null},updates:[]}}],
              contributions:[{source:'crossref',rank:1,score:1/61}],conflicts:[],versionRelations:[],
              matchedLibraryItemId:item.id,archived:item.archived,missingFields:[]};
            const searchId='search-'+(current.searches.size+1);
            const result={schemaVersion:14,strategy:null,executionId:'execution-'+searchId,
              ranking:{method:'rrf',version:1,k:60,sourceWeights:[{source:'crossref',weight:1}]},
              searchId,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60*60*1000).toISOString(),
              status:'complete',candidates:[candidate],sources:[],truncated:false,warnings:[],total:1,nextOffset:null};
            current.searches.set(searchId,{projectId:input.projectId,result:clone(result)});
            return result;
          }),
          listLibraryPage:input=>invoke('listLibraryPage',input,()=>{
            const query=(input.query??'').trim().toLowerCase();
            const all=[...current.records.values()].filter(item=>
              (input.projectId===null||item.projectIds.includes(input.projectId))&&
              (input.includeArchived||!item.archived)&&
              (!query||[item.metadata.title,item.bibliography.citationKey,...item.metadata.authors]
                .join(' ').toLowerCase().includes(query)))
              .sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt));
            const start=input.cursor===null||input.cursor===undefined?0:
              Math.max(0,all.findIndex(item=>item.id===input.cursor.id)+1);
            const limit=Math.min(input.limit??200,current.options.pageSize??200);
            const items=all.slice(start,start+limit),hasMore=start+items.length<all.length,last=items.at(-1);
            return {items:clone(items),total:all.length,hasMore,
              nextCursor:hasMore&&last?{id:last.id,updatedAt:last.updatedAt}:null};
          }),
          getLibraryItem:input=>invoke('getLibraryItem',input,()=>clone(current.records.get(input.id)??null)),
          listDocuments:input=>invoke('listDocuments',input,()=>clone([...current.documents.values()]
            .filter(document=>document.libraryItemId===input.libraryItemId))),
          getDocumentStatuses:input=>invoke('getDocumentStatuses',input,plan=>({
            items:input.libraryItemIds.map(libraryItemId=>({libraryItemId,
              documents:[...current.documents.values()].filter(document=>document.libraryItemId===libraryItemId)
                .map(document=>({id:document.id,status:document.status,currentParseId:document.currentParseId,
                  indexStatus:plan.indexStatus??current.indexStatuses.get(document.id)??'unavailable',
                  error:current.indexErrors.get(document.id)??document.error}))}))
          })),
          importDocument:input=>invoke('importDocument',input,plan=>
            importSource(input,plan,input.sourcePath.split('/').at(-1))),
          parseDocument:input=>invoke('parseDocument',input,plan=>{
            const previous=current.documents.get(input.documentId);
            if(!previous)throw new Error('Missing fixture document: '+input.documentId);
            const status=plan.status??'ready';
            const document={...previous,status,
              currentParseId:status==='ready'&&plan.currentParseId!==null?'parse-'+previous.libraryItemId:null,
              activeParseId:status==='parsing'?previous.activeParseId:null,
              error:plan.documentError??null};
            current.documents.set(document.id,document);
            return clone(plan.returnId?{...document,id:plan.returnId}:document);
          },()=>{
            const document=current.documents.get(input.documentId);
            if(document)current.documents.set(document.id,{...document,status:'parsing',
              activeParseId:'pending-'+document.libraryItemId,error:null});
          }),
          linkLibraryItem:input=>invoke('linkLibraryItem',input,()=>{
            const previous=current.records.get(input.id);
            if(!previous)throw new Error('Missing fixture paper: '+input.id);
            const projectIds=input.linked?[...new Set([...previous.projectIds,input.projectId])]
              :previous.projectIds.filter(id=>id!==input.projectId);
            const item={...previous,projectIds,revision:previous.revision+1};
            current.records.set(item.id,item);return clone(item);
          }),
          archiveLibraryItem:input=>invoke('archiveLibraryItem',input,()=>{
            const previous=current.records.get(input.id);
            const item={...previous,archived:input.archived,revision:previous.revision+1};
            current.records.set(item.id,item);return clone(item);
          }),
          wikiSnapshot:async()=>ok({claims:[],sources:[]}),
          onLibraryChanged:listener=>{current.listeners.add(listener);return()=>current.listeners.delete(listener);},
          getModelsStatus:async()=>ok({ready:false,error:null,models:[],downloading:false,selectedPack:'compact'}),
          listAcquisition:input=>invoke('listAcquisition',input,()=>{
            const jobs=current.jobs.filter(job=>input.libraryItemId===undefined||job.libraryItemId===input.libraryItemId);
            return {jobs:clone(jobs),total:jobs.length,nextOffset:null};
          }),
          resolveDocumentParse:input=>invoke('resolveDocumentParse',input,()=>clone(
            input.documentId?current.documents.get(input.documentId)??null:
              [...current.documents.values()].find(document=>document.libraryItemId===input.libraryItemId)??null)),
          getDocumentContent:input=>invoke('getDocumentContent',input,()=>({
            run:{id:input.parseId,documentId:input.documentId,status:'ready',error:null,createdAt:timestamp,finishedAt:timestamp},
            content:{sourceHash:'a'.repeat(64),pageCount:1,parseMode:'native-text',warnings:[],assets:[],blocks}
          })),
          listReadingNotes:async()=>ok([]),
          exportBibliography:input=>invoke('exportBibliography',input,()=>({content:'@article{fixture2026}',filename:'references.bib'})),
          searchWiki:async()=>ok({pages:[],nextOffset:null,mode:'keyword',degradation:null}),
          knowledgeJobs:async()=>ok([]),listIndexedFiles:async()=>ok([]),listIndexJobs:async()=>ok([]),
          getIndexStatus:async()=>ok({phase:'idle',generation:1,error:null,workspacePath:'/synthetic',
            lastScanAt:null,counts:{total:0,ready:0,queued:0,running:0,failed:0},
            settings:{revision:1,projectId:'project-a',paused:false,watch:false,kinds:[],include:[],
              exclude:[],embeddingConfigId:null}})
        };
        current.client={api:{research,files:{
          selectFromDialog:()=>invoke('selectFromDialog',null,()=>({filePaths:current.pickerPath?[current.pickerPath]:[]}))
        },chat:{startRun:input=>invoke('startRun',input,()=>({threadId:'thread-'+current.calls.length,runId:'run-'+current.calls.length}))}}};
        current.dropBridge={importPdf:(file,options)=>invoke('dropImport',{file:{name:file.name,type:file.type,size:file.size},options},
          plan=>importSource({target:'new-item',...options},plan,file.name))};
        current.emitChanged=(projectId='project-a')=>{
          for(const listener of current.listeners)listener({
            affectedProjectIds:[projectId],libraryItemIds:[...current.records.keys()],reason:'documents'
          });
        };
        current.snapshot=()=>{
          const store=current.store;
          return {projectId:store?.projectId??null,writable:store?.writable??null,
            itemIds:store?.items.map(item=>item.id)??[],total:store?.total??null,status:store?.status??null,
            query:store?.query??null,refreshing:store?.refreshing??null,
            selectedId:store?.selectedId??null,documents:clone(store?.documents??[]),
            documentsStatus:store?.documentsStatus??null,parseInFlight:store?.parseInFlight??null,
            documentStatuses:store?.documentStatuses instanceof Map
              ?clone([...store.documentStatuses]):[],
            action:clone(store?.action??{}),assistant:clone(store?.assistant??{}),
            calls:clone(current.calls),results:clone(current.results),records:clone([...current.records.values()]),
            importReceipts:[...current.importReceipts.values()].map(operation=>({
              input:clone(operation.input),result:clone(operation.result)})),
            importApplications:clone(current.importApplications),
            searches:clone([...current.searches.values()]),
            savedDocuments:clone([...current.documents.values()]),sources:Object.fromEntries(current.sources),
            gates:Object.fromEntries([...current.gates].map(([key,gate])=>[key,{started:gate.started,released:gate.released}])),
            renderCount:current.renderCount};
        };
        current.start=(operation,input,key)=>{
          const store=current.store;
          let promise;
          if(operation==='new-item')promise=store.addPdfToNewItem(input);
          else if(operation==='doi')promise=store.importDoi(input.doi);
          else if(operation==='candidate')promise=current.importActions.addCandidate(input.searchId,input.candidateId);
          else if(operation==='search')promise=current.importActions.searchLiterature(input.query,['crossref'],10);
          else if(operation==='attach')promise=store.addPdfToItem(input);
          else if(operation==='drop')promise=store.addDroppedPdf(new File(['%PDF-synthetic'],input?.name??'Automatic study.pdf',
            {type:input?.type??'application/pdf'}));
          else if(operation==='parse')promise=store.startParse(input.documentId,input.tier??null);
          else if(operation==='link')promise=store.linkItem(current.records.get(input.id),input.linked);
          else if(operation==='ask-item')promise=store.askAssistantAboutItem(current.records.get(input.id));
          else if(operation==='ask')promise=store.askAssistant(input.prompt);
          else if(operation==='export')promise=store.exportItem(current.records.get(input.id),input.format??'bibtex');
          else if(operation==='captured')promise=current.captured.get(input.key)();
          else throw new Error('Unknown workflow operation: '+operation);
          current.results[key]={settled:false};
          void Promise.resolve(promise).then(value=>{
            current.results[key]={settled:true,value:value??null};
          },error=>{current.results[key]={settled:true,rejection:String(error)};});
        };
        return current;
      }

      function StoreAndHub({current,scope,view}){
        const store=useLiteratureStore(current.client,scope.projectId,scope.writable);
        current.importActions=useLiteratureImportActions({store});
        current.store=store;current.renderCount++;
        return <LiteratureScopeProvider value={store}><ViewActivity active>
          <LiteratureHubView view={view} projectId={scope.projectId}/>
        </ViewActivity></LiteratureScopeProvider>;
      }
      function Harness({current}){
        const [scope,setScope]=useState({projectId:'project-a',writable:true,...current.options.scope});
        const [mounted,setMounted]=useState(true);
        const [view,setView]=useState('library');
        const [literatureRequest,setLiteratureRequest]=useState(null);
        const [openNonce,setOpenNonce]=useState(0);
        current.setScope=next=>flushSync(()=>setScope(value=>({...value,...next})));
        current.unmount=()=>flushSync(()=>setMounted(false));
        const openLiterature=target=>{
          if(target.kind==='reader')current.store.select(target.libraryItemId);
          setView(target.kind==='concept'?'knowledge':'library');
          setOpenNonce(value=>value+1);
          setLiteratureRequest({projectId:scope.projectId,nonce:openNonce+1,target});
        };
        return <WorkspaceScopeProvider value={{client:current.client,projectId:scope.projectId,
          projectTitle:'Scientific evidence',workspacePath:'/synthetic',writable:scope.writable,
          workspaceStatus:'ready',workspaceError:null,rebindWorkspace(){},openFile:null,
          openFileInCanvas(){},openSettings(){},firstStepsVisible:false,firstStepsRequestId:0,
          openFirstSteps(){},dismissFirstSteps(){},contextDrawerOpen:false,
          openReviewInspector(){},openView:(next,onNavigated)=>{setView(next);onNavigated?.();},
          openLiterature,literatureRequest,
          consumeLiteratureRequest:request=>setLiteratureRequest(value=>value?.nonce===request?null:value),
          tool:null,openTool(){},openTasks(){},openAssistant(){},adoptAcceptedRun(){},openArtifact(){}}}>
          {mounted?<StoreAndHub current={current} scope={scope} view={view}/>:null}
        </WorkspaceScopeProvider>;
      }
      window.fixture={
        mount:(options={})=>{
          world=makeWorld(options);window.rocPdfDrop=world.dropBridge;
          flushSync(()=>root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domAnimation} strict>
            <Harness key={++nonce} current={world}/>
          </LazyMotion></MotionConfig>));
        },
        snapshot:()=>world.snapshot(),
        queue:(method,plan)=>world.queue(method,plan),
        release:key=>world.release(key),
        start:(operation,input,key)=>world.start(operation,input,key),
        captureLink:(key,input)=>{
          const store=world.store,item=world.records.get(input.id);
          world.captured.set(key,()=>store.linkItem(item,input.linked));
        },
        select:id=>flushSync(()=>world.store.select(id)),
        setQuery:query=>flushSync(()=>world.store.setQuery(query)),
        setScope:next=>world.setScope(next),
        unmount:()=>world.unmount(),
        reload:()=>world.store.reload(),
        loadMore:()=>world.store.loadMore(),
        setDocument:(id,patch)=>world.documents.set(id,{...world.documents.get(id),...patch}),
        setRecord:(id,patch)=>world.records.set(id,{...world.records.get(id),...patch}),
        setIndexStatus:(id,status,error=null)=>{
          world.indexStatuses.set(id,status);world.indexErrors.set(id,error);
        },
        setJobs:jobs=>{world.jobs=jobs;},
        emitChanged:projectId=>world.emitChanged(projectId)
      };
    `
  });
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1450,height:900,
      webPreferences:{contextIsolation:true,nodeIntegration:false}})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.fixture?.mount === 'function');
});

after(async () => {
  try {
    await app?.close();
  } finally {
    if (directory) await rm(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function settleRendering() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function capture(name) {
  if (!process.env.ROC_LITERATURE_CAPTURE) return;
  await mkdir(process.env.ROC_LITERATURE_CAPTURE, {recursive: true});
  await page.screenshot({path: join(process.env.ROC_LITERATURE_CAPTURE, name + '.png')});
}

async function withWorkflowDiagnostics(t, name, execute) {
  try {
    return await execute();
  } catch (error) {
    try {
      const state = await snapshot();
      const focus = await page.evaluate(() => ({
        tagName: document.activeElement?.tagName ?? null,
        testId: document.activeElement?.getAttribute('data-testid') ?? null
      }));
      const lastCalls = state.calls.slice(-8).map(call => {
        if (call.method !== 'getDocumentStatuses') return call;
        const ids = call.input.libraryItemIds;
        return {...call, input: {...call.input, libraryItemIds: {
          count: ids.length, first: ids.slice(0, 2), last: ids.slice(-2)
        }}};
      });
      t.diagnostic(name + ' failure: ' + JSON.stringify({
        focus, projectId: state.projectId, writable: state.writable, query: state.query,
        status: state.status, refreshing: state.refreshing, itemCount: state.itemIds.length,
        action: state.action, gates: state.gates, lastCalls,
        menuFocusTimeline: await page.evaluate(() => window.fixture.menuFocusTimeline ?? null),
        projectLinkCalls: calls(state, 'linkLibraryItem').map(call => call.input)
      }));
      await capture(name + '-failure');
      if (name === 'workflow-undo-virtual' &&
        await page.evaluate(() => window.fixture.virtualUndoGeometry?.some(sample => sample.label === 'focusin'))) {
        await page.waitForFunction(() => window.fixture.virtualUndoGeometry.some(sample => sample.label === 'focus-settled-220ms'));
        t.diagnostic('Virtual Undo settled geometry: ' + JSON.stringify(
          await page.evaluate(() => window.fixture.virtualUndoGeometry.at(-1))));
      }
    } catch (diagnosticError) {
      t.diagnostic('Failure evidence could not be captured: ' + String(diagnosticError));
    }
    throw error;
  } finally {
    if (name === 'workflow-undo-virtual') {
      try {
        await page.evaluate(() => window.fixture.virtualUndoCleanup?.());
      } catch (cleanupError) {
        t.diagnostic('Virtual Undo observer cleanup failed: ' + String(cleanupError));
      }
    }
    if (name === 'workflow-doi-readd') {
      try {
        t.diagnostic('DOI menu focus timeline: ' + JSON.stringify(
          await page.evaluate(() => window.fixture.menuFocusTimeline ?? [])));
        await page.evaluate(() => window.fixture.menuFocusCleanup?.());
      } catch (cleanupError) {
        t.diagnostic('DOI menu observer cleanup failed: ' + String(cleanupError));
      }
    }
  }
}

async function mount(options = {}) {
  await page.evaluate(options => window.fixture.mount(options), options);
  await page.waitForFunction(() => window.fixture.snapshot().status === 'ready');
  await expect(page.getByTestId('literature-row-paper-0')).toBeVisible();
  await settleRendering();
  assert.equal((await page.getByTestId('literature-list-toolbar').boundingBox()).height, 48);
}

async function queue(method, plan) {
  await page.evaluate(({method, plan}) => window.fixture.queue(method, plan), {method, plan});
}

async function start(operation, input, key = operation) {
  await page.evaluate(({operation, input, key}) => window.fixture.start(operation, input, key), {operation, input, key});
}

async function result(key) {
  await page.waitForFunction(key => window.fixture.snapshot().results[key]?.settled, key);
  const entry = await page.evaluate(key => window.fixture.snapshot().results[key], key);
  assert.equal(entry.rejection, undefined);
  return entry.value;
}

async function snapshot() {
  return page.evaluate(() => window.fixture.snapshot());
}

async function waitGate(key) {
  await page.waitForFunction(key => window.fixture.snapshot().gates[key]?.started, key);
}

async function release(key) {
  await page.evaluate(key => window.fixture.release(key), key);
}

async function select(id) {
  await page.evaluate(id => window.fixture.select(id), id);
  await page.waitForFunction(id => {
    const state = window.fixture.snapshot();
    return state.selectedId === id && state.documentsStatus === 'ready';
  }, id);
}

async function enableMultiselect() {
  await page.getByTestId('literature-filter-toggle').click();
  await expect(page.getByTestId('literature-filter-popover')).toBeVisible();
  await page.getByTestId('literature-multiselect').click();
  await expect(page.getByTestId('literature-filter-popover')).toBeHidden();
  await expect(page.getByTestId('literature-filter-toggle')).toBeFocused();
}

async function openRowMenu(id) {
  const more = page.getByTestId('literature-more-' + id);
  await expect(more).toBeEnabled();
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-row-menu')).toBeVisible();
  await expect(page.getByTestId('literature-row-menu-read')).toBeFocused();
  return page.getByTestId('literature-row-menu-remove');
}

async function removeFromCurrentProject(id) {
  const remove = await openRowMenu(id);
  await expect(remove).toHaveAccessibleName('从当前项目移除');
  await expect(remove).toBeEnabled();
  await page.keyboard.press('End');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-row-menu')).toBeHidden();
}

function rowCheckbox(id) {
  return page.getByTestId('literature-row-' + id).locator('..').getByRole('checkbox');
}

function calls(state, method) {
  return state.calls.filter(call => call.method === method);
}

async function prepareDoiItem(doi) {
  await page.evaluate(doi => {
    const item = window.fixture.snapshot().records.find(item => item.id === 'paper-1');
    window.fixture.setRecord(item.id, {projectIds: ['project-b'], metadata: {...item.metadata, doi}});
    window.fixture.reload();
  }, doi);
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && !state.refreshing && !state.itemIds.includes('paper-1');
  });
  await expect(page.getByTestId('literature-row-paper-1')).toHaveCount(0);
}

async function pasteDoi(text) {
  await page.getByTestId('literature-list').evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData}));
  }, text);
}

async function expectImportedProjectItem() {
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && !state.refreshing && !state.action.pending &&
      state.itemIds.includes('paper-1') && state.records.find(item => item.id === 'paper-1')
        ?.projectIds.includes('project-a');
  });
  await expect(page.getByTestId('literature-row-paper-1')).toBeVisible();
}

async function exerciseSharedImportReceipts(operation, input, prefix) {
  const initial = await snapshot();
  const initialCalls = calls(initial, 'addLiterature').length;
  const initialApplications = initial.importApplications.length;
  const initialReceipts = initial.importReceipts.length;
  await queue('addLiterature', {gate: prefix + '-a-processing'});
  await start(operation, input, prefix + '-a-first');
  await waitGate(prefix + '-a-processing');
  await queue('addLiterature', {replyGate: prefix + '-a-late-reply'});
  await start(operation, input, prefix + '-a-duplicate');
  let state = await snapshot();
  let requests = calls(state, 'addLiterature').slice(initialCalls);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input.requestId, requests[1].input.requestId, 'Concurrent import intent must share one ID');
  assert.equal(state.results[prefix + '-a-first'].settled, false);
  assert.equal(state.results[prefix + '-a-duplicate'].settled, false);
  assert.equal(state.importApplications.length, initialApplications, 'An in-flight duplicate must not apply early');
  await release(prefix + '-a-processing');
  const firstResult = await result(prefix + '-a-first');
  assert.equal(firstResult.ok, true);
  await waitGate(prefix + '-a-late-reply');
  await queue('addLiterature', {gate: prefix + '-b-processing'});
  await start(operation, input, prefix + '-b-first');
  state = await snapshot();
  requests = calls(state, 'addLiterature').slice(initialCalls);
  assert.equal(requests.length, 3);
  assert.notEqual(requests[2].input.requestId, requests[0].input.requestId,
    'An observed terminal success must release the completed intent ID');
  await waitGate(prefix + '-b-processing');
  await release(prefix + '-a-late-reply');
  assert.deepEqual(await result(prefix + '-a-duplicate'), firstResult);
  await start(operation, input, prefix + '-b-duplicate');
  state = await snapshot();
  requests = calls(state, 'addLiterature').slice(initialCalls);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(call => call.input.requestId), [
    requests[0].input.requestId, requests[0].input.requestId,
    requests[2].input.requestId, requests[2].input.requestId
  ], 'A late old response must not clear the newer in-flight intent');
  assert.equal(state.importReceipts.length, initialReceipts + 2);
  assert.equal(state.importApplications.length, initialApplications + 1);
  await release(prefix + '-b-processing');
  const secondResult = await result(prefix + '-b-first');
  assert.equal(secondResult.ok, true);
  assert.deepEqual(await result(prefix + '-b-duplicate'), secondResult);
  await expectImportedProjectItem();
  state = await snapshot();
  assert.equal(state.importApplications.length, initialApplications + 2,
    'Four transport calls must apply only the two distinct ledger operations');
  assert.equal(state.importReceipts.length, initialReceipts + 2);
  assert.deepEqual(state.importReceipts.slice(initialReceipts).map(receipt => receipt.result.status),
    ['completed', 'completed']);
}

async function listGeometry() {
  return page.evaluate(() => {
    const selectors = {
      toolbar: '[data-testid="literature-list-toolbar"]',
      list: '[data-testid="literature-list"]',
      body: '[data-testid="literature-list-body"]',
      viewport: '.library-virtual-list'
    };
    return Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing workflow geometry target: ' + selector);
      const {x, y, width, height} = element.getBoundingClientRect();
      return [name, {x, y, width, height}];
    }));
  });
}

function assertStableGeometry(before, after, action) {
  for (const [name, bounds] of Object.entries(before)) {
    for (const [dimension, value] of Object.entries(bounds)) {
      assert.equal(after[name][dimension], value, `${action} changed ${name}.${dimension}`);
    }
  }
}

const newItemInput = {
  sourcePath: '/synthetic/Automatic study.pdf',
  title: 'Automatic study',
  citationKey: 'automatic-study',
  metadataMode: 'automatic'
};

test('automatic new-item import returns its receipt while one default parse continues in the real store', async () => {
  await mount();
  await queue('importDocument', {documentId: 'document-new', libraryItemId: 'paper-new'});
  await queue('parseDocument', {gate: 'new-parse'});
  await start('new-item', newItemInput);
  const outcome = await result('new-item');
  assert.deepEqual(outcome, {ok: true, createdCount: 1, duplicateCount: 0,
    documentId: 'document-new', libraryItemId: 'paper-new'});
  await waitGate('new-parse');
  await select('paper-new');
  let state = await snapshot();
  assert.deepEqual(calls(state, 'importDocument')[0].input,
    {target: 'new-item', ...newItemInput, projectId: 'project-a'});
  assert.deepEqual(calls(state, 'parseDocument').map(call => call.input),
    [{documentId: 'document-new', tier: null}]);
  assert.equal(state.action.pending, false);
  assert.equal(state.parseInFlight, 'document-new');
  assert.equal(state.documents[0].status, 'parsing');
  await release('new-parse');
  await page.waitForFunction(() => window.fixture.snapshot().documents[0]?.status === 'ready');
  state = await snapshot();
  assert.equal(state.documents[0].currentParseId, 'parse-paper-new');
  assert.equal(state.parseInFlight, null);
  assert.equal(state.action.error, null);
});

test('the real PDF picker can submit automatic metadata without typing, while provided metadata remains an explicit choice', async () => {
  for (const mode of ['automatic', 'provided']) {
    await mount();
    await queue('importDocument', {documentId: 'document-picker', libraryItemId: 'paper-picker'});
    await queue('parseDocument', {gate: 'picker-parse'});
    await page.getByTestId('literature-import-open').click();
    await expect(page.getByTestId('literature-import-dialog')).toBeVisible();
    await expect(page.getByTestId('literature-import-document-metadata-fields')).toBeHidden();
    await page.getByTestId('literature-import-pick-document').click();
    await expect(page.getByTestId('literature-import-document-submit')).toBeEnabled();
    if (mode === 'provided') {
      await page.getByTestId('literature-import-document-metadata-toggle').click();
      await page.getByTestId('literature-import-document-title').fill('A deliberate manual title');
      await page.getByTestId('literature-import-document-key').fill('my-manual-reference');
    }
    await page.getByTestId('literature-import-document-submit').click();
    await waitGate('picker-parse');
    await expect(page.getByTestId('literature-import-document-submit')).toBeEnabled();
    const state = await snapshot();
    assert.equal(calls(state, 'selectFromDialog').length, 1);
    const input = calls(state, 'importDocument')[0].input;
    assert.equal(input.target, 'new-item');
    assert.equal(input.sourcePath, '/synthetic/Automatic study.pdf');
    assert.equal(input.projectId, 'project-a');
    assert.equal(input.metadataMode, mode);
    assert.ok(input.title.length > 0 && input.citationKey.length > 0);
    if (mode === 'provided') {
      assert.equal(input.title, 'A deliberate manual title');
      assert.equal(input.citationKey, 'my-manual-reference');
    } else {
      await expect(page.getByTestId('literature-import-document-metadata-fields')).toBeHidden();
    }
    assert.deepEqual(calls(state, 'parseDocument').map(call => call.input),
      [{documentId: 'document-picker', tier: null}]);
    assert.equal(state.savedDocuments.find(document => document.id === 'document-picker').status, 'parsing');
    await capture('workflow-picker-' + mode);
    await release('picker-parse');
    await page.waitForFunction(() => window.fixture.snapshot().savedDocuments
      .find(document => document.id === 'document-picker')?.status === 'ready');
  }
});

test('drop import uses the File capability, automatic metadata and returned document identity', async () => {
  await mount();
  await queue('dropImport', {documentId: 'document-dropped', libraryItemId: 'paper-dropped'});
  await queue('parseDocument', {gate: 'drop-parse'});
  await start('drop', {name: 'A source study.PDF'});
  const outcome = await result('drop');
  await waitGate('drop-parse');
  const state = await snapshot();
  const request = calls(state, 'dropImport')[0].input;
  assert.equal(request.file.name, 'A source study.PDF');
  assert.equal(request.options.projectId, 'project-a');
  assert.equal(request.options.metadataMode, 'automatic');
  assert.ok(request.options.title.length > 0);
  assert.ok(request.options.citationKey.length > 0);
  assert.equal(Object.hasOwn(request.options, 'sourcePath'), false);
  assert.equal(Object.hasOwn(request.file, 'path'), false);
  assert.equal(outcome.documentId, 'document-dropped');
  assert.equal(outcome.libraryItemId, 'paper-dropped');
  assert.deepEqual(calls(state, 'parseDocument').map(call => call.input),
    [{documentId: 'document-dropped', tier: null}]);
  await release('drop-parse');
  await page.waitForFunction(() => window.fixture.snapshot().savedDocuments
    .find(document => document.id === 'document-dropped')?.status === 'ready');
});

test('unsupported drops and an unavailable native bridge leave the library untouched', async () => {
  await mount();
  await start('drop', {name: 'unsupported.txt'}, 'unsupported');
  assert.equal((await result('unsupported')).ok, false);
  await page.evaluate(() => {delete window.rocPdfDrop;});
  await start('drop', {name: 'valid.pdf'}, 'unavailable');
  const outcome = await result('unavailable');
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /导入|选择/u);
  const state = await snapshot();
  assert.equal(calls(state, 'dropImport').length, 0);
  assert.equal(calls(state, 'importDocument').length, 0);
  assert.equal(calls(state, 'parseDocument').length, 0);
  assert.equal(state.itemIds.length, 6);
});

test('ready reimports reuse the stored parse and already-parsing imports keep authoritative polling', async () => {
  for (const status of ['ready', 'parsing']) {
    await mount();
    await queue('importDocument', {documentId: 'document-paper-0', libraryItemId: 'paper-0', status});
    await start('new-item', newItemInput);
    assert.equal((await result('new-item')).documentId, 'document-paper-0');
    await select('paper-0');
    const initial = await snapshot();
    assert.equal(calls(initial, 'parseDocument').length, 0);
    assert.equal(initial.documents[0].status, status);
    if (status === 'parsing') {
      await page.evaluate(() => window.fixture.setDocument('document-paper-0', {
        status: 'ready', currentParseId: 'parse-polled', activeParseId: null
      }));
      await page.waitForFunction(() => window.fixture.snapshot().documents[0]?.currentParseId === 'parse-polled');
      const polled = await snapshot();
      assert.ok(calls(polled, 'listDocuments').length > calls(initial, 'listDocuments').length);
      assert.equal(calls(polled, 'parseDocument').length, 0);
    }
  }
});

test('ok parse envelopes with failed, cancelled or mismatched documents cannot become successful parses', async () => {
  for (const status of ['failed', 'cancelled']) {
    await mount({count: 80, documents: {'paper-0': 'imported'}});
    await select('paper-0');
    const baseline = await listGeometry();
    await queue('parseDocument', {status, documentError: 'fixture-' + status});
    await start('parse', {documentId: 'document-paper-0'});
    assert.equal(await result('parse'), false);
    await page.waitForFunction(status => window.fixture.snapshot().action.error === 'fixture-' + status, status);
    await page.waitForFunction(status => window.fixture.snapshot().documents[0]?.status === status, status);
    const state = await snapshot();
    assert.equal(state.documents[0].currentParseId, null);
    assert.equal(state.parseInFlight, null);
    assert.equal(state.action.error, 'fixture-' + status);
    await expect(page.getByRole('alert').filter({hasText: 'fixture-' + status}).first()).toBeVisible();
    await settleRendering();
    await capture('workflow-parse-' + status);
    assertStableGeometry(baseline, await listGeometry(), 'Parse ' + status + ' error');
  }
  await mount({count: 80, documents: {'paper-0': 'imported'}});
  await select('paper-0');
  const baseline = await listGeometry();
  await queue('parseDocument', {returnId: 'another-document'});
  await start('parse', {documentId: 'document-paper-0'});
  assert.equal(await result('parse'), false);
  assert.match((await snapshot()).action.error, /文档.*不一致/u);
  await settleRendering();
  assertStableGeometry(baseline, await listGeometry(), 'Mismatched parse receipt error');
});

test('a ready response without a current receipt stays unverified, and concurrent starts share one parse RPC', async () => {
  await mount({documents: {'paper-0': 'imported'}});
  await queue('parseDocument', {gate: 'deduplicated-parse', currentParseId: null});
  await start('parse', {documentId: 'document-paper-0'}, 'first');
  await start('parse', {documentId: 'document-paper-0'}, 'second');
  await waitGate('deduplicated-parse');
  assert.equal(calls(await snapshot(), 'parseDocument').length, 1);
  await release('deduplicated-parse');
  assert.equal(await result('first'), false);
  assert.equal(await result('second'), false);
  assert.equal(calls(await snapshot(), 'parseDocument').length, 1);
});

test('late imported receipts cannot start parsing after a project switch, readonly transition or unmount', async () => {
  for (const change of ['project', 'readonly', 'unmount']) {
    await mount();
    await queue('importDocument', {gate: 'held-import', documentId: 'document-late', libraryItemId: 'paper-late'});
    await start('new-item', newItemInput);
    await waitGate('held-import');
    if (change === 'project') {
      await page.evaluate(() => window.fixture.setScope({projectId: 'project-b'}));
      await page.waitForFunction(() => window.fixture.snapshot().projectId === 'project-b' &&
        window.fixture.snapshot().status === 'ready');
    } else if (change === 'readonly') {
      await page.evaluate(() => window.fixture.setScope({writable: false}));
    } else {
      await page.evaluate(() => window.fixture.unmount());
    }
    const before = await snapshot();
    await release('held-import');
    assert.equal((await result('new-item')).ok, false);
    const state = await snapshot();
    assert.deepEqual(calls(state, 'importDocument').map(call => call.input.projectId), ['project-a']);
    assert.equal(calls(state, 'parseDocument').length, 0);
    assert.equal(state.selectedId, null);
    if (change === 'unmount') assert.equal(state.renderCount, before.renderCount);
    else {
      assert.equal(state.action.pending, false);
      assert.equal(state.action.error, null);
      assert.equal(state.assistant.threadId, null);
    }
  }
});

test('readonly stores reject import, drop, parsing, project mutation and assistant writes before RPC', async () => {
  await mount({scope: {writable: false}, documents: {'paper-0': 'imported'}});
  for (const [operation, input] of [
    ['new-item', newItemInput],
    ['attach', {sourcePath: newItemInput.sourcePath, libraryItemId: 'paper-0'}],
    ['drop', {name: 'Automatic study.pdf'}],
    ['parse', {documentId: 'document-paper-0'}],
    ['link', {id: 'paper-0', linked: false}],
    ['ask-item', {id: 'paper-0'}],
    ['ask', {prompt: 'Read this project paper'}]
  ]) {
    await start(operation, input);
    await result(operation);
  }
  const state = await snapshot();
  for (const method of ['importDocument', 'dropImport', 'parseDocument', 'linkLibraryItem', 'startRun']) {
    assert.equal(calls(state, method).length, 0, 'Readonly store called ' + method);
  }
  assert.equal(state.writable, false);
  assert.equal(state.records[0].archived, false);
  assert.deepEqual(state.records[0].projectIds, ['project-a', 'project-b']);
});

test('late failed parse and assistant receipts cannot publish into a different project or readonly scope', async () => {
  for (const change of ['project', 'readonly']) {
    await mount({documents: {'paper-0': 'imported'}});
    await select('paper-0');
    await queue('parseDocument', {gate: 'late-parse', status: 'failed', documentError: 'old-project-parse-error'});
    await queue('startRun', {gate: 'late-assistant'});
    await start('parse', {documentId: 'document-paper-0'});
    await start('ask-item', {id: 'paper-0'});
    await waitGate('late-parse');
    await waitGate('late-assistant');
    await page.evaluate(change => window.fixture.setScope(change === 'project'
      ? {projectId: 'project-b'} : {writable: false}), change);
    await release('late-parse');
    await release('late-assistant');
    assert.equal(await result('parse'), false);
    await result('ask-item');
    const state = await snapshot();
    assert.equal(state.action.error, null);
    assert.equal(state.parseInFlight, null);
    assert.equal(state.assistant.threadId, null);
    assert.equal(state.assistant.error, null);
    assert.equal(state.assistant.pending, false);
    assert.deepEqual(calls(state, 'startRun').map(call => call.input.researchProjectId), ['project-a']);
  }
});

test('project unlink and relink preserve the global library identity and source receipt without archiving', async () => {
  await mount();
  const original = await snapshot();
  await start('link', {id: 'paper-0', linked: false}, 'unlink');
  assert.equal(await result('unlink'), true);
  await page.waitForFunction(() => !window.fixture.snapshot().itemIds.includes('paper-0'));
  let state = await snapshot();
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input),
    [{id: 'paper-0', projectId: 'project-a', linked: false}]);
  assert.deepEqual(state.records.find(item => item.id === 'paper-0').projectIds, ['project-b']);
  assert.equal(state.records.find(item => item.id === 'paper-0').archived, false);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  await start('link', {id: 'paper-0', linked: true}, 'relink');
  assert.equal(await result('relink'), true);
  await page.waitForFunction(() => window.fixture.snapshot().itemIds.includes('paper-0'));
  state = await snapshot();
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input), [
    {id: 'paper-0', projectId: 'project-a', linked: false},
    {id: 'paper-0', projectId: 'project-a', linked: true}
  ]);
  assert.equal(calls(state, 'archiveLibraryItem').length, 0);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
});

test('failed project removal keeps the row, and an old Undo callback cannot target a new project', async () => {
  await mount();
  await queue('linkLibraryItem', {error: 'fixture-project-unlink-failed'});
  await start('link', {id: 'paper-0', linked: false}, 'failed-unlink');
  assert.equal(await result('failed-unlink'), false);
  let state = await snapshot();
  assert.equal(state.action.error, 'fixture-project-unlink-failed');
  assert.ok(state.itemIds.includes('paper-0'));
  assert.deepEqual(state.records.find(item => item.id === 'paper-0').projectIds, ['project-a', 'project-b']);

  await start('link', {id: 'paper-0', linked: false}, 'unlink');
  assert.equal(await result('unlink'), true);
  await page.evaluate(() => window.fixture.captureLink('old-project-undo', {id: 'paper-0', linked: true}));
  const previousCalls = calls(await snapshot(), 'linkLibraryItem').length;
  await page.evaluate(() => window.fixture.setScope({projectId: 'project-b'}));
  await start('captured', {key: 'old-project-undo'}, 'stale-undo');
  assert.equal(await result('stale-undo'), false);
  state = await snapshot();
  assert.equal(calls(state, 'linkLibraryItem').length, previousCalls);
  assert.equal(state.projectId, 'project-b');
  assert.deepEqual(state.records.find(item => item.id === 'paper-0').projectIds, ['project-b']);
});

test('row keyboard navigation, asking and reading retain the actual item identity', async () => {
  await mount();
  const firstRow = page.getByTestId('literature-row-paper-0');
  await firstRow.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('literature-row-paper-1')).toBeFocused();
  assert.equal((await snapshot()).selectedId, null);
  await page.keyboard.press('Home');
  await expect(firstRow).toBeFocused();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.fixture.snapshot().selectedId === 'paper-0' &&
    window.fixture.snapshot().documentsStatus === 'ready');
  await expect(page.getByTestId('literature-library-browse')).toBeVisible();
  await expect(page.getByTestId('literature-inspector-title')).toContainText('0000 Scientific evidence');
  await expect(page.getByTestId('paper-reader')).toBeHidden();
  await queue('startRun', {gate: 'row-assistant'});
  const ask = page.getByTestId('literature-ask-paper-1');
  await ask.focus();
  await page.keyboard.press('Enter');
  await waitGate('row-assistant');
  await expect(ask).toBeDisabled();
  await page.keyboard.press('Enter');
  let state = await snapshot();
  assert.equal(calls(state, 'startRun').length, 1);
  const input = calls(state, 'startRun')[0].input;
  assert.equal(input.researchProjectId, 'project-a');
  assert.ok(input.input.includes('paper-1'));
  assert.ok(input.input.includes(state.records.find(item => item.id === 'paper-1').metadata.title));
  assert.equal(input.input.includes('document-paper-0'), false);
  assert.equal(state.selectedId, 'paper-0');
  await release('row-assistant');
  await page.waitForFunction(() => window.fixture.snapshot().assistant.threadId !== null);
  state = await snapshot();
  assert.equal(state.assistant.pending, false);
  assert.ok(state.assistant.threadId);
  await page.getByTestId('literature-read-paper-1').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-hub')).toHaveAttribute('data-reader-mode', 'read');
  await expect(page.getByTestId('reader-title')).toContainText('0001 Scientific evidence');
  assert.equal((await snapshot()).selectedId, 'paper-1');
  await page.getByTestId('literature-back-to-list').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-hub')).toHaveAttribute('data-reader-mode', 'browse');
  await page.getByTestId('literature-row-paper-1').focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('literature-row-paper-5')).toBeFocused();
});

test('bibliography exports remain available in a readonly project', async () => {
  await mount({scope: {writable: false}});
  await start('export', {id: 'paper-0'});
  assert.deepEqual(await result('export'), {content: '@article{fixture2026}', filename: 'references.bib'});
  assert.deepEqual(calls(await snapshot(), 'exportBibliography').map(call => call.input),
    [{ids: ['paper-0'], format: 'bibtex'}]);
});

test('parsed documents remain unready until an index receipt is confirmed, and index failures stay visible', async () => {
  await mount({count: 80});
  const badge = page.getByTestId('literature-row-paper-0').locator('..').locator('.library-row-status .status-badge');
  await page.waitForFunction(() => window.fixture.snapshot().documentStatuses.length > 0);
  await expect(badge).not.toHaveAttribute('data-tone', 'ready');
  const baseline = await listGeometry();
  const statusWidth = await badge.locator('..').evaluate(element => element.getBoundingClientRect().width);
  for (const [indexStatus, tone] of [['running', 'processing'], ['ready', 'ready'], ['failed', 'danger']]) {
    await page.evaluate(({indexStatus}) => {
      window.fixture.setIndexStatus('document-paper-0', indexStatus,
        indexStatus === 'failed' ? 'fixture-index-failed' : null);
      window.fixture.emitChanged('project-a');
    }, {indexStatus});
    await expect(badge).toHaveAttribute('data-tone', tone);
    if (indexStatus === 'failed') {
      await expect(badge.locator('.status-badge__segment')).toHaveCount(0);
    } else {
      await expect(badge).toHaveAttribute('data-progress', indexStatus === 'ready' ? '3' : '1');
      assert.deepEqual(await badge.locator('.status-badge__segment').evaluateAll(elements =>
        elements.map(element => element.getAttribute('data-state'))), indexStatus === 'ready'
        ? ['completed', 'completed', 'completed'] : ['completed', 'current', 'pending']);
    }
    assertStableGeometry(baseline, await listGeometry(), 'Index status ' + indexStatus);
    assert.equal(await badge.locator('..').evaluate(element => element.getBoundingClientRect().width), statusWidth);
    if (indexStatus !== 'running') await capture('workflow-index-' + indexStatus);
  }
  await page.evaluate(() => {
    window.fixture.setDocument('document-paper-0', {status: 'imported', currentParseId: null});
    window.fixture.setIndexStatus('document-paper-0', 'ready');
    window.fixture.emitChanged('project-a');
  });
  await expect(badge).not.toHaveAttribute('data-tone', 'ready');
  assertStableGeometry(baseline, await listGeometry(), 'Receipt without a parsed source');
});

test('a late batch-status receipt from the previous project cannot mark current rows ready', async () => {
  await mount();
  await page.waitForFunction(() => window.fixture.snapshot().documentStatuses.length > 0);
  await queue('getDocumentStatuses', {gate: 'old-project-status', indexStatus: 'ready'});
  await page.evaluate(() => window.fixture.emitChanged('project-a'));
  await waitGate('old-project-status');
  await page.evaluate(() => window.fixture.setScope({projectId: 'project-b'}));
  await page.waitForFunction(() => window.fixture.snapshot().projectId === 'project-b' &&
    window.fixture.snapshot().status === 'ready' && window.fixture.snapshot().documentStatuses.length > 0);
  const badge = page.getByTestId('literature-row-paper-0').locator('..').locator('.library-row-status .status-badge');
  await expect(badge).not.toHaveAttribute('data-tone', 'ready');
  await release('old-project-status');
  await settleRendering();
  await expect(badge).not.toHaveAttribute('data-tone', 'ready');
  assert.equal((await snapshot()).projectId, 'project-b');
});

test('bulk selection stays truthful through clear, background removal, Undo and a full-library query', async () => {
  await mount({count: 80});
  const baseline = await listGeometry();
  const original = await snapshot();
  const bulk = page.getByTestId('literature-bulk-actions');
  await expect(bulk).toHaveCount(0);
  await enableMultiselect();
  await expect(bulk).toHaveCount(0);
  assertStableGeometry(baseline, await listGeometry(), 'Enable selection without checked rows');
  for (const id of ['paper-0', 'paper-1']) await rowCheckbox(id).check();
  await expect(bulk).toContainText(/已选\s*2/u);
  assertStableGeometry(baseline, await listGeometry(), 'Show bulk pill');
  await page.getByTestId('literature-bulk-clear').click();
  await expect(bulk).toHaveCount(0);
  for (const id of ['paper-0', 'paper-1']) await rowCheckbox(id).check();
  await page.evaluate(() => {
    window.fixture.setRecord('paper-0', {projectIds: ['project-b']});
    window.fixture.emitChanged('project-a');
  });
  await expect(page.getByTestId('literature-row-paper-0')).toHaveCount(0);
  await expect(bulk).toContainText(/已选\s*1/u);
  assertStableGeometry(baseline, await listGeometry(), 'Refresh effective selection');
  await page.getByTestId('literature-bulk-remove').click();
  await expect(page.getByTestId('literature-row-paper-1')).toHaveCount(0);
  await expect(bulk).toHaveCount(0);
  const toast = page.getByTestId('literature-undo-toast');
  await expect(toast).toBeVisible();
  assert.ok(['status', 'alert'].includes(await toast.getAttribute('role')));
  let state = await snapshot();
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input),
    [{id: 'paper-1', projectId: 'project-a', linked: false}]);
  assert.equal(calls(state, 'archiveLibraryItem').length, 0);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  assertStableGeometry(baseline, await listGeometry(), 'Project removal toast');
  await capture('workflow-bulk-remove-undo');
  await page.getByTestId('literature-undo').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-row-paper-1')).toBeVisible();
  await expect(bulk).toHaveCount(0);
  state = await snapshot();
  assert.deepEqual(calls(state, 'linkLibraryItem').at(-1).input,
    {id: 'paper-1', projectId: 'project-a', linked: true});
  assert.equal(state.records.find(item => item.id === 'paper-0').projectIds.includes('project-a'), false);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assertStableGeometry(baseline, await listGeometry(), 'Undo project removal');

  await rowCheckbox('paper-1').check();
  await expect(bulk).toContainText(/已选\s*1/u);
  await page.getByTestId('literature-search').fill('0001');
  await page.waitForFunction(() => window.fixture.snapshot().itemIds.length === 1 &&
    window.fixture.snapshot().status === 'ready');
  await expect(bulk).toHaveCount(0);
  assert.deepEqual(calls(await snapshot(), 'listLibraryPage').at(-1).input.query, '0001');
});

test('partial rejected unlink and relink RPCs retain successful removals and allow only failed rows to retry Undo', async () => {
  await mount({count: 80});
  await select('paper-4');
  const baseline = await listGeometry();
  const original = await snapshot();
  const bulk = page.getByTestId('literature-bulk-actions');
  const toast = page.getByTestId('literature-undo-toast');
  const undo = page.getByTestId('literature-undo');
  await enableMultiselect();
  for (const id of ['paper-0', 'paper-1', 'paper-2']) await rowCheckbox(id).check();
  await queue('linkLibraryItem', {});
  await queue('linkLibraryItem', {reject: 'fixture-unlink-rpc-rejected'});
  await queue('linkLibraryItem', {gate: 'partial-unlink'});
  await page.getByTestId('literature-bulk-remove').click();
  await waitGate('partial-unlink');
  await expect(page.getByTestId('literature-row-paper-0')).toHaveCount(0);
  await expect(page.getByTestId('literature-row-paper-1')).toBeVisible();
  await expect(page.getByTestId('literature-row-paper-2')).toBeVisible();
  await expect(page.getByTestId('literature-bulk-remove')).toBeDisabled();
  await release('partial-unlink');
  await expect(page.getByTestId('literature-row-paper-2')).toHaveCount(0);
  await expect(toast).toContainText(/已移除\s*2\s*篇/u);
  await expect(undo).toBeEnabled();
  await expect(bulk).toContainText(/已选\s*1/u);
  await expect(page.getByRole('alert').filter({hasText: /1\s*篇未能移除，请重试/u})).toBeVisible();
  assertStableGeometry(baseline, await listGeometry(), 'Partial unlink RPC rejection');
  let state = await snapshot();
  assert.equal(state.selectedId, 'paper-4');
  for (const [id, projectIds] of [
    ['paper-0', ['project-b']], ['paper-1', ['project-a', 'project-b']], ['paper-2', ['project-b']]
  ]) assert.deepEqual(state.records.find(item => item.id === id).projectIds, projectIds);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  await capture('workflow-partial-unlink-failure');

  await queue('linkLibraryItem', {reject: 'fixture-relink-rpc-rejected'});
  await queue('linkLibraryItem', {gate: 'partial-relink'});
  await undo.focus();
  await page.keyboard.press('Enter');
  await waitGate('partial-relink');
  await expect(undo).toBeDisabled();
  await release('partial-relink');
  await expect(page.getByTestId('literature-row-paper-2')).toBeVisible();
  await expect(page.getByTestId('literature-row-paper-0')).toHaveCount(0);
  await expect(page.getByTestId('literature-row-paper-1')).toBeVisible();
  await expect(toast).toContainText(/已移除\s*1\s*篇/u);
  await expect(undo).toBeEnabled();
  await expect(page.getByRole('alert').filter({hasText: /1\s*篇未能恢复，可再次撤销/u})).toBeVisible();
  assertStableGeometry(baseline, await listGeometry(), 'Partial relink RPC rejection');
  state = await snapshot();
  assert.equal(state.selectedId, 'paper-4');
  assert.deepEqual(calls(state, 'linkLibraryItem').filter(call => call.input.linked).map(call => call.input.id),
    ['paper-0', 'paper-2']);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  await capture('workflow-partial-undo-failure');

  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-row-paper-0')).toBeVisible();
  await expect(toast).toHaveCount(0);
  assert.deepEqual(calls(await snapshot(), 'linkLibraryItem').filter(call => call.input.linked)
    .map(call => call.input.id), ['paper-0', 'paper-2', 'paper-0']);
  await removeFromCurrentProject('paper-1');
  await expect(page.getByTestId('literature-row-paper-1')).toHaveCount(0);
  await expect(toast).toContainText(/已移除\s*1\s*篇/u);
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-row-paper-1')).toBeVisible();
  await expect(toast).toHaveCount(0);
  state = await snapshot();
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input), [
    {id: 'paper-0', projectId: 'project-a', linked: false},
    {id: 'paper-1', projectId: 'project-a', linked: false},
    {id: 'paper-2', projectId: 'project-a', linked: false},
    {id: 'paper-0', projectId: 'project-a', linked: true},
    {id: 'paper-2', projectId: 'project-a', linked: true},
    {id: 'paper-0', projectId: 'project-a', linked: true},
    {id: 'paper-1', projectId: 'project-a', linked: false},
    {id: 'paper-1', projectId: 'project-a', linked: true}
  ]);
  for (const id of ['paper-0', 'paper-1', 'paper-2']) {
    assert.deepEqual([...state.records.find(item => item.id === id).projectIds].sort(),
      ['project-a', 'project-b']);
  }
  assert.equal(calls(state, 'archiveLibraryItem').length, 0);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  assertStableGeometry(baseline, await listGeometry(), 'Retry failed removal and Undo');
});

test('single project removal is keyboard accessible, Undo restores focus, and old project notices expire on scope change', async t => {
  await mount();
  await page.getByTestId('literature-row-paper-0').click();
  await page.waitForFunction(() => window.fixture.snapshot().documentsStatus === 'ready');
  const original = await snapshot();
  await removeFromCurrentProject('paper-1');
  await expect(page.getByTestId('literature-row-paper-1')).toHaveCount(0);
  await expect(page.getByTestId('literature-undo-toast')).toBeVisible();
  assert.equal((await snapshot()).selectedId, 'paper-0');
  await page.getByTestId('literature-undo').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('literature-row-paper-1')).toBeVisible();
  try {
    await expect(page.getByTestId('literature-row-paper-1')).toBeFocused();
  } catch (error) {
    const focus = await page.evaluate(() => ({
      tagName: document.activeElement?.tagName ?? null,
      testId: document.activeElement?.getAttribute('data-testid') ?? null,
      className: document.activeElement?.className ?? null,
      restoredRowTabIndex: document.querySelector('[data-testid="literature-row-paper-1"]')?.getAttribute('tabindex') ?? null
    }));
    t.diagnostic('Keyboard Undo focus failure: ' + JSON.stringify(focus));
    await capture('workflow-undo-focus-failure');
    throw error;
  }
  await capture('workflow-undo-focus-restored');
  let state = await snapshot();
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input), [
    {id: 'paper-1', projectId: 'project-a', linked: false},
    {id: 'paper-1', projectId: 'project-a', linked: true}
  ]);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);

  await queue('linkLibraryItem', {error: 'fixture-keyboard-remove-failed'});
  await removeFromCurrentProject('paper-2');
  await expect(page.getByRole('alert').filter({hasText: 'fixture-keyboard-remove-failed'}).first()).toBeVisible();
  await expect(page.getByTestId('literature-row-paper-2')).toBeVisible();
  await removeFromCurrentProject('paper-2');
  await expect(page.getByTestId('literature-row-paper-2')).toHaveCount(0);
  await expect(page.getByTestId('literature-undo-toast')).toBeVisible();
  const before = calls(await snapshot(), 'linkLibraryItem').length;
  await page.evaluate(() => window.fixture.setScope({projectId: 'project-b'}));
  await expect(page.getByTestId('literature-undo-toast')).toHaveCount(0);
  assert.equal(calls(await snapshot(), 'linkLibraryItem').length, before);
  await page.evaluate(() => window.fixture.setScope({writable: false}));
  for (const id of ['literature-import-open', 'literature-ask-paper-3']) {
    await expect(page.getByTestId(id)).toBeDisabled();
  }
  const readonlyRemove = await openRowMenu('paper-3');
  await expect(readonlyRemove).toBeDisabled();
  await expect(page.getByTestId('literature-row-menu-read')).toBeEnabled();
  await expect(page.getByTestId('literature-row-menu-copy')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('literature-row-menu')).toBeHidden();
  state = await snapshot();
  assert.equal(calls(state, 'archiveLibraryItem').length, 0);
  assert.deepEqual(state.sources, original.sources);
});

test('delayed keyboard Undo preserves moved focus and cancels restoration after query, project or readonly changes', async t => withWorkflowDiagnostics(t, 'workflow-undo-delayed', async () => {
  for (const scenario of ['moved-focus', 'query', 'project', 'readonly']) {
    await mount();
    const row = page.getByTestId('literature-row-paper-1');
    const search = page.getByTestId('literature-search');
    const undo = page.getByTestId('literature-undo');
    await removeFromCurrentProject('paper-1');
    await expect(row).toHaveCount(0);
    await page.waitForFunction(() => {
      const state = window.fixture.snapshot();
      return state.status === 'ready' && !state.refreshing && !state.action.pending &&
        !state.itemIds.includes('paper-1');
    });
    await expect(undo).toBeEnabled();
    const gate = 'undo-scope-' + scenario;
    await queue('linkLibraryItem', {gate});
    await undo.focus();
    await page.keyboard.press('Enter');
    await waitGate(gate);
    await expect(undo).toBeDisabled();
    let state = await snapshot();
    assert.deepEqual(state.records.find(item => item.id === 'paper-1').projectIds, ['project-b'], scenario);
    assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input), [
      {id: 'paper-1', projectId: 'project-a', linked: false},
      {id: 'paper-1', projectId: 'project-a', linked: true}
    ], scenario);
    if (scenario === 'moved-focus') {
      await search.focus();
      await expect(search).toBeFocused();
    } else if (scenario === 'query') {
      // Change the real query without moving focus, so its own scope guard is exercised.
      await page.evaluate(() => window.fixture.setQuery('Scientific evidence'));
      await page.waitForFunction(() => {
        const state = window.fixture.snapshot();
        return state.query === 'Scientific evidence' && state.status === 'ready' &&
          !state.refreshing && state.itemIds.length === 5;
      });
      await expect(search).toHaveValue('Scientific evidence');
    } else {
      await page.evaluate(scenario => window.fixture.setScope(
        scenario === 'project' ? {projectId: 'project-b'} : {writable: false}
      ), scenario);
      await page.waitForFunction(scenario => {
        const state = window.fixture.snapshot();
        return state.status === 'ready' && !state.refreshing &&
          (scenario === 'project' ? state.projectId === 'project-b' : state.writable === false);
      }, scenario);
      await expect(page.getByTestId('literature-undo-toast')).toHaveCount(0);
    }
    const focusAnchor = await page.evaluateHandle(() => document.activeElement);
    try {
      await release(gate);
      await page.waitForFunction(() => window.fixture.snapshot().records
        .find(item => item.id === 'paper-1')?.projectIds.includes('project-a'));
      // An authoritative change event makes the restored row mount even in the new scope.
      await page.evaluate(() => window.fixture.emitChanged(window.fixture.snapshot().projectId));
      await page.waitForFunction(() => {
        const state = window.fixture.snapshot();
        return state.status === 'ready' && !state.refreshing && !state.action.pending &&
          state.itemIds.includes('paper-1') && state.total === 6;
      });
      await expect(row).toBeVisible();
      await settleRendering();
      assert.equal(await focusAnchor.evaluate(element =>
        document.activeElement === (element?.isConnected ? element : document.body)), true,
      scenario + ' allowed delayed Undo to steal focus');
      await expect(row).not.toBeFocused();
      if (scenario === 'moved-focus') await expect(search).toBeFocused();
      state = await snapshot();
      assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input), [
        {id: 'paper-1', projectId: 'project-a', linked: false},
        {id: 'paper-1', projectId: 'project-a', linked: true}
      ], scenario + ' retargeted or repeated the original relink');
      const currentRequest = calls(state, 'listLibraryPage').at(-1).input;
      assert.equal(currentRequest.projectId, scenario === 'project' ? 'project-b' : 'project-a');
      assert.equal(currentRequest.query, scenario === 'query' ? 'Scientific evidence' : '');
      await capture('workflow-undo-delayed-' + scenario);
    } finally {
      await focusAnchor.dispose();
    }
  }
}));

test('keyboard Undo waits for its delayed list refresh before focusing the successfully restored row', async t => withWorkflowDiagnostics(t, 'workflow-undo-refresh', async () => {
  await mount();
  const row = page.getByTestId('literature-row-paper-1');
  await removeFromCurrentProject('paper-1');
  await expect(row).toHaveCount(0);
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && !state.refreshing && !state.action.pending && state.itemIds.length === 5;
  });
  const before = await snapshot();
  await queue('listLibraryPage', {gate: 'undo-list-refresh'});
  await page.getByTestId('literature-undo').focus();
  await page.keyboard.press('Enter');
  await waitGate('undo-list-refresh');
  let state = await snapshot();
  assert.equal(state.refreshing, true);
  assert.equal(state.records.find(item => item.id === 'paper-1').projectIds.includes('project-a'), true);
  assert.equal(state.itemIds.includes('paper-1'), false);
  assert.equal(state.itemIds.length, 5);
  assert.equal(calls(state, 'listLibraryPage').length, calls(before, 'listLibraryPage').length + 1);
  assert.deepEqual(calls(state, 'listLibraryPage').at(-1).input, {
    projectId: 'project-a', query: '', includeArchived: false, limit: 200, cursor: null
  });
  await settleRendering();
  await expect(row).toHaveCount(0);
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    'literature-row-paper-1');
  await capture('workflow-undo-refresh-pending');
  await release('undo-list-refresh');
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && !state.refreshing && state.itemIds.length === 6 &&
      state.itemIds.includes('paper-1');
  });
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
  state = await snapshot();
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input), [
    {id: 'paper-1', projectId: 'project-a', linked: false},
    {id: 'paper-1', projectId: 'project-a', linked: true}
  ]);
  assert.equal(state.selectedId, before.selectedId);
  await capture('workflow-undo-refresh-restored-focus');
}));

test('keyboard Undo positions and focuses a restored virtual row across the full 1000-paper window', async t => withWorkflowDiagnostics(t, 'workflow-undo-virtual', async () => {
  await mount({count: 1000});
  for (const count of [400, 600, 800, 1000]) {
    await page.getByTestId('literature-load-more').click();
    await page.waitForFunction(count => window.fixture.snapshot().itemIds.length === count, count);
  }
  const viewport = page.locator('.library-virtual-list');
  const row = page.getByTestId('literature-row-paper-650');
  await viewport.evaluate(element => {element.scrollTop = 64 * 650;});
  await page.waitForFunction(() => document.querySelector('.library-virtual-list')?.scrollTop === 64 * 650);
  await expect(row).toBeVisible();
  await removeFromCurrentProject('paper-650');
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && !state.refreshing && !state.action.pending &&
      state.itemIds.length === 999 && !state.itemIds.includes('paper-650');
  });
  await expect(row).toHaveCount(0);
  // Move away before requesting Undo; the restored row must be mounted by the virtualizer.
  await viewport.evaluate(element => {element.scrollTop = 64 * 20;});
  await page.waitForFunction(() => document.querySelector('.library-virtual-list')?.scrollTop === 64 * 20);
  await settleRendering();
  await queue('linkLibraryItem', {gate: 'virtual-undo-relink'});
  await queue('listLibraryPage', {gate: 'virtual-undo-refresh'});
  await page.getByTestId('literature-undo').focus();
  await page.keyboard.press('Enter');
  await waitGate('virtual-undo-relink');
  await expect(page.getByTestId('literature-undo')).toBeDisabled();
  await release('virtual-undo-relink');
  await waitGate('virtual-undo-refresh');
  assert.equal((await snapshot()).itemIds.length, 999);
  await expect(row).toHaveCount(0);
  assert.equal(await viewport.evaluate(element => element.scrollTop), 64 * 20);
  await page.evaluate(() => {
    const scroller = document.querySelector('.library-virtual-list');
    const bounds = element => {
      if (!element) return null;
      const {top, bottom, height} = element.getBoundingClientRect();
      return {top, bottom, height, clientHeight: element.clientHeight, offsetHeight: element.offsetHeight};
    };
    const samples = [];
    let settledTimer = null;
    const measure = label => {
      const row = scroller.querySelector('[data-testid="literature-row-paper-650"]');
      const mounted = [...scroller.querySelectorAll('[data-index]')].map(element => ({
        index: Number(element.getAttribute('data-index')),
        knownSize: element.getAttribute('data-known-size')
      }));
      const style = getComputedStyle(scroller);
      samples.push({
        label, time: performance.now(), scrollTop: scroller.scrollTop,
        focus: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
        scroller: bounds(scroller), viewport: bounds(scroller.querySelector('[data-viewport-type]')),
        body: bounds(document.querySelector('[data-testid="literature-list-body"]')),
        itemList: bounds(scroller.querySelector('[data-testid="virtuoso-item-list"]')),
        target: bounds(row), row: bounds(row?.closest('[data-library-row]')),
        mountedCount: mounted.length,
        mountedRange: mounted.length ? [mounted[0].index, mounted.at(-1).index] : [],
        targetKnownSize: mounted.find(item => item.index === 650)?.knownSize ?? null,
        scrollPaddingTop: style.scrollPaddingTop, scrollPaddingBottom: style.scrollPaddingBottom
      });
    };
    const onFocus = event => {
      if (event.target.getAttribute?.('data-testid') !== 'literature-row-paper-650') return;
      document.removeEventListener('focusin', onFocus);
      measure('focusin');
      requestAnimationFrame(() => {
        measure('focus-first-frame');
        requestAnimationFrame(() => measure('focus-second-frame'));
      });
      settledTimer = setTimeout(() => {
        measure('focus-settled-220ms');
        settledTimer = null;
      }, 220);
    };
    document.addEventListener('focusin', onFocus);
    window.fixture.virtualUndoGeometry = samples;
    window.fixture.virtualUndoCleanup = () => {
      document.removeEventListener('focusin', onFocus);
      if (settledTimer !== null) clearTimeout(settledTimer);
    };
    measure('before-refresh-release');
  });
  await release('virtual-undo-refresh');
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && !state.refreshing && state.itemIds.length === 1000 &&
      state.itemIds.includes('paper-650');
  });
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
  await settleRendering();
  const geometry = await row.evaluate(element => {
    const viewport = document.querySelector('.library-virtual-list');
    const row = element.closest('[data-library-row]');
    const viewportBounds = viewport.getBoundingClientRect(), rowBounds = row.getBoundingClientRect();
    return {
      viewportTop: viewportBounds.top, viewportBottom: viewportBounds.bottom,
      rowTop: rowBounds.top, rowBottom: rowBounds.bottom, rowHeight: rowBounds.height,
      scrollTop: viewport.scrollTop,
      mountedIds: [...viewport.querySelectorAll('[data-library-row] .library-row-open')]
        .map(element => element.getAttribute('data-testid'))
    };
  });
  t.diagnostic('Virtual Undo geometry: ' + JSON.stringify({
    ...geometry, samples: await page.evaluate(() => window.fixture.virtualUndoGeometry)
  }));
  assert.equal(geometry.rowHeight, 64);
  assert.ok(geometry.rowTop >= geometry.viewportTop && geometry.rowBottom <= geometry.viewportBottom,
    'The restored row must be fully inside its scroll viewport');
  assert.ok(geometry.scrollTop > 64 * 600 && geometry.scrollTop <= 64 * 650,
    'Undo must position the restored row beyond the manually retained initial window');
  assert.ok(geometry.mountedIds.length > 0 && geometry.mountedIds.length < 60,
    'Undo must preserve virtualization for 1000 loaded papers');
  assert.ok(geometry.mountedIds.includes('literature-row-paper-650'));
  await page.waitForFunction(() => window.fixture.virtualUndoGeometry.some(sample => sample.label === 'focus-settled-220ms'));
  await expect(row).toBeFocused();
  const settled = await page.evaluate(() => window.fixture.virtualUndoGeometry.find(
    sample => sample.label === 'focus-settled-220ms'));
  t.diagnostic('Virtual Undo settled geometry: ' + JSON.stringify(settled));
  assert.equal(settled.row.height, 64);
  assert.ok(settled.row.top >= settled.scroller.top && settled.row.bottom <= settled.scroller.bottom,
    'The restored row must remain fully visible after the virtualizer positioning tail');
  assert.equal(settled.focus, 'literature-row-paper-650');
  assert.ok(settled.mountedCount > 0 && settled.mountedCount < 60);
  const state = await snapshot();
  assert.equal(state.total, 1000);
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input), [
    {id: 'paper-650', projectId: 'project-a', linked: false},
    {id: 'paper-650', projectId: 'project-a', linked: true}
  ]);
  assert.equal(calls(state, 'archiveLibraryItem').length, 0);
  await capture('workflow-undo-virtual-restored-focus');
}));

test('nested file drag enters stay visible inside the list and close on the actual boundary without importing', async () => {
  await mount({count: 80});
  const baseline = await listGeometry();
  const list = page.getByTestId('literature-list');
  const overlay = page.getByTestId('literature-drop-overlay');
  for (const exit of ['outside-target', 'null-target']) {
    await list.evaluate(element => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['%PDF-synthetic'], 'Nested study.pdf', {type: 'application/pdf'}));
      const row = element.querySelector('[data-testid="literature-row-paper-0"]');
      const inner = row.firstElementChild;
      const {left, top} = element.getBoundingClientRect();
      for (const target of [element, row, inner]) {
        target.dispatchEvent(new DragEvent('dragenter', {bubbles: true, cancelable: true,
          dataTransfer, clientX: left + 30, clientY: top + 90}));
      }
      inner.dispatchEvent(new DragEvent('dragleave', {bubbles: true, cancelable: true, dataTransfer,
        relatedTarget: row, clientX: left + 30, clientY: top + 90}));
    });
    await expect(overlay).toBeVisible();
    assertStableGeometry(baseline, await listGeometry(), 'Nested file drag enters');
    await list.evaluate(element => {
      const {left, top} = element.getBoundingClientRect();
      element.querySelector('[data-testid="literature-row-paper-0"]').dispatchEvent(new DragEvent('dragleave', {
        bubbles: true, cancelable: true, relatedTarget: null, clientX: left + 30, clientY: top + 90
      }));
    });
    await expect(overlay).toBeVisible();
    await list.evaluate((element, exit) => {
      const {right, top} = element.getBoundingClientRect();
      element.dispatchEvent(new DragEvent('dragleave', {bubbles: true, cancelable: true,
        relatedTarget: exit === 'outside-target' ? document.body : null, clientX: right + 2, clientY: top + 90}));
    }, exit);
    await expect(overlay).toHaveCount(0);
    assertStableGeometry(baseline, await listGeometry(), 'File drag leaves the list with ' + exit);
  }
  const state = await snapshot();
  assert.equal(calls(state, 'dropImport').length, 0);
  assert.equal(calls(state, 'importDocument').length, 0);
  assert.equal(calls(state, 'parseDocument').length, 0);
  assert.equal(state.itemIds.length, 80);
});

test('dropping a PDF into the Hub starts one automatic pipeline without moving the toolbar or list', async () => {
  await mount({count: 80});
  const baseline = await listGeometry();
  await queue('dropImport', {documentId: 'document-drop-ui', libraryItemId: 'paper-drop-ui'});
  await queue('parseDocument', {gate: 'drop-ui-parse'});
  await page.getByTestId('literature-list').evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['%PDF-synthetic'], 'Automatic drop.pdf', {type: 'application/pdf'}));
    element.dispatchEvent(new DragEvent('dragenter', {bubbles: true, cancelable: true, dataTransfer}));
  });
  await expect(page.getByTestId('literature-drop-overlay')).toBeVisible();
  assertStableGeometry(baseline, await listGeometry(), 'Drag overlay');
  await page.getByTestId('literature-list').evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['%PDF-synthetic'], 'Automatic drop.pdf', {type: 'application/pdf'}));
    element.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer}));
  });
  await waitGate('drop-ui-parse');
  await expect(page.getByTestId('literature-row-paper-drop-ui')).toBeVisible();
  assertStableGeometry(baseline, await listGeometry(), 'Automatic dropped import');
  await capture('workflow-drop-parsing');
  let state = await snapshot();
  assert.equal(calls(state, 'dropImport').length, 1);
  assert.equal(calls(state, 'dropImport')[0].input.options.metadataMode, 'automatic');
  assert.deepEqual(calls(state, 'parseDocument').map(call => call.input),
    [{documentId: 'document-drop-ui', tier: null}]);
  await release('drop-ui-parse');
  await page.waitForFunction(() => window.fixture.snapshot().savedDocuments
    .find(document => document.id === 'document-drop-ui')?.status === 'ready');
  await settleRendering();
  assertStableGeometry(baseline, await listGeometry(), 'Dropped parse completion');
  const badge = page.getByTestId('literature-row-paper-drop-ui').locator('..').locator('.library-row-status .status-badge');
  await expect(badge).not.toHaveAttribute('data-tone', 'ready');
  state = await snapshot();
  assert.equal(calls(state, 'parseDocument').length, 1);
});

test('the backend query finds papers beyond the initial 200-item page', async () => {
  await mount({count: 1000});
  assert.equal((await snapshot()).itemIds.length, 200);
  await page.getByTestId('literature-search').fill('0999');
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && state.itemIds.length === 1 && state.itemIds[0] === 'paper-999';
  });
  await expect(page.getByTestId('literature-row-paper-999')).toBeVisible();
  const request = calls(await snapshot(), 'listLibraryPage').at(-1).input;
  assert.equal(request.query, '0999');
  assert.equal(request.projectId, 'project-a');
  assert.equal(request.cursor, null);
  assert.equal(request.limit, 200);
});

test('a background refresh retains all five explicitly loaded pages and the 1000-paper scroll window', async () => {
  await mount({count: 1000});
  for (const count of [400, 600, 800, 1000]) {
    await page.getByTestId('literature-load-more').click();
    await page.waitForFunction(count => window.fixture.snapshot().itemIds.length === count, count);
  }
  const viewport = page.locator('.library-virtual-list');
  await viewport.evaluate(element => {element.scrollTop = 64 * 650;});
  await page.waitForFunction(() => document.querySelector('.library-virtual-list')?.scrollTop === 64 * 650);
  await settleRendering();
  const visibleIds = await page.locator('[data-library-row] .library-row-open').evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-testid')));
  assert.ok(visibleIds.length > 0 && visibleIds.length < 60, '1000 rows must remain virtualized');
  const baseline = await listGeometry();
  assert.equal(baseline.toolbar.height, 48);
  const initial = await snapshot();
  await page.getByTestId('literature-filter-toggle').click();
  await expect(page.getByTestId('literature-filter-popover')).toBeVisible();
  await queue('listLibraryPage', {gate: 'refresh-window'});
  await page.getByTestId('literature-refresh').click();
  await waitGate('refresh-window');
  assert.equal((await snapshot()).itemIds.length, 1000);
  assertStableGeometry(baseline, await listGeometry(), 'Pending background refresh');
  assert.equal(await viewport.evaluate(element => element.scrollTop), 64 * 650);
  assert.deepEqual(await page.locator('[data-library-row] .library-row-open').evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-testid'))), visibleIds);
  await release('refresh-window');
  const initialPageCalls = calls(initial, 'listLibraryPage').length;
  await page.waitForFunction(initialPageCalls => {
    const state = window.fixture.snapshot();
    return state.calls.filter(call => call.method === 'listLibraryPage').length === initialPageCalls + 5 &&
      state.status === 'ready' && state.itemIds.length === 1000;
  }, initialPageCalls);
  await settleRendering();
  assertStableGeometry(baseline, await listGeometry(), 'Completed background refresh');
  assert.equal(await viewport.evaluate(element => element.scrollTop), 64 * 650);
  const state = await snapshot();
  assert.equal(state.total, 1000);
  assert.equal(state.itemIds.at(-1), 'paper-999');
  assert.deepEqual(calls(state, 'listLibraryPage').slice(-5).map(call => call.input.cursor?.id??null),
    [null, 'paper-199', 'paper-399', 'paper-599', 'paper-799']);
  await capture('workflow-retained-1000-papers');
});

test('pasting the same DOI after a successful import and project removal starts a new intent and restores the original item', async t => withWorkflowDiagnostics(t, 'workflow-doi-readd', async () => {
  await mount();
  const doi = '10.1234/retained-workflow';
  await prepareDoiItem(doi);
  const original = await snapshot();
  await pasteDoi('https://doi.org/' + doi);
  await expectImportedProjectItem();
  let state = await snapshot();
  const first = calls(state, 'addLiterature')[0].input;
  assert.match(first.requestId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
  assert.deepEqual({...first, requestId: 'intent'}, {
    projectId: 'project-a', requestId: 'intent', destination: 'current_project',
    ingestionPolicy: 'fulltext_auto', entries: [{kind: 'doi', doi}]
  });
  assert.equal(state.importReceipts.length, 1);
  assert.equal(state.importApplications.length, 1);
  assert.equal(state.importReceipts[0].result.counts.linked, 1);
  assert.equal(state.importReceipts[0].result.items[0].libraryItemId, 'paper-1');
  await page.evaluate(() => {
    const timeline = [];
    const describe = element => ({
      tag: element?.tagName, testId: element?.getAttribute?.('data-testid'),
      action: element?.getAttribute?.('data-context-action'), role: element?.getAttribute?.('role')
    });
    const record = event => {
      if (timeline.length >= 40) return;
      const state = window.fixture.snapshot();
      timeline.push({
        event: event.type, key: event.key ?? null, time: performance.now(),
        target: describe(event.target), focus: describe(document.activeElement),
        selectedId: state.selectedId,
        actionCalls: state.calls.filter(call =>
          ['linkLibraryItem', 'archiveLibraryItem', 'getDocumentContent'].includes(call.method))
          .map(call => ({method: call.method, input: call.input}))
      });
    };
    for (const type of ['focusin', 'keydown', 'keyup', 'click']) document.addEventListener(type, record, true);
    window.fixture.menuFocusTimeline = timeline;
    window.fixture.menuFocusCleanup = () => {
      for (const type of ['focusin', 'keydown', 'keyup', 'click']) document.removeEventListener(type, record, true);
    };
  });
  await removeFromCurrentProject('paper-1');
  await expect(page.getByTestId('literature-row-paper-1')).toHaveCount(0);
  await page.waitForFunction(() => {
    const state = window.fixture.snapshot();
    return state.status === 'ready' && !state.refreshing && !state.action.pending &&
      !state.itemIds.includes('paper-1');
  });
  await settleRendering();
  assert.deepEqual((await snapshot()).records.find(item => item.id === 'paper-1').projectIds, ['project-b']);
  await pasteDoi('doi: ' + doi);
  await page.waitForFunction(() => window.fixture.snapshot().calls.filter(call => call.method === 'addLiterature').length === 2);
  state = await snapshot();
  const second = calls(state, 'addLiterature')[1].input;
  assert.notEqual(second.requestId, first.requestId, 'A completed DOI receipt must not be reused for re-adding a removed item');
  assert.deepEqual({...second, requestId: first.requestId}, first);
  await expectImportedProjectItem();
  state = await snapshot();
  assert.equal(state.importReceipts.length, 2);
  assert.equal(state.importApplications.length, 2);
  assert.deepEqual(state.importReceipts.map(receipt => receipt.result.items[0].libraryItemId), ['paper-1', 'paper-1']);
  assert.deepEqual(state.importReceipts.map(receipt => receipt.result.counts.linked), [1, 1]);
  assert.equal(state.records.length, original.records.length);
  assert.deepEqual(calls(state, 'linkLibraryItem').map(call => call.input),
    [{id: 'paper-1', projectId: 'project-a', linked: false}]);
  assert.equal(calls(state, 'archiveLibraryItem').length, 0);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  await capture('workflow-doi-readded-original-item');
}));

test('DOI imports share in-flight IDs, protect newer intents from late replies and retain IDs when transport results are unknown', async t => withWorkflowDiagnostics(t, 'workflow-doi-request-identity', async () => {
  const doi = '10.1234/shared-workflow';
  await mount();
  await prepareDoiItem(doi);
  await exerciseSharedImportReceipts('doi', {doi}, 'doi-shared');

  for (const failure of ['reject', 'error']) {
    await mount();
    await prepareDoiItem(doi);
    const original = await snapshot();
    await queue('addLiterature', {[failure]: 'fixture-doi-' + failure + '-after-commit'});
    await start('doi', {doi}, 'doi-unknown');
    const unknown = await result('doi-unknown');
    assert.equal(unknown.ok, false);
    assert.ok(unknown.message.includes('fixture-doi-' + failure + '-after-commit'));
    let state = await snapshot();
    const committed = state.records.find(item => item.id === 'paper-1');
    assert.equal(committed.projectIds.includes('project-a'), true,
      'The unknown transport outcome must follow an actual backend commit');
    assert.equal(state.importReceipts.length, 1);
    assert.equal(state.importReceipts[0].result.status, 'completed');
    assert.equal(state.importApplications.length, 1);
    await expect(page.getByTestId('literature-row-paper-1')).toHaveCount(0);
    await start('doi', {doi}, 'doi-unknown-retry');
    assert.deepEqual(await result('doi-unknown-retry'), {ok: true, createdCount: 1, duplicateCount: 0});
    await expectImportedProjectItem();
    state = await snapshot();
    const requests = calls(state, 'addLiterature').map(call => call.input);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].requestId, requests[1].requestId,
      failure + ' must retain the same intent ID for recovery of its cached receipt');
    assert.equal(state.importReceipts.length, 1);
    assert.equal(state.importApplications.length, 1, 'A cached receipt retry must not relink a second time');
    assert.equal(state.records.find(item => item.id === 'paper-1').revision, committed.revision);
    assert.deepEqual(state.savedDocuments, original.savedDocuments);
    assert.deepEqual(state.sources, original.sources);
  }

  await mount();
  await prepareDoiItem(doi);
  await queue('addLiterature', {disposition: 'failed'});
  await start('doi', {doi}, 'doi-known-failure');
  assert.equal((await result('doi-known-failure')).ok, false);
  const failed = await snapshot();
  assert.equal(failed.importReceipts[0].result.status, 'failed');
  assert.deepEqual(failed.records.find(item => item.id === 'paper-1').projectIds, ['project-b']);
  await start('doi', {doi}, 'doi-known-failure-retry');
  assert.deepEqual(await result('doi-known-failure-retry'), {ok: true, createdCount: 1, duplicateCount: 0});
  await expectImportedProjectItem();
  const requests = calls(await snapshot(), 'addLiterature').map(call => call.input);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId,
    'An observed terminal failure must release its intent ID for a genuine new attempt');
}));

test('the same still-valid search candidate can be re-added after removal and late old candidate replies preserve a newer intent', async t => withWorkflowDiagnostics(t, 'workflow-candidate-request-identity', async () => {
  await mount();
  await prepareDoiItem('10.1234/candidate-workflow');
  await start('search', {query: 'Retained scientific evidence'}, 'candidate-search');
  const search = await result('candidate-search');
  assert.equal(search.ok, true);
  assert.ok(Date.parse(search.result.expiresAt) > Date.now());
  const input = {searchId: search.result.searchId, candidateId: search.result.candidates[0].candidateId};
  const original = await snapshot();
  await start('candidate', input, 'candidate-first');
  assert.deepEqual(await result('candidate-first'), {ok: true, createdCount: 1, duplicateCount: 0});
  await expectImportedProjectItem();
  await start('link', {id: 'paper-1', linked: false}, 'candidate-unlink');
  assert.equal(await result('candidate-unlink'), true);
  await page.waitForFunction(() => !window.fixture.snapshot().itemIds.includes('paper-1') &&
    !window.fixture.snapshot().refreshing);
  await expect(page.getByTestId('literature-row-paper-1')).toHaveCount(0);
  await start('candidate', input, 'candidate-readded');
  assert.deepEqual(await result('candidate-readded'), {ok: true, createdCount: 1, duplicateCount: 0});
  await expectImportedProjectItem();
  let state = await snapshot();
  const requests = calls(state, 'addLiterature').map(call => call.input);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId,
    'A candidate re-add must create a new intent rather than reuse the old completed receipt');
  assert.deepEqual({...requests[1], requestId: requests[0].requestId}, requests[0]);
  assert.deepEqual(requests[0].entries, [{kind: 'candidate', searchId: input.searchId, candidateId: input.candidateId}]);
  assert.deepEqual(state.importReceipts.map(receipt => receipt.result.items[0].libraryItemId), ['paper-1', 'paper-1']);
  assert.deepEqual(state.importReceipts.map(receipt => receipt.result.counts.linked), [1, 1]);
  assert.deepEqual(state.searches, original.searches, 'Re-adding must retain the original still-valid frozen search');
  assert.equal(calls(state, 'searchLiterature').length, 1);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  await start('link', {id: 'paper-1', linked: false}, 'candidate-before-shared');
  assert.equal(await result('candidate-before-shared'), true);
  await page.waitForFunction(() => !window.fixture.snapshot().itemIds.includes('paper-1') &&
    !window.fixture.snapshot().refreshing);
  await exerciseSharedImportReceipts('candidate', input, 'candidate-shared');
  state = await snapshot();
  assert.deepEqual(state.searches, original.searches);
  assert.deepEqual(state.savedDocuments, original.savedDocuments);
  assert.deepEqual(state.sources, original.sources);
  assert.equal(calls(state, 'archiveLibraryItem').length, 0);
  await capture('workflow-candidate-readded-original-item');
}));
