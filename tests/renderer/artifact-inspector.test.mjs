import {Annotation, Command, END, MemorySaver, START, StateGraph} from '@langchain/langgraph';
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

let directory, app, page, api, active, windowId;
const fixtures=[],errors=[],reads=[];
const artifacts=join(process.cwd(),'.artifacts/research-optimization/artifact-inspector-ui');
const hash=value=>createHash('sha256').update(value).digest('hex');
before(async()=>{
  api=await loadResearchTestApi();
  directory=mkdtempSync(join(tmpdir(),'roc-artifact-inspector-ui-'));
  mkdirSync(artifacts,{recursive:true});
  await esbuild.build({stdin:{contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ResearchGateApprovalCard} from './src/renderer/assistant/blocks/approval-cards';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:{inspectArtifact:input=>window.inspectFromMain(input),getGateReviewContext:input=>window.readGateFromMain(input),
      inspectEvidence:input=>window.relationFromMain('inspectEvidence',input),
      proposeEvidenceRelation:input=>window.relationFromMain('proposeEvidenceRelation',input),
      reviewEvidenceRelation:input=>window.relationFromMain('reviewEvidenceRelation',input),
      evidenceRelationHistory:input=>window.relationFromMain('evidenceRelationHistory',input),
      listSourceMigrations:input=>window.relationFromMain('listSourceMigrations',input),
      captureSourceMigration:input=>window.relationFromMain('captureSourceMigration',input),
      rejectSourceMigration:input=>window.relationFromMain('rejectSourceMigration',input)}}};
    function Harness({link,initialApproval}) {
      const [request,setRequest]=useState(null);
      const [readingLocations]=useState(()=>new Map());
      const [reviewCallback,setReviewCallback]=useState(null);
      window.selectArtifact=value=>flushSync(()=>setRequest(value));
      const [approval,setApproval]=useState(initialApproval);
      window.replaceApproval=value=>flushSync(()=>setApproval(value));
      return <main className="p-4"><ResearchGateApprovalCard key={approval.interruptId} approval={approval} onReadGateContext={client.api.research.getGateReviewContext}
        onOpenArtifact={(request,callback)=>{setReviewCallback(()=>callback);setRequest(request);}}
        onApprovalDecision={(id,decisions)=>{
          window.decisions.push({id,decisions});
          window.submitGateFromMain(id,decisions).then(result=>{
            window.resumeResult=result;
            if(result.approval!==null) window.replaceApproval(result.approval);
          }).catch(error=>window.resumeError=error.message);
        }}/>
        {request===null ? null : <ArtifactInspector key={JSON.stringify(request)} client={client} request={request}
          readingLocations={readingLocations}
          onReviewContext={context=>reviewCallback(context)} onClose={()=>setRequest(null)} onOpenTask={taskId=>{window.tasks.push(taskId);setRequest(null);}}/>}</main>;
    }
    let generation=0;
    window.mount=(link,approval)=>{window.decisions=[];window.tasks=[];window.resumeResult=null;window.resumeError=null;flushSync(()=>root.render(
      <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
        <Harness key={++generation} link={link} initialApproval={approval}/></LazyMotion></MotionConfig>));};
  `,resolveDir:process.cwd(),loader:'tsx'},outfile:join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent'});
  const assets=join(process.cwd(),'dist/renderer/assets');
  writeFileSync(join(directory,'app.css'),readdirSync(assets).filter(file=>file.endsWith('.css')).map(file=>readFileSync(join(assets,file),'utf8')).join('\n'));
  writeFileSync(join(directory,'index.html'),`<html data-theme="light"><link rel="stylesheet" href="app.css"><style>
    body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}
    main>section{width:min(420px,100%)}
    </style><div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))}));`);
  app=await _electron.launch({executablePath:electronPath,args:[join(directory,'main.cjs')]});
  page=await app.firstWindow();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  windowId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('inspectFromMain',async input=>{
    const f=active;
    reads.push(input);
    api.parseIpcRequestArgs('roc:research:artifact-inspect',[input]);
    const result=await f.bridge.invoke('research.inspectArtifact',[input],windowId);
    if(f.defer) return new Promise(resolve=>{f.finish=()=>resolve(result);});
    return result;
  });
  await page.exposeFunction('readGateFromMain',async input=>{
    const f=active;
    reads.push({gateReview:input});
    api.parseIpcRequestArgs('roc:research:gate-review',[input]);
    const result=await f.bridge.invoke('research.getGateReviewContext',[input],windowId);
    if(f.deferGate) return new Promise(resolve=>{f.finishGate=()=>resolve(result);});
    return result;
  });
  await page.exposeFunction('relationFromMain',async(method,input)=>{
    const f=active;
    reads.push({relation:method,input});
    const channel={inspectEvidence:'roc:research:evidence-inspect',proposeEvidenceRelation:'roc:research:relations-propose',
      reviewEvidenceRelation:'roc:research:relations-review',evidenceRelationHistory:'roc:research:relations-history',
      listSourceMigrations:'roc:research:source-migrations-list',captureSourceMigration:'roc:research:source-migrations-capture',
      rejectSourceMigration:'roc:research:source-migrations-reject'}[method];
    api.parseIpcRequestArgs(channel,[input]);
    const result=await f.bridge.invoke(`research.${method}`,[input],windowId);
    if(f.deferRelation===method)return new Promise(resolve=>{f.finishRelation=()=>resolve(result);});
    return result;
  });
  await page.exposeFunction('submitGateFromMain',async(id,decisions)=>{
    const f=active;
    assert.equal(id,f.approval.interruptId);
    const result=await f.graph.invoke(new Command({resume:{decisions}}),f.graphConfig);
    const pending=result.__interrupt__?.[0];
    const approval=pending===undefined?null:{kind:'approval',interruptId:pending.id,...pending.value.request};
    if(approval!==null) f.approval=approval;
    return {done:result.done,approval};
  });
  await page.waitForFunction(()=>typeof mount==='function');
});
after(async()=>{
  try {await app?.close();} finally {fixtures.forEach(f=>f.close());api?.dispose();if(directory)rmSync(directory,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
});
async function scene({long=false,managed=false}={}) {
  const f=createResearchFixture(api,'reading');fixtures.push(f);active=f;reads.length=0;
  const excerpt=long ? '原始来源长段落与定位说明。'.repeat(120) : 'An actual retained synthetic source excerpt.';
  let evidenceId='inspector-evidence';
  if(managed) {
    f.document=f.repository.documents.import({id:'inspector-managed-document',libraryItemId:null,projectId:f.project.id,
      filename:'inspector.pdf',mediaType:'pdf',sourcePath:'documents/inspector.pdf',sourceHash:hash('synthetic original PDF'),size:22,
      entry:{metadata:{id:'inspector-managed-literature',source:'local',externalId:'inspector-managed-fixture',doi:null,
        title:'Managed source',authors:['Synthetic Author'],abstract:null,publishedYear:2026,citationCount:null,
        url:null,openAccessUrl:null,importedAt:'2026-11-04T00:00:00.000Z',updatedAt:'2026-11-04T00:00:00.000Z'},
        bibliography:{citationKey:'inspector2026',entryType:'article',fields:{title:'Managed source'},preambles:[],
          csl:null,title:'Managed source',authors:['Synthetic Author'],doi:null,publishedYear:2026,abstract:null,url:null}}
    },false).document;
    f.sourceText=long?'原始迁移候选完整段落，用于逐块人工核对。'.repeat(80):'An actual retained synthetic migration source.';
    f.reparse=(parseId,blocks=[
      {id:'target-first',kind:'paragraph',label:'Synthetic paragraph',text:f.sourceText,locator:'page:1',imageAssetId:null,
        locations:[{page:1,bbox:[1,2,30,40],coordinateOrigin:'TOPLEFT'}]},
      {id:'target-second',kind:'paragraph',label:'Synthetic paragraph',text:f.sourceText,locator:'page:3',imageAssetId:null,
        locations:[{page:3,bbox:[1,2,30,40],coordinateOrigin:'TOPLEFT'}]}
    ])=>{
      f.repository.documents.begin(f.document.id,parseId);
      f.repository.documents.complete(f.document.id,parseId,{outputPath:'/tmp/synthetic-ui-parse',files:{},content:{
        contractVersion:4,engine:'paddleocr.js',engineVersion:'synthetic-ui-test',parserVersion:'roc-research-parser/2',
        parserFingerprint:hash('synthetic ui parser'),modelManifest:'',runtime:{node:'synthetic'},tier:'compact',
        parseMode:'native-text',device:'cpu',sourceHash:f.document.sourceHash,pageCount:4,
        content:blocks.map(block=>block.text).join('\n\n'),blocks,assets:[],
        artifacts:{middleJson:'artifacts/middle.json',markdown:'artifacts/document.md',structuredContent:'artifacts/structured.json'},warnings:[]
      }});
    };
    f.reparse('inspector-old');
    f.source=f.repository.evidence.capture({projectId:f.project.id,chunkId:'document:inspector-old:chunk:0'});
    evidenceId=f.source.id;
  } else f.db.prepare(`INSERT INTO research_evidence
    (id,project_id,document_id,chunk_id,source_type,source_id,source_version,title,locator,excerpt,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('inspector-evidence',f.project.id,'inspector-document','inspector-document:chunk:0',
    'file','synthetic-source','parse-v1','Original synthetic source','page:2',excerpt,hash(excerpt),'2026-11-04T00:00:00.000Z');
  const empty=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',title:'Empty real artifact',path:null});
  const completed=f.repository.runs.complete(f.run.id,f.project.id,{title:'真实保存的阅读产物',markdown:'# Saved result\n\nActual **persisted** markdown.',
    claims:[{subjectType:'claim',content:'A working hypothesis',status:'hypothesis',evidenceIds:[evidenceId]}],sections:[],verdict:'uncertain'});
  const artifactId=completed.outputArtifactIds[0];
  await api.createResearchHumanGate({repository:f.repository}).complete({projectId:f.project.id,expectedStage:'reading',action:'complete'});
  const snapshot=f.repository.inspectArtifact({projectId:f.project.id,artifactId,expectedVersion:null}).snapshot;
  const handlers=new Map();
  api.registerResearchArtifactInspectorCapability({pluginId:'fixture',capabilities:{register(pluginId,descriptor,handler){handlers.set(descriptor.name,handler);}}},f.repository);
  api.registerResearchEvidenceCapabilities({pluginId:'fixture',capabilities:{register(pluginId,descriptor,handler){handlers.set(descriptor.name,handler);}}},f.repository.evidence);
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability(name,input){return handlers.get(name)(input);}});
  f.link={projectId:f.project.id,artifactId,expectedVersion:snapshot.version,title:snapshot.artifact.title,kind:snapshot.artifact.kind};
  f.empty=empty;f.snapshot=snapshot;
  const gate=api.createResearchHumanGate({repository:f.repository});
  const tools=api.createResearchTools({projectId:f.project.id,signal:new AbortController().signal,
    dispatchStage:async()=>assert.fail('UI gate cannot dispatch a model'),capabilities:{invoke:async(name,input)=>{
      if(name==='research.workflow.get')return f.repository.getWorkflow(f.project.id);
      if(name==='research.workflow.gateReview')return f.repository.readGateReviewContext(input);
      if(name==='research.workflow.transition')return input.action==='approve'?gate.approve(input):gate.reject(input);
      assert.fail(name);
    }}});
  const tool=tools.find(tool=>tool.name==='research_approve_gate');
  f.graph=new StateGraph(Annotation.Root({done:Annotation()})).addNode('gate',async()=>{
    await tool.invoke({});return{done:true};
  }).addEdge(START,'gate').addEdge('gate',END).compile({checkpointer:new MemorySaver()});
  f.graphConfig={configurable:{thread_id:`inspector-${f.project.id}`}};
  const pending=(await f.graph.invoke({done:false},f.graphConfig)).__interrupt__[0];
  f.approval={kind:'approval',interruptId:pending.id,...pending.value.request};
  await page.evaluate(({link,approval})=>mount(link,approval),{link:f.link,approval:f.approval});
  return f;
}
async function openArtifact() {
  await page.getByTestId('assistant-gate-artifact').last().focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-inspector-content').waitFor({state:'visible'});
  await page.waitForFunction(()=>{
    const panel=document.querySelector('[data-testid="artifact-inspector-panel"]');
    return panel&&getComputedStyle(panel).transform==='none'&&getComputedStyle(panel).opacity==='1';
  });
}
async function audit(label) {
  const code=readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js','utf8');
  const result=await page.evaluate(`(${code})({root:'body',viewport:true})`);
  writeFileSync(join(artifacts,label+'-audit.json'),JSON.stringify(result,null,2));
  assert.equal(result.cut,0);
  // The shared full-height drawer touches these physical window edges. Only
  // its left shadow is meant to be visible; no other hidden shadow is allowed.
  assert.deepEqual(result.issues.filter(issue=>issue.level==='hidden').map(issue=>issue.side).sort(),['bottom','right','top']);
  assert.ok(result.issues.every(issue=>issue.el==='div.fixed.inset-0.flex > div.relative.z-10.ml-auto' && issue.gap===0));
  await page.screenshot({path:join(artifacts,label+'.png')});
}

