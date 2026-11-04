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
import {createReviewQualityFixture} from '../unit/fixtures/research-review-quality.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c4c-ui');
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
  getReviewExtractionHistory:'roc:research:review-extraction-history',listEvidence:'roc:research:evidence-list',inspectEvidence:'roc:research:evidence-inspect',getReviewQualityPlan:'roc:research:review-quality-plan-get',createReviewQualityPlan:'roc:research:review-quality-plan-create',getReviewQualityAssessment:'roc:research:review-quality-assessment-get',saveReviewQualityAssessment:'roc:research:review-quality-assessment-save',getReviewQualityAssessmentHistory:'roc:research:review-quality-assessment-history'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-quality-assessment-ui-')); mkdirSync(artifacts, {recursive: true});
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
async function fixture(options) {
  const f=await createReviewQualityFixture(api,options);
  fixtures.push(f);
  const registry=new api.CapabilityRegistry();
  for(const descriptor of [...api.researchSystematicReviewCapabilities,...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities,...api.researchReviewDeduplicationCapabilities,...api.researchReviewScreeningCapabilities,
    ...api.researchReviewFullTextCapabilities,...api.researchReviewFullTextScreeningCapabilities,...api.researchLibraryCapabilities,...api.researchDocumentCapabilities,...api.researchReviewExtractionCapabilities,...api.researchEvidenceCapabilities,...api.researchReviewQualityCapabilities])registry.declare('research',descriptor);
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
  f.qualityAssessments=new api.ResearchReviewQualityAssessmentRepository(f.db,f.repository,f.qualityPlans,f.extractions,f.fullFreezing,()=>f.time);
  api.registerResearchReviewQualityCapabilities(context,f.qualityPlans,f.qualityAssessments);
  f.qualityPlan=await f.qualityPlans.create(f.qualityInput(),actor);
  f.assessmentGet={...f.qualityGet(f.extraction.snapshot.id),qualityPlanId:f.qualityPlan.snapshot.id};
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
  await tid('artifact-review-extractions-inspect').focus();await page.keyboard.press('Enter');
  await tid('artifact-review-extractions').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-extractions-refresh"]').disabled);
}




const actor={kind:'user',id:'synthetic-quality-assessment-human'};
async function select() {
  await tid('artifact-review-extraction-select').first().click();await tid('artifact-review-extraction-current').waitFor();
  await tid('artifact-review-quality-inspect').click();await tid('artifact-review-quality-plan-frozen').waitFor();
  await tid('artifact-review-quality-assessment-inspect').focus();await page.keyboard.press('Enter');await tid('artifact-review-quality-assessment').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-quality-assessment-refresh"]').disabled);
}
function assessment(f,requestId='assessment-original') {
  return {...f.assessmentGet,requestId,expectedPlanHash:f.qualityPlan.snapshotHash,expectedExtractionHash:f.extraction.snapshotHash,
    domains:f.qualityPlan.snapshot.request.definition.domains.map(domain=>({domainId:domain.id,
      value:{kind:'judged',judgement:domain.judgements[0],reason:'Synthetic explicit human domain judgement'},evidence:[f.reference]})),
    overall:{value:{kind:'judged',judgement:f.qualityPlan.snapshot.request.definition.overallJudgements[1],reason:'Synthetic explicit overall judgement independent of domains'},evidence:[f.reference]},
    reviewerId:f.reviewerIds[0],reviewNote:'Synthetic human reviews fixed quality categories and exact extraction source Evidence',
    parentAssessmentId:null,expectedParentHash:null,revisionReason:null};
}
async function fill(f,{kind='judged'}={}) {
  const definition=f.qualityPlan.snapshot.request.definition;
  for(const [label,choices] of [...definition.domains.map(domain=>[domain.label,domain.judgements]),['总体评价',definition.overallJudgements]]) {
    await page.getByLabel(`${label}判断类型`,{exact:true}).selectOption(kind);
    if(kind==='judged')await page.getByLabel(`${label}判断类别`,{exact:true}).selectOption(label==='总体评价'?choices[1]:choices[0]);
    await page.getByLabel(`${label}理由`,{exact:true}).fill(label==='总体评价'?'Synthetic explicit overall judgement independent of domains':'Synthetic explicit human domain judgement');
    await page.getByLabel(`${label}提取证据`,{exact:true}).selectOption(f.evidence.id);
    await tid('artifact-review-quality-judgement').filter({has:page.getByRole('heading',{name:label,exact:true})}).getByTestId('artifact-review-quality-evidence-add').click();
  }
  await page.getByLabel('质量评价审核人',{exact:true}).selectOption(f.reviewerIds[0]);
  await page.getByLabel('质量评价审核说明',{exact:true}).fill(assessment(f).reviewNote);
}
async function save() {await tid('artifact-review-quality-assessment-save').click();await tid('artifact-review-quality-assessment-current').waitFor();}
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

