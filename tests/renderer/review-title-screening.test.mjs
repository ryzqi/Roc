import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewScreeningPlanFixture} from '../unit/fixtures/research-review-screening.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c2b-ui');
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
  getReviewScreeningDecisionHistory:'roc:research:review-screening-history',listReviewScreeningSuggestions:'roc:research:review-screening-suggestions'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-title-ui-')); mkdirSync(artifacts, {recursive: true});
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
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Encountered two children with the same key|Each child in a list should have a unique/u.test(message.text())) errors.push(message.text());
  });
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input});
    api.parseIpcRequestArgs(channels[method], [input]);
    if (method === 'getReviewScreeningPhase' && f.readFailure) return {ok:false,error:f.readFailure};
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
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
    for (const f of fixtures) await f.dispose();
    api?.dispose(); if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
async function fixture(options) {
  const f = await createReviewScreeningPlanFixture(api, options);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of [...api.researchSystematicReviewCapabilities, ...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities, ...api.researchReviewDeduplicationCapabilities, ...api.researchReviewScreeningCapabilities]) registry.declare('research', descriptor);
  const context = {pluginId: 'research', capabilities: registry};
  api.registerResearchSystematicReviewCapabilities(context, f.repository.systematicReviews);
  api.registerResearchReviewSearchCapabilities(context, f.reviews);
  api.registerResearchReviewCorpusCapabilities(context, f.corpora);
  api.registerResearchReviewDeduplicationCapabilities(context, f.dedup);
  api.registerResearchReviewScreeningCapabilities(context, f.screening, f.decisions, f.arbitration, f.freezing);
  f.plan=f.screening.createPlan(f.input,{kind:'user',id:'synthetic-declarer'});
  f.phase={...f.get,phase:'title_abstract'};
  f.target=(index,requestId)=>({...f.get,expectedPlanHash:f.plan.snapshotHash,hitId:f.corpus.snapshot.hits[index].id,phase:'title_abstract',requestId});
  f.decision=(index,reviewerId,requestId,outcome=include,extra={})=>({...f.target(index,requestId),reviewerId,outcome,consideredSuggestion:null,parentDecisionId:null,expectedParentHash:null,revisionReason:null,...extra});
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  fixtures.push(f); return f;
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
  await tid('artifact-review-title-counts').waitFor();
}

const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'Synthetic title meets the declared controlled comparison criterion'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Synthetic provided title does not report the required outcome'};
const uncertain={decision:'uncertain',reason:'Synthetic raw abstract is missing and the title is insufficient'};
const origin={kind:'agent_tool',operationId:'synthetic-operation',idempotencyKey:'synthetic-idempotency',toolCallId:'synthetic-tool-call',
  canonicalToolIdentity:'capability:research.reviewScreening.suggest',toolVersion:'1',attemptId:'first-attempt',capabilityName:'research.reviewScreening.suggest',capabilityVersion:'1.0.0'};
async function select(f,index=0,reviewer=0) {
  await tid('artifact-review-title-select').nth(index).focus(); await page.keyboard.press('Enter');
  await tid('artifact-review-title-record').getByText('摘要未提供',{exact:true}).waitFor();
  await page.getByLabel('标题摘要审核人',{exact:true}).selectOption(f.input.titleAbstractReviewers[reviewer].id);
  await tid('artifact-review-title-decision').waitFor();
}
async function fill(outcome=include) {
  await page.getByLabel('筛选决定',{exact:true}).selectOption(outcome.decision);
  if(outcome.decision==='include')await tid('artifact-review-title-form').getByRole('checkbox').check();
  if(outcome.decision==='exclude')await page.getByLabel('主要排除准则',{exact:true}).selectOption(outcome.exclusionCriterionId);
  await page.getByLabel('筛选理由',{exact:true}).fill(outcome.reason);
}
async function save() {
  await tid('artifact-review-title-save').click();await tid('artifact-review-title-current').waitFor();
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



test('native source and declared reviewer selection saves a real uncertain decision without manufacturing a missing abstract',async()=>{
  const f=await fixture({screening:{titleAbstractReviewers:1,fullTextReviewers:2,conflictResolution:'human_adjudication'}});
  await mount(f);await select(f);assert.equal(await tid('artifact-review-title-focus').evaluate(element=>element===document.activeElement),true);
  await fill(uncertain);await audit('title-default');await tid('artifact-review-title-save').hover();await audit('title-hover');await save();
  const phase=f.freezing.getPhase(f.phase),decision=phase.items[0].decisions[0];
  assert.deepEqual(decision.snapshot.request.outcome,uncertain);assert.equal(decision.snapshot.material.abstractStatus,'missing');
  assert.deepEqual(decision.snapshot.material.hit,f.corpus.snapshot.hits[0]);assert.equal(decision.snapshot.actor.id,`window:${windowId}`);
  assert.equal(phase.counts.uncertain,1);assert.equal(phase.counts.included,0);assert.equal(phase.counts.pending,7);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(),0);
});

