import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {ideaCanvasContentFixture, ideaPlanBodyFixture} from '../unit/fixtures/research-idea-plan.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], calls = [], errors = [];
const artifacts = resolve('.artifacts/research-optimization/xidea-a2-ui');
const routes = {
  inspectArtifact: ['roc:research:artifact-inspect', 'research.inspectArtifact'],
  getGateReviewContext: ['roc:research:gate-review', 'research.getGateReviewContext'],
  saveIdeaPlan: ['roc:research:idea-plan-save', 'research.saveIdeaPlan'],
  freezeIdeaPlan: ['roc:research:idea-plan-freeze', 'research.freezeIdeaPlan'],
  getIdeaPlan: ['roc:research:idea-plan-get', 'research.getIdeaPlan'],
  getIdeaPlanHistory: ['roc:research:idea-plan-history', 'research.getIdeaPlanHistory']
};
before(async () => {
  api = await loadResearchTestApi();
  directory = await mkdtemp(join(tmpdir(), 'roc-idea-plan-ui-'));
  await mkdir(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {StageArtifactInspector} from './src/renderer/artifacts/StageArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(routes))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({request,writable}) {
      const [open,setOpen]=useState(true),[locations]=useState(()=>new Map());
      return <main><button id="opener" onClick={()=>setOpen(true)}>打开构思工件</button>
        {open?<StageArtifactInspector client={client} request={request} writable={writable} readingLocations={locations}
          onClose={()=>setOpen(false)} onOpenTask={()=>setOpen(false)} onReviewContext={value=>window.returnedReview=value}/>:null}</main>;
    }
    let generation=0;
    window.mount=(request,writable=true)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} request={request} writable={writable}/></LazyMotion></MotionConfig>));
    window.clear=()=>flushSync(()=>root.render(null));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}#opener{margin:16px}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    calls.push({method, input}); api.parseIpcRequestArgs(routes[method][0], [input]);
    const scene = active;
    const result = await scene.bridge.invoke(routes[method][1], [input], windowId);
    if (scene.loseReply === method) {
      delete scene.loseReply; assert.equal(result.ok, true);
      return {ok: false, error: {code: 'fixture_reply_lost', category: 'degraded', message: '连接中断，已写入回执未送达。', retryable: true}};
    }
    if (scene.defer === method) return new Promise(done => {scene.finish = () => done(result);});
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => {
  try {await app?.close(); for (const f of fixtures) f.close(); api?.dispose();}
  finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
function fixture() {
  const f = createResearchFixture(api, 'ideation'); fixtures.push(f);
  const run = f.repository.runs.complete(f.run.id, f.project.id, {
    title: 'Testable hypothesis', markdown: 'Saved synthetic Canvas', claims: [], sections: [], verdict: 'uncertain',
    ideaCanvas: ideaCanvasContentFixture()
  });
  f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'ideation', action: 'complete'});
  const artifactId = run.outputArtifactIds[0], canvas = f.repository.ideas.get(artifactId), handlers = new Map();
  const context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchIdeaPlanCapabilities(context, f.repository.ideaPlans);
  const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, request) => handlers.get(name)(request)});
  const save = (body, parent = null, id = 'direct') => api.withResearchHumanContext({
    capability: 'research.ideaPlans.save', projectId: f.project.id, windowId
  }, () => f.repository.ideaPlans.save({projectId: f.project.id, artifactId, requestId: id,
    canvas: {version: canvas.version, contentHash: canvas.contentHash},
    parent: parent === null ? null : {versionId: parent.version.id, versionHash: parent.versionHash},
    revisionReason: parent === null ? null : `Explicit revision ${id}`, body}));
  return {...f, artifactId, canvas, bridge, save};
}
async function scene(f = fixture(), writable = true) {
  active = f; calls.length = 0;
  await page.evaluate(({request, writable}) => mount(request, writable), {
    request: {projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null}, writable
  });
  await page.getByTestId('artifact-idea-plans').waitFor();
  return f;
}
async function fillPlan() {
  const body = ideaPlanBodyFixture();
  for (const [label, value] of [
    ['可证伪条件', body.falsifiableIf], ['指标 1 ID', 'mean'], ['指标 1 名称', 'Latency mean'],
    ['指标 1 定义', body.metrics[0].definition], ['指标 1 单位', 'ms'], ['指标 1 预期结果', body.metrics[0].expectedOutcome],
    ['数据计划', body.dataPlan], ['实验设计', body.design], ['分析计划', body.analysisPlan],
    ['新颖性检索范围', body.novelty.searchScope], ['未计算原因', body.sampleSize.reason]
  ]) await page.getByLabel(label, {exact: true}).fill(value);
  await page.getByLabel('指标 1 方向', {exact: true}).selectOption('lower');
  await page.getByLabel('观察时序声明', {exact: true}).selectOption('before_data');
}
async function enter(id) {await page.getByTestId(id).focus(); await page.keyboard.press('Enter');}
async function receiptVersion(version) {
  await expect(page.getByTestId('artifact-idea-plan-receipt').first().locator('dd').nth(1)).toHaveText(String(version));
}
const history = f => f.repository.ideaPlans.history({projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 100});
const changes = f => f.db.prepare('SELECT total_changes()').pluck().get();

