import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {unknownExperiment, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createPublishedFigureFixture} from '../unit/fixtures/research-production-test-kit.mjs';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let api, directory, app, page, active;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/figure-consistency-ui');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-figure-consistency-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const methods=['inspectArtifact','inspectFigureConsistency','saveFigureConsistencyReview','getFigureConsistencyHistory','getExperimentResultEvidence','getGateReviewContext'];
    const client={api:{research:Object.fromEntries(methods.map(method=>[method,input=>window.fromMain(method,input)]))}};
    function Harness({initial}) {
      const [request,setRequest]=useState(initial),[writable,setWritable]=useState(true);
      const [locations]=useState(()=>new Map()),[drafts]=useState(()=>new Map());
      window.setWritable=value=>flushSync(()=>setWritable(value));
      return <main>{request===null?null:<ArtifactInspector key={JSON.stringify(request)} client={client}
        selection={{kind:'stage',request,onReviewContext:()=>{}}} writable={writable}
        readingLocations={locations} reviewDrafts={drafts} onClose={()=>setRequest(null)} onOpenTask={()=>{}}/>}</main>;
    }
    let generation=0;
    window.mount=input=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initial={input}/></LazyMotion></MotionConfig>));
    window.unmount=()=>flushSync(()=>root.render(null));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fromMain', async (method, input) => {
    const f = active;
    calls.push({method, input});
    const channel = {inspectArtifact: 'roc:research:artifact-inspect', inspectFigureConsistency: 'roc:research:figure-consistency-inspect',
      saveFigureConsistencyReview: 'roc:research:figure-consistency-save', getFigureConsistencyHistory: 'roc:research:figure-consistency-history',
      getExperimentResultEvidence: 'roc:research:experiment-result-evidence-get', getGateReviewContext: 'roc:research:gate-review'}[method];
    api.parseIpcRequestArgs(channel, [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], 73);
    const hold = f.holds.get(method);
    if (hold !== undefined) return new Promise(resolve => {
      hold.release = () => resolve(hold.loseReply ? {ok: false, error: {code: 'fixture_reply_lost', message: '数值审核回执连接中断'}} : result);
      hold.ready.resolve();
    });
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => {
  if (page !== undefined && !page.isClosed()) await page.evaluate(() => window.unmount?.());
  try {await app?.close();} finally {
    for (const f of fixtures) await f.dispose(); api?.dispose();
    if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

const rule = () => ({conversion: {kind: 'identity'}, rounding: {kind: 'none'}, tolerance: {absolute: 0, relative: 0, rationale: 'Exact stored synthetic measurement'}});
async function scene({long = false, many = false} = {}) {
  const figureSource = JSON.parse(readFileSync('tests/fixtures/research-workflow/figure.vl.json', 'utf8'));
  if (many) figureSource.data.values = Array.from({length: 22}, (_, index) => ({group: `Group ${index + 1}`, mean: index + 2}));
  const f = await createPublishedFigureFixture(api, {figureSource}); fixtures.push(f); active = f; calls.length = 0; f.holds = new Map();
  try {
    f.openRevision = () => f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'figure', action: 'reject',
      expectedArtifactVersions: f.repository.getWorkflow(f.project.id).stages.find(stage => stage.stage === 'figure').artifactIds.map(artifactId => ({
        artifactId, version: f.repository.inspectArtifact({projectId: f.project.id, artifactId, expectedVersion: null}).snapshot.version
      }))});
    f.openRevision();
    const run = f.repository.experiments.create({projectId: f.project.id, ownerRunId: null, requestId: 'measurement',
      label: 'Synthetic stored measurement; not executed', engine: 'typescript', sourceVersion: 1, sourcePath: 'analysis.mts',
      inputPaths: [], parameters: {}, runtime: {kind: 'bundled-node'}, timeoutMs: 1000, network: 'disabled'},
    f.project.workspacePath, f.project.workspacePath, '/tmp/roc-synthetic-results');
    const unavailable = {kind: 'unavailable', reason: 'Synthetic contract fixture'};
    const snapshot = {schemaVersion: 1, id: 'figure-result', request: {
      projectId: f.project.id, requestId: 'reviewed-result', runId: run.id, expectedInputHash: 'a'.repeat(64),
      resultPath: 'metrics.json', expectedResultHash: 'b'.repeat(64),
      definitions: [{id: 'mean', label: 'Mean', definition: 'Synthetic mean', unit: 'ms', direction: 'lower'}],
      method: {name: 'Mean', rationale: 'Synthetic sample', assumptions: 'Synthetic', limitations: 'No scientific inference'}},
    actor: {kind: 'user', id: 'window:90'}, recordedAt: '2026-11-03T00:00:00.000Z',
    result: {schemaVersion: 1, metrics: [{id: 'mean', value: 2, unit: 'ms', sampleSize: 3,
      uncertainty: unavailable, confidenceInterval: unavailable, effect: unavailable}]},
    execution: {runId: run.id, inputHash: 'a'.repeat(64), engine: 'typescript', environmentHash: 'c'.repeat(64),
      source: {area: 'input', path: 'analysis.mts', sha256: 'd'.repeat(64), size: 5},
      output: {area: 'output', path: 'metrics.json', sha256: 'b'.repeat(64), size: 10}, inputs: [],
      parameters: {}, arguments: [], seed: null}};
    f.result = f.repository.experimentResults.save({snapshot, snapshotHash: hash(snapshot)});
    f.evidence = f.repository.experimentResults.captureMetric(f.result, 'mean');
    const claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
    f.claim = f.repository.evidence.updateClaim({experiment: {...unknownExperiment}, id: claim.id, expectedVersion: claim.version,
      content: long ? '图稿指标、单位、来源与场景位置逐项核对。'.repeat(35) : 'Synthetic figure maps an actual post-transform bar datum to a stored metric.',
      status: 'supported', evidenceIds: [f.evidence.id]});
    f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'figure', action: 'complete'});
    f.tracePath = join(f.repository.figureRuns.root(f.project.id, f.productionRun.id), 'output', 'figure-data.json');
    f.trace = JSON.parse(await readFile(f.tracePath, 'utf8'));
    f.mark = f.trace.marks.find(mark => mark.directFields.y === 'mean_end');
    assert.ok(f.mark, 'compiled stack endpoint is the actual y datum');
    f.binding = (item = f.mark.items[0]) => ({claimId: f.claim.id, expectedClaimHash: api.relationClaimHash(f.claim),
      markName: f.mark.name, channel: 'y', field: 'mean_end', scenePath: item.scenePath, unit: 'ms',
      evidenceId: f.evidence.id, resultId: f.result.snapshot.id, resultHash: f.result.snapshotHash, metricId: 'mean', rule: rule()});
    f.service = new api.ResearchFigureConsistencyService(f.repository, f.figureService,
      {evidence: async () => ({receipt: f.result, metricId: 'mean'})});
    f.inspect = (page = {markName: null, offset: 0, limit: 100}, expectedHash = null) =>
      f.service.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash, page});
    f.request = (overrides = {}) => ({projectId: f.project.id, artifactId: f.artifactId, requestId: 'mapping',
      expectedArtifactVersion: f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null}).snapshot.version,
      figure: {id: f.figureId, manifestHash: f.repository.figures.get(f.project.id, f.figureId).manifestHash, traceHash: hash(f.trace)},
      parent: null, rationale: 'Explicit mapping of compiled bar endpoint', bindings: [f.binding()], ...overrides});
    f.save = (request = f.request(), windowId = 73) => api.withResearchHumanContext({
      capability: 'research.figureConsistency.save', projectId: request.projectId, windowId}, () => f.service.save(request));
    f.history = (offset = 0, limit = 10) => f.repository.figureConsistency.history({
      projectId: f.project.id, artifactId: f.artifactId, offset, limit});
    f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
    const handlers = new Map();
    const context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
    api.registerResearchArtifactInspectorCapability(context, f.repository);
    api.registerResearchFigureConsistencyCapabilities(context, f.service, f.repository.figureConsistency);
    f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) =>
      name === 'research.experimentResults.evidence' ? Promise.resolve({receipt: f.result, metricId: 'mean'}) : handlers.get(name)(input)});
    f.selection = {projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null};
    f.hold = (method, loseReply = false) => {
      const value = {ready: Promise.withResolvers(), loseReply}; f.holds.set(method, value); return value;
    };
    await page.evaluate(request => mount(request), f.selection);
    await page.getByTestId('artifact-inspector-content').waitFor();
    return f;
  } catch (error) {await f.dispose(); throw error;}
}
const report = () => page.getByTestId('artifact-figure-consistency');
const editor = () => page.getByTestId('artifact-figure-consistency-editor');
const fields = () => page.getByTestId('artifact-figure-consistency-fields');
async function openReport() {
  await page.getByTestId('artifact-figure-consistency-toggle').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-figure-consistency-hash').waitFor();
}
async function selectMark(f) {
  await page.getByRole('combobox', {name: '场景标记', exact: true}).selectOption(f.mark.name);
  await page.getByTestId('artifact-figure-consistency-page').waitFor();
}
async function openEditor(f) {
  await page.getByTestId('artifact-figure-consistency-edit').click();
  await selectMark(f); await fields().waitFor();
}
async function fillMapping(f, {item = '0', unit = 'ms', conversion = 'identity', add = true} = {}) {
  await fields().getByRole('combobox', {name: '场景数据项', exact: true}).selectOption(item);
  await fields().getByRole('combobox', {name: '数据通道与字段', exact: true}).selectOption('y');
  await fields().getByRole('combobox', {name: '图稿指标主张', exact: true}).selectOption(f.claim.id);
  await fields().getByRole('combobox', {name: '图稿指标证据', exact: true}).selectOption(f.evidence.id);
  await fields().getByText('来源指标 mean：2 ms', {exact: true}).waitFor();
  await fields().getByRole('textbox', {name: '展示单位', exact: true}).fill(unit);
  await fields().getByRole('combobox', {name: '单位转换', exact: true}).selectOption(conversion);
  if (conversion === 'affine') {
    await fields().getByRole('spinbutton', {name: '转换比例', exact: true}).fill('0.001');
    await fields().getByRole('spinbutton', {name: '转换偏移', exact: true}).fill('0');
    await fields().getByRole('textbox', {name: '转换理由', exact: true}).fill('Milliseconds divided by one thousand.');
  }
  await fields().getByRole('combobox', {name: '舍入规则', exact: true}).selectOption('none');
  await fields().getByRole('spinbutton', {name: '绝对容差', exact: true}).fill('0');
  await fields().getByRole('spinbutton', {name: '相对容差', exact: true}).fill('0');
  await fields().getByRole('textbox', {name: '容差理由', exact: true}).fill('Exact explicit rule.');
  if (add) {
    await page.getByTestId('artifact-figure-consistency-add').click();
    await fields().getByRole('combobox', {name: '场景数据项', exact: true}).evaluate(element => {
      if (element.value !== '') throw new Error('candidate did not clear');
    });
    await editor().getByRole('textbox', {name: '图稿数据审核理由', exact: true}).fill('Human review of the actual compiled datum and synthetic stored metric.');
  }
}
async function declare(f, index, parent = null) {
  return f.save(f.request({requestId: `history-${index}`, parent: parent === null ? null : {
    reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash}, rationale: `Stored human revision ${index}`}));
}