test('two actual declared reviewers retain pending until both decide and display a true conflict rather than predicting consensus',async()=>{
  const f=await fixture();await mount(f);await select(f);await fill();await save();
  assert.equal(f.freezing.getPhase(f.phase).items[0].status,'pending');
  assert.match(await tid('artifact-review-title-counts').innerText(),/待审 8/u);
  await page.getByLabel('标题摘要审核人',{exact:true}).selectOption(f.input.titleAbstractReviewers[1].id);
  await fill(exclude);await save();
  const phase=f.freezing.getPhase(f.phase);assert.equal(phase.items[0].status,'conflict');assert.equal(phase.counts.conflict,1);
  assert.match(await tid('artifact-review-title-counts').innerText(),/冲突 1/u);assert.equal(phase.freeze,null);
  await audit('title-conflict');
});

test('exact parent revision retains the old human verdict and native expanded immutable history',async()=>{
  const f=await fixture({screening:{titleAbstractReviewers:1,fullTextReviewers:1,conflictResolution:'human_adjudication'}});
  await mount(f);await select(f);await fill(uncertain);await save();
  const first=f.freezing.getPhase(f.phase).items[0].decisions[0];
  await tid('artifact-review-title-revise').click();await fill({...exclude,reason:exclude.reason+'. '.repeat(2000)});
  await page.getByLabel('筛选修订原因',{exact:true}).fill('Synthetic additional human review supports exclusion');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-title-current"]')?.textContent.includes('版本 2'));
  const history=f.decisions.history({...f.get,decisionId:first.snapshot.id});assert.equal(history.length,2);
  assert.deepEqual(history[0],{...first,isLatest:false});assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);
  await tid('artifact-review-title-history').locator('summary').click();await tid('artifact-review-title-history').locator('ul').waitFor({state:'visible'});
  assert.match(await tid('artifact-review-title-history').innerText(),/版本 1 无法判断/u);await audit('title-long-history');
});

test('considering a real independent model suggestion records its hash without filling or changing the final human outcome',async()=>{
  const f=await fixture({screening:{titleAbstractReviewers:1,fullTextReviewers:1,conflictResolution:'human_adjudication'}});
  const proposal=f.decisions.suggest({...f.target(0,'proposal'),outcome:include},origin);
  await mount(f);assert.equal(f.freezing.getPhase(f.phase).counts.included,0);await select(f);
  await tid('artifact-review-title-consider').click();assert.equal(await page.getByLabel('筛选决定',{exact:true}).inputValue(),'');
  await fill(uncertain);await save();const phase=f.freezing.getPhase(f.phase),human=phase.items[0].decisions[0];
  assert.deepEqual(human.snapshot.request.outcome,uncertain);
  assert.deepEqual(human.snapshot.request.consideredSuggestion,{id:proposal.snapshot.id,expectedHash:proposal.snapshotHash});
  assert.equal(phase.counts.uncertain,1);assert.equal(phase.counts.included,0);assert.equal(phase.items[0].suggestionCount,1);
});

test('lost actual human save reply replays exact input and cannot duplicate a decision',async()=>{
  const f=await fixture();await mount(f);await select(f);await fill();const start=calls.length;f.loseReply='saveReviewScreeningDecision';
  await tid('artifact-review-title-save').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  const writes=calls.slice(start).filter(call=>call.method==='saveReviewScreeningDecision');assert.equal(writes.length,2);
  assert.deepEqual(writes[1].input,writes[0].input);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_decisions').pluck().get(),1);
});

test('independent current decision defeats a stale null parent and a reread preserves the actual saved authority',async()=>{
  const f=await fixture();await mount(f);await select(f);await fill(uncertain);
  const actual=f.decisions.save(f.decision(0,f.input.titleAbstractReviewers[0].id,'independent',exclude),{kind:'user',id:'other-author'});
  const before=f.changes();await tid('artifact-review-title-save').click();
  await tid('artifact-review-title-decision').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(await page.getByLabel('筛选理由',{exact:true}).inputValue(),uncertain.reason);
  await tid('artifact-review-title-refresh').click();await tid('artifact-review-title-current').waitFor();
  assert.match(await tid('artifact-review-title-current').innerText(),/other-author/u);
  assert.equal(f.freezing.getPhase(f.phase).items[0].decisions[0].snapshotHash,actual.snapshotHash);
});