test('keyboard plan editing locks real drawer, preserves lost save/freeze replies and invalidates exact human review versions', async () => {
  const f = await scene();
  assert.deepEqual(calls.map(call => call.method), ['inspectArtifact']);
  const gate = f.repository.readGateReviewContext({projectId: f.project.id, expectedStage: 'ideation', artifactId: f.artifactId});
  await fillPlan();
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), true);
  await page.keyboard.press('Escape'); await expect(page.getByTestId('artifact-inspector')).toBeVisible();
  f.loseReply = 'saveIdeaPlan';
  await enter('artifact-idea-plan-save');
  await page.getByRole('alert').filter({hasText: '连接中断'}).waitFor();
  const saved = history(f).items[0], saveChanges = changes(f);
  assert.equal(saved.version.actor.id, `window:${windowId}`);
  assert.deepEqual(saved.version.request.body, ideaPlanBodyFixture());
  await enter('artifact-idea-plan-save'); await receiptVersion(1);
  assert.equal(changes(f), saveChanges);
  const saves = calls.filter(call => call.method === 'saveIdeaPlan');
  assert.deepEqual(saves[0].input, saves[1].input);
  assert.throws(() => f.repository.assertArtifactReview({projectId: f.project.id, expectedStage: 'ideation',
    expectedArtifactVersions: gate.artifactLinks.map(link => ({artifactId: link.artifactId, version: link.expectedVersion}))}),
  /research_artifact_review_changed/u);
  await page.getByLabel('计划冻结审核说明', {exact: true}).fill('Reviewed all predictions and explicit uncalculated power.');
  f.loseReply = 'freezeIdeaPlan'; await enter('artifact-idea-plan-freeze');
  await page.getByRole('alert').filter({hasText: '连接中断'}).waitFor();
  const frozenChanges = changes(f);
  await enter('artifact-idea-plan-freeze');
  await expect(page.getByTestId('artifact-idea-plan-receipt').first()).toContainText('已冻结');
  assert.equal(changes(f), frozenChanges);
  const freezes = calls.filter(call => call.method === 'freezeIdeaPlan');
  assert.deepEqual(freezes[0].input, freezes[1].input);
  assert.equal(history(f).items[0].freeze.actor.id, `window:${windowId}`);
  await enter('artifact-idea-plan-revise');
  await page.getByLabel('分析计划', {exact: true}).fill('An explicitly revised method');
  await page.getByLabel('计划修订原因', {exact: true}).fill('Before observing new data');
  f.defer = 'saveIdeaPlan';
  await enter('artifact-idea-plan-save');
  await expect(page.getByTestId('artifact-idea-plan-save')).toBeDisabled();
  await expect(page.getByLabel('分析计划', {exact: true})).toBeDisabled();
  await page.getByTestId('artifact-inspector-close').click();
  await expect(page.getByTestId('artifact-inspector')).toBeVisible();
  assert.equal(history(f).total, 2);
  assert.deepEqual(history(f).items[1].version, saved.version);
  f.finish(); delete f.defer; await receiptVersion(2);
  await page.keyboard.press('Escape'); await expect(page.getByTestId('artifact-inspector')).toHaveCount(0);
});

