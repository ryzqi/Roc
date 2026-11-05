import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {reviewSearchPayloadFixture} from '../unit/fixtures/research-review-search.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewScreeningPlanFixture} from '../unit/fixtures/research-review-screening.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c2c-ui');
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
  adjudicateReviewScreening:'roc:research:review-screening-adjudicate',getReviewScreeningArbitrationHistory:'roc:research:review-screening-arbitrations',freezeReviewScreeningPhase:'roc:research:review-screening-freeze'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-title-arbitration-ui-')); mkdirSync(artifacts, {recursive: true});
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
  await page.waitForFunction(()=>!document.querySelector('[data-testid="artifact-review-title-refresh"]').disabled);
}

const include={decision:'include',inclusionCriterionIds:['controlled'],reason:'Synthetic title meets the declared controlled comparison criterion'};
const exclude={decision:'exclude',exclusionCriterionId:'no-outcome',reason:'Synthetic provided title does not report the required outcome'};
const uncertain={decision:'uncertain',reason:'Synthetic raw abstract is missing and the title is insufficient'};
const origin={kind:'agent_tool',operationId:'synthetic-operation',idempotencyKey:'synthetic-idempotency',toolCallId:'synthetic-tool-call',
  canonicalToolIdentity:'capability:research.reviewScreening.suggest',toolVersion:'1',attemptId:'first-attempt',capabilityName:'research.reviewScreening.suggest',capabilityVersion:'1.0.0'};

const actor={kind:'user',id:'synthetic-original-human'};
async function scene({single=false,...options}={}) {
  const f=await fixture(single?{...options,screening:{titleAbstractReviewers:1,fullTextReviewers:1,conflictResolution:'human_adjudication'}}:options);
  for(const [index] of f.corpus.snapshot.hits.entries()) {
    for(const [position,reviewer] of f.input.titleAbstractReviewers.entries()) {
      f.decisions.save(f.decision(index,reviewer.id,`decision-${index}-${position}`,index===0?(single?uncertain:position===0?include:exclude):include),actor);
    }
  }
  return f;
}
async function select() {
  await tid('artifact-review-title-select').first().focus();await page.keyboard.press('Enter');
  await tid('artifact-review-title-record').getByText('摘要未提供',{exact:true}).waitFor();await tid('artifact-review-title-arbitration').waitFor();
}
async function fill(f,outcome=include) {
  const form=tid('artifact-review-title-arbitration-form');
  await form.getByLabel('标题摘要仲裁人',{exact:true}).selectOption(f.input.adjudicator.id);
  await form.getByLabel('筛选决定',{exact:true}).selectOption(outcome.decision);
  if(outcome.decision==='include')await form.getByRole('checkbox').check();
  else await form.getByLabel('主要排除准则',{exact:true}).selectOption(outcome.exclusionCriterionId);
  await form.getByLabel('筛选理由',{exact:true}).fill(outcome.reason);
}
async function save() {
  await tid('artifact-review-title-arbitration-save').click();await tid('artifact-review-title-arbitration-current').waitFor();
}
async function freeze(note='Synthetic human reviewed the complete exact title decision and arbitration set') {
  await page.getByLabel('标题摘要整轮审核说明',{exact:true}).fill(note);await tid('artifact-review-title-freeze').click();
  await tid('artifact-review-title-frozen').waitFor();
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




test('actual complete conflict uses exact declared human adjudicator and decision hashes before conserved whole-round freeze',async()=>{
  const f=await scene();await mount(f);
  assert.equal(await tid('artifact-review-title-freeze').isDisabled(),true);await select();await fill(f);await audit('arbitration-default');
  await tid('artifact-review-title-arbitration-save').hover();await audit('arbitration-hover');await save();
  const phase=f.freezing.getPhase(f.phase),arbitration=phase.items[0].arbitration;
  assert.deepEqual(arbitration.snapshot.request.decisions,phase.items[0].decisions.map(decision=>({id:decision.snapshot.id,expectedHash:decision.snapshotHash})));
  assert.equal(arbitration.snapshot.actor.id,`window:${windowId}`);assert.equal(arbitration.snapshot.request.reviewerId,f.input.adjudicator.id);
  assert.equal(phase.counts.included,8);assert.equal(phase.counts.conflict,0);await freeze();
  const frozen=f.freezing.getPhase(f.phase);assert.equal(frozen.freeze.request.expectedReviewHash,phase.reviewHash);
  assert.equal(frozen.freeze.actor.id,`window:${windowId}`);assert.equal(frozen.freeze.authority.counts.recordsToScreen,8);
  assert.equal(await tid('artifact-review-title-arbitration-form').count(),0);assert.equal(await tid('artifact-review-title-freeze-form').count(),0);
  await audit('title-frozen-after-arbitration');
});

test('single reviewer uncertain is independently adjudicated with one declared primary exclusion rather than silently counted included',async()=>{
  const f=await scene({single:true});await mount(f);assert.equal(f.freezing.getPhase(f.phase).counts.uncertain,1);
  await select();await fill(f,exclude);await save();await freeze();const phase=f.freezing.getPhase(f.phase);
  assert.equal(phase.counts.excluded,1);assert.equal(phase.counts.included,7);assert.equal(phase.counts.uncertain,0);
  assert.equal(phase.freeze.authority.items[0].primaryExclusionCriterionId,'no-outcome');
});

test('changed real reviewer set refuses a stale arbitration without losing the original user draft',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);
  const original=f.freezing.getPhase(f.phase).items[0].decisions[1];
  f.decisions.save(f.decision(0,f.input.titleAbstractReviewers[1].id,'independent-revision',uncertain,{parentDecisionId:original.snapshot.id,
    expectedParentHash:original.snapshotHash,revisionReason:'Synthetic later independent reviewer examination'}),actor);
  const before=f.changes();await tid('artifact-review-title-arbitration-save').click();
  await tid('artifact-review-title-arbitration').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();
  assert.equal(f.changes(),before);assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_arbitrations').pluck().get(),0);
  assert.equal(await tid('artifact-review-title-arbitration-form').getByLabel('筛选理由',{exact:true}).inputValue(),include.reason);
});

