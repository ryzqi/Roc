import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {reviewProtocolBodyFixture} from '../unit/fixtures/research-review-protocol.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7a-ui');
const methods = {
  listReviewProtocols: 'roc:research:review-protocol-list',
  getReviewProtocol: 'roc:research:review-protocol-get',
  getReviewProtocolHistory: 'roc:research:review-protocol-history',
  saveReviewProtocol: 'roc:research:review-protocol-save',
  freezeReviewProtocol: 'roc:research:review-protocol-freeze',
  listReviewSearches: 'roc:research:review-search-list',
  listReviewCorpora: 'roc:research:review-corpus-list'
};
const tid = id => page.getByTestId(id);
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-protocol-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(methods))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({initialRequest,writable}) {
      const [request,setRequest]=useState(initialRequest);
      const [open,setOpen]=useState(true);
      const [reviewDrafts]=useState(()=>new Map());
      const [readingLocations]=useState(()=>new Map());
      window.selectReview=next=>flushSync(()=>{setRequest(next);setOpen(true);});
      return <main><button data-testid="literature-review-inspect" onClick={()=>setOpen(true)}>综述核查</button>
        {!open?null:<ArtifactInspector key={JSON.stringify(request)} client={client} writable={writable}
          selection={{kind:'review',request}} readingLocations={readingLocations} reviewDrafts={reviewDrafts}
          onClose={()=>setOpen(false)} onOpenTask={()=>{throw Error('review has no stage artifact task');}}/>}
      </main>;
    }
    let generation=0;
    window.mount=(initialRequest,writable=true)=>flushSync(()=>root.render(
      <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
        <Harness key={++generation} initialRequest={initialRequest} writable={writable}/>
      </LazyMotion></MotionConfig>));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{padding:16px}'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active;
    calls.push({method, input});
    api.parseIpcRequestArgs(methods[method], [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
    if (method === f.deferWrite) {
      return new Promise(resolve => {f.releaseWrite = () => resolve(result); f.writeStarted();});
    }
    if (method === 'getReviewProtocol' && f.deferRead) {
      return new Promise(resolve => {f.releaseRead = () => resolve(result); f.readStarted();});
    }
    if (method === f.loseReply) {
      f.loseReply = null;
      assert.equal(result.ok, true);
      return {ok: false, error: {message: 'Synthetic reply lost after actual commit'}};
    }
    return result;
  });
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {
    fixtures.forEach(f => f.close()); api?.dispose();
    if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
function fixture() {
  const f = createResearchFixture(api, 'reading');
  const registry = new api.CapabilityRegistry();
  for (const descriptor of api.researchSystematicReviewCapabilities) registry.declare('research', descriptor);
  api.registerResearchSystematicReviewCapabilities({pluginId: 'research', capabilities: registry}, f.repository.systematicReviews);
  f.reviews = new api.ResearchReviewSearchService(f.db, f.repository,
    {search: async () => {throw new Error('unexpected_search_in_protocol_test');}}, error => {throw error;});
  const corpora = new api.ResearchReviewCorpusRepository(f.db, f.repository, f.reviews);
  for (const descriptor of [...api.researchReviewSearchCapabilities, ...api.researchReviewCorpusCapabilities]) registry.declare('research', descriptor);
  api.registerResearchReviewSearchCapabilities({pluginId: 'research', capabilities: registry}, f.reviews);
  api.registerResearchReviewCorpusCapabilities({pluginId: 'research', capabilities: registry}, corpora);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.save = (body = reviewProtocolBodyFixture(), prior = null) => f.repository.systematicReviews.save({
    projectId: f.project.id, requestId: crypto.randomUUID(), protocolId: prior?.version.protocolId ?? null,
    expectedVersionId: prior?.version.id ?? null, expectedVersionHash: prior?.versionHash ?? null,
    body, deviationReason: prior === null ? null : 'Independent synthetic method revision'
  }, {kind: 'user', id: 'independent-engineering-reviewer'});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  fixtures.push(f); return f;
}
async function mount(f, versionId = null, writable = true) {
  active = f;
  await page.evaluate(({projectId, versionId, writable}) => window.mount({mode: 'manage', projectId, versionId}, writable),
    {projectId: f.project.id, versionId, writable});
  await tid('artifact-review').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-review-refresh"]').disabled);
}
async function fillNew() {
  await tid('artifact-review-new').click();
  const body = reviewProtocolBodyFixture();
  await page.getByLabel('研究问题', {exact: true}).fill(body.question);
  await page.getByLabel('纳入标准 1', {exact: true}).fill(body.inclusionCriteria[0].text);
  await page.getByLabel('排除标准 1', {exact: true}).fill(body.exclusionCriteria[0].text);
  await page.getByLabel('发表起始年', {exact: true}).fill('2020');
  await page.getByLabel('发表截止年', {exact: true}).fill('2026');
  await page.getByLabel('检索式 1', {exact: true}).fill(body.databases[0].queries[0]);
  await page.getByLabel('每页记录数', {exact: true}).fill('5');
  await page.getByLabel('标题摘要审核人数', {exact: true}).selectOption('2');
  await page.getByLabel('全文审核人数', {exact: true}).selectOption('2');
  await page.getByLabel('研究设计 1', {exact: true}).fill(body.qualityAssessment[0].studyDesign);
  await page.getByLabel('评价框架 1', {exact: true}).fill(body.qualityAssessment[0].framework);
  await page.getByLabel('框架版本 1', {exact: true}).fill('1');
  await page.getByLabel('字段名称 1', {exact: true}).fill(body.extractionFields[0].label);
  await page.getByLabel('字段单位 1', {exact: true}).fill('mg/L');
}
async function audit(label) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="artifact-inspector-panel"]');
    return panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(panel).transform === 'none';
  });
  const source = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const result = await page.evaluate(`(${source})({root:'body',viewport:true})`);
  writeFileSync(join(artifacts, `${label}-audit.json`), JSON.stringify(result, null, 2));
  assert.equal(result.cut, 0);
  const geometry = await tid('artifact-inspector-panel').evaluate(element => ({
    width: element.getBoundingClientRect().width, viewport: window.innerWidth,
    left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
    overflow: element.scrollWidth - element.clientWidth
  }));
  assert.ok(geometry.width <= geometry.viewport);
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport);
  assert.equal(geometry.overflow, 0);
  await page.screenshot({path: join(artifacts, `${label}.png`)});
}