async function openRelationClaim(f) {
  const claim=f.repository.evidence.listClaims({projectId:f.project.id,artifactId:f.link.artifactId})[0];
  await page.getByTestId(`artifact-relations-claim-${claim.id}`).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator(`#relation-claim-${claim.id}`).evaluate(details=>details===document.activeElement),true,
    'keyboard jump focuses the details group so its Enter cannot toggle the summary');
  await page.locator(`#relation-claim-${claim.id} > div`).waitFor({state:'visible'});
  return claim;
}
async function activateRendered(locator) {
  await locator.waitFor({state:'visible'});
  await locator.focus();
  assert.equal(await locator.evaluate(element=>element===document.activeElement),true,'keyboard action must reach the rendered control');
  await page.keyboard.press('Enter');
}
async function recaptureRelations(f) {
  await page.getByTestId('artifact-inspector-recapture').waitFor();
  await page.getByTestId('artifact-inspector-recapture').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-relations').waitFor();
  await page.getByTestId('artifact-inspector-recapture').waitFor({state:'detached'});
  return await openRelationClaim(f);
}
async function proposeRelation(f,kind='supports',condition='') {
  const claim=await openRelationClaim(f);
  await activateRendered(page.locator(`[data-reading-key="relation-proposal-summary:${claim.id}"]`));
  assert.equal(await page.getByTestId(`artifact-relation-propose-${claim.id}`).isDisabled(),true);
  await page.getByTestId(`artifact-relation-source-${claim.id}`).selectOption('inspector-evidence');
  await page.getByTestId(`artifact-relation-kind-${claim.id}`).selectOption(kind);
  if(condition!=='')await page.getByTestId(`artifact-relation-condition-${claim.id}`).fill(condition);
  await page.waitForFunction(id=>!document.querySelector(`[data-testid="${id}"]`).disabled,`artifact-relation-propose-${claim.id}`);
  await activateRendered(page.getByTestId(`artifact-relation-propose-${claim.id}`));
  await recaptureRelations(f);
  return f.repository.evidence.relations.list({projectId:f.project.id,claimId:claim.id}).at(-1);
}