test('explicit domain and overall judgements preserve exact frozen choices and extraction Evidence without automatic aggregation',async()=>{
  const f=await fixture();await mount(f);await select();
  assert.equal(await page.getByLabel('Declared methods判断类型',{exact:true}).inputValue(),'');
  assert.equal(await tid('artifact-review-quality-assessment-save').isDisabled(),true);const start=calls.length;
  await fill(f);await audit('assessment-default');await tid('artifact-review-quality-assessment-save').hover();await audit('assessment-hover');await save();
  const saved=f.qualityAssessments.get(f.assessmentGet),expected=assessment(f);
  assert.deepEqual(saved.snapshot.request.domains,expected.domains);assert.deepEqual(saved.snapshot.request.overall,expected.overall);
  assert.equal(saved.snapshot.request.expectedPlanHash,f.qualityPlan.snapshotHash);assert.equal(saved.snapshot.request.expectedExtractionHash,f.extraction.snapshotHash);
  assert.equal(saved.snapshot.actor.id,`window:${windowId}`);assert.equal(calls.slice(start).filter(call=>call.method==='inspectEvidence').length,0);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_evidence').pluck().get(),1);
  assert.equal(saved.snapshot.request.overall.value.judgement,'concerns');
});

test('unjudgeable domain and overall results retain reasons and exact source refs rather than a numeric or invented category',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f,{kind:'unjudgeable'});await save();
  const saved=f.qualityAssessments.get(f.assessmentGet);assert.equal(saved.snapshot.request.overall.value.kind,'unjudgeable');
  assert.ok(saved.snapshot.request.domains.every(domain=>domain.value.kind==='unjudgeable'&&domain.evidence[0].expectedHash===f.reference.expectedHash));
  assert.equal(await page.getByLabel('Declared methods判断类别',{exact:true}).count(),0);
});

test('each domain and overall requires explicit Evidence and reasons with no implicit source selection',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);
  const overall=tid('artifact-review-quality-judgement').filter({has:page.getByRole('heading',{name:'总体评价',exact:true})});
  await overall.getByRole('button',{name:'移除此判断证据引用',exact:true}).click();assert.equal(await tid('artifact-review-quality-assessment-save').isDisabled(),true);
  await overall.getByTestId('artifact-review-quality-evidence-add').click();await page.getByLabel('Declared methods理由',{exact:true}).fill('');
  assert.equal(await tid('artifact-review-quality-assessment-save').isDisabled(),true);assert.equal(f.qualityAssessments.get(f.assessmentGet),null);
});

test('precise parent revision preserves earlier categorical judgement and complete immutable history',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);await save();const first=f.qualityAssessments.get(f.assessmentGet);
  await tid('artifact-review-quality-assessment-revise').click();
  await page.getByLabel('总体评价判断类型',{exact:true}).selectOption('unjudgeable');
  await page.getByLabel('总体评价理由',{exact:true}).fill('Synthetic later human audit cannot judge overall source quality. '.repeat(100));
  await page.getByLabel('质量评价修订原因',{exact:true}).fill('Synthetic human explicitly revises overall judgement');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-quality-assessment-current"]')?.textContent.includes('版本 2'));
  const history=f.qualityAssessments.history(f.assessmentGet);assert.equal(history.length,2);assert.deepEqual(history[0],{...first,isLatest:false});
  assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);
  const details=tid('artifact-review-quality-assessment-history');await details.locator('summary').first().click();
  await details.locator('li').first().locator('summary').click();await details.locator('li').first().locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await details.locator('li').first().locator('pre').innerText()),first.snapshot);await audit('assessment-expanded-history');
});

