import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {auditReviewInspector} from './fixtures/audit-review-inspector.mjs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewDeduplicationFixture} from '../unit/fixtures/research-review-deduplication.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7c1-ui');
const channels = {
  listReviewProtocols: 'roc:research:review-protocol-list', getReviewProtocol: 'roc:research:review-protocol-get',
  getReviewProtocolHistory: 'roc:research:review-protocol-history', listReviewSearches: 'roc:research:review-search-list',
  listReviewCorpora: 'roc:research:review-corpus-list', getReviewCorpus: 'roc:research:review-corpus-get',
  getReviewCorpusHit: 'roc:research:review-corpus-hit', getReviewDeduplication: 'roc:research:review-deduplication-get',
  saveReviewDuplicateDecision: 'roc:research:review-deduplication-save',
  getReviewDuplicateDecisionHistory: 'roc:research:review-deduplication-history',
  freezeReviewDeduplication: 'roc:research:review-deduplication-freeze'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-dedup-ui-')); mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    window.disposeHarness=()=>flushSync(()=>root.render(null));
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
  try {await page?.evaluate(()=>window.disposeHarness()); await app?.close();} finally {
    for (const f of fixtures) await f.dispose();
    api?.dispose(); if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
async function fixture(options) {
  const f = await createReviewDeduplicationFixture(api, options);
  const registry = new api.CapabilityRegistry();
  for (const descriptor of [...api.researchSystematicReviewCapabilities, ...api.researchReviewSearchCapabilities,
    ...api.researchReviewCorpusCapabilities, ...api.researchReviewDeduplicationCapabilities]) registry.declare('research', descriptor);
  const context = {pluginId: 'research', capabilities: registry};
  api.registerResearchSystematicReviewCapabilities(context, f.repository.systematicReviews);
  api.registerResearchReviewSearchCapabilities(context, f.reviews);
  api.registerResearchReviewCorpusCapabilities(context, f.corpora);
  api.registerResearchReviewDeduplicationCapabilities(context, f.dedup);
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
}
async function select(f, left = 0, right = 4) {
  await tid('artifact-review-dedup').getByLabel('记录 A', {exact: true}).selectOption(f.corpus.snapshot.hits[left].id);
  await tid('artifact-review-dedup').getByLabel('记录 B', {exact: true}).selectOption(f.corpus.snapshot.hits[right].id);
  await tid('artifact-review-duplicate-editor').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-duplicate-editor"]')?.textContent.includes('Controlled paper'));
}
async function fill(decision = 'duplicate', reason = 'Synthetic human compared both original metadata reports') {
  const editor = tid('artifact-review-duplicate-editor');
  await editor.getByLabel('去重决定', {exact: true}).selectOption(decision);
  await editor.getByLabel('去重规则', {exact: true}).fill('Explicit synthetic report identity review');
  await editor.getByLabel('规则版本', {exact: true}).fill('engineering-v1');
  await editor.getByLabel('核查理由', {exact: true}).fill(reason);
}
async function save() {
  await tid('artifact-review-duplicate-save').click();
  await tid('artifact-review-duplicate-current').waitFor();
}
async function freeze(note = 'Synthetic human reviewed all original records and every current pair decision') {
  await page.getByLabel('整轮去重审核说明', {exact: true}).fill(note);
  await tid('artifact-review-dedup-freeze').click();
  await tid('artifact-review-dedup-frozen').waitFor();
}
const audit = label => auditReviewInspector(page, artifacts, label);

test('review draft protection keeps authored pair decisions through close and freezes replacement entries', async () => {
  const f = await fixture(); await mount(f); await select(f);
  await fill('duplicate', 'Keep this authored pair review.');
  assert.equal(await tid('artifact-review-dedup').getByLabel('记录 A', {exact: true}).isDisabled(), true);
  assert.equal(await tid('artifact-review-dedup-refresh').isDisabled(), true);
  assert.equal(await tid('artifact-review-refresh').isDisabled(), true);
  assert.equal(await tid('artifact-review-duplicate-editor').getByLabel('核查理由', {exact: true}).isDisabled(), false);
  await page.keyboard.press('Escape');
  assert.equal(await tid('artifact-inspector-panel').count(), 1);
  assert.equal(await tid('artifact-review-duplicate-editor').getByLabel('核查理由', {exact: true}).inputValue(), 'Keep this authored pair review.');
});

test('review draft protection covers whole-round notes and native unload', async () => {
  const f = await fixture(); await mount(f);
  await page.getByLabel('整轮去重审核说明', {exact: true}).fill('Retain this whole-round explanation.');
  const prevented = await page.evaluate(() => {
    const event = new Event('beforeunload', {cancelable: true});
    window.dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(prevented, true);
  assert.equal(await tid('artifact-review-dedup-refresh').isDisabled(), true);
  assert.equal(await page.getByLabel('整轮去重审核说明', {exact: true}).isDisabled(), false);
});

test('actual corpus entry inspects exact raw endpoints and freezes explicit left removal with conserved counts and window authority', async () => {
  const f = await fixture(); await mount(f);
  await tid('artifact-review-corpus-record').first().waitFor();
  assert.equal(await tid('artifact-review-corpus-record').count(), 8);
  await tid('artifact-review-corpus-record').nth(0).getByTestId('artifact-review-record-left').click();
  await tid('artifact-review-corpus-record').nth(4).getByTestId('artifact-review-record-right').focus();
  await page.keyboard.press('Enter');
  await tid('artifact-review-duplicate-editor').waitFor();
  assert.equal(await tid('artifact-review-pair-focus').evaluate(element => element === document.activeElement), true);
  await fill(); await audit('pair-default');
  await tid('artifact-review-duplicate-save').hover(); await audit('pair-hover'); await save();
  const state = f.dedup.get(f.get), decision = state.decisions[0];
  assert.equal(decision.snapshot.actor.id, `window:${windowId}`);
  assert.equal(decision.snapshot.request.leftHitId, f.corpus.snapshot.hits[0].id);
  assert.equal(decision.snapshot.request.rightHitId, f.corpus.snapshot.hits[4].id);
  assert.equal(decision.snapshot.left.hit.recordHash, f.corpus.snapshot.hits[0].recordHash);
  assert.equal(state.freeze, null);
  await freeze();
  const frozen = f.dedup.get(f.get);
  assert.equal(frozen.freeze.identifiedRecords, 8); assert.equal(frozen.freeze.removedDuplicates, 1); assert.equal(frozen.freeze.recordsToScreen, 7);
  assert.deepEqual(frozen.freeze.removed, [{hitId: f.corpus.snapshot.hits[0].id, retainedHitId: f.corpus.snapshot.hits[4].id}]);
  assert.equal(frozen.freeze.actor.id, `window:${windowId}`);
  assert.equal(await tid('artifact-review-duplicate-save').count(), 0);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_library').pluck().get(), 0);
  await audit('frozen-human');
});

test('explicit distinct revision preserves old decision and immutable history, then freezes zero removals', async () => {
  const f = await fixture(); await mount(f); await select(f); await fill(); await save();
  const original = f.dedup.get(f.get).decisions[0];
  await tid('artifact-review-duplicate-revise').click();
  await fill('distinct', 'Synthetic revised evidence supports different reports. '.repeat(50));
  await page.getByLabel('决定修订原因', {exact: true}).fill('Synthetic original identity decision corrected');
  await save();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-duplicate-current"]')?.textContent.includes('版本 2'));
  const history = f.dedup.history({...f.get, decisionId: original.snapshot.id});
  assert.equal(history.length, 2); assert.deepEqual(history[0], {...original, isLatest: false});
  assert.equal(history[1].snapshot.request.parentDecisionId, original.snapshot.id);
  assert.equal(history[1].snapshot.request.expectedParentHash, original.snapshotHash);
  await tid('artifact-review-duplicate-history').locator('summary').click();
  await tid('artifact-review-duplicate-history').locator('ul').waitFor({state: 'visible'});
  assert.match(await tid('artifact-review-duplicate-history').innerText(), /版本 1 同一报告/u);
  await freeze();
  assert.equal(f.dedup.get(f.get).freeze.recordsToScreen, 8);
  await audit('distinct-history');
});

test('lost pair and freeze replies replay exact immutable requests without duplicate decisions or authority receipts', async () => {
  const f = await fixture(); await mount(f); await select(f); await fill();
  const start = calls.length; f.loseReply = 'saveReviewDuplicateDecision';
  await tid('artifact-review-duplicate-save').click();
  await page.getByRole('alert').filter({hasText: 'reply lost'}).waitFor();
  await save();
  const writes = calls.slice(start).filter(call => call.method === 'saveReviewDuplicateDecision');
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].input, writes[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_duplicate_decisions').pluck().get(), 1);
  f.loseReply = 'freezeReviewDeduplication';
  await page.getByLabel('整轮去重审核说明', {exact: true}).fill('Synthetic exact freeze reply review');
  await tid('artifact-review-dedup-freeze').click();
  await page.getByRole('alert').filter({hasText: 'reply lost'}).waitFor();
  await tid('artifact-review-dedup-freeze').click(); await tid('artifact-review-dedup-frozen').waitFor();
  const freezes = calls.slice(start).filter(call => call.method === 'freezeReviewDeduplication');
  assert.equal(freezes.length, 2); assert.deepEqual(freezes[1].input, freezes[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_deduplication_freezes').pluck().get(), 1);
});

test('the same hit cannot be declared a pair; empty human decision set freezes only after explicit whole-round review', async () => {
  const f = await fixture(); await mount(f); await select(f, 0, 0); await fill();
  assert.match(await tid('artifact-review-duplicate-editor').innerText(), /两个不同的原始命中/u);
  assert.equal(await tid('artifact-review-duplicate-save').isDisabled(), true);
  assert.equal(f.dedup.get(f.get).decisions.length, 0);
  assert.equal(await tid('artifact-review-dedup-freeze').isDisabled(), true);
  assert.equal(await page.getByLabel('整轮去重审核说明', {exact: true}).isDisabled(), true);
  await tid('artifact-review-duplicate-discard').click();
  await page.getByRole('button', {name: '取消', exact: true}).click();
  assert.equal(await tid('artifact-review-duplicate-editor').getByLabel('核查理由', {exact: true}).inputValue(),
    'Synthetic human compared both original metadata reports');
  await tid('artifact-review-duplicate-discard').click();
  await page.getByRole('button', {name: '放弃修改并继续', exact: true}).click();
  assert.equal(await page.getByLabel('整轮去重审核说明', {exact: true}).isDisabled(), false);
  assert.equal(f.dedup.get(f.get).decisions.length, 0);
  await freeze('Synthetic human explicitly retained every original return without duplicate removals');
  assert.equal(f.dedup.get(f.get).freeze.recordsToScreen, 8);
  assert.equal(f.dedup.get(f.get).freeze.removedDuplicates, 0);
});

test('actual independent parent revision refuses stale GUI edit without overwriting either saved history or explicit draft', async () => {
  const f = await fixture(); await mount(f); await select(f); await fill(); await save();
  const original = f.dedup.get(f.get).decisions[0];
  await tid('artifact-review-duplicate-revise').click(); await fill('distinct', 'Uncommitted stale synthetic edit');
  await page.getByLabel('决定修订原因', {exact: true}).fill('Synthetic GUI stale parent');
  const independent = f.dedup.save(f.save(0, 4, 'independent-parent', {decision: 'distinct',
    parentDecisionId: original.snapshot.id, expectedParentHash: original.snapshotHash, revisionReason: 'Independent synthetic revision'}),
  {kind: 'user', id: 'independent-reviewer'});
  const unchanged = f.changes(); await tid('artifact-review-duplicate-save').click();
  await page.getByRole('alert').filter({hasText: '状态已变化'}).waitFor();
  assert.equal(f.changes(), unchanged);
  assert.equal(await tid('artifact-review-duplicate-editor').getByLabel('核查理由', {exact: true}).inputValue(), 'Uncommitted stale synthetic edit');
  assert.equal(f.dedup.get(f.get).decisions[0].snapshot.id, independent.snapshot.id);
});

test('cyclic actual pair graph refuses freeze and leaves reviewed pair facts visible without fake empty authority', async () => {
  const f = await fixture();
  const actor = {kind: 'user', id: 'synthetic-cycle-reviewer'};
  f.dedup.save(f.save(0, 1, 'cycle-01'), actor); f.dedup.save(f.save(1, 2, 'cycle-12'), actor);
  f.dedup.save(f.save(2, 0, 'cycle-20'), actor);
  await mount(f); const unchanged = f.changes();
  await page.getByLabel('整轮去重审核说明', {exact: true}).fill('Synthetic graph review exposes a cycle');
  await tid('artifact-review-dedup-freeze').click();
  await page.getByRole('alert').filter({hasText: '状态已变化'}).waitFor();
  assert.equal(f.changes(), unchanged);
  assert.equal(f.dedup.get(f.get).decisions.length, 3);
  assert.equal(f.dedup.get(f.get).freeze, null);
  assert.equal(await tid('artifact-review-dedup-frozen').count(), 0);
  assert.match(await tid('artifact-review-duplicate-decisions').innerText(), /3 项/u);
});

test('archived or frozen corpus remains readable with exact endpoints but no save/revision/freeze controls', async () => {
  const f = await fixture();
  f.dedup.save(f.save(0, 4, 'pre-archive'), {kind: 'user', id: 'synthetic-human'});
  f.dedup.freeze(f.freeze(), {kind: 'user', id: 'synthetic-human'});
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  const unchanged = f.changes(); await mount(f, false); await select(f);
  assert.equal(await tid('artifact-review-duplicate-save').count(), 0);
  assert.equal(await tid('artifact-review-duplicate-revise').count(), 0);
  assert.equal(await tid('artifact-review-dedup-freeze').count(), 0);
  assert.match(await tid('artifact-review-duplicate-current').innerText(), /同一报告/u);
  assert.equal(f.changes(), unchanged);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(860, 650));
  await audit('archived-dark-narrow');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1100, 900));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});

test('missing marked freeze receipt renders integrity error and cannot reopen a fresh mutable review', async () => {
  const f = await fixture(); f.dedup.freeze(f.freeze(), {kind: 'user', id: 'synthetic-human'});
  f.db.prepare('DELETE FROM research_review_deduplication_freezes WHERE corpus_id=?').run(f.corpus.snapshot.id);
  const unchanged = f.changes(); await mount(f);
  await tid('artifact-review-dedup').getByRole('alert').filter({hasText: '校验失败'}).waitFor();
  assert.equal(await tid('artifact-review-dedup-freeze').count(), 0);
  assert.equal(await tid('artifact-review-duplicate-editor').count(), 0);
  assert.equal(f.changes(), unchanged);
});