test('opt-in actual figure drawer preserves mappings across pages and retries exact human save with dirty/pending close locks', async () => {
  const f = await scene({many: true});
  assert.equal(calls.filter(value => value.method === 'inspectFigureConsistency').length, 0);
  const before = f.changes(); await openReport(); assert.equal(f.changes(), before);
  await page.getByTestId('artifact-inspector-review').click(); await page.getByTestId('artifact-inspector-return-review').waitFor();
  await openEditor(f); await fillMapping(f, {add: false});
  for (const id of ['artifact-inspector-refresh', 'artifact-inspector-review', 'artifact-inspector-return-review',
    'artifact-consistency-toggle', 'artifact-figure-consistency-refresh', 'artifact-figure-consistency-toggle',
    'artifact-figure-consistency-history-open', 'artifact-figure-consistency-page-next']) {
    assert.equal(await page.getByTestId(id).isDisabled(), true, id);
  }
  assert.equal(await page.getByRole('combobox', {name: '场景标记', exact: true}).isDisabled(), true);
  await page.getByTestId('artifact-inspector-close').click();
  await page.getByTestId('artifact-draft-discard-panel').waitFor();
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await page.getByTestId('artifact-draft-discard-panel').waitFor({state:'detached'});
  await page.keyboard.press('Escape');
  await page.getByTestId('artifact-draft-discard-panel').waitFor();
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await page.getByTestId('artifact-draft-discard-panel').waitFor({state:'detached'});
  await page.getByTestId('artifact-inspector-scrim').click({position: {x: 5, y: 5}});
  await page.getByTestId('artifact-draft-discard-panel').waitFor();
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await page.getByTestId('artifact-draft-discard-panel').waitFor({state:'detached'});
  assert.equal(await fields().count(), 1);
  await fields().getByRole('spinbutton', {name: '绝对容差', exact: true}).fill('');
  await page.getByTestId('artifact-figure-consistency-add').click();
  assert.match(await fields().getByRole('alert').innerText(), /完整填写/u);
  assert.equal(calls.filter(value => value.method === 'saveFigureConsistencyReview').length, 0);
  await fields().getByRole('spinbutton', {name: '绝对容差', exact: true}).fill('0');
  await page.getByTestId('artifact-figure-consistency-add').click();
  await page.getByTestId('artifact-figure-consistency-page-next').click();
  await page.getByTestId('artifact-figure-consistency-page').getByText('场景数据 21–22，共 22 项', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('artifact-figure-consistency-draft-count').innerText(), '待保存图稿映射，共 1 项');
  await fillMapping(f);
  assert.equal(await page.getByTestId('artifact-figure-consistency-draft-count').innerText(), '待保存图稿映射，共 2 项');
  const hold = f.hold('saveFigureConsistencyReview', true);
  await page.getByTestId('artifact-figure-consistency-save').focus(); await page.keyboard.press('Enter'); await hold.ready.promise;
  assert.equal(await page.getByTestId('artifact-figure-consistency-discard').isDisabled(), true);
  const saved = f.history().items[0], request = calls.find(value => value.method === 'saveFigureConsistencyReview').input;
  assert.equal(saved.snapshot.material.mappings[0].calculation.consistent, true);
  assert.equal(saved.snapshot.material.mappings[1].calculation.consistent, false);
  assert.deepEqual(saved.snapshot.request.bindings.map(value => value.scenePath), [f.mark.items[0].scenePath, f.mark.items[20].scenePath]);
  const retryBefore = f.changes(); f.holds.delete('saveFigureConsistencyReview'); hold.release();
  await editor().getByRole('alert').waitFor();
  await page.getByTestId('artifact-figure-consistency-save').click();
  await page.getByTestId('artifact-figure-consistency-fields').waitFor({state: 'hidden'});
  await page.getByTestId('artifact-figure-consistency-hash').waitFor();
  assert.deepEqual(calls.filter(value => value.method === 'saveFigureConsistencyReview').map(value => value.input), [request, request]);
  assert.equal(f.changes(), retryBefore);
  assert.deepEqual(saved.snapshot.actor, {kind: 'user', id: 'window:73'});
  assert.equal(await page.getByTestId('artifact-inspector-return-review').isDisabled(), true);
  assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
});

