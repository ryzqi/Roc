import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {reviewProtocolBodyFixture} from '../unit/fixtures/research-review-protocol.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture} from '../unit/fixtures/research-review-fulltext-screening.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c5-ui');
const channels = {
  listReviewProtocols: 'roc:research:review-protocol-list', getReviewProtocol: 'roc:research:review-protocol-get',
  getReviewProtocolHistory: 'roc:research:review-protocol-history', listReviewSearches: 'roc:research:review-search-list',
  listReviewCorpora: 'roc:research:review-corpus-list', getReviewCorpus: 'roc:research:review-corpus-get',
  getReviewCorpusHit: 'roc:research:review-corpus-hit', getReviewDeduplication: 'roc:research:review-deduplication-get',
  saveReviewDuplicateDecision: 'roc:research:review-deduplication-save',
  getReviewDuplicateDecisionHistory: 'roc:research:review-deduplication-history',
  freezeReviewDeduplication: 'roc:research:review-deduplication-freeze',
  createReviewScreeningPlan: 'roc:research:review-screening-createPlan', getReviewScreeningPlan: 'roc:research:review-screening-getPlan',
  getReviewScreeningPhase:'roc:research:review-screening-phase',saveReviewScreeningDecision:'roc:research:review-screening-save',
  getReviewScreeningDecisionHistory:'roc:research:review-screening-history',listReviewScreeningSuggestions:'roc:research:review-screening-suggestions',
  adjudicateReviewScreening:'roc:research:review-screening-adjudicate',getReviewScreeningArbitrationHistory:'roc:research:review-screening-arbitrations',freezeReviewScreeningPhase:'roc:research:review-screening-freeze',
  getReviewFullTextScreeningPhase:'roc:research:review-fulltext-phase',saveReviewFullTextBinding:'roc:research:review-fulltext-save',
  getReviewFullTextBindingHistory:'roc:research:review-fulltext-history',listLibrary:'roc:research:library-list',
  listDocuments:'roc:research:document-list',previewDocument:'roc:research:document-preview',
  getDocument:'roc:research:document-get',getDocumentContent:'roc:research:document-content',
  saveReviewFullTextDecision:'roc:research:review-fulltext-decision-save',getReviewFullTextDecisionHistory:'roc:research:review-fulltext-decision-history',
  listReviewFullTextSuggestions:'roc:research:review-fulltext-suggestions',
  getReviewFullTextArbitrationHistory:'roc:research:review-fulltext-arbitrations',
  listReviewExtractions:'roc:research:review-extraction-list',saveReviewExtraction:'roc:research:review-extraction-save',
  getReviewExtractionHistory:'roc:research:review-extraction-history',listEvidence:'roc:research:evidence-list',inspectEvidence:'roc:research:evidence-inspect',getReviewStudies:'roc:research:review-studies-get',saveReviewStudies:'roc:research:review-studies-save',getReviewStudiesHistory:'roc:research:review-studies-history'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-studies-ui-')); mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({initialRequest,writable}) {
      const [request,setRequest]=useState(initialRequest),[open,setOpen]=useState(true);
      const [readingLocations]=useState(()=>new Map()),[reviewDrafts]=useState(()=>new Map());
      window.selectReview=next=>flushSync(()=>setRequest(next));
      return <main><button data-testid="literature-review-inspect" onClick={()=>setOpen(true)}>综述核查</button>
        {!open?null:<ArtifactInspector key={JSON.stringify(request)} client={client} selection={{kind:'review',request}}
          writable={writable} readingLocations={readingLocations} reviewDrafts={reviewDrafts}
          onClose={()=>setOpen(false)} onOpenTask={()=>{}}/>}
      </main>;
    }
    let generation=0;
    window.mount=(initialRequest,writable=true)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initialRequest={initialRequest} writable={writable}/></LazyMotion></MotionConfig>));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{padding:16px}'});
  await build({entryPoints:['src/main/pdf-preview-protocol.ts'],outfile:join(directory,'protocol.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
  writeFileSync(join(directory,'main.cjs'),`const {app,BrowserWindow}=require('electron');
    const protocol=require(${JSON.stringify(join(directory,'protocol.cjs'))});protocol.registerPdfPreviewScheme();
    app.setPath('userData',${JSON.stringify(join(directory,'data'))});
    app.whenReady().then(()=>{
      protocol.registerPdfPreviewProtocol(()=>({invokeCapability:async(name,input)=>{
        const method=name==='research.document.source'?'source':name==='research.document.asset'?'asset':null;
        if(method===null)throw new Error('unsupported test resource');
        const result=await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.callMain('+JSON.stringify(method)+','+JSON.stringify(input)+')');
        if(!result.ok)throw new Error(result.message);
        return new Response(new Uint8Array(result.bytes),{headers:result.headers});
      }}),null);
      return new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory,'index.html'))});
    });`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Encountered two children with the same key|Each child in a list should have a unique/u.test(message.text())) errors.push(message.text());
  });
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input});
    if(method==='source'||method==='asset'){
      try{const response=await f.registry.invoke(`research.document.${method}`,input);return {ok:true,bytes:Array.from(new Uint8Array(await response.arrayBuffer())),headers:Object.fromEntries(response.headers)};}
      catch(error){return {ok:false,message:error.message};}
    }
    api.parseIpcRequestArgs(channels[method], [input]);
    if (method === f.failMethod && f.readFailure) return {ok:false,error:f.readFailure};
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
    if (method === 'getDocumentContent' && f.mismatchContent && result.ok) return {...result,data:{...result.data,run:{...result.data.run,id:'wrong-echoed-full-parse'}}};
    if (method === f.loseReply) {
      f.loseReply = null; assert.equal(result.ok, true, JSON.stringify(result));
      return {ok: false, error: {message: 'Synthetic actual commit reply lost'}};
    }
    if (method === f.deferMethod) {
      return new Promise(resolve => {f.release = () => resolve(result); f.started();});
    }
    return result;
  });
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {
    for (const f of fixtures) {await f.libraryService?.shutdown();await f.cleanup();}
    api?.dispose(); if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
async function fixture({included=[0,2],...options}={}) {
  const f=await createReviewFullTextScreeningFixture(api,options);
  fixtures.push(f);f.includedIndices=included;
  for(const index of [0,2,3,4,5,6,7]) {
    if(included.includes(index)) {
      await f.bind(index);
      for(const reviewer of f.reviewerIds)await f.fullScreening.save(f.vote(index,reviewer,`include-${index}-${reviewer}`),actor);
    }else await f.fulltexts.save(f.notRetrieved(index,`gap-${index}`),actor);
  }
  f.fullFrozen=await f.fullFreezing.freeze({...f.fullPhase,requestId:'freeze-for-ui-groups',
    expectedReviewHash:f.fullFreezing.getPhase(f.fullPhase).reviewHash,reviewNote:'Synthetic human confirms fulltext sources for explicit report memberships'},actor);
  f.extractions=new api.ResearchReviewExtractionRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,f.service,()=>f.time);
  f.studies=new api.ResearchReviewStudiesRepository(f.db,f.repository,f.fullFreezing,f.fulltexts,()=>f.time);
  const registry=new api.CapabilityRegistry();
  for(const descriptor of [...api.researchSystematicReviewCapabilities,...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities,...api.researchReviewDeduplicationCapabilities,...api.researchReviewScreeningCapabilities,
    ...api.researchReviewFullTextCapabilities,...api.researchReviewFullTextScreeningCapabilities,...api.researchLibraryCapabilities,...api.researchDocumentCapabilities,...api.researchReviewExtractionCapabilities,...api.researchEvidenceCapabilities,...api.researchReviewStudiesCapabilities])registry.declare('research',descriptor);
  const context={pluginId:'research',capabilities:registry};
  api.registerResearchSystematicReviewCapabilities(context,f.repository.systematicReviews);
  api.registerResearchReviewSearchCapabilities(context,f.reviews);api.registerResearchReviewCorpusCapabilities(context,f.corpora);
  api.registerResearchReviewDeduplicationCapabilities(context,f.dedup);
  api.registerResearchReviewScreeningCapabilities(context,f.screening,f.decisions,f.arbitration,f.freezing);
  api.registerResearchReviewFullTextCapabilities(context,f.fulltexts);
  api.registerResearchReviewFullTextScreeningCapabilities(context,f.fullScreening,f.fullArbitration,f.fullFreezing);
  f.libraryService=new api.ResearchLibraryService(f.repository.library,{},f.root,async()=>{throw new Error('unexpected_external_library_request');});
  api.registerResearchLibraryCapabilities(context,f.repository.library,f.libraryService);
  api.registerResearchDocumentCapabilities(context,f.repository.documents,f.service);
  api.registerResearchEvidenceCapabilities(context,f.repository.evidence);
  api.registerResearchReviewExtractionCapabilities(context,f.extractions);
  api.registerResearchReviewStudiesCapabilities(context,f.studies);
  f.registry=registry;
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
  return f;
}
async function mount(f, writable = true) {
  active = f;
  await page.evaluate(({request, writable}) => window.mount(request, writable),
    {request: {projectId: f.project.id, versionId: f.protocol.version.id}, writable});
  await tid('artifact-review-corpus-inspect').first().waitFor();
  await tid('artifact-review-corpus-inspect').first().focus();
  await page.keyboard.press('Enter');
  await tid('artifact-review-dedup').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-review-dedup-refresh"]').disabled);
  if (f.frozen === null) return;
  await tid('artifact-review-screening-inspect').focus(); await page.keyboard.press('Enter');
  await tid('artifact-review-screening-plan').waitFor();
  await tid('artifact-review-screening-plan-frozen').waitFor();
  await tid('artifact-review-title-inspect').focus(); await page.keyboard.press('Enter');
  await tid('artifact-review-title').waitFor();
  await tid('artifact-review-title-frozen').waitFor();
  await tid('artifact-review-fulltext-inspect').focus();await page.keyboard.press('Enter');
  await tid('artifact-review-fulltext-frozen').waitFor();
  await tid('artifact-review-studies-inspect').focus();await page.keyboard.press('Enter');
  await tid('artifact-review-studies').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-studies-refresh"]').disabled);
}