test('post-observation revision retains negative evidence, audited power and unchanged frozen predictions; reverting timing is refused', async () => {
  const f = fixture(), first = f.save(ideaPlanBodyFixture());
  api.withResearchHumanContext({capability: 'research.ideaPlans.freeze', projectId: f.project.id, windowId},
    () => f.repository.ideaPlans.freeze({projectId: f.project.id, artifactId: f.artifactId, versionId: first.version.id,
      expectedHash: first.versionHash, requestId: 'freeze-direct', reviewNote: 'Frozen expectations'}));
  f.repository.knowledge.upsertFromSource({id: 'negative', projectId: f.project.id, sourceType: 'file', sourceId: 'negative.txt',
    title: 'Synthetic contradictory observation', content: 'Observed increase +2 ms',
    chunks: [{content: 'Observed increase +2 ms', locator: 'line:1'}], embeddingPolicy: 'none'});
  const evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'negative:chunk:0'});
  await scene(f); await enter('artifact-idea-plan-revise');
  await page.getByLabel('观察时序声明', {exact: true}).selectOption('after_data');
  await page.getByLabel('已观察证据 ID（逗号分隔）', {exact: true}).fill(evidence.id);
  await page.getByLabel('样本量与功效', {exact: true}).selectOption('calculated');
  await page.getByLabel('样本量计算方法', {exact: true}).fill('Recorded synthetic calculation only');
  await page.getByLabel('计算参数（每行名称=值）', {exact: true}).fill('alpha=0.05\npower=0.8');
  await page.getByLabel('已审核样本量', {exact: true}).fill('20');
  await page.getByLabel('功效计算证据 ID（逗号分隔）', {exact: true}).fill(evidence.id);
  await page.getByLabel('功效计算审核说明', {exact: true}).fill('Human reviewed assumptions of synthetic formula');
  await page.getByLabel('计划修订原因', {exact: true}).fill('Preserve contradictory observation and amend the analysis');
  await enter('artifact-idea-plan-save'); await receiptVersion(2);
  const second = history(f).items[0];
  assert.deepEqual(second.version.request.body.sampleSize.parameters, {alpha: '0.05', power: '0.8'});
  assert.deepEqual(second.version.request.body.metrics, first.version.request.body.metrics);
  await expect(page.getByText('Synthetic contradictory observation', {exact: false}).first()).toBeVisible();
  await enter('artifact-idea-plan-revise');
  await page.getByLabel('观察时序声明', {exact: true}).selectOption('before_data');
  await page.getByLabel('计划修订原因', {exact: true}).fill('Attempt to erase observation timing');
  await enter('artifact-idea-plan-save');
  await page.getByRole('alert').filter({hasText: '不能改为观察数据前'}).waitFor();
  assert.equal(history(f).total, 2);
  await enter('artifact-idea-plan-discard');
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), false);
});