test('lost real arbitration and freeze replies retry exact requests without duplicate authority records',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);const start=calls.length;
  f.loseReply='adjudicateReviewScreening';await tid('artifact-review-title-arbitration-save').click();
  await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();await save();
  f.loseReply='freezeReviewScreeningPhase';await page.getByLabel('标题摘要整轮审核说明',{exact:true}).fill('Synthetic exact freeze retry note');
  await tid('artifact-review-title-freeze').click();await page.getByRole('alert').filter({hasText:'reply lost'}).waitFor();
  await tid('artifact-review-title-freeze').click();await tid('artifact-review-title-frozen').waitFor();
  for(const method of ['adjudicateReviewScreening','freezeReviewScreeningPhase']) {
    const writes=calls.slice(start).filter(call=>call.method===method);assert.equal(writes.length,2);assert.deepEqual(writes[1].input,writes[0].input);
  }
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_arbitrations').pluck().get(),1);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_freezes').pluck().get(),1);
});

test('new reviewer revision makes old arbitration visibly inapplicable and exact parent re-arbitration preserves immutable history',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);await save();const first=f.freezing.getPhase(f.phase).items[0].arbitration;
  const original=f.freezing.getPhase(f.phase).items[0].decisions[1];
  f.decisions.save(f.decision(0,f.input.titleAbstractReviewers[1].id,'later-uncertain',uncertain,{parentDecisionId:original.snapshot.id,
    expectedParentHash:original.snapshotHash,revisionReason:'Synthetic source review changed uncertainty'}),actor);
  await tid('artifact-review-title-refresh').click();await tid('artifact-review-title-arbitration-current').getByText('原审核决定已变化，此仲裁不适用于当前集合',{exact:true}).waitFor();
  assert.equal(f.freezing.getPhase(f.phase).counts.uncertain,1);assert.equal(await tid('artifact-review-title-freeze').isDisabled(),true);
  await tid('artifact-review-title-arbitration-revise').click();await fill(f,{...exclude,reason:exclude.reason+' Long scientific review rationale.'.repeat(100)});
  await page.getByLabel('仲裁修订原因',{exact:true}).fill('Synthetic explicit updated reviewer set re-arbitration');await save();
  await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-title-arbitration-current"]')?.textContent.includes('版本 2'));
  const history=f.arbitration.history({...f.get,arbitrationId:first.snapshot.id});assert.equal(history.length,2);
  assert.equal(history[0].currentDecisionSet,false);assert.equal(history[1].snapshot.request.expectedParentHash,first.snapshotHash);
  await tid('artifact-review-title-arbitration-history').locator('summary').click();
  await tid('artifact-review-title-arbitration-history').locator('ul').waitFor({state:'visible'});await audit('arbitration-expanded-history');
});

test('held real arbitration and whole-round freeze keep their own forms and block other writes, reads and dismissal',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);
  let begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='adjudicateReviewScreening';
  await tid('artifact-review-title-arbitration-save').click();await begun;
  assert.equal(await tid('artifact-review-title-arbitration-form').count(),1);
  assert.equal(await tid('artifact-review-title-arbitration-form').getByLabel('筛选理由',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('标题摘要审核人',{exact:true}).isDisabled(),true);
  assert.equal(await tid('artifact-review-title-refresh').isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);
  f.deferMethod=null;f.release();await tid('artifact-review-title-arbitration-current').waitFor();
  await page.getByLabel('标题摘要整轮审核说明',{exact:true}).fill('Synthetic held whole-round submission');
  begun=new Promise(resolve=>{f.started=resolve;});f.deferMethod='freezeReviewScreeningPhase';
  await tid('artifact-review-title-freeze').click();await begun;
  assert.equal(await tid('artifact-review-title-freeze-form').count(),1);
  assert.equal(await page.getByLabel('标题摘要整轮审核说明',{exact:true}).isDisabled(),true);
  assert.equal(await tid('artifact-review-title-select').first().isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await tid('artifact-inspector-panel').count(),1);
  f.deferMethod=null;f.release();await tid('artifact-review-title-frozen').waitFor();
});