test('keyboard source selection creates a real proposal, human confirmation refreshes versions, and the original gate needs new context',async()=>{
  const f=await scene(),before=f.db.prepare('SELECT total_changes()').pluck().get();
  await openArtifact();await page.getByTestId('artifact-relations-matrix').waitFor();
  assert.match(await page.getByTestId('artifact-relations-matrix').innerText(),/确认 0/u);
  await page.getByTestId('artifact-relations-filter').selectOption('weak');
  assert.equal(await page.getByTestId('artifact-relations-matrix').count(),1);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  const proposed=await proposeRelation(f);
  assert.equal(proposed.status,'proposed');
  assert.deepEqual(proposed.proposer,{kind:'user',id:`window:${windowId}`});
  assert.equal(proposed.reviewer,null);
  assert.match(await page.getByTestId('artifact-relations-matrix').innerText(),/提议 1/u);
  const expected={projectId:f.project.id,relationId:proposed.id,expectedVersion:1,expectedClaimVersion:1,
    expectedSourceDigest:proposed.sourceDigest,decision:'confirm',note:'已核对固定原文，保留假设状态。'};
  await page.getByTestId(`artifact-relation-note-${proposed.id}`).fill(expected.note);
  await activateRendered(page.getByTestId(`artifact-relation-confirm-${proposed.id}`));
  await recaptureRelations(f);
  const confirmed=f.repository.evidence.relations.get(proposed.id,f.project.id);
  assert.equal(confirmed.status,'confirmed');assert.deepEqual(confirmed.reviewer,{kind:'user',id:`window:${windowId}`});
  assert.equal(f.repository.evidence.getClaim(confirmed.claimId).status,'hypothesis');
  assert.ok(reads.some(read=>read.relation==='reviewEvidenceRelation'&&JSON.stringify(read.input)===JSON.stringify(expected)));
  assert.match(await page.getByTestId('artifact-relations-matrix').innerText(),/确认 1/u);
  await page.getByTestId('artifact-relations-filter').selectOption('weak');
  assert.match(await page.getByTestId('artifact-relations').innerText(),/没有符合条件/u);
  await page.getByTestId('artifact-relations-filter').selectOption('all');await openRelationClaim(f);
  const after=f.db.prepare('SELECT total_changes()').pluck().get();
  await activateRendered(page.getByTestId(`artifact-relation-history-${proposed.id}`));
  await page.getByTestId(`artifact-relation-${proposed.id}`).getByText(/版本 2，已确认/u).waitFor();
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),after);
  await page.getByTestId('artifact-inspector-review').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-inspector-return-review').waitFor();
  await page.getByTestId('artifact-inspector-return-review').focus();await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  await activateRendered(page.getByTestId('assistant-gate-approve'));
  await page.waitForFunction(()=>window.resumeResult?.done===true);
  assert.equal(f.repository.getWorkflow(f.project.id).currentStage,'ideation');
});

test('contradictions, required qualification conditions and rejected decisions stay distinct from historical support',async()=>{
  const f=await scene();await openArtifact();
  const contradicts=await proposeRelation(f,'contradicts');
  await activateRendered(page.getByTestId(`artifact-relation-confirm-${contradicts.id}`));
  const claim=await recaptureRelations(f);
  await page.getByTestId('artifact-relations-filter').selectOption('conflict');
  assert.match(await page.getByTestId('artifact-relations-matrix').innerText(),/确认 1/u);
  await page.getByTestId('artifact-relations-filter').selectOption('all');await openRelationClaim(f);
  await activateRendered(page.locator(`[data-reading-key="relation-proposal-summary:${claim.id}"]`));
  await page.getByTestId(`artifact-relation-source-${claim.id}`).selectOption('inspector-evidence');
  await page.getByTestId(`artifact-relation-kind-${claim.id}`).selectOption('qualifies');
  assert.equal(await page.getByTestId(`artifact-relation-propose-${claim.id}`).isDisabled(),true);
  await page.getByTestId(`artifact-relation-condition-${claim.id}`).fill('仅适用于保存的样本，单位与原文一致。');
  await activateRendered(page.getByTestId(`artifact-relation-propose-${claim.id}`));
  await recaptureRelations(f);
  const qualifies=f.repository.evidence.relations.list({projectId:f.project.id,claimId:claim.id}).at(-1);
  assert.equal(qualifies.kind,'qualifies');
  assert.match(await page.getByTestId(`artifact-relation-${qualifies.id}`).innerText(),/仅适用于保存的样本/u);
  await activateRendered(page.getByTestId(`artifact-relation-reject-${qualifies.id}`));
  await recaptureRelations(f);
  assert.equal(f.repository.evidence.relations.get(qualifies.id,f.project.id).status,'rejected');
  await page.getByTestId('artifact-relations-filter').selectOption('pending');
  assert.match(await page.getByTestId('artifact-relations').innerText(),/没有符合条件/u);
  await page.getByTestId('artifact-relations-filter').selectOption('weak');
  assert.equal(await page.getByTestId('artifact-relations-matrix').count(),1,'confirmed contradiction does not create confirmed support');
});