const actor={kind:'user',id:'synthetic-study-group-human'};
function groups(f,requestId='groups-original') {
  return {...f.get,requestId,expectedFullFreezeHash:f.fullFrozen.freezeHash,
    groups:f.includedIndices.length===0?[]:[{studyId:'study-one',label:'Synthetic study one',reason:'Synthetic explicit human investigation identity',
      reports:f.includedIndices.map(index=>({hitId:f.corpus.snapshot.hits[index].id,expectedBindingHash:f.bound.get(index).snapshotHash,
        sourceNote:'Synthetic human identifies this investigation in the bound original report'}))}],
    reviewerId:f.reviewerIds[0],reviewNote:'Synthetic human confirms exact report memberships without inferred study identity',
    parentGroupingId:null,expectedParentHash:null,revisionReason:null};
}
async function fillGroup(f,position=1,indices=f.includedIndices,id='study-one') {
  const label=`研究 ${position}`;
  await page.getByRole('button',{name:'添加声明研究',exact:true}).click();
  await page.getByLabel(`${label}ID`,{exact:true}).fill(id);await page.getByLabel(`${label}名称`,{exact:true}).fill(`Synthetic ${id==='study-one'?'study one':id}`);
  await page.getByLabel(`${label}身份理由`,{exact:true}).fill('Synthetic explicit human investigation identity');
  for(const index of indices) {
    await page.getByLabel(`${label}纳入报告`,{exact:true}).selectOption(f.corpus.snapshot.hits[index].id);
    await page.getByLabel(`${label}报告原文说明`,{exact:true}).fill('Synthetic human identifies this investigation in the bound original report');
    await tid('artifact-review-study-group').filter({has:page.getByRole('heading',{name:label,exact:true})}).getByTestId('artifact-review-study-report-add').click();
  }
}
async function fill(f) {
  if(f.includedIndices.length>0)await fillGroup(f);
  await page.getByLabel('归组审核人',{exact:true}).selectOption(f.reviewerIds[0]);
  await page.getByLabel('归组审核说明',{exact:true}).fill(groups(f).reviewNote);
}
async function save() {await tid('artifact-review-studies-save').click();await tid('artifact-review-studies-current').waitFor();}
async function audit(label) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="artifact-inspector-panel"]');
    return panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(panel).transform === 'none';
  });
  const source = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const result = await page.evaluate(`(${source})({root:'body',viewport:true})`);
  assert.equal(result.cut, 0);
  writeFileSync(join(artifacts, `${label}-audit.json`), JSON.stringify(result, null, 2));
  await page.screenshot({path: join(artifacts, `${label}.png`)});
}

