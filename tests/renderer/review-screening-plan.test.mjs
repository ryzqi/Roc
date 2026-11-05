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
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c2a-ui');
const channels = {
  listReviewProtocols: 'roc:research:review-protocol-list', getReviewProtocol: 'roc:research:review-protocol-get',
  getReviewProtocolHistory: 'roc:research:review-protocol-history', listReviewSearches: 'roc:research:review-search-list',
  listReviewCorpora: 'roc:research:review-corpus-list', getReviewCorpus: 'roc:research:review-corpus-get',
  getReviewCorpusHit: 'roc:research:review-corpus-hit', getReviewDeduplication: 'roc:research:review-deduplication-get',
  saveReviewDuplicateDecision: 'roc:research:review-deduplication-save',
  getReviewDuplicateDecisionHistory: 'roc:research:review-deduplication-history',
  freezeReviewDeduplication: 'roc:research:review-deduplication-freeze',
  createReviewScreeningPlan: 'roc:research:review-screening-createPlan', getReviewScreeningPlan: 'roc:research:review-screening-getPlan'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-screening-plan-ui-')); mkdirSync(artifacts, {recursive: true});
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
    if (method === 'getReviewScreeningPlan' && f.readFailure) return {ok:false,error:f.readFailure};
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
  await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-review-screening-plan-refresh"]').disabled);
}
async function fill(f, note = 'Synthetic human declared the actual phase reviewers and adjudicator') {
  for (const [phase, reviewers] of [['标题摘要', f.input.titleAbstractReviewers], ['全文', f.input.fullTextReviewers]]) {
    for (const [index, reviewer] of reviewers.entries()) {
      await page.getByLabel(`${phase}审核人 ${index + 1}标识`, {exact: true}).fill(reviewer.id);
      await page.getByLabel(`${phase}审核人 ${index + 1}姓名`, {exact: true}).fill(reviewer.name);
    }
  }
  await page.getByLabel('仲裁人标识', {exact: true}).fill(f.input.adjudicator.id);
  await page.getByLabel('仲裁人姓名', {exact: true}).fill(f.input.adjudicator.name);
  await page.getByLabel('审核人声明说明', {exact: true}).fill(note);
}
async function save() {
  await tid('artifact-review-screening-plan-create').click();
  await tid('artifact-review-screening-plan-frozen').waitFor();
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


test('actual frozen corpus entry declares exact protocol phase counts and retains real window authority separately', async () => {
  const f = await fixture(); await mount(f);
  await tid('artifact-review-screening-plan-form').waitFor();
  await fill(f); await audit('declaration-default');
  await tid('artifact-review-screening-plan-create').hover(); await audit('declaration-hover');
  await tid('artifact-review-screening-plan-create').focus(); await page.keyboard.press('Enter');
  await tid('artifact-review-screening-plan-frozen').waitFor();
  const plan = f.screening.getPlan(f.get);
  assert.deepEqual(plan.snapshot.request.titleAbstractReviewers, f.input.titleAbstractReviewers);
  assert.deepEqual(plan.snapshot.request.fullTextReviewers, f.input.fullTextReviewers);
  assert.deepEqual(plan.snapshot.request.adjudicator, f.input.adjudicator);
  assert.equal(plan.snapshot.request.expectedCorpusHash, f.corpus.snapshotHash);
  assert.equal(plan.snapshot.request.expectedDedupFreezeHash, f.frozen.freezeHash);
  assert.equal(plan.snapshot.actor.id, `window:${windowId}`);
  assert.equal(await tid('artifact-review-screening-plan-create').count(), 0);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
  await audit('declaration-frozen');
});

test('single reviewer phases have exactly one explicit identity field each and no guessed default names', async () => {
  const f = await fixture({screening: {titleAbstractReviewers: 1, fullTextReviewers: 1, conflictResolution: 'human_adjudication'}});
  await mount(f);
  assert.equal(await page.getByLabel('标题摘要审核人 1标识', {exact: true}).inputValue(), '');
  assert.equal(await page.getByLabel('标题摘要审核人 2标识', {exact: true}).count(), 0);
  assert.equal(await page.getByLabel('全文审核人 2标识', {exact: true}).count(), 0);
  await fill(f); await save();
  assert.equal(f.screening.getPlan(f.get).snapshot.request.titleAbstractReviewers.length, 1);
  assert.equal(f.screening.getPlan(f.get).snapshot.request.fullTextReviewers.length, 1);
});

test('duplicate declared identities refuse without writes and actual corrected input receives a new request', async () => {
  const f = await fixture(); await mount(f); await fill(f);
  await page.getByLabel('标题摘要审核人 2标识', {exact: true}).fill(f.input.titleAbstractReviewers[0].id);
  const before = f.changes(), start = calls.length;
  await tid('artifact-review-screening-plan-create').click();
  await page.getByRole('alert').filter({hasText: 'review_screening_reviewers_duplicate'}).waitFor();
  assert.equal(f.changes(), before);
  await page.getByLabel('标题摘要审核人 2标识', {exact: true}).fill(f.input.titleAbstractReviewers[1].id);
  await save();
  const writes = calls.slice(start).filter(call => call.method === 'createReviewScreeningPlan');
  assert.equal(writes.length, 2); assert.notEqual(writes[0].input.requestId, writes[1].input.requestId);
});

test('lost actual commit reply retries the exact declaration without replacing identities or creating a second row', async () => {
  const f = await fixture(); await mount(f); await fill(f);
  const start = calls.length; f.loseReply = 'createReviewScreeningPlan';
  await tid('artifact-review-screening-plan-create').click();
  await page.getByRole('alert').filter({hasText: 'reply lost'}).waitFor();
  await save();
  const writes = calls.slice(start).filter(call => call.method === 'createReviewScreeningPlan');
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].input, writes[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_screening_plans').pluck().get(), 1);
});

test('pending actual declaration keeps its form visible and blocks scope selection, refresh and drawer dismissal', async () => {
  const f = await fixture(); await mount(f); await fill(f);
  const begun = new Promise(resolve => {f.started = resolve;}); f.deferMethod = 'createReviewScreeningPlan';
  await tid('artifact-review-screening-plan-create').click(); await begun;
  assert.equal(await tid('artifact-review-screening-plan-form').count(), 1);
  assert.equal(await page.getByLabel('仲裁人姓名', {exact: true}).isDisabled(), true);
  assert.equal(await tid('artifact-review-screening-plan-refresh').isDisabled(), true);
  assert.equal(await tid('artifact-review-dedup-refresh').isDisabled(), true);
  assert.equal(await tid('artifact-review-new').isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await tid('artifact-inspector-panel').count(), 1);
  f.deferMethod = null; f.release(); await tid('artifact-review-screening-plan-frozen').waitFor();
});

test('marked missing receipt and uncoded read failure never authorize creation; actual restored receipt is readable', async () => {
  const f = await fixture();
  f.screening.createPlan(f.input, {kind: 'user', id: 'synthetic-before-display'});
  const row = f.db.prepare('SELECT * FROM research_review_screening_plans').get();
  f.db.prepare('DELETE FROM research_review_screening_plans').run();
  assert.throws(() => f.screening.getPlan(f.get), /research_review_screening_snapshot_invalid/);
  await mount(f);
  await tid('artifact-review-screening-plan').getByRole('alert').filter({hasText: '校验失败'}).waitFor();
  assert.equal(await tid('artifact-review-screening-plan-form').count(), 0);
  f.readFailure = {message: 'Synthetic transport declaration not found'};
  await tid('artifact-review-screening-plan-refresh').click();
  await page.getByRole('alert').filter({hasText: 'Synthetic transport'}).waitFor();
  assert.equal(await tid('artifact-review-screening-plan-form').count(), 0);
  f.db.prepare(`INSERT INTO research_review_screening_plans (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  f.readFailure = null; await tid('artifact-review-screening-plan-refresh').click();
  await tid('artifact-review-screening-plan-frozen').waitFor();
});

test('late missing read from a prior project cannot enable creation or replace the current frozen declaration', async () => {
  const a = await fixture(), b = await fixture();
  b.screening.createPlan(b.input, {kind: 'user', id: 'current-project-declarer'});
  const begun = new Promise(resolve => {a.started = resolve;}); a.deferMethod = 'getReviewScreeningPlan';
  active = a;
  const firstMount = mount(a); await begun;
  await mount(b); await tid('artifact-review-screening-plan-frozen').waitFor();
  a.deferMethod = null; a.release(); await firstMount;
  assert.equal(await tid('artifact-review-screening-plan-form').count(), 0);
  assert.match(await tid('artifact-review-screening-plan-frozen').innerText(), /current-project-declarer/u);
});

test('unfrozen deduplication has no declaration entry, archived and historical protocol declarations are read only at narrow dark size', async () => {
  const unfrozen = await fixture({freeze: false}); await mount(unfrozen);
  assert.equal(await tid('artifact-review-screening-inspect').count(), 0);
  const f = await fixture(); f.screening.createPlan(f.input, {kind: 'user', id: 'historical-declarer'});
  f.repository.systematicReviews.save({projectId:f.project.id, protocolId:f.protocol.version.protocolId, requestId: 'next-protocol', expectedVersionId: f.protocol.version.id,
    expectedVersionHash: f.protocol.versionHash, deviationReason: 'Synthetic later protocol', body: {...f.protocol.version.body, question: 'Later question'}}, {kind: 'user', id: 'later-author'});
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(650, 860));
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const before = f.changes(); await mount(f, false);
  await tid('artifact-review-screening-plan-frozen').waitFor();
  assert.match(await tid('artifact-review-screening-plan-frozen').innerText(), /历史协议/u);
  assert.equal(await tid('artifact-review-screening-plan-create').count(), 0);
  assert.equal(f.changes(), before);
  await audit('declaration-archived-dark-narrow');
});