test('source invalidation after display refuses a real decision without writes and refresh shows retained invalidated evidence',async()=>{
  const f=await scene();await openArtifact();
  const proposed=await proposeRelation(f);
  f.repository.evidence.invalidateChunksOf('inspector-document');
  const before=f.db.prepare('SELECT total_changes()').pluck().get();
  await activateRendered(page.getByTestId(`artifact-relation-confirm-${proposed.id}`));
  await page.getByTestId(`artifact-relation-${proposed.id}`).getByRole('alert').waitFor();
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  assert.equal(f.repository.evidence.relations.get(proposed.id,f.project.id).status,'invalidated');
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  await page.getByTestId('artifact-inspector-refresh').focus();await page.keyboard.press('Enter');
  const claim=await recaptureRelations(f);
  assert.match(await page.getByTestId(`artifact-relation-${proposed.id}`).innerText(),/来源已失效/u);
  assert.equal(await page.getByTestId(`artifact-relation-confirm-${proposed.id}`).count(),0);
  await activateRendered(page.locator(`[data-reading-key="relation-proposal-summary:${claim.id}"]`));
  await page.getByTestId(`artifact-relation-source-${claim.id}`).selectOption('inspector-evidence');
  await page.getByText('此来源已失效，不能提议新关系。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId(`artifact-relation-propose-${claim.id}`).isDisabled(),true);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
});

test('late actual relation review response cannot refresh or expose the prior project after selection changes',async()=>{
  const f=await scene();await openArtifact();
  const proposed=await proposeRelation(f);
  f.deferRelation='reviewEvidenceRelation';
  await activateRendered(page.getByTestId(`artifact-relation-confirm-${proposed.id}`));
  for(let attempt=0;attempt<100&&f.finishRelation===undefined;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(f.finishRelation);
  assert.equal(await page.getByTestId(`artifact-relation-confirm-${proposed.id}`).isDisabled(),true);
  assert.equal(f.repository.evidence.relations.get(proposed.id,f.project.id).status,'confirmed');
  const other=await scene();
  await openArtifact();
  const before=reads.length;
  f.finishRelation();f.deferRelation=null;
  await page.getByTestId('artifact-relations').waitFor();
  assert.equal(await page.getByTestId(`artifact-relation-${proposed.id}`).count(),0);
  assert.equal(await page.getByText('关系变更已保存，请核对刷新后的工件版本。',{exact:true}).count(),0);
  assert.equal(reads.length,before);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  assert.equal(other.repository.evidence.relations.list({projectId:other.project.id,claimId:null}).length,0);
});

test('long relation excerpts preserve native keyboard reading and matrix layout across light dark narrow windows and reduced motion',async()=>{
  const f=await scene({long:true});
  const claim=f.repository.evidence.listClaims({projectId:f.project.id,artifactId:f.link.artifactId})[0];
  const request={projectId:f.project.id,claimId:claim.id,expectedClaimVersion:claim.version,evidenceId:'inspector-evidence',
    expectedSourceDigest:api.relationSourceDigest(f.repository.evidence.inspectEvidence('inspector-evidence',f.project.id)),
    kind:'qualifies',condition:'实际保存的限定条件。'.repeat(40),supersedesRelationId:null};
  const proposal=await f.bridge.invoke('research.proposeEvidenceRelation',[request],windowId);
  assert.equal(proposal.ok,true);
  await openArtifact();await recaptureRelations(f);
  const before=f.db.prepare('SELECT total_changes()').pluck().get();
  for(const [width,theme,motion] of [[1100,'light','no-preference'],[1099,'dark','reduce'],[800,'light','reduce']]) {
    await page.setViewportSize({width,height:800});await page.emulateMedia({reducedMotion:motion});
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByTestId('artifact-relations-filter').scrollIntoViewIfNeeded();
    const layout=await page.getByTestId('artifact-relations').evaluate(element=>({
      width:element.clientWidth,overflow:element.scrollWidth>element.clientWidth,
      fonts:[...new Set([...element.querySelectorAll('button,select,p,td,th,summary,textarea')].map(node=>getComputedStyle(node).fontSize))]
    }));
    assert.equal(layout.overflow,false);assert.ok(layout.width>350);
    assert.ok(layout.fonts.every(size=>parseFloat(size)>=12));
    await page.getByTestId(`artifact-relation-note-${proposal.data.id}`).waitFor({state:'visible'});
    await page.getByTestId(`artifact-relation-note-${proposal.data.id}`).focus();
    assert.equal(await page.getByTestId(`artifact-relation-note-${proposal.data.id}`).evaluate(element=>element===document.activeElement),true);
    await page.keyboard.press('PageDown');
    await audit(`relations-${width}-${theme}-${motion}`);
  }
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  await page.setViewportSize({width:1100,height:900});await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
});

test('assistant identity links inspect real saved content and source then return focus and actual task without approving',async()=>{
  const f=await scene(),before=f.db.prepare('SELECT total_changes()').pluck().get();
  assert.equal(reads.length,0);
  await openArtifact();
  assert.deepEqual(reads[0],{projectId:f.project.id,artifactId:f.link.artifactId,expectedVersion:f.link.expectedVersion});
  assert.match(await page.getByTestId('artifact-inspector-content').innerText(),/Actual persisted markdown/u);
  assert.match(await page.getByTestId('artifact-inspector-content').innerText(),/假设/u);
  assert.match(await page.getByTestId('artifact-inspector-panel').innerText(),/等待人工审核/u);
  await page.locator('details > summary').filter({hasText:'Original synthetic source'}).click();
  await page.getByText('An actual retained synthetic source excerpt.',{exact:true}).waitFor();
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  await audit('opened-source');
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.testid),'assistant-gate-artifact');
  await openArtifact();await page.getByTestId('artifact-inspector-task').click();
  await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>tasks),[f.snapshot.origin.taskId]);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  assert.equal(f.repository.getArtifact(f.link.artifactId).status,'draft');
});

