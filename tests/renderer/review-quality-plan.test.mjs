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
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c4b-ui');
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
  getReviewExtractionHistory:'roc:research:review-extraction-history',listEvidence:'roc:research:evidence-list',inspectEvidence:'roc:research:evidence-inspect',getReviewQualityPlan:'roc:research:review-quality-plan-get',createReviewQualityPlan:'roc:research:review-quality-plan-create'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-quality-ui-')); mkdirSync(artifacts, {recursive: true});
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
  f.registry=registry;
  f.bridge=api.createPluginCapabilityAdapter({invokeCapability:(name,input)=>registry.invoke(name,input)});
  return f;
}
async function mount(f, writable = true) {
  active = f;
  await page.evaluate(({request, writable}) => window.mount(request, writable),
    {request: {mode: 'manage', projectId: f.project.id, versionId: f.protocol.version.id}, writable});
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




const actor={kind:'user',id:'synthetic-quality-human'};
async function select() {
  await tid('artifact-review-extraction-select').first().click();await tid('artifact-review-extraction-current').waitFor();
  await tid('artifact-review-quality-inspect').focus();await page.keyboard.press('Enter');await tid('artifact-review-quality-plan').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-quality-plan-refresh"]').disabled);
}
async function fill(f,index='0') {
  await page.getByLabel('协议声明的质量框架',{exact:true}).selectOption(index);
  const definition=f.qualityInput().definition;
  await page.getByLabel('框架定义与文档依据',{exact:true}).fill(definition.documentationNote);
  for(const [i,domain] of definition.domains.entries()) {
    if(i>0)await page.getByRole('button',{name:'添加评价域',exact:true}).click();
    const label=`评价域 ${i+1}`;
    await page.getByLabel(`${label}ID`,{exact:true}).fill(domain.id);
    await page.getByLabel(`${label}名称`,{exact:true}).fill(domain.label);
    await page.getByLabel(`${label}问题`,{exact:true}).fill(domain.question);
    for(const [j,value] of domain.judgements.entries()) {
      if(j>1)await page.getByRole('button',{name:`添加${label}判断类别`,exact:true}).click();
      await page.getByLabel(`${label}判断类别 ${j+1}`,{exact:true}).fill(value);
    }
  }
  for(const [i,value] of definition.overallJudgements.entries()) {
    if(i>1)await page.getByRole('button',{name:'添加总体判断类别',exact:true}).click();
    await page.getByLabel(`总体判断类别 ${i+1}`,{exact:true}).fill(value);
  }
  await page.getByLabel('框架审核人',{exact:true}).selectOption(f.reviewerIds[0]);
  await page.getByLabel('框架审核说明',{exact:true}).fill(f.qualityInput().reviewNote);
}
async function save() {await tid('artifact-review-quality-plan-create').click();await tid('artifact-review-quality-plan-frozen').waitFor();}
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

test('quality framework starts blank and freezes explicit domains/categories against the exact extraction with native human authority',async()=>{
  const f=await fixture();await mount(f);await select();
  assert.equal(await page.getByLabel('协议声明的质量框架',{exact:true}).inputValue(),'');
  assert.equal(await page.getByLabel('评价域 1ID',{exact:true}).inputValue(),'');
  assert.equal(await tid('artifact-review-quality-plan-create').isDisabled(),true);
  await fill(f);await audit('quality-default');await tid('artifact-review-quality-plan-create').hover();await audit('quality-hover');await save();
  const plan=f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id));
  assert.deepEqual(plan.snapshot.request.definition,f.qualityInput().definition);
  assert.equal(plan.snapshot.request.expectedExtractionHash,f.extraction.snapshotHash);assert.equal(plan.snapshot.actor.id,`window:${windowId}`);
  assert.equal(await tid('artifact-review-quality-plan-form').count(),0);
  await tid('artifact-review-quality-plan-frozen').locator('summary').click();await tid('artifact-review-quality-plan-frozen').locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await tid('artifact-review-quality-plan-frozen').locator('pre').innerText()),plan.snapshot);await audit('quality-frozen-expanded');
});

