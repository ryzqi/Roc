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
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c3c-ui');
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
  adjudicateReviewFullText:'roc:research:review-fulltext-adjudicate',freezeReviewFullTextScreening:'roc:research:review-fulltext-freeze'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-fulltext-arbitration-ui-')); mkdirSync(artifacts, {recursive: true});
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
  await tid('artifact-review-fulltext').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-fulltext-refresh"]').disabled);
}




const actor={kind:'user',id:'synthetic-fulltext-set-human'};
const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'Synthetic current fulltext meets the controlled comparison criterion'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Synthetic human adjudicator identifies missing reported outcome'};
const uncertain={decision:'uncertain',reason:'Synthetic source eligibility cannot be judged by the initial reviewer'};
async function scene({single=false,...options}={}) {
  const f=await fixture(single?{...options,screening:{titleAbstractReviewers:1,fullTextReviewers:1,conflictResolution:'human_adjudication'}}:options);
  await f.bind();
  for(const [index] of f.corpus.snapshot.hits.entries())if(index!==0&&index!==1)await f.fulltexts.save(f.notRetrieved(index,`no-fulltext-${index}`),actor);
  for(const [position,reviewerId] of f.reviewerIds.entries())await f.fullScreening.save(f.vote(0,reviewerId,`vote-${position}`,single?uncertain:position===0?include:exclude),actor);
  return f;
}
async function select() {
  await tid('artifact-review-fulltext-select').first().focus();await page.keyboard.press('Enter');
  await tid('artifact-review-full-source-block').first().waitFor();await tid('artifact-review-full-arbitration').waitFor();
}
async function fill(f,outcome=include) {
  const form=tid('artifact-review-full-arbitration-form');await form.getByLabel('全文资格仲裁人',{exact:true}).selectOption(f.plan.snapshot.request.adjudicator.id);
  await form.getByLabel('筛选决定',{exact:true}).selectOption(outcome.decision);
  if(outcome.decision==='include')await form.getByRole('checkbox').check();else await form.getByLabel('主要排除准则',{exact:true}).selectOption(outcome.exclusionCriterionId);
  await form.getByLabel('筛选理由',{exact:true}).fill(outcome.reason);
}
async function save() {await tid('artifact-review-full-arbitration-save').click();await tid('artifact-review-full-arbitration-current').waitFor();}
async function freeze(note='Synthetic human reviewed exact complete fulltext retrieval and adjudicated qualification') {
  await page.getByLabel('全文整轮审核说明',{exact:true}).fill(note);await tid('artifact-review-full-freeze').click();await tid('artifact-review-fulltext-frozen').waitFor();
}
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







test('actual complete source-bound conflict adjudication and fullfreeze retain exact vote/source hashes and conserved report counts',async()=>{
  const f=await scene();await mount(f);assert.equal(await tid('artifact-review-full-freeze').isDisabled(),true);await select();await fill(f);await audit('full-arbitration-default');
  await tid('artifact-review-full-arbitration-save').hover();await audit('full-arbitration-hover');await save();const phase=f.fullFreezing.getPhase(f.fullPhase),arbitration=phase.items[0].arbitration;
  assert.deepEqual(arbitration.snapshot.request.decisions,phase.items[0].decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash})));
  assert.equal(arbitration.snapshot.request.expectedBindingHash,f.bound.get(0).snapshotHash);assert.equal(arbitration.snapshot.actor.id,`window:${windowId}`);
  assert.equal(phase.counts.included,1);assert.equal(phase.counts.not_retrieved,6);await freeze();const frozen=f.fullFreezing.getPhase(f.fullPhase);
  assert.equal(frozen.freeze.request.expectedReviewHash,phase.reviewHash);assert.equal(frozen.freeze.actor.id,`window:${windowId}`);
  assert.equal(frozen.freeze.authority.counts.reportsToSeek,7);assert.equal(frozen.freeze.authority.counts.included,1);assert.equal(frozen.freeze.authority.counts.not_retrieved,6);
  assert.equal(await tid('artifact-review-full-freeze-form').count(),0);assert.equal(await tid('artifact-review-full-arbitration-form').count(),0);await audit('full-frozen-after-arbitration');
});