test('source invalidation changes the actual snapshot and requires explicit new-version recapture',async()=>{
  const f=await scene();await openArtifact();
  f.repository.evidence.invalidateChunksOf('inspector-document');
  await page.getByTestId('artifact-inspector-refresh').click();
  await page.getByText('工件或来源已变更。当前内容需要重新核对。',{exact:false}).waitFor();
  assert.equal(reads.at(-1).expectedVersion,f.link.expectedVersion);
  await page.getByTestId('artifact-inspector-recapture').click();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-inspector-recapture"]'));
  assert.notEqual(reads.at(-1).expectedVersion,f.link.expectedVersion);
  assert.match(await page.getByTestId('artifact-inspector-panel').innerText(),/旧定位已失效/u);
  await page.locator('details > summary').filter({hasText:'Original synthetic source'}).click();
  await page.getByText('An actual retained synthetic source excerpt.',{exact:true}).waitFor();
  assert.throws(()=>f.repository.evidence.getEvidence('inspector-evidence',f.project.id),/research_evidence_reference_superseded/u);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
});

test('same saved version restores native source expansion reading scroll and focus without restoring a human decision',async()=>{
  const f=await scene({long:true});await openArtifact();
  const summary=page.locator('details > summary').filter({hasText:'Original synthetic source'});
  await summary.click();await page.getByText('原始来源长段落与定位说明。'.repeat(120),{exact:true}).waitFor();
  await page.getByText('原始来源长段落与定位说明。'.repeat(120),{exact:true}).scrollIntoViewIfNeeded();
  await summary.focus();
  const before=await summary.evaluate(element=>({top:element.closest('[aria-describedby]').querySelector('[data-reading-key="refresh"]').parentElement.parentElement.parentElement.scrollTop,
    key:document.activeElement.dataset.readingKey}));
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector').waitFor({state:'detached'});
  await page.getByTestId('assistant-gate-artifact').last().focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-inspector-content').waitFor();
  await page.waitForFunction(({top,key})=>{
    const body=document.querySelector('[data-reading-key="refresh"]').parentElement.parentElement.parentElement;
    return Math.abs(body.scrollTop-top)<2&&document.activeElement.dataset.readingKey===key;
  },before);
  assert.equal(await summary.evaluate(element=>element.parentElement.open),true);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  assert.equal(f.repository.getArtifact(f.link.artifactId).status,'draft');
});

test('real empty missing denied and damaged-source states do not become placeholder content or approval',async()=>{
  const f=await scene();
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.empty.id,expectedVersion:null});
  await page.getByText('该工件尚无已保存的角色正文。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-task').count(),0);
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:'missing',expectedVersion:null});
  await page.getByText('工件、项目或关联证据不存在。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-content').count(),0);
  const other=f.repository.createProject({title:'Other',description:'Isolation',workspacePath:'/tmp/inspector-other'});
  await page.evaluate(request=>selectArtifact(request),{projectId:other.id,artifactId:f.link.artifactId,expectedVersion:null});
  await page.getByText('工件或证据不属于当前项目。',{exact:true}).waitFor();
  f.db.prepare('UPDATE research_evidence SET excerpt=? WHERE id=?').run('Corrupted saved source','inspector-evidence');
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.link.artifactId,expectedVersion:null});
  await page.getByText('证据原文与保存的内容校验值不一致。',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-content').count(),0);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
});

test('late real bridge response cannot replace another artifact selection',async()=>{
  const f=await scene();f.defer=true;
  await page.getByTestId('assistant-gate-artifact').last().click();
  await page.getByText('正在读取工件…',{exact:true}).waitFor();
  while(typeof f.finish!=='function') await new Promise(resolve=>setTimeout(resolve,5));
  const finish=f.finish;f.defer=false;
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.empty.id,expectedVersion:null});
  await page.getByText('该工件尚无已保存的角色正文。',{exact:true}).waitFor();finish();
  assert.match(await page.getByTestId('artifact-inspector-panel').innerText(),/Empty real artifact/u);
  assert.doesNotMatch(await page.getByTestId('artifact-inspector-panel').innerText(),/Actual persisted markdown/u);
});

test('source drawer supports keyboard reading and fixed chrome at light dark 1100 1099 and 800 with reduced motion',async()=>{
  await scene({long:true});await openArtifact();
  await page.locator('details > summary').filter({hasText:'Original synthetic source'}).click();
  for(const theme of ['light','dark'])for(const width of [1100,1099,800]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByTestId('artifact-inspector-refresh').scrollIntoViewIfNeeded();
    await page.getByTestId('artifact-inspector-refresh').hover();await audit(theme+'-'+width);
    const layout=await page.evaluate(()=>{
      const panel=document.querySelector('[data-testid="artifact-inspector-panel"]');
      return {scroll:panel.scrollTop,overflow:panel.scrollWidth>panel.clientWidth,title:panel.querySelector('h2').getBoundingClientRect().top,
        small:[...panel.querySelectorAll('p,button,dd,summary')].some(element=>parseFloat(getComputedStyle(element).fontSize)<12)};
    });
    assert.equal(layout.scroll,0);assert.equal(layout.overflow,false);assert.ok(layout.title>=0);assert.equal(layout.small,false);
  }
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
});