test('new parent or actual trace drift refuses a save, keeps draft and leaves stored history independently readable', async () => {
  for (const conflict of ['parent', 'trace']) {
    const f = await scene(); await openReport(); await openEditor(f); await fillMapping(f);
    const stored = await declare(f, 1);
    if (conflict === 'trace') await writeFile(f.tracePath, Buffer.concat([await readFile(f.tracePath), Buffer.from(' ')]));
    const before = f.changes();
    await page.getByTestId('artifact-figure-consistency-save').click(); await editor().getByRole('alert').waitFor();
    assert.match(await editor().getByRole('alert').innerText(), conflict === 'parent' ? /新版本|变化/u : /冻结文件已变化/u);
    assert.equal(f.changes(), before);
    assert.equal(await page.getByTestId('artifact-figure-consistency-draft-count').innerText(), '待保存图稿映射，共 1 项');
    assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), true);
    await page.getByTestId('artifact-figure-consistency-discard').click();
    await page.getByTestId('artifact-figure-consistency-refresh').click(); await report().getByRole('alert').waitFor();
    assert.equal(await page.getByTestId('artifact-figure-consistency-hash').count(), 0);
    await page.getByTestId('artifact-figure-consistency-history-open').click();
    const history = page.getByTestId('artifact-figure-consistency-history'); await history.waitFor();
    assert.match(await history.innerText(), /历史来源未按当前版本复核/u);
    const raw = history.locator('details').filter({has: page.locator('summary', {hasText: '图稿审核回执原文'})});
    await raw.locator('summary').click(); await raw.locator('pre').waitFor({state: 'visible'});
    assert.deepEqual(JSON.parse(await raw.locator('pre').innerText()), stored);
  }
});