test('real main bridge saves structured scope, freezes human review and restores exact receipts without writes', async () => {
  const f = fixture(); await mount(f); await fillNew();
  const beforeSave = calls.length;
  await page.getByLabel('研究问题', {exact: true}).focus();
  await page.keyboard.press('Enter');
  assert.equal(calls.slice(beforeSave).filter(call => call.method === 'saveReviewProtocol').length, 0);
  await tid('artifact-review-save').click();
  await tid('artifact-review-freeze-form').waitFor();
  const saved = f.repository.systematicReviews.list({projectId: f.project.id, limit: 100})[0];
  assert.equal(saved.version.actor.id, `window:${windowId}`);
  assert.equal(saved.version.body.question, reviewProtocolBodyFixture().question);
  assert.equal(saved.version.body.extractionFields[0].unit, 'mg/L');
  assert.equal(saved.version.body.screening.titleAbstractReviewers, 2);
  assert.equal(saved.freeze, null);
  assert.equal(await tid('artifact-review-freeze').isDisabled(), true);
  await page.getByLabel('人工审核说明', {exact: true}).fill('Synthetic human reviewed all declared scope and methods');
  await tid('artifact-review-freeze').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-protocol-state"]')?.textContent.includes('已冻结'));
  const frozen = f.repository.systematicReviews.get({projectId: f.project.id, versionId: saved.version.id});
  assert.equal(frozen.freeze.actor.id, `window:${windowId}`);
  const unchanged = f.changes();
  await mount(f, saved.version.id);
  assert.equal(await page.getByLabel('研究问题', {exact: true}).inputValue(), frozen.version.body.question);
  assert.equal(await page.getByLabel('研究问题', {exact: true}).isDisabled(), true);
  assert.equal(f.changes(), unchanged);
  await audit('frozen-light');
});