test('inspector rereads the entire stage and returns to the original real interrupt before explicit keyboard approval',async()=>{
  const f=await scene();
  const original=f.approval.interruptId;
  await openArtifact();
  f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','Reviewed latest body') WHERE artifact_id=?").run(f.link.artifactId);
  const before=f.db.prepare('SELECT total_changes()').pluck().get();
  await page.getByTestId('artifact-inspector-review').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-inspector-gate-context').waitFor();
  assert.match(await page.getByTestId('artifact-inspector-gate-context').innerText(),/Empty real artifact/u);
  assert.match(await page.getByTestId('artifact-inspector-gate-context').innerText(),/真实保存的阅读产物/u);
  assert.equal(await page.getByTestId('artifact-inspector-return-review').isDisabled(),true);
  await page.getByTestId('artifact-inspector-refresh').click();
  await page.getByTestId('artifact-inspector-content').getByText('Reviewed latest body',{exact:true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-return-review').isDisabled(),false);
  await audit('gate-whole-context');
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  await page.getByTestId('artifact-inspector-return-review').focus();await page.keyboard.press('Enter');
  await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  await page.waitForFunction(()=>document.activeElement.dataset.testid==='assistant-gate-refresh');
  assert.match(await page.getByTestId('assistant-gate-reviewed-at').innerText(),/已重读 2 个工件，需重新确认/u);
  await page.screenshot({path:join(artifacts,'gate-returned-card.png')});
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  await page.getByTestId('assistant-gate-approve').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.resumeResult?.done===true||window.resumeError!==null);
  assert.equal(await page.evaluate(()=>window.resumeError),null);
  assert.equal(f.repository.getWorkflow(f.project.id).currentStage,'ideation');
  const decision=(await page.evaluate(()=>decisions))[0];
  assert.equal(decision.id,original);
  assert.equal(decision.decisions[0].reviewedArtifactVersions.length,2);
  assert.notEqual(decision.decisions[0].reviewedArtifactVersions.find(value=>value.artifactId===f.link.artifactId).version,f.link.expectedVersion);
});

test('old card approval refuses stale data and displays a new real interrupt before a new human decision',async()=>{
  const f=await scene(),original=f.approval.interruptId;
  f.db.prepare("UPDATE research_artifact_contents SET output_json=json_set(output_json,'$.markdown','Changed after review') WHERE artifact_id=?").run(f.link.artifactId);
  const before=f.db.prepare('SELECT total_changes()').pluck().get();
  await page.getByTestId('assistant-gate-approve').click();
  await page.getByTestId('assistant-gate-review-error').waitFor();
  assert.notEqual(f.approval.interruptId,original);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  assert.equal(f.repository.getArtifact(f.link.artifactId).status,'draft');
  assert.equal((await page.evaluate(()=>decisions)).length,1);
  await page.getByTestId('assistant-gate-refresh').focus();await page.keyboard.press('Enter');
  await page.getByTestId('assistant-gate-reviewed-at').waitFor();
  assert.equal((await page.evaluate(()=>decisions)).length,1);
  await page.getByTestId('assistant-gate-reject').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.resumeResult?.done===true||window.resumeError!==null);
  assert.equal(await page.evaluate(()=>window.resumeError),null);
  assert.equal(f.repository.getWorkflow(f.project.id).currentStage,'reading');
  assert.equal(f.repository.getWorkflow(f.project.id).stages.find(value=>value.stage==='reading').status,'running');
});

test('late whole-context reads are discarded on selection or project replacement and never submit decisions',async()=>{
  const f=await scene();await openArtifact();f.deferGate=true;
  await page.getByTestId('artifact-inspector-review').click();
  await page.getByText('正在读取整个阶段的审核上下文…',{exact:true}).waitFor();
  while(typeof f.finishGate!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  const finish=f.finishGate;f.deferGate=false;
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.empty.id,expectedVersion:null});
  await page.getByText('该工件尚无已保存的角色正文。',{exact:true}).waitFor();finish();
  assert.equal(await page.getByTestId('artifact-inspector-gate-context').count(),0);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  f.deferGate=true;delete f.finishGate;
  await page.getByTestId('artifact-inspector-review').click();
  while(typeof f.finishGate!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  const last=f.finishGate;
  const next=await scene();last();
  assert.equal(await page.getByTestId('assistant-gate-reviewed-at').count(),0);
  assert.equal(await page.getByTestId('artifact-inspector-panel').count(),0);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  assert.equal(next.repository.getWorkflow(next.project.id).currentStage,'reading');
});

async function openMigrationSource(f,{current=true}={}) {
  await openArtifact();
  if(current) {
    await page.getByTestId('artifact-inspector-recapture').waitFor();
    await activateRendered(page.getByTestId('artifact-inspector-recapture'));
    await page.getByTestId('artifact-inspector-recapture').waitFor({state:'detached'});
  }
  await expandMigrationSource(f);
}
async function expandMigrationSource(f) {
  const summary=page.locator(`[data-reading-key="evidence-summary:${f.source.id}"]`);
  await summary.waitFor({state:'visible'});
  if(!await summary.evaluate(element=>element.parentElement.open)) await activateRendered(summary);
  assert.equal(await summary.evaluate(element=>element.parentElement.open),true);
  const toggle=page.getByTestId(`artifact-source-migrations-toggle-${f.source.id}`);
  await toggle.waitFor({state:'visible'});
  if(await toggle.getAttribute('aria-expanded')!=='true') await activateRendered(toggle);
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
}
async function openMigrationCandidate(f,proposalId) {
  const inspection=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:f.source.id});
  const id=proposalId??inspection[0].proposal.id;
  const details=page.getByTestId(`artifact-source-migration-${id}`);
  await details.waitFor({state:'visible'});
  if(!await details.evaluate(element=>element.open)) await activateRendered(details.locator(':scope > summary'));
  await details.locator(':scope > div').waitFor({state:'visible'});
  return details;
}