test('paged stored history has exact complete receipts and approved archived readonly scopes send no writes', async () => {
  const f = await scene(); let parent = null; const receipts = [];
  for (let index = 1; index <= 12; index++) {parent = await declare(f, index, parent); receipts.push(parent);}
  await page.evaluate(request => mount(request), f.selection); await openReport();
  await page.getByTestId('artifact-figure-consistency-history-open').click();
  const history = page.getByTestId('artifact-figure-consistency-history'); await history.waitFor();
  assert.equal(await history.getByTestId('artifact-figure-consistency-receipt').count(), 10);
  await page.getByTestId('artifact-figure-consistency-history-next').click();
  await history.getByText('保存回执，共 12 版。历史来源未按当前版本复核。', {exact: true}).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="artifact-figure-consistency-history"] [data-testid="artifact-figure-consistency-receipt"]').length === 2);
  const raw = history.getByTestId('artifact-figure-consistency-receipt').last().locator('details').last();
  await raw.locator('summary').focus(); await page.keyboard.press('Enter'); await raw.locator('pre').waitFor({state: 'visible'});
  assert.deepEqual(JSON.parse(await raw.locator('pre').innerText()), receipts[0]);
  await openEditor(f); await page.evaluate(() => setWritable(false));
  assert.equal(await page.getByTestId('artifact-figure-consistency-save').isDisabled(), true);
  for (const state of ['approved', 'archived']) {
    if (state === 'approved') f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
    else f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await page.evaluate(request => mount(request), f.selection); await openReport(); await openEditor(f);
    assert.equal(await page.getByTestId('artifact-figure-consistency-save').isDisabled(), true);
    await page.getByTestId('artifact-figure-consistency-page').waitFor();
  }
  assert.equal(calls.filter(value => value.method === 'saveFigureConsistencyReview').length, 0);
});