test('lost save/freeze replies retry the exact original requests and do not append duplicate receipts', async () => {
  const f = fixture(); await mount(f); await fillNew();
  f.loseReply = 'saveReviewProtocol';
  const start = calls.length;
  await tid('artifact-review-save').click();
  await page.getByRole('alert').filter({hasText: 'reply lost'}).waitFor();
  await tid('artifact-review-save').click();
  await tid('artifact-review-freeze-form').waitFor();
  const saves = calls.slice(start).filter(call => call.method === 'saveReviewProtocol');
  assert.equal(saves.length, 2); assert.deepEqual(saves[1].input, saves[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_protocol_versions').pluck().get(), 1);
  f.loseReply = 'freezeReviewProtocol';
  await page.getByLabel('人工审核说明', {exact: true}).fill('Synthetic exact reply retry review');
  await tid('artifact-review-freeze').click();
  await page.getByRole('alert').filter({hasText: 'reply lost'}).waitFor();
  await tid('artifact-review-freeze').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-protocol-state"]')?.textContent.includes('已冻结'));
  const freezes = calls.slice(start).filter(call => call.method === 'freezeReviewProtocol');
  assert.equal(freezes.length, 2); assert.deepEqual(freezes[1].input, freezes[0].input);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_protocol_freezes').pluck().get(), 1);
});

test('window-local draft survives close/reopen; invalid years refuse before any write; native Escape restores opener focus', async () => {
  const f = fixture(); await mount(f); await fillNew();
  await page.getByLabel('发表起始年', {exact: true}).fill('2027');
  await tid('artifact-review-save').click();
  await page.getByRole('alert').filter({hasText: 'review_publication_window_invalid'}).waitFor();
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_protocol_versions').pluck().get(), 0);
  await page.keyboard.press('Escape');
  await tid('artifact-review').waitFor({state: 'hidden'});
  await tid('literature-review-inspect').focus();
  await page.keyboard.press('Enter');
  await tid('artifact-review-new').click();
  assert.equal(await page.getByLabel('研究问题', {exact: true}).inputValue(), reviewProtocolBodyFixture().question);
  assert.equal(await page.getByLabel('发表起始年', {exact: true}).inputValue(), '2027');
  await page.keyboard.press('Escape');
  await tid('artifact-review').waitFor({state: 'hidden'});
  assert.equal(await tid('literature-review-inspect').evaluate(element => element === document.activeElement), true);
});

test('revision creates an immutable successor and old frozen scope remains readonly in history', async () => {
  const f = fixture(), first = f.save();
  const frozen = f.repository.systematicReviews.freeze({projectId: f.project.id, requestId: 'synthetic-freeze',
    versionId: first.version.id, expectedVersionHash: first.versionHash, reviewNote: 'Original synthetic scope reviewed'}, {kind: 'user', id: 'original-reviewer'});
  await mount(f, first.version.id);
  await tid('artifact-review-revise').click();
  await page.getByLabel('研究问题', {exact: true}).fill('Explicit changed synthetic review question');
  await page.getByLabel('修订原因', {exact: true}).fill('Synthetic broadened scope after search planning');
  await tid('artifact-review-save').click();
  await tid('artifact-review-freeze-form').waitFor();
  const history = f.repository.systematicReviews.history({projectId: f.project.id, protocolId: first.version.protocolId});
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], {...frozen, isLatest: false});
  assert.equal(history[1].version.parentVersionHash, first.versionHash);
  assert.equal(history[1].freeze, null);
  await tid('artifact-review-history-version').filter({hasText: '版本 1'}).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-protocol-state"]')?.textContent.includes('历史版本'));
  assert.equal(await page.getByLabel('研究问题', {exact: true}).inputValue(), first.version.body.question);
  assert.equal(await tid('artifact-review-revise').count(), 0);
  assert.equal(await tid('artifact-review-freeze').count(), 0);
});