test('migration inspector requires current recapture and an explicit keyboard target, retaining the original scientific records',async()=>{
  const f=await scene({managed:true});
  const claim=f.repository.evidence.listClaims({projectId:f.project.id,artifactId:f.link.artifactId})[0];
  const proposed=f.repository.evidence.relations.propose({projectId:f.project.id,claimId:claim.id,
    expectedClaimVersion:claim.version,evidenceId:f.source.id,
    expectedSourceDigest:api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.source.id,f.project.id)),
    kind:'supports',condition:null,supersedesRelationId:null},{kind:'user',id:'synthetic-before-ui-reparse'});
  f.repository.evidence.relations.review({projectId:f.project.id,relationId:proposed.id,expectedVersion:proposed.version,
    expectedClaimVersion:claim.version,expectedSourceDigest:proposed.sourceDigest,decision:'confirm',note:null},
  {kind:'user',id:'synthetic-before-ui-reparse'});
  f.reparse('inspector-new');
  const original={claim:f.repository.evidence.getClaim(claim.id),
    source:f.repository.evidence.inspectEvidence(f.source.id,f.project.id),
    review:f.repository.evidence.relations.history(proposed.id,f.project.id)};
  const before=f.db.prepare('SELECT total_changes()').pluck().get();
  await openMigrationSource(f,{current:false});
  let candidate=await openMigrationCandidate(f);
  assert.equal(await candidate.getByTestId('artifact-source-migration-capture').isDisabled(),true);
  assert.equal(await candidate.getByTestId('artifact-source-migration-reject').isDisabled(),true);
  assert.equal(await candidate.locator('input:checked').count(),0);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  await activateRendered(page.getByTestId('artifact-inspector-recapture'));
  await page.getByTestId('artifact-inspector-recapture').waitFor({state:'detached'});
  await expandMigrationSource(f);
  candidate=await openMigrationCandidate(f);
  const target=candidate.getByTestId('artifact-source-migration-target-1');
  await target.waitFor({state:'visible'});await target.focus();await page.keyboard.press('Space');
  assert.equal(await target.isChecked(),true);
  await candidate.getByTestId('artifact-source-migration-note').fill('人工选择第三页的第二个块。');
  const sourceDetails=page.locator(`[data-reading-key="evidence:${f.source.id}"]`);
  await sourceDetails.evaluate(async details=>{await Promise.all(details.getAnimations({subtree:true}).map(animation=>animation.finished));});
  const sourceLayout=await sourceDetails.evaluate(details=>({
    summaryBottom:details.querySelector(':scope > summary').getBoundingClientRect().bottom,
    firstTop:details.querySelector(':scope > p').getBoundingClientRect().top,
    pseudo:getComputedStyle(details,'::details-content').overflow
  }));
  await page.waitForFunction(id=>{
    const details=document.querySelector(`[data-testid="artifact-source-migration-${id}"]`);
    return details!==null&&details.querySelector(':scope > div').getBoundingClientRect().bottom<=details.getBoundingClientRect().bottom;
  },f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:f.source.id})[0].proposal.id);
  const candidateLayout=await candidate.evaluate(details=>({
    summaryBottom:details.querySelector(':scope > summary').getBoundingClientRect().bottom,
    firstTop:details.querySelector(':scope > div > p').getBoundingClientRect().top,
    bottom:details.getBoundingClientRect().bottom,
    bodyBottom:details.querySelector(':scope > div').getBoundingClientRect().bottom,
    blockSize:getComputedStyle(details,'::details-content').blockSize,
    animations:details.getAnimations({subtree:true}).map(animation=>({state:animation.playState,current:animation.currentTime,
      timing:animation.effect.getComputedTiming()})),
    scrollTop:details.scrollTop,
    pseudo:getComputedStyle(details,'::details-content').overflow
  }));
  writeFileSync(join(artifacts,'source-migration-candidate-layout.json'),JSON.stringify(candidateLayout,null,2));
  writeFileSync(join(artifacts,'source-migration-source-layout.json'),JSON.stringify(sourceLayout,null,2));
  assert.ok(sourceLayout.firstTop>=sourceLayout.summaryBottom,'source disclosure must retain its original locator and excerpt above the migration area');
  assert.ok(candidateLayout.firstTop>=candidateLayout.summaryBottom,'expanded native details must show the beginning of the candidate above its target controls');
  assert.ok(candidateLayout.bodyBottom<=candidateLayout.bottom,'expanded candidate must contain its target controls and notes after all ancestor animations finish');
  await audit('source-migration-ambiguous-keyboard');
  await activateRendered(candidate.getByTestId('artifact-source-migration-capture'));
  await page.getByTestId('artifact-source-migrations').getByText('已捕获新证据',{exact:true}).waitFor();
  candidate=await openMigrationCandidate(f);
  await candidate.getByTestId('artifact-source-migration-decision').waitFor({state:'visible'});
  const decision=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:f.source.id})[0].decision;
  assert.equal(decision.actor.id,`window:${windowId}`);
  assert.equal(decision.request.chunkId,'document:inspector-new:chunk:1');
  assert.equal(decision.request.note,'人工选择第三页的第二个块。');
  assert.equal(decision.capturedSource.sourceLocator.blockId,'target-second');
  assert.equal(decision.capturedSource.sourceLocator.locations[0].page,3);
  assert.match(await candidate.innerText(),/当前定位仍有效/u);
  assert.equal(await candidate.getByTestId('artifact-source-migration-target-1').isChecked(),true);
  assert.equal(await candidate.getByTestId('artifact-source-migration-target-1').isDisabled(),true);
  assert.deepEqual(f.repository.evidence.getClaim(claim.id),original.claim);
  assert.deepEqual(f.repository.evidence.inspectEvidence(f.source.id,f.project.id),original.source);
  assert.deepEqual(f.repository.evidence.relations.history(proposed.id,f.project.id),original.review);
  assert.equal(original.review.at(-1).relation.status,'invalidated');
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  await candidate.scrollIntoViewIfNeeded();await audit('source-migration-captured-history');
  const after=f.db.prepare('SELECT total_changes()').pluck().get();
  await activateRendered(page.getByTestId('artifact-source-migrations-refresh'));
  candidate=await openMigrationCandidate(f);
  await candidate.getByTestId('artifact-source-migration-decision').waitFor({state:'visible'});
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),after);
  assert.equal(f.repository.getArtifact(f.link.artifactId).status,'draft');
  f.reparse('inspector-later');
  const changed=f.db.prepare('SELECT total_changes()').pluck().get();
  await activateRendered(page.getByTestId('artifact-source-migrations-refresh'));
  candidate=await openMigrationCandidate(f,decision.proposalId);
  await candidate.getByTestId('artifact-source-migration-decision').waitFor({state:'visible'});
  assert.match(await candidate.innerText(),/该新证据的位置也已失效/u);
  assert.deepEqual(f.repository.evidence.sourceMigrations.get({projectId:f.project.id,proposalId:decision.proposalId}).decision,decision);
  assert.equal(decision.capturedSource.referenceStatus,'recorded');
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),changed);
});

test('migration inspector refuses an obsolete selected target, rereads fixed history and explicitly rejects an unmatched proposal',async()=>{
  const f=await scene({managed:true});f.reparse('inspector-new');
  await openMigrationSource(f);
  let candidate=await openMigrationCandidate(f);
  const oldProposal=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:f.source.id})[0].proposal;
  await candidate.getByTestId('artifact-source-migration-target-0').check();
  f.reparse('inspector-third',[{id:'changed',kind:'paragraph',label:'Changed scientific paragraph',text:'Different scientific statement.',
    locator:'page:4',imageAssetId:null,locations:[]}]);
  const before=f.db.prepare('SELECT total_changes()').pluck().get();
  await activateRendered(candidate.getByTestId('artifact-source-migration-capture'));
  await candidate.getByRole('alert').waitFor();
  assert.match(await candidate.getByRole('alert').innerText(),/候选、请求或来源已改变/u);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  assert.equal(f.repository.evidence.list(f.project.id).length,1);
  await activateRendered(page.getByTestId('artifact-source-migrations-refresh'));
  candidate=await openMigrationCandidate(f,oldProposal.id);
  assert.match(await candidate.innerText(),/旧目标已被新解析替换/u);
  assert.equal(await candidate.getByTestId('artifact-source-migration-capture').isDisabled(),true);
  const latest=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:f.source.id}).at(-1);
  assert.equal(latest.proposal.match,'no_match');
  candidate=await openMigrationCandidate(f,latest.proposal.id);
  assert.equal(await candidate.getByTestId('artifact-source-migration-target-0').count(),0);
  assert.equal(await candidate.getByTestId('artifact-source-migration-capture').isDisabled(),true);
  await candidate.getByTestId('artifact-source-migration-note').fill('正文已变更，拒绝自动定位。');
  await activateRendered(candidate.getByTestId('artifact-source-migration-reject'));
  await page.getByTestId(`artifact-source-migration-${latest.proposal.id}`).getByText('已拒绝',{exact:true}).waitFor();
  candidate=await openMigrationCandidate(f,latest.proposal.id);
  await candidate.getByTestId('artifact-source-migration-decision').waitFor({state:'visible'});
  assert.match(await candidate.innerText(),/未捕获新证据/u);
  assert.equal(f.repository.evidence.list(f.project.id).length,1);
  assert.deepEqual(f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:f.source.id})[0].proposal,oldProposal);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
});