test('late report page metric and save replies cannot populate or refresh a new project', async () => {
  const first = await scene(); await openReport(); await openEditor(first); await fillMapping(first);
  const write = first.hold('saveFigureConsistencyReview');
  await page.getByTestId('artifact-figure-consistency-save').click(); await write.ready.promise;
  const second = await scene(); await openReport(); const before = calls.filter(value => value.method === 'inspectArtifact').length;
  first.holds.delete('saveFigureConsistencyReview'); write.release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(calls.filter(value => value.method === 'inspectArtifact').length, before);
  const late = second.hold('inspectFigureConsistency');
  await page.getByTestId('artifact-figure-consistency-refresh').click(); await late.ready.promise;
  const third = await scene(); await openReport(); second.holds.delete('inspectFigureConsistency'); late.release();
  assert.equal(await page.getByTestId('artifact-figure-consistency-hash').innerText(), (await third.inspect({markName: null, offset: 0, limit: 20})).reportHash);
  await openEditor(third);
  const metric = third.hold('getExperimentResultEvidence');
  await fields().getByRole('combobox', {name: '图稿指标主张', exact: true}).selectOption(third.claim.id);
  await fields().getByRole('combobox', {name: '图稿指标证据', exact: true}).selectOption(third.evidence.id); await metric.ready.promise;
  const fourth = await scene(); await openReport();
  third.holds.delete('getExperimentResultEvidence'); metric.release(); await openEditor(fourth);
  assert.equal(await fields().getByText('来源指标 mean：2 ms', {exact: true}).count(), 0);
  await page.getByTestId('artifact-figure-consistency-edit').click();
  const sceneRead = fourth.hold('inspectFigureConsistency');
  await page.getByRole('combobox', {name: '场景标记', exact: true}).selectOption('');
  await page.getByRole('combobox', {name: '场景标记', exact: true}).selectOption(fourth.mark.name); await sceneRead.ready.promise;
  const fifth = await scene(); await openReport(); fourth.holds.delete('inspectFigureConsistency'); sceneRead.release();
  assert.equal(await page.getByTestId('artifact-figure-consistency-items').count(), 0);
  await openEditor(fifth); await fillMapping(fifth);
  assert.equal(await page.getByTestId('artifact-figure-consistency-draft-count').innerText(), '待保存图稿映射，共 1 项');
});