test('unreviewed studies remain unreported until human groups two exact included reports into one declared study',async()=>{
  const f=await fixture();await mount(f);await tid('artifact-review-studies-unreviewed').waitFor();
  assert.equal(await tid('artifact-review-study-group').count(),0);assert.equal(await tid('artifact-review-studies-save').isDisabled(),true);
  await fill(f);await audit('studies-default');await tid('artifact-review-studies-save').hover();await audit('studies-hover');await save();
  const saved=f.studies.get(f.get);assert.deepEqual(saved.snapshot.request.groups,groups(f).groups);
  assert.equal(saved.includedReports,2);assert.equal(saved.includedStudies,1);assert.equal(saved.snapshot.actor.id,`window:${windowId}`);
  assert.equal(saved.snapshot.request.expectedFullFreezeHash,f.fullFrozen.freezeHash);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),1);
});

test('incomplete report membership and duplicate member selection cannot submit a complete study declaration',async()=>{
  const f=await fixture();await mount(f);await fillGroup(f,1,[0]);
  await page.getByLabel('归组审核人',{exact:true}).selectOption(f.reviewerIds[0]);await page.getByLabel('归组审核说明',{exact:true}).fill(groups(f).reviewNote);
  assert.equal(await tid('artifact-review-studies-save').isDisabled(),true);
  await page.getByLabel('研究 1纳入报告',{exact:true}).selectOption(f.corpus.snapshot.hits[0].id);
  await page.getByLabel('研究 1报告原文说明',{exact:true}).fill('Synthetic repeated member cannot add a second duplicate');
  assert.equal(await tid('artifact-review-study-report-add').isDisabled(),true);assert.equal(f.studies.get(f.get),null);
});