test('real independent assessment defeats an old null parent without replacing either the human draft or saved result',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);
  const independent=await f.qualityAssessments.save(assessment(f,'independent-assessment'),actor),before=f.changes();
  await tid('artifact-review-quality-assessment-save').click();await page.getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.deepEqual(f.qualityAssessments.get(f.assessmentGet),independent);
  assert.equal(await page.getByLabel('Declared methods理由',{exact:true}).inputValue(),'Synthetic explicit human domain judgement');
  await tid('artifact-review-quality-assessment-refresh').click();await tid('artifact-review-quality-assessment-current').waitFor();
});

test('lost actual assessment reply retries exact reasons and Evidence with only one immutable version',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);f.loseReply='saveReviewQualityAssessment';const start=calls.length;
  await tid('artifact-review-quality-assessment-save').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  const writes=calls.slice(start).filter(call=>call.method==='saveReviewQualityAssessment');
  assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);assert.equal(f.qualityAssessments.history(f.assessmentGet).length,1);
});

test('actual Evidence invalidation refuses a new assessment without rewriting the selected frozen digest',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);f.repository.evidence.invalidateEvidence(f.evidence.id,f.project.id);const before=f.changes();
  await tid('artifact-review-quality-assessment-save').click();await page.getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_quality_assessments').pluck().get(),0);
  assert.equal(await page.getByLabel('Declared methods理由',{exact:true}).inputValue(),'Synthetic explicit human domain judgement');
});

test('physical original source drift refuses assessment and exact byte restoration permits the same request retry',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);writeFileSync(f.sourcePath,Buffer.from('synthetic assessment source byte drift'));const before=f.changes();
  await tid('artifact-review-quality-assessment-save').click();await page.getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_quality_assessments').pluck().get(),0);
  writeFileSync(f.sourcePath,f.original);await save();
});

test('pending assessment retains its form but blocks extraction revision, framework refresh, report selection and close',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='saveReviewQualityAssessment';
  await tid('artifact-review-quality-assessment-save').click();await begun;assert.equal(await tid('artifact-review-quality-assessment-form').count(),1);
  assert.equal(await page.getByLabel('Declared methods理由',{exact:true}).isDisabled(),true);
  assert.equal(await tid('artifact-review-quality-plan-refresh').isDisabled(),true);assert.equal(await tid('artifact-review-extraction-revise').isDisabled(),true);
  assert.equal(await tid('artifact-review-extractions-refresh').isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);
  f.deferMethod=null;f.release();await tid('artifact-review-quality-assessment-current').waitFor();
});

test('missing marked assessment receipt remains an integrity failure with no new empty human form',async()=>{
  const f=await fixture();await f.qualityAssessments.save(assessment(f),actor);f.db.prepare('DELETE FROM research_review_quality_assessments').run();
  await mount(f);await select();await page.getByRole('alert').filter({hasText:'校验失败'}).first().waitFor();
  assert.equal(await tid('artifact-review-quality-assessment-form').count(),0);
});

test('late prior-project assessment cannot replace the next exact framework read or populate judgement fields',async()=>{
  const f=await fixture(),next=await fixture();await f.qualityAssessments.save(assessment(f),actor);await mount(f);await select();
  const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='getReviewQualityAssessment';await tid('artifact-review-quality-assessment-refresh').click();
  await begun;await mount(next);await select();f.deferMethod=null;f.release();await tid('artifact-review-quality-assessment-form').waitFor();
  assert.equal(await tid('artifact-review-quality-assessment-current').count(),0);
  assert.equal(await page.getByLabel('Declared methods判断类型',{exact:true}).inputValue(),'');
});

test('archived changed-source assessment retains exact original categories/Evidence and read-only history at dark narrow size',async()=>{
  const f=await fixture(),saved=await f.qualityAssessments.save(assessment(f),actor);f.reparse();
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const before=f.changes();await mount(f,false);await select();await tid('artifact-review-quality-assessment-current').waitFor();
  assert.equal(await tid('artifact-review-quality-assessment-form').count(),0);assert.equal(await tid('artifact-review-quality-assessment-revise').count(),0);
  assert.equal(f.changes(),before);await page.getByText('评价引用的提取或来源已变化',{exact:true}).waitFor();
  await tid('artifact-review-quality-assessment-current').locator('summary').click();await tid('artifact-review-quality-assessment-current').locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await tid('artifact-review-quality-assessment-current').locator('pre').innerText()),saved.snapshot);await audit('assessment-archived-dark-narrow');
});
