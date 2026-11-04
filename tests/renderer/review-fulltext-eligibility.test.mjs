import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {reviewSearchPayloadFixture} from '../unit/fixtures/research-review-search.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewFullTextScreeningFixture} from '../unit/fixtures/research-review-fulltext-screening.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c3b-ui');
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
  listReviewFullTextSuggestions:'roc:research:review-fulltext-suggestions'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-fulltext-eligibility-ui-')); mkdirSync(artifacts, {recursive: true});
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
  const f=await createReviewFullTextScreeningFixture(api,options);
  fixtures.push(f);
  const registry=new api.CapabilityRegistry();
  for(const descriptor of [...api.researchSystematicReviewCapabilities,...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities,...api.researchReviewDeduplicationCapabilities,...api.researchReviewScreeningCapabilities,
    ...api.researchReviewFullTextCapabilities,...api.researchReviewFullTextScreeningCapabilities,...api.researchLibraryCapabilities,...api.researchDocumentCapabilities])registry.declare('research',descriptor);
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
  await tid('artifact-review-fulltext-counts').waitFor();
}



const actor={kind:'user',id:'synthetic-full-qualification-human'};
const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'Synthetic human examined the saved fulltext controlled comparison'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Synthetic bound fulltext lacks the required outcome'};
const uncertain={decision:'uncertain',reason:'Synthetic saved fulltext does not allow a final eligibility judgment'};
const origin={kind:'agent_tool',operationId:'full-operation',idempotencyKey:'full-key',toolCallId:'full-tool-call',canonicalToolIdentity:'capability:research.reviewFullTextScreening.suggest',
  toolVersion:'1',attemptId:'first-attempt',capabilityName:'research.reviewFullTextScreening.suggest',capabilityVersion:'1.0.0'};
async function scene({single=false,...options}={}) {
  const f=await fixture(single?{...options,screening:{titleAbstractReviewers:1,fullTextReviewers:1,conflictResolution:'human_adjudication'}}:options);
  await f.bind();return f;
}
async function select(f,reviewer=0) {
  await tid('artifact-review-fulltext-select').first().focus();await page.keyboard.press('Enter');
  await tid('artifact-review-full-source-block').first().waitFor();
  await page.getByLabel('全文资格审核人',{exact:true}).selectOption(f.reviewerIds[reviewer]);await tid('artifact-review-full-decision').waitFor();
}
async function fill(outcome=include) {
  const form=tid('artifact-review-full-form');await form.getByLabel('筛选决定',{exact:true}).selectOption(outcome.decision);
  if(outcome.decision==='include')await form.getByRole('checkbox').check();
  if(outcome.decision==='exclude')await form.getByLabel('主要排除准则',{exact:true}).selectOption(outcome.exclusionCriterionId);
  await form.getByLabel('筛选理由',{exact:true}).fill(outcome.reason);
}
async function save() {await tid('artifact-review-full-save').click();await tid('artifact-review-full-current').waitFor();}
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






test('actual fixed fulltext blocks and PDF.js protocol canvas are read before a source-bound human eligibility decision',async()=>{
  const f=await scene({single:true});await mount(f);await select(f);
  assert.match(await tid('artifact-review-full-source-block').first().innerText(),new RegExp(f.collected.data.content.blocks[0].text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  await tid('artifact-review-full-pdf-toggle').click();await tid('reader-pdf-canvas').waitFor();
  await page.waitForFunction(()=>{const canvas=document.querySelector('[data-testid="reader-pdf-canvas"]');
    if(!canvas||canvas.width===0||canvas.height===0)return false;const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]>0&&pixels[index]<200)return true;return false;});
  const source=calls.filter(call=>call.method==='source').at(-1);assert.equal(source.input.documentId,f.document.id);assert.equal(source.input.sourceHash,f.document.sourceHash);
  await audit('full-qualification-pdf');await tid('artifact-review-full-pdf-toggle').click();await fill();await save();
  const phase=f.fullFreezing.getPhase(f.fullPhase),decision=phase.items[0].decisions[0];
  assert.equal(decision.snapshot.request.bindingId,f.bound.get(0).snapshot.id);assert.equal(decision.snapshot.request.expectedBindingHash,f.bound.get(0).snapshotHash);
  assert.equal(decision.snapshot.request.expectedTitleFreezeHash,f.title.freezeHash);assert.equal(decision.snapshot.actor.id,`window:${windowId}`);
  assert.deepEqual(decision.snapshot.request.outcome,include);assert.equal(phase.counts.included,1);assert.equal(f.freezing.getPhase(f.phase).counts.included,7);
});