test('one report can explicitly contribute to different declared studies while unique report count remains fixed',async()=>{
  const f=await fixture();await mount(f);await fill(f);await fillGroup(f,2,[0],'study-two');await save();
  const saved=f.studies.get(f.get);assert.equal(saved.includedReports,2);assert.equal(saved.includedStudies,2);
  assert.equal(saved.snapshot.request.groups[1].reports[0].hitId,saved.snapshot.request.groups[0].reports[0].hitId);
});

test('duplicate study IDs cannot be accepted even when all reports are explicitly covered',async()=>{
  const f=await fixture();await mount(f);await fill(f);await fillGroup(f,2,[0],'study-one');
  assert.equal(await tid('artifact-review-studies-save').isDisabled(),true);assert.equal(f.studies.get(f.get),null);
});

test('precise parent membership revision keeps original two-report one-study receipt and native complete history',async()=>{
  const f=await fixture();await mount(f);await fill(f);await save();const first=f.studies.get(f.get);
  await tid('artifact-review-studies-revise').click();await tid('artifact-review-study-group').getByRole('button',{name:'移除此报告关联',exact:true}).nth(1).click();
  await fillGroup(f,2,[2],'study-two');await page.getByLabel('归组修订原因',{exact:true}).fill('Synthetic human separates declared investigation identities');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-studies-current"]')?.textContent.includes('版本 2'));
  const history=f.studies.history(f.get);assert.equal(history.length,2);assert.deepEqual(history[0],{...first,isLatest:false});
  assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);assert.equal(history[1].includedStudies,2);
  const details=tid('artifact-review-studies-history');await details.locator('summary').first().click();
  await details.locator('li').first().locator('summary').click();await details.locator('li').first().locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await details.locator('li').first().locator('pre').innerText()),first.snapshot);await audit('studies-expanded-history');
});