test('held actual human commit keeps its own form visible and blocks reviewer, record, refresh and closing',async()=>{
  const f=await fixture();await mount(f);await select(f);await fill();
  const begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='saveReviewScreeningDecision';
  await tid('artifact-review-title-save').click();await begun;
  assert.equal(await tid('artifact-review-title-form').count(),1);assert.equal(await page.getByLabel('筛选理由',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('标题摘要审核人',{exact:true}).isDisabled(),true);
  assert.equal(await tid('artifact-review-title-select').first().isDisabled(),true);
  assert.equal(await tid('artifact-review-title-refresh').isDisabled(),true);assert.equal(await tid('artifact-review-screening-plan-refresh').isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);
  f.deferMethod=null;f.release();await tid('artifact-review-title-current').waitFor();
});

test('phase read failure retains labeled old receipts and prohibits writes until a real successful reread',async()=>{
  const f=await fixture();await mount(f);await select(f);await fill(uncertain);
  f.readFailure={code:'research_review_screening_snapshot_invalid',message:'Synthetic original phase receipt corrupt'};
  await tid('artifact-review-title-refresh').click();await page.getByRole('alert').filter({hasText:'Synthetic original phase'}).waitFor();
  assert.match(await tid('artifact-review-title').innerText(),/上次成功读取/u);assert.equal(await tid('artifact-review-title-form').count(),0);
  f.readFailure=null;await tid('artifact-review-title-refresh').click();await tid('artifact-review-title-form').waitFor();
  assert.equal(await page.getByLabel('筛选理由',{exact:true}).inputValue(),uncertain.reason);
});

test('frozen and archived title decisions stay readable with exact metadata and history but no mutable form at dark narrow size',async()=>{
  const f=await fixture({screening:{titleAbstractReviewers:1,fullTextReviewers:1,conflictResolution:'human_adjudication'}});
  for(const [index] of f.corpus.snapshot.hits.entries())f.decisions.save(f.decision(index,f.input.titleAbstractReviewers[0].id,`include-${index}`),{kind:'user',id:'original-human'});
  const phase=f.freezing.getPhase(f.phase);f.freezing.freeze({...f.phase,requestId:'human-freeze',expectedReviewHash:phase.reviewHash,reviewNote:'Synthetic complete exact human set'}, {kind:'user',id:'human-freezer'});
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(650,860));await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const before=f.changes();await mount(f,false);await select(f);await tid('artifact-review-title-current').waitFor();
  assert.equal(await tid('artifact-review-title-form').count(),0);assert.equal(await tid('artifact-review-title-revise').count(),0);
  assert.equal(await tid('artifact-review-title-frozen').count(),1);assert.equal(f.changes(),before);await audit('title-archived-dark-narrow');
});


test('independent suggestions paginate real snapshots without changing human counts or borrowing a different-page reference',async()=>{
  const f=await fixture({screening:{titleAbstractReviewers:1,fullTextReviewers:1,conflictResolution:'human_adjudication'}});
  for(let index=0;index<31;index++)f.decisions.suggest({...f.target(0,`proposal-${index}`),outcome:{...include,reason:`Synthetic proposal ${index}`}},
    {...origin,operationId:`operation-${index}`,idempotencyKey:`key-${index}`,toolCallId:`call-${index}`});
  const finalPage=f.decisions.listSuggestions({...f.phase,hitId:f.corpus.snapshot.hits[0].id,offset:30,limit:30});
  assert.equal(finalPage.length,1);
  await mount(f);await select(f);await tid('artifact-review-title-suggestion').nth(29).waitFor();
  assert.equal(await tid('artifact-review-title-suggestion').count(),30);
  await tid('artifact-review-title-suggestions').getByRole('button',{name:'下一页建议',exact:true}).click();
  await tid('artifact-review-title-suggestions').getByText(finalPage[0].snapshot.request.outcome.reason,{exact:true}).waitFor();
  assert.equal(await tid('artifact-review-title-suggestion').count(),1);await tid('artifact-review-title-consider').click();
  await fill(uncertain);await save();const phase=f.freezing.getPhase(f.phase);
  assert.deepEqual(phase.items[0].decisions[0].snapshot.request.consideredSuggestion,{id:finalPage[0].snapshot.id,expectedHash:finalPage[0].snapshotHash});
  assert.equal(phase.items[0].suggestionCount,31);assert.equal(phase.counts.included,0);
});

test('late original title read cannot reintroduce the prior project record or a writable reviewer form',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,900));await page.evaluate(()=>document.documentElement.dataset.theme='light');
  const a=await fixture(),b=await fixture();await mount(a);
  const begun=new Promise(resolve=>{a.started=resolve;});a.deferMethod='getReviewCorpusHit';
  await tid('artifact-review-title-select').first().click();await begun;
  await mount(b);await select(b);const body=await tid('artifact-review-title-record').innerText();
  a.deferMethod=null;a.release();
  assert.equal(await tid('artifact-review-title').count(),1);assert.equal(await tid('artifact-review-title-record').innerText(),body);
  assert.equal(await page.getByLabel('标题摘要审核人',{exact:true}).inputValue(),b.input.titleAbstractReviewers[0].id);
  await fill(uncertain);await save();assert.equal(a.freezing.getPhase(a.phase).items[0].decisions.length,0);
  assert.equal(b.freezing.getPhase(b.phase).items[0].decisions[0].snapshot.request.corpusId,b.corpus.snapshot.id);
});