test('concurrent parent revision remains authoritative; failed stale write keeps explicit draft and readonly refresh', async () => {
  const f = fixture(), first = f.save(); await mount(f, first.version.id);
  await tid('artifact-review-revise').click();
  await page.getByLabel('研究问题', {exact: true}).fill('Uncommitted conflicting question');
  await page.getByLabel('修订原因', {exact: true}).fill('Synthetic stale edit');
  const second = f.save({...first.version.body, question: 'Independently saved authoritative scope'}, first);
  const unchanged = f.changes();
  await tid('artifact-review-save').click();
  await page.getByRole('alert').filter({hasText: '状态已变化'}).waitFor();
  assert.equal(f.changes(), unchanged);
  assert.equal(await page.getByLabel('研究问题', {exact: true}).inputValue(), 'Uncommitted conflicting question');
  await tid('artifact-review-refresh').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review-protocol-state"]')?.textContent.includes('历史版本'));
  assert.equal(await page.getByLabel('研究问题', {exact: true}).inputValue(), first.version.body.question);
  assert.equal(await tid('artifact-review-save').count(), 0);
  assert.equal(f.repository.systematicReviews.list({projectId: f.project.id, limit: 100})[0].version.id, second.version.id);
});

test('archived scope shows actual fixed data and no human write controls', async () => {
  const f = fixture(), saved = f.save();
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  const unchanged = f.changes(); await mount(f, saved.version.id, false);
  assert.equal(await tid('artifact-review-new').isDisabled(), true);
  assert.equal(await tid('artifact-review-revise').count(), 0);
  assert.equal(await tid('artifact-review-freeze').count(), 0);
  assert.equal(await page.getByLabel('研究问题', {exact: true}).isDisabled(), true);
  assert.equal(f.changes(), unchanged);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(860, 650));
  await audit('archived-narrow-dark');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1100, 900));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});

test('late exact-version response from another project cannot replace selected scope or publish its form', async () => {
  const old = fixture(), saved = old.save(), next = fixture();
  const readStarted = new Promise(resolve => {old.readStarted = resolve;});
  active = old; old.deferRead = true;
  await page.evaluate(request => window.mount(request), {mode: 'manage', projectId: old.project.id, versionId: saved.version.id});
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review"]')?.textContent.includes('正在读取协议版本'));
  await readStarted;
  assert.ok(old.releaseRead);
  active = next;
  await page.evaluate(request => window.selectReview(request), {projectId: next.project.id, versionId: null});
  old.deferRead = false; old.releaseRead();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review"]')?.textContent.includes('尚无综述协议'));
  assert.equal(await tid('artifact-review-protocol-editor').count(), 0);
  assert.equal(await tid('artifact-review').getByText(saved.version.body.question, {exact: true}).count(), 0);
  await tid('artifact-review-new').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('研究问题', {exact: true}).inputValue(), '');
  await audit('new-empty');
  await tid('artifact-review-save').hover();
  await audit('new-hover');
  await page.getByLabel('使用 PICO', {exact: true}).check();
  await page.getByLabel('研究人群', {exact: true}).fill('Synthetic population '.repeat(120));
  await audit('new-expanded-long');
});

test('pending real commit blocks closing, switching and resubmitting until its receipt arrives', async () => {
  const f = fixture(); await mount(f); await fillNew();
  const started = new Promise(resolve => {f.writeStarted = resolve;});
  f.deferWrite = 'saveReviewProtocol';
  const start = calls.length;
  await tid('artifact-review-save').click(); await started;
  assert.equal(await tid('artifact-review-save').isDisabled(), true);
  assert.equal(await tid('artifact-review-new').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await tid('artifact-review').isVisible(), true);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_review_protocol_versions').pluck().get(), 1);
  f.deferWrite = null; f.releaseWrite();
  await tid('artifact-review-freeze-form').waitFor();
  assert.equal(calls.slice(start).filter(call => call.method === 'saveReviewProtocol').length, 1);
});

test('marked frozen receipt loss renders an error and does not display it as an editable draft', async () => {
  const f = fixture(), saved = f.save();
  f.repository.systematicReviews.freeze({projectId: f.project.id, requestId: 'lost-receipt',
    versionId: saved.version.id, expectedVersionHash: saved.versionHash, reviewNote: 'Explicit synthetic frozen scope'},
  {kind: 'user', id: 'synthetic-human'});
  f.db.prepare('DELETE FROM research_review_protocol_freezes WHERE version_id=?').run(saved.version.id);
  const unchanged = f.changes(); await mount(f, saved.version.id);
  await page.getByRole('alert').filter({hasText: '校验失败'}).first().waitFor();
  assert.equal(await tid('artifact-review-protocol-editor').count(), 0);
  assert.equal(await tid('artifact-review-draft-status').count(), 0);
  assert.equal(f.changes(), unchanged);
});