test('zero included reports still require an explicit reviewed empty grouping before zero studies is reported',async()=>{
  const f=await fixture({included:[]});await mount(f);await tid('artifact-review-studies-unreviewed').waitFor();assert.equal(f.studies.get(f.get),null);
  assert.equal(await page.getByRole('button',{name:'添加声明研究',exact:true}).isDisabled(),true);await fill(f);await save();
  assert.equal(f.studies.get(f.get).includedReports,0);assert.equal(f.studies.get(f.get).includedStudies,0);
});

test('lost real grouping reply retries exact membership once without duplicate receipts',async()=>{
  const f=await fixture();await mount(f);await fill(f);f.loseReply='saveReviewStudies';const start=calls.length;
  await tid('artifact-review-studies-save').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  const writes=calls.slice(start).filter(call=>call.method==='saveReviewStudies');assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);
  assert.equal(f.studies.history(f.get).length,1);
});

test('true source byte drift refuses new grouping and exact restoration permits the unchanged request',async()=>{
  const f=await fixture();await mount(f);await fill(f);writeFileSync(f.sourcePath,Buffer.from('synthetic grouping source drift'));const before=f.changes();
  await tid('artifact-review-studies-save').click();await page.getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.studies.get(f.get),null);writeFileSync(f.sourcePath,f.original);await save();
});

test('pending grouping preserves its form while blocking source refresh, extraction entry and close',async()=>{
  const f=await fixture();await mount(f);await fill(f);const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='saveReviewStudies';
  await tid('artifact-review-studies-save').click();await begun;assert.equal(await tid('artifact-review-studies-form').count(),1);
  assert.equal(await page.getByLabel('研究 1ID',{exact:true}).isDisabled(),true);assert.equal(await tid('artifact-review-fulltext-refresh').isDisabled(),true);
  assert.equal(await tid('artifact-review-extractions-inspect').isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);
  f.deferMethod=null;f.release();await tid('artifact-review-studies-current').waitFor();
});

test('lost marked grouping cannot become unreviewed and a late prior-project receipt cannot populate a fresh project',async()=>{
  const broken=await fixture();await broken.studies.save(groups(broken),actor);broken.db.prepare('DELETE FROM research_review_study_groupings').run();
  await mount(broken);await page.getByRole('alert').filter({hasText:'校验失败'}).first().waitFor();assert.equal(await tid('artifact-review-studies-form').count(),0);
  const f=await fixture(),next=await fixture();await f.studies.save(groups(f),actor);await mount(f);
  const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='getReviewStudies';await tid('artifact-review-studies-refresh').click();await begun;
  await mount(next);f.deferMethod=null;f.release();await tid('artifact-review-studies-unreviewed').waitFor();
  assert.equal(await tid('artifact-review-studies-current').count(),0);assert.equal(await tid('artifact-review-study-group').count(),0);
});

test('archived changed-source grouping retains distinct counts and exact memberships read-only at dark narrow size',async()=>{
  const f=await fixture(),saved=await f.studies.save(groups(f),actor);f.reparse();f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');const before=f.changes();
  await mount(f,false);await tid('artifact-review-studies-current').waitFor();assert.equal(await tid('artifact-review-studies-form').count(),0);
  assert.equal(await tid('artifact-review-studies-revise').count(),0);assert.equal(f.changes(),before);await page.getByText('归组的协议或来源引用已变化',{exact:true}).waitFor();
  await tid('artifact-review-studies-current').locator('summary').click();await tid('artifact-review-studies-current').locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await tid('artifact-review-studies-current').locator('pre').innerText()),saved.snapshot);await audit('studies-archived-dark-narrow');
});