test('only study-design-matching declared frameworks can be selected and the explicit second version is preserved',async()=>{
  const body=reviewProtocolBodyFixture(),first=body.qualityAssessment[0];
  body.qualityAssessment.push({...first,framework:'Synthetic alternative framework',version:'v2'},
    {...first,studyDesign:'Synthetic other study design',framework:'Other design framework'});
  const f=await fixture({protocolBody:body});await mount(f);await select();
  assert.equal(await page.getByLabel('协议声明的质量框架',{exact:true}).locator('option').count(),3);
  await fill(f,'1');await save();assert.deepEqual(f.qualityPlans.get(f.qualityGet(f.extraction.snapshot.id)).snapshot.request.framework,body.qualityAssessment[1]);
});

test('duplicate domain IDs and judgement categories cannot submit a frozen definition',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);
  await page.getByLabel('评价域 2ID',{exact:true}).fill('methods');assert.equal(await tid('artifact-review-quality-plan-create').isDisabled(),true);
  await page.getByLabel('评价域 2ID',{exact:true}).fill('reporting');
  await page.getByLabel('评价域 1判断类别 2',{exact:true}).fill('adequate');assert.equal(await tid('artifact-review-quality-plan-create').isDisabled(),true);
  assert.equal(f.qualityPlans.list(f.get).length,0);
});

test('unknown study design retains its real missing judgement and cannot invent a framework',async()=>{
  const f=await fixture();
  f.extraction=await f.extractions.save({...f.extract('design-missing'),parentExtractionId:f.extraction.snapshot.id,
    expectedParentHash:f.extraction.snapshotHash,revisionReason:'Synthetic human cannot identify source study design',
    studyDesign:{value:{kind:'missing',reason:'Synthetic source does not report design'},evidence:[f.reference]}},actor);
  await mount(f);await select();await page.getByText('研究设计尚不能确定，无法选择质量框架。',{exact:true}).waitFor();
  assert.equal(await tid('artifact-review-quality-plan-form').count(),0);assert.equal(f.qualityPlans.list(f.get).length,0);
});

test('lost real quality freeze reply retries an exact definition without another frozen plan',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);const start=calls.length;f.loseReply='createReviewQualityPlan';
  await tid('artifact-review-quality-plan-create').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  const writes=calls.slice(start).filter(call=>call.method==='createReviewQualityPlan');assert.equal(writes.length,2);
  assert.deepEqual(writes[1].input,writes[0].input);assert.equal(f.qualityPlans.list(f.get).length,1);
});

test('physical source drift refuses quality freeze and restoring exact bytes permits the same explicit retry',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);
  writeFileSync(f.sourcePath,Buffer.from('synthetic changed PDF bytes'));const before=f.changes();
  await tid('artifact-review-quality-plan-create').click();await page.getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.qualityPlans.list(f.get).length,0);
  writeFileSync(f.sourcePath,f.original);await save();assert.equal(f.qualityPlans.list(f.get).length,1);
});

test('pending quality freeze keeps its form visible and blocks extraction revision, refresh, selection and close',async()=>{
  const f=await fixture();await mount(f);await select();await fill(f);const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='createReviewQualityPlan';
  await tid('artifact-review-quality-plan-create').click();await begun;
  assert.equal(await tid('artifact-review-quality-plan-form').count(),1);assert.equal(await page.getByLabel('评价域 1ID',{exact:true}).isDisabled(),true);
  assert.equal(await tid('artifact-review-extraction-revise').isDisabled(),true);assert.equal(await tid('artifact-review-extractions-refresh').isDisabled(),true);
  assert.equal(await tid('artifact-review-extraction-select').first().isDisabled(),true);await page.keyboard.press('Escape');
  assert.equal(await tid('artifact-inspector-panel').count(),1);f.deferMethod=null;f.release();await tid('artifact-review-quality-plan-frozen').waitFor();
});