test('single reviewer uncertainty gets explicit primary-reason human adjudication and never turns unobtained fulltexts into exclusions',async()=>{
  const f=await scene({single:true});await mount(f);await select();await fill(f,exclude);await save();await freeze();const phase=f.fullFreezing.getPhase(f.fullPhase);
  assert.equal(phase.counts.excluded,1);assert.equal(phase.counts.not_retrieved,6);assert.equal(phase.counts.included,0);
  assert.equal(phase.freeze.authority.items[0].primaryExclusionCriterionId,'no-outcome');
});

test('lost actual fulltext arbitration and fullfreeze replies replay exact requests with no duplicate scientific authority',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);const start=calls.length;f.loseReply='adjudicateReviewFullText';
  await tid('artifact-review-full-arbitration-save').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  f.loseReply='freezeReviewFullTextScreening';await page.getByLabel('全文整轮审核说明',{exact:true}).fill('Synthetic exact fullfreeze retry');
  await tid('artifact-review-full-freeze').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await tid('artifact-review-full-freeze').click();await tid('artifact-review-fulltext-frozen').waitFor();
  for(const method of ['adjudicateReviewFullText','freezeReviewFullTextScreening']){const writes=calls.slice(start).filter(call=>call.method===method);assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);}
  assert.equal(f.db.prepare("SELECT count(*) FROM research_review_screening_arbitrations WHERE phase='full_text'").pluck().get(),1);
  assert.equal(f.db.prepare("SELECT count(*) FROM research_review_screening_freezes WHERE phase='full_text'").pluck().get(),1);
});

test('actual current reviewer revision refuses old fulltext adjudication references and preserves the human draft',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);const original=f.fullFreezing.getPhase(f.fullPhase).items[0].decisions[1];
  await f.fullScreening.save(f.vote(0,f.reviewerIds[1],'new-reviewer',uncertain,{parentDecisionId:original.snapshot.id,expectedParentHash:original.snapshotHash,revisionReason:'Synthetic independent review changed'}),actor);
  const before=f.changes();await tid('artifact-review-full-arbitration-save').click();await tid('artifact-review-full-arbitration').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare("SELECT count(*) FROM research_review_screening_arbitrations WHERE phase='full_text'").pluck().get(),0);
  assert.equal(await tid('artifact-review-full-arbitration-form').getByLabel('筛选理由',{exact:true}).inputValue(),include.reason);
});

test('real original-byte drift during a ready fullfreeze prevents a scientific receipt and exact restored bytes allow retry',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);await save();await page.getByLabel('全文整轮审核说明',{exact:true}).fill('Synthetic current ready fulltext set');
  const modified=Buffer.from(f.original);modified[0]^=1;writeFileSync(f.sourcePath,modified);const before=f.changes(),start=calls.length;
  await tid('artifact-review-full-freeze').click();await tid('artifact-review-fulltext').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare("SELECT count(*) FROM research_review_screening_freezes WHERE phase='full_text'").pluck().get(),0);
  writeFileSync(f.sourcePath,f.original);await tid('artifact-review-full-freeze').click();await tid('artifact-review-fulltext-frozen').waitFor();
  const writes=calls.slice(start).filter(call=>call.method==='freezeReviewFullTextScreening');assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);
});

test('new current fulltext reviewer set makes prior adjudication inapplicable and exact parent revision preserves immutable history',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);await save();const first=f.fullFreezing.getPhase(f.fullPhase).items[0].arbitration;
  const previous=f.fullFreezing.getPhase(f.fullPhase).items[0].decisions[1];await f.fullScreening.save(f.vote(0,f.reviewerIds[1],'later-review',uncertain,
    {parentDecisionId:previous.snapshot.id,expectedParentHash:previous.snapshotHash,revisionReason:'Synthetic later source review uncertainty'}),actor);
  await tid('artifact-review-fulltext-refresh').click();await tid('artifact-review-full-arbitration-current').getByText('原审核决定已变化，此仲裁不适用于当前集合',{exact:true}).waitFor();
  assert.equal(await tid('artifact-review-full-freeze').isDisabled(),true);await tid('artifact-review-full-arbitration-revise').click();await fill(f,{...exclude,reason:exclude.reason+' Long updated scientific source rationale.'.repeat(100)});
  await page.getByLabel('仲裁修订原因',{exact:true}).fill('Synthetic explicit changed source review set');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-full-arbitration-current"]')?.textContent.includes('版本 2'));
  const history=f.fullArbitration.history({...f.get,arbitrationId:first.snapshot.id});assert.equal(history.length,2);assert.equal(history[0].currentDecisionSet,false);
  assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);await tid('artifact-review-full-arbitration-history').locator('summary').click();
  await tid('artifact-review-full-arbitration-history').locator('ul').waitFor({state:'visible'});await audit('full-arbitration-expanded-history');
});