test('a real newer human decision invalidates ready-to-freeze hash and a fresh read cannot hide the new unresolved count',async()=>{
  const f=await scene({single:true});const original=f.freezing.getPhase(f.phase).items[0].decisions[0];
  const resolved=f.decisions.save(f.decision(0,f.input.titleAbstractReviewers[0].id,'resolved',include,{parentDecisionId:original.snapshot.id,
    expectedParentHash:original.snapshotHash,revisionReason:'Synthetic resolved initial title uncertainty'}),actor);
  await mount(f);await page.getByLabel('标题摘要整轮审核说明',{exact:true}).fill('Synthetic original ready set');
  f.decisions.save(f.decision(0,f.input.titleAbstractReviewers[0].id,'new-uncertainty',uncertain,{parentDecisionId:resolved.snapshot.id,
    expectedParentHash:resolved.snapshotHash,revisionReason:'Synthetic independently discovered uncertainty'}),actor);
  const before=f.changes();await tid('artifact-review-title-freeze').click();
  await tid('artifact-review-title').getByRole('alert').filter({hasText:'状态已变化'}).waitFor();assert.equal(f.changes(),before);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_freezes').pluck().get(),0);
  await tid('artifact-review-title-refresh').click();await page.waitForFunction(()=>document.querySelector('[data-testid="artifact-review-title-counts"]')?.textContent.includes('无法判断 1'));
  assert.equal(await tid('artifact-review-title-freeze').isDisabled(),true);
});

test('marked missing whole-round receipt is a real read failure and never reopens mutable decisions or a fresh freeze',async()=>{
  const f=await scene();await mount(f);await select();await fill(f);await save();await freeze();
  f.db.prepare('DELETE FROM research_review_screening_freezes WHERE corpus_id=?').run(f.corpus.snapshot.id);
  assert.throws(()=>f.freezing.getPhase(f.phase),/research_review_screening_snapshot_invalid/);
  await mount(f);await tid('artifact-review-title').getByRole('alert').filter({hasText:'校验失败'}).waitFor();
  assert.equal(await tid('artifact-review-title-arbitration-form').count(),0);assert.equal(await tid('artifact-review-title-freeze-form').count(),0);
  assert.equal(await tid('artifact-review-title-select').count(),0);
});


test('actual zero-record corpus still requires an explicit human empty-set freeze and retains original count facts',async()=>{
  const f=await scene({fetch:async url=>Response.json(reviewSearchPayloadFixture(Number(new URL(url).searchParams.get('page')),0))});
  await mount(f);assert.equal(await tid('artifact-review-title-select').count(),0);
  assert.equal(f.freezing.getPhase(f.phase).freeze,null);assert.equal(await tid('artifact-review-title-freeze').isDisabled(),true);
  await freeze('Synthetic human explicitly reviewed the empty original corpus');const phase=f.freezing.getPhase(f.phase);
  assert.equal(phase.freeze.authority.items.length,0);assert.deepEqual(phase.freeze.authority.counts,{recordsToScreen:0,pending:0,uncertain:0,conflict:0,included:0,excluded:0});
  assert.equal(phase.freeze.actor.id,`window:${windowId}`);assert.equal(f.corpora.get(f.get).identifiedRecords,0);
});

test('title pagination selects exact retained original hit on the second page instead of substituting a first-page identity',async()=>{
  const f=await scene({maxPages:3,fetch:async url=>Response.json(reviewSearchPayloadFixture(Number(new URL(url).searchParams.get('page')),6))});
  await mount(f);assert.equal(await tid('artifact-review-title-select').count(),10);
  await tid('artifact-review-title').getByRole('button',{name:'下一页记录',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-testid="artifact-review-title-select"]').length===2);
  await select();const last=calls.filter(call=>call.method==='getReviewCorpusHit').at(-1);
  assert.equal(last.input.hitId,f.freezing.getPhase(f.phase).items[10].hit.id);
  await tid('artifact-review-title-record').locator('details').first().locator('summary').click();
  await tid('artifact-review-title-record').locator('details').first().locator('pre').waitFor({state:'visible'});
  assert.match(await tid('artifact-review-title-record').locator('details').first().locator('pre').innerText(),new RegExp(f.corpus.snapshot.hits[10].id));
});