test('two declared fulltext reviewers create pending then true conflict with separate title counts and no automatic whole-round freeze',async()=>{
  const f=await scene();await mount(f);await select(f);await fill();await save();assert.equal(f.fullFreezing.getPhase(f.fullPhase).items[0].status,'pending');
  await page.getByLabel('全文资格审核人',{exact:true}).selectOption(f.reviewerIds[1]);await fill(exclude);await save();
  const phase=f.fullFreezing.getPhase(f.fullPhase);assert.equal(phase.counts.conflict,1);assert.equal(phase.freeze,null);
  assert.match(await tid('artifact-review-fulltext-counts').innerText(),/冲突 1/u);assert.equal(f.freezing.getPhase(f.phase).counts.excluded,1);
});

test('exact fulltext human revision preserves old uncertain judgment and fixed source identity in immutable native history',async()=>{
  const f=await scene({single:true});await mount(f);await select(f);await fill(uncertain);await save();const first=f.fullFreezing.getPhase(f.fullPhase).items[0].decisions[0];
  await tid('artifact-review-full-revise').click();await fill({...exclude,reason:exclude.reason+' Long human fulltext rationale.'.repeat(100)});
  await page.getByLabel('筛选修订原因',{exact:true}).fill('Synthetic explicit source review resolved the earlier uncertainty');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-full-current"]')?.textContent.includes('版本 2'));
  const history=f.fullScreening.history({...f.get,decisionId:first.snapshot.id});assert.equal(history.length,2);assert.deepEqual(history[0],{...first,isLatest:false});
  assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);assert.equal(history[1].snapshot.request.expectedBindingHash,f.bound.get(0).snapshotHash);
  await tid('artifact-review-full-history').locator('summary').click();await tid('artifact-review-full-history').locator('ul').waitFor({state:'visible'});await audit('full-qualification-history');
});

test('considering a real source-bound suggestion keeps the human outcome independent and preserves exact proposal provenance',async()=>{
  const f=await scene({single:true});const proposal=await f.fullScreening.suggest({...f.target(0,'full-proposal'),outcome:include},origin);
  await mount(f);await select(f);await tid('artifact-review-full-consider').click();
  assert.equal(await tid('artifact-review-full-form').getByLabel('筛选决定',{exact:true}).inputValue(),'');await fill(uncertain);await save();
  const human=f.fullFreezing.getPhase(f.fullPhase).items[0].decisions[0];assert.deepEqual(human.snapshot.request.outcome,uncertain);
  assert.deepEqual(human.snapshot.request.consideredSuggestion,{id:proposal.snapshot.id,expectedHash:proposal.snapshotHash});
  assert.equal(f.fullFreezing.getPhase(f.fullPhase).counts.included,0);
});

test('proposal tied to a real superseded binding remains visible but cannot be considered as a current-source suggestion',async()=>{
  const f=await scene({single:true});await f.fullScreening.suggest({...f.target(0,'old-proposal'),outcome:include},origin);const original=f.bound.get(0);
  f.reparse();const revised=await f.fulltexts.save({...f.retrieved(0,'new-source',{...f.selection,parseId:'fulltext-reparse'}),parentBindingId:original.snapshot.id,
    expectedParentHash:original.snapshotHash,revisionReason:'Synthetic later parse explicitly selected'},actor);f.bound.set(0,revised);
  await mount(f);await select(f);await tid('artifact-review-full-consider').waitFor();assert.equal(await tid('artifact-review-full-consider').isDisabled(),true);
  assert.match(await tid('artifact-review-full-suggestions').innerText(),/历史来源建议/u);await fill(uncertain);await save();
  assert.equal(f.fullFreezing.getPhase(f.fullPhase).items[0].decisions[0].snapshot.request.consideredSuggestion,null);
});