test('held actual source-verified arbitration and whole-round freeze retain own form and block reader, other writes and dismissal',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);let begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='adjudicateReviewFullText';
  await tid('artifact-review-full-arbitration-save').click();await begun;assert.equal(await tid('artifact-review-full-arbitration-form').count(),1);
  assert.equal(await tid('artifact-review-full-arbitration-form').getByLabel('筛选理由',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('全文资格审核人',{exact:true}).isDisabled(),true);assert.equal(await tid('artifact-review-full-source-refresh').isDisabled(),true);
  assert.equal(await tid('artifact-review-fulltext-binding-revise').count(),0);await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);
  f.deferMethod=null;f.release();await tid('artifact-review-full-arbitration-current').waitFor();await page.getByLabel('全文整轮审核说明',{exact:true}).fill('Synthetic held whole-round fullfreeze');
  begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='freezeReviewFullTextScreening';await tid('artifact-review-full-freeze').click();await begun;
  assert.equal(await tid('artifact-review-full-freeze-form').count(),1);assert.equal(await page.getByLabel('全文整轮审核说明',{exact:true}).isDisabled(),true);
  assert.equal(await tid('artifact-review-fulltext-refresh').isDisabled(),true);assert.equal(await tid('artifact-review-fulltext-select').first().isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);f.deferMethod=null;f.release();await tid('artifact-review-fulltext-frozen').waitFor();
});

test('marked missing fullfreeze is a real read error with no reopened authority or mutable source controls',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);await save();await freeze();f.db.prepare("DELETE FROM research_review_screening_freezes WHERE phase='full_text'").run();
  assert.throws(()=>f.fullFreezing.getPhase(f.fullPhase),/research_review_screening_snapshot_invalid/);
  await mount(f);await tid('artifact-review-fulltext').getByRole('alert').filter({hasText:'校验失败'}).waitFor();
  assert.equal(await tid('artifact-review-full-freeze-form').count(),0);assert.equal(await tid('artifact-review-fulltext-select').count(),0);assert.equal(await tid('artifact-review-full-arbitration-form').count(),0);
});

test('frozen source reparse and archive retain immutable fullfreeze counts and actual old verdicts with visibly changed references at dark narrow width',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);await save();await freeze();const frozen=f.fullFreezing.getPhase(f.fullPhase).freeze;
  f.reparse();f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const before=f.changes();await mount(f,false);await select();assert.equal(f.changes(),before);assert.deepEqual(f.fullFreezing.getPhase(f.fullPhase).freeze,frozen);
  assert.match(await tid('artifact-review-fulltext-frozen').innerText(),/冻结后的来源引用已变化/u);assert.equal(await tid('artifact-review-full-arbitration-form').count(),0);
  assert.equal(await tid('artifact-review-full-freeze-form').count(),0);await audit('full-arbitration-archived-dark-narrow');
});


test('actual empty fulltext set needs explicit human freeze and preserves all zero counts without manufacturing source bindings',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));await page.evaluate(()=>document.documentElement.dataset.theme='light');
  const f=await fixture({document:false,fetch:async url=>Response.json(reviewSearchPayloadFixture(Number(new URL(url).searchParams.get('page')),0))});
  await mount(f);assert.equal(await tid('artifact-review-fulltext-select').count(),0);assert.equal(await tid('artifact-review-full-freeze').isDisabled(),true);
  assert.equal(f.fullFreezing.getPhase(f.fullPhase).freeze,null);await freeze('Synthetic human explicitly froze the empty fulltext set');
  const phase=f.fullFreezing.getPhase(f.fullPhase);assert.equal(phase.freeze.authority.items.length,0);
  assert.equal(phase.freeze.authority.counts.reportsToSeek,0);assert.equal(phase.freeze.authority.counts.not_retrieved,0);
  assert.equal(phase.freeze.authority.counts.included,0);assert.equal(phase.freeze.authority.counts.excluded,0);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_fulltext_bindings').pluck().get(),0);
});