test('a newer scene page hides data until the whole artifact is refreshed', async () => {
  const f = await scene(); await openReport(); await declare(f, 1);
  await page.getByRole('combobox', {name: '场景标记', exact: true}).selectOption(f.mark.name);
  await page.getByTestId('artifact-figure-consistency-scene').getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('artifact-figure-consistency-items').count(), 0);
  assert.equal(await fields().count(), 0);
  await page.getByTestId('artifact-figure-consistency-refresh').click();
  await report().getByText('工件已变化，请先刷新工件。', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('artifact-figure-consistency-hash').count(), 0);
  await page.getByTestId('artifact-inspector-refresh').click();
  await page.getByTestId('artifact-figure-consistency-hash').waitFor(); await selectMark(f);
  assert.equal(await page.getByTestId('artifact-figure-consistency-items').locator('li').count(), 2);
});

test('actual scene and long conversion controls fit both narrow themes with reduced motion and exact clip audit', async () => {
  const f = await scene({long: true}); await openReport(); await openEditor(f);
  await fillMapping(f, {unit: 's', conversion: 'affine'});
  await fillMapping(f, {unit: 's', conversion: 'affine', add: false});
  await editor().getByRole('textbox', {name: '图稿数据审核理由'}).fill('完整原文、指标、单位、舍入与容差逐项核对。'.repeat(50));
  await page.getByTestId('artifact-figure-consistency-save').click();
  assert.match(await editor().getByRole('alert').innerText(), /先加入或清空待加入图稿映射/u);
  assert.equal(calls.filter(call => call.method === 'saveFigureConsistencyReview').length, 0);
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  await page.setViewportSize({width: 650, height: 900}); await page.emulateMedia({reducedMotion: 'reduce'});
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.getByTestId('artifact-figure-consistency-fields').getByRole('spinbutton', {name: '转换比例', exact: true}).scrollIntoViewIfNeeded();
    await page.getByTestId('artifact-figure-consistency-add').hover();
    for (const state of ['default', 'hover', 'expanded', 'final']) {
      if (state === 'default') await page.mouse.move(5, 5);
      if (state === 'hover') await page.getByTestId('artifact-figure-consistency-add').hover();
      if (state === 'expanded') {
        const disclosure = page.getByTestId('artifact-figure-consistency-scene').locator('details').first();
        if (!(await disclosure.evaluate(element => element.open))) await disclosure.locator('summary').click();
        await disclosure.locator('pre').waitFor({state: 'visible'});
      }
      if (state === 'final') await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
    writeFileSync(join(artifacts, `${theme}-${state}-audit.json`), JSON.stringify(audit, null, 2));
    assert.equal(audit.cut, 0);
    const panelPath = await page.getByTestId('artifact-inspector-panel').evaluate(element => {
      const parts = [];
      for (let item = element; item && item !== document.body && parts.length < 4; item = item.parentElement) {
        parts.unshift(`${item.tagName.toLowerCase()}${[...item.classList].slice(0, 3).map(name => `.${name}`).join('')}`);
      }
      return parts.join(' > ');
    });
    assert.equal(audit.hidden, 3);
    assert.deepEqual(audit.issues.map(issue => [issue.el, issue.kind, issue.side, issue.level, issue.gap, issue.why]).sort(),
      ['bottom', 'right', 'top'].map(side => [panelPath, 'box-shadow', side, 'hidden', 0, 'overflow:hidden']).sort());
    }
    assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await editor().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('select,input,textarea')].every(input => {
        const rect = input.getBoundingClientRect();
        return rect.width > 100 && rect.left >= bounds.left && rect.right <= bounds.right;
      });
    }), true);
    await page.getByTestId('artifact-figure-consistency-fields').getByRole('spinbutton', {name: '转换比例', exact: true}).scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-fields-650.png`)});
    await page.getByRole('combobox', {name: '场景标记', exact: true}).scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-scene-650.png`)});
    await editor().getByRole('textbox', {name: '图稿数据审核理由'}).focus();
    await page.getByTestId('artifact-figure-consistency-save').scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-save-650.png`)});
  }
});