test('lost actual fulltext human decision commit reply retries exact source and request without duplicate scientific decisions',async()=>{
  const f=await scene();await mount(f);await select(f);await fill();const start=calls.length;f.loseReply='saveReviewFullTextDecision';
  await tid('artifact-review-full-save').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  const writes=calls.slice(start).filter(call=>call.method==='saveReviewFullTextDecision');assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);
  assert.equal(f.db.prepare("SELECT count(*) FROM research_review_screening_decisions WHERE phase='full_text'").pluck().get(),1);
});

test('actual original file byte drift after display refuses scientific judgment without writes and never creates a success-shaped fallback',async()=>{
  const f=await scene();await mount(f);await select(f);await fill();const modified=Buffer.from(f.original);modified[0]^=1;writeFileSync(f.sourcePath,modified);const before=f.changes();
  await tid('artifact-review-full-save').click();await tid('artifact-review-full-decision').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare("SELECT count(*) FROM research_review_screening_decisions WHERE phase='full_text'").pluck().get(),0);
  assert.equal(await tid('artifact-review-full-form').getByLabel('筛选理由',{exact:true}).inputValue(),include.reason);
});

test('pending actual eligibility commit keeps its own human form and blocks source rebind, reader refresh, reviewer, record and dismissal',async()=>{
  const f=await scene();await mount(f);await select(f);await fill();const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='saveReviewFullTextDecision';
  await tid('artifact-review-full-save').click();await begun;assert.equal(await tid('artifact-review-full-form').count(),1);
  assert.equal(await tid('artifact-review-full-form').getByLabel('筛选理由',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('全文资格审核人',{exact:true}).isDisabled(),true);assert.equal(await tid('artifact-review-full-source-refresh').isDisabled(),true);
  assert.equal(await tid('artifact-review-fulltext-binding-revise').count(),0);assert.equal(await tid('artifact-review-fulltext-refresh').isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);f.deferMethod=null;f.release();await tid('artifact-review-full-current').waitFor();
});

test('archived superseded original fulltext and old human judgment remain readable at dark narrow size with no new scientific writes',async()=>{
  const f=await scene({single:true});await f.fullScreening.save(f.vote(0,f.reviewerIds[0],'pre-archive',include),actor);f.reparse();
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const before=f.changes();await mount(f,false);await select(f);await tid('artifact-review-full-current').waitFor();
  assert.match(await tid('artifact-review-full-current').innerText(),/来源已变化，原决定保留/u);assert.equal(await tid('artifact-review-full-form').count(),0);
  assert.equal(await tid('artifact-review-full-revise').count(),0);assert.equal(f.changes(),before);await audit('full-qualification-archived-dark-narrow');
});


test('wrong echoed fixed parse identity is a visible source error and cannot expose a writable scientific form',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));await page.evaluate(()=>document.documentElement.dataset.theme='light');
  const f=await scene();f.mismatchContent=true;await mount(f);await tid('artifact-review-fulltext-select').first().click();
  await tid('artifact-review-full-eligibility').getByRole('alert').filter({hasText:'保存的全文解析版本与返回内容不一致'}).waitFor();
  assert.equal(await tid('artifact-review-full-form').count(),0);assert.equal(await page.getByLabel('全文资格审核人',{exact:true}).count(),0);
  f.mismatchContent=false;await tid('artifact-review-full-source-refresh').click();await page.getByLabel('全文资格审核人',{exact:true}).waitFor();
});

test('late original fulltext content from another project cannot expose that old source or authorize a current scientific decision',async()=>{
  const a=await scene(),b=await scene();await mount(a);const begun=new Promise(resolve=>{a.started=resolve;});a.deferMethod='getDocumentContent';
  await tid('artifact-review-fulltext-select').first().click();await begun;
  await mount(b);await select(b);const body=await tid('artifact-review-full-eligibility').innerText();a.deferMethod=null;a.release();
  assert.equal(await tid('artifact-review-full-eligibility').count(),1);assert.equal(await tid('artifact-review-full-eligibility').innerText(),body);
  await fill(uncertain);await save();assert.equal(a.fullFreezing.getPhase(a.fullPhase).items[0].decisions.length,0);
  const decision=b.fullFreezing.getPhase(b.fullPhase).items[0].decisions[0];assert.equal(decision.snapshot.request.corpusId,b.corpus.snapshot.id);
  assert.equal(decision.snapshot.request.expectedBindingHash,b.bound.get(0).snapshotHash);
});