test('transport or lost marked quality receipt cannot become an empty editable plan',async()=>{
  const f=await fixture();f.failMethod='getReviewQualityPlan';f.readFailure={code:'synthetic_transport_error',message:'Synthetic quality transport error'};
  await mount(f);await select();await page.getByRole('alert').filter({hasText:'transport error'}).waitFor();
  assert.equal(await tid('artifact-review-quality-plan-form').count(),0);f.readFailure=null;
  await tid('artifact-review-quality-plan-refresh').click();await tid('artifact-review-quality-plan-form').waitFor();await fill(f);await save();
  f.db.prepare('DELETE FROM research_review_quality_plans').run();await tid('artifact-review-quality-plan-refresh').click();
  await page.getByRole('alert').filter({hasText:'校验失败'}).waitFor();assert.equal(await tid('artifact-review-quality-plan-form').count(),0);
});

test('late prior-project quality receipt cannot replace the next project nullable read or open a freeze form early',async()=>{
  const f=await fixture(),next=await fixture();await f.qualityPlans.create(f.qualityInput(),actor);await mount(f);await select();
  const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='getReviewQualityPlan';await tid('artifact-review-quality-plan-refresh').click();
  await begun;await mount(next);await select();f.deferMethod=null;f.release();
  await tid('artifact-review-quality-plan-form').waitFor();assert.equal(await tid('artifact-review-quality-plan-frozen').count(),0);
  assert.equal(await page.getByLabel('框架定义与文档依据',{exact:true}).inputValue(),'');
});

test('revised extraction requires its own definition while the old frozen framework stays inspectable through exact history',async()=>{
  const f=await fixture(),first=f.extraction,plan=await f.qualityPlans.create(f.qualityInput(),actor);
  f.extraction=await f.extractions.save({...f.extract('revise-extraction-for-framework'),parentExtractionId:first.snapshot.id,
    expectedParentHash:first.snapshotHash,revisionReason:'Synthetic human refines value interpretation for a new exact extraction'},actor);
  await mount(f);await select();await tid('artifact-review-quality-plan-form').waitFor();
  assert.equal(await tid('artifact-review-quality-plan-frozen').count(),0);
  await tid('artifact-review-extraction-history').locator('summary').first().click();
  await tid('artifact-review-extraction-history').locator('li').first().getByRole('button',{name:'核查此提取版本的质量框架',exact:true}).click();
  await tid('artifact-review-quality-plan-frozen').waitFor();assert.equal(await tid('artifact-review-quality-plan-form').count(),0);
  await page.getByText('框架引用的提取或来源已变化',{exact:true}).waitFor();
  await tid('artifact-review-quality-plan-frozen').locator('summary').click();await tid('artifact-review-quality-plan-frozen').locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await tid('artifact-review-quality-plan-frozen').locator('pre').innerText()),plan.snapshot);
});

test('archived stale-source quality definition remains readable with exact categories and no mutable controls at dark narrow size',async()=>{
  const f=await fixture();const plan=await f.qualityPlans.create(f.qualityInput(),actor);f.reparse();
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const before=f.changes();await mount(f,false);await select();await tid('artifact-review-quality-plan-frozen').waitFor();
  assert.equal(await tid('artifact-review-quality-plan-form').count(),0);assert.equal(f.changes(),before);
  await page.getByText('框架引用的提取或来源已变化',{exact:true}).waitFor();
  await tid('artifact-review-quality-plan-frozen').locator('summary').click();await tid('artifact-review-quality-plan-frozen').locator('pre').waitFor({state:'visible'});
  assert.deepEqual(JSON.parse(await tid('artifact-review-quality-plan-frozen').locator('pre').innerText()),plan.snapshot);await audit('quality-archived-dark-narrow');
});