test('late migration reads and successful pending capture cannot affect another artifact or project',async()=>{
  const f=await scene({managed:true});f.reparse('inspector-new');f.deferRelation='listSourceMigrations';
  await openMigrationSource(f);
  await page.getByText('正在读取定位候选…',{exact:true}).waitFor();
  while(typeof f.finishRelation!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  const finishRead=f.finishRelation;f.deferRelation=null;
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.empty.id,expectedVersion:null});
  await page.getByText('该工件尚无已保存的角色正文。',{exact:true}).waitFor();finishRead();
  assert.equal(await page.getByTestId('artifact-source-migrations').count(),0);
  await page.evaluate(request=>selectArtifact(request),{projectId:f.project.id,artifactId:f.link.artifactId,expectedVersion:null});
  await page.getByTestId('artifact-inspector-content').waitFor();
  await activateRendered(page.locator(`[data-reading-key="evidence-summary:${f.source.id}"]`));
  await activateRendered(page.getByTestId(`artifact-source-migrations-toggle-${f.source.id}`));
  const candidate=await openMigrationCandidate(f);
  await candidate.getByTestId('artifact-source-migration-target-1').check();
  f.deferRelation='captureSourceMigration';delete f.finishRelation;
  await activateRendered(candidate.getByTestId('artifact-source-migration-capture'));
  await candidate.getByText('正在保存决定…',{exact:true}).waitFor();
  assert.equal(await candidate.getByTestId('artifact-source-migration-reject').isDisabled(),true);
  assert.equal(await candidate.getByTestId('artifact-source-migration-note').isDisabled(),true);
  while(typeof f.finishRelation!=='function')await new Promise(resolve=>setTimeout(resolve,5));
  const finishCapture=f.finishRelation;
  const decision=f.repository.evidence.sourceMigrations.list({projectId:f.project.id,evidenceId:f.source.id})[0].decision;
  assert.ok(decision,'pending transport already committed the original project decision');
  const next=await scene();finishCapture();
  await page.getByTestId('assistant-gate-artifact').last().waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-panel').count(),0);
  assert.equal(await page.getByTestId('artifact-source-migrations').count(),0);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
  assert.equal(next.repository.evidence.list(next.project.id).length,1);
  assert.equal(f.repository.evidence.list(f.project.id).length,2);
});

test('migration snapshot damage is an explicit error and only an actual restored snapshot can be reread',async()=>{
  const f=await scene({managed:true});f.reparse('inspector-new');
  const row=f.db.prepare('SELECT id,snapshot_json FROM research_source_migration_proposals').get();
  f.db.prepare("UPDATE research_source_migration_proposals SET snapshot_json=json_set(snapshot_json,'$.targets[0].block.text','Corrupt target') WHERE id=?")
    .run(row.id);
  const before=f.db.prepare('SELECT total_changes()').pluck().get();
  await openMigrationSource(f);
  const panel=page.getByTestId('artifact-source-migrations');
  await panel.getByRole('alert').waitFor();
  assert.match(await panel.getByRole('alert').innerText(),/保存的候选、捕获或目标块校验失败/u);
  assert.equal(await panel.getByTestId('artifact-source-migration-capture').count(),0);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
  f.db.prepare('UPDATE research_source_migration_proposals SET snapshot_json=? WHERE id=?').run(row.snapshot_json,row.id);
  const restored=f.db.prepare('SELECT total_changes()').pluck().get();
  await activateRendered(page.getByTestId('artifact-source-migrations-refresh'));
  const candidate=await openMigrationCandidate(f);
  assert.equal(await panel.getByRole('alert').count(),0);
  assert.equal(await candidate.getByTestId('artifact-source-migration-capture').isDisabled(),true);
  assert.equal(await candidate.locator('input:checked').count(),0);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),restored);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
});

test('migration long targets remain keyboard readable at light800 and dark1099 with fixed chrome and no horizontal overflow',async()=>{
  const f=await scene({managed:true,long:true});f.reparse('inspector-new');
  await openMigrationSource(f);
  const candidate=await openMigrationCandidate(f);
  for(const [theme,width] of [['light',800],['dark',1099]]) {
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const note=candidate.getByTestId('artifact-source-migration-note');
    await note.waitFor({state:'visible'});await note.focus();await page.keyboard.press('PageDown');
    await note.scrollIntoViewIfNeeded();
    await audit(`source-migration-${theme}-${width}`);
    const layout=await page.evaluate(()=>{
      const panel=document.querySelector('[data-testid="artifact-inspector-panel"]');
      const migration=document.querySelector('[data-testid="artifact-source-migrations"]');
      return {overflow:panel.scrollWidth>panel.clientWidth||migration.scrollWidth>migration.clientWidth,
        title:panel.querySelector('h2').getBoundingClientRect().top,
        small:[...migration.querySelectorAll('p,button,dd,summary,span')].some(element=>parseFloat(getComputedStyle(element).fontSize)<12),
        selected:migration.querySelectorAll('input:checked').length};
    });
    assert.equal(layout.overflow,false);assert.ok(layout.title>=0);assert.equal(layout.small,false);assert.equal(layout.selected,0);
    assert.equal(await note.evaluate(element=>element===document.activeElement),true);
  }
  await page.keyboard.press('Escape');await page.getByTestId('artifact-inspector-panel').waitFor({state:'detached'});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  assert.equal(f.repository.evidence.list(f.project.id).length,1);
  assert.deepEqual(await page.evaluate(()=>decisions),[]);
});