test('paged exact history survives disk restart and archive; old scope cannot display a late history response', async () => {
  const f = fixture(); let latest = null;
  for (let i = 0; i < 12; i++) latest = f.save({...ideaPlanBodyFixture(), analysisPlan: `Explicit method ${i + 1}`}, latest, `version-${i + 1}`);
  const database = join(directory, 'history.sqlite'); await f.db.backup(database);
  const disk = new Database(database); disk.pragma('foreign_keys=ON');
  try {
    api.applyResearchDatabaseSchema(disk);
    const repository = new api.ResearchRepository(disk, f.tasks), before = disk.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(repository.ideaPlans.history({projectId: f.project.id, artifactId: f.artifactId, offset: 10, limit: 10}).items,
      history(f).items.slice(10));
    assert.equal(disk.prepare('SELECT total_changes()').pluck().get(), before);
  } finally {disk.close();}
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await scene(f);
  assert.equal(await page.getByTestId('artifact-idea-plan-revise').count(), 0);
  await enter('artifact-idea-plan-history');
  await expect(page.getByTestId('artifact-idea-plan-history-select')).toHaveCount(10);
  await page.getByRole('button', {name: '下一页计划', exact: true}).click();
  await expect(page.getByTestId('artifact-idea-plan-history-select')).toHaveCount(2);
  await page.getByTestId('artifact-idea-plan-history-select').last().focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('artifact-idea-plan-history-receipt')).toContainText('历史版本');
  assert.equal(calls.filter(call => call.method === 'getIdeaPlan').at(-1).input.expectedHash, history(f).items.at(-1).versionHash);
  f.defer = 'getIdeaPlanHistory';
  await page.getByRole('button', {name: '上一页计划', exact: true}).click();
  await page.getByText('正在读取计划历史…', {exact: true}).waitFor();
  const other = fixture(); await scene(other); f.finish(); delete f.defer;
  await expect(page.getByTestId('artifact-idea-plan-form')).toBeVisible();
  assert.equal(await page.getByTestId('artifact-idea-plan-history-list').count(), 0);
});

test('real narrow drawer in light/dark and reduced motion preserves focus, visible controls and unclipped shadows', async () => {
  const f = await scene();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(650, 900));
  await page.emulateMedia({reducedMotion: 'reduce'}); await fillPlan();
  const auditSource = await readFile(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8'), audits = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.getByLabel('可证伪条件', {exact: true}).focus();
    await page.getByLabel('可证伪条件', {exact: true}).scrollIntoViewIfNeeded();
    await expect(page.getByLabel('可证伪条件', {exact: true})).toBeFocused();
    assert.equal(await page.getByLabel('可证伪条件', {exact: true}).evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    const runAudit = async state => {
      const result = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      audits.push({theme, state, ...result});
      await writeFile(join(artifacts, 'audits.json'), JSON.stringify(audits, null, 2));
      assert.equal(result.cut, 0);
      const panelPath = await page.getByTestId('artifact-inspector-panel').evaluate(element => {
        const parts = [];
        for (let item = element; item && item !== document.body && parts.length < 4; item = item.parentElement) {
          parts.unshift(`${item.tagName.toLowerCase()}${[...item.classList].slice(0, 3).map(name => `.${name}`).join('')}`);
        }
        return parts.join(' > ');
      });
      assert.equal(result.hidden, 3);
      assert.deepEqual(result.issues.map(issue => [issue.el, issue.kind, issue.side, issue.level, issue.gap, issue.why]).sort(),
        ['bottom', 'right', 'top'].map(side => [panelPath, 'box-shadow', side, 'hidden', 0, 'overflow:hidden']).sort());
    };
    await runAudit('editing');
    await page.getByTestId('artifact-idea-plan-save').hover(); await runAudit('hover');
    const summary = page.locator('[data-reading-key="raw-snapshot-summary"]');
    await summary.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('[data-reading-key="raw-snapshot"] pre')).toBeVisible();
    await runAudit('expanded');
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.getByLabel('可证伪条件', {exact: true}).scrollIntoViewIfNeeded();
    await page.getByLabel('可证伪条件', {exact: true}).focus();
    await page.screenshot({path: join(artifacts, `${theme}-plan.png`)});
  }
  await writeFile(join(artifacts, 'audits.json'), JSON.stringify(audits, null, 2));
  assert.equal(history(f).total, 0);
});
