import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {unknownExperiment, createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let api, directory, app, page, active;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/consistency-ui');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-consistency-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const methods=['inspectArtifact','inspectConsistency','saveConsistencyReview','getConsistencyHistory','getExperimentResultEvidence','getGateReviewContext'];
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
    const channel = {inspectArtifact: 'roc:research:artifact-inspect', inspectConsistency: 'roc:research:consistency-inspect',
      saveConsistencyReview: 'roc:research:consistency-save', getConsistencyHistory: 'roc:research:consistency-history',
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
    fixtures.forEach(f => f.close()); api?.dispose();
    if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function scene({long = false, waiting = false} = {}) {
  const f = createResearchFixture(api, 'writing');
  fixtures.push(f); active = f; calls.length = 0; f.holds = new Map();
  const experiment = f.repository.experiments.create({projectId: f.project.id, ownerRunId: null, requestId: 'measurement',
    label: 'Stored synthetic measurement', engine: 'typescript', sourceVersion: 1, sourcePath: 'analysis.mts', inputPaths: [],
    parameters: {}, runtime: {kind: 'bundled-node'}, timeoutMs: 1000, network: 'disabled'},
  '/tmp/roc-research-fixture', '/tmp/roc-research-fixture', '/tmp/roc-synthetic-results');
  const unavailable = {kind: 'unavailable', reason: 'Synthetic UI contract fixture'};
  const snapshot = {schemaVersion: 1, id: 'fixed-result', request: {
    projectId: f.project.id, requestId: 'reviewed-result', runId: experiment.id, expectedInputHash: 'a'.repeat(64),
    resultPath: 'metrics.json', expectedResultHash: 'b'.repeat(64),
    definitions: [{id: 'mean', label: 'Mean', definition: 'Recorded synthetic mean', unit: 'ms', direction: 'lower'}],
    method: {name: 'Arithmetic mean', rationale: 'All observations', assumptions: 'Synthetic sample', limitations: 'No inference'}},
  actor: {kind: 'user', id: 'window:73'}, recordedAt: '2026-11-03T00:00:00.000Z',
  result: {schemaVersion: 1, metrics: [{id: 'mean', value: -2.345, unit: 'ms', sampleSize: 3,
    uncertainty: unavailable, confidenceInterval: unavailable, effect: unavailable}]},
  execution: {runId: experiment.id, inputHash: 'a'.repeat(64), engine: 'typescript', environmentHash: 'c'.repeat(64),
    source: {area: 'input', path: 'analysis.mts', sha256: 'd'.repeat(64), size: 5},
    output: {area: 'output', path: 'metrics.json', sha256: 'b'.repeat(64), size: 10}, inputs: [],
    parameters: {}, arguments: [], seed: null}};
  f.result = f.repository.experimentResults.save({snapshot, snapshotHash: hash(snapshot)});
  f.evidence = f.repository.experimentResults.captureMetric(f.result, 'mean');
  f.artifactId = f.withWorker(() => f.repository.runs.complete(f.run.id, f.project.id, {title: '数值来源与规则',
    markdown: 'Synthetic measured report', claims: [
      {experiment: {...unknownExperiment}, subjectType: 'paragraph', content: `${long ? '长主张、单位与指标来源逐项核对。'.repeat(25) : 'Mean '}-2.35 ms and comparison 17 ms.`,
        status: 'supported', evidenceIds: [f.evidence.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  if (waiting) f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
  // UI lifecycle uses synthetic recorded result material. Actual CPython byte verification is separately exercised by A4A.
  const evidence = async input => ({ok: true, data: {receipt: f.result, metricId: 'mean'}});
  f.service = new api.ResearchConsistencyService(f.repository, {evidence: async () => ({receipt: f.result, metricId: 'mean'})});
  const handlers = new Map();
  const context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchConsistencyCapabilities(context, f.service, f.repository.consistency);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) =>
    name === 'research.experimentResults.evidence' ? evidence(input).then(reply => reply.data) : handlers.get(name)(input)});
  f.request = {projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null};
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  f.hold = (method, loseReply = false) => {
    const value = {ready: Promise.withResolvers(), loseReply}; f.holds.set(method, value); return value;
  };
  await page.evaluate(request => mount(request), f.request);
  await page.getByTestId('artifact-inspector-content').waitFor();
  return f;
}
const report = () => page.getByTestId('artifact-consistency');
const editor = () => page.getByTestId('artifact-consistency-editor');
async function openReport() {
  await page.getByTestId('artifact-consistency-toggle').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-consistency-hash').waitFor();
}
async function openEditor() {
  await page.getByTestId('artifact-consistency-edit').focus(); await page.keyboard.press('Enter');
  await editor().waitFor();
}
async function fillMapping(f, {position = '0', unit = 'ms', conversion = 'identity', rounding = 'decimal_places', add = true} = {}) {
  const fields = page.getByTestId('artifact-consistency-fields');
  await fields.getByRole('combobox', {name: '数值位置', exact: true}).selectOption(position);
  await fields.getByRole('combobox', {name: '指标证据', exact: true}).selectOption(f.evidence.id);
  await fields.getByText('来源指标 mean：-2.345 ms', {exact: true}).waitFor();
  await fields.getByRole('combobox', {name: '展示位置', exact: true}).selectOption(position === '0' ? 'abstract' : 'table');
  await fields.getByRole('textbox', {name: '展示单位', exact: true}).fill(unit);
  await fields.getByRole('combobox', {name: '单位转换', exact: true}).selectOption(conversion);
  if (conversion === 'affine') {
    await fields.getByRole('spinbutton', {name: '转换比例', exact: true}).fill('0.001');
    await fields.getByRole('spinbutton', {name: '转换偏移', exact: true}).fill('0');
    await fields.getByRole('textbox', {name: '转换理由', exact: true}).fill('Milliseconds divided by one thousand.');
  }
  await fields.getByRole('combobox', {name: '舍入规则', exact: true}).selectOption(rounding);
  if (rounding === 'decimal_places') await fields.getByRole('spinbutton', {name: '小数位数', exact: true}).fill('2');
  await fields.getByRole('spinbutton', {name: '绝对容差', exact: true}).fill('0');
  await fields.getByRole('spinbutton', {name: '相对容差', exact: true}).fill('0');
  await fields.getByRole('textbox', {name: '容差理由', exact: true}).fill('Exact displayed decimal after declared rounding.');
  if (add) {
    await page.getByTestId('artifact-consistency-add').click();
    await editor().getByText('待保存映射，共 1 项', {exact: true}).waitFor();
    await editor().getByRole('textbox', {name: '数值审核理由', exact: true}).fill('Explicit comparison of the recorded metric and this numeric location.');
  }
}
async function declare(f, number) {
  const current = await f.service.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash: null});
  const parent = current.report.review;
  const start = f.claim.content.indexOf('-2.35');
  return api.withResearchHumanContext({capability: 'research.consistency.save', projectId: f.project.id, windowId: 73},
    () => f.service.save({projectId: f.project.id, artifactId: f.artifactId, requestId: `history-${number}`,
      expectedArtifactVersion: current.report.artifactVersion, parent: parent === null ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash},
      rationale: `Human numeric review ${number}.`, bindings: [{claimId: f.claim.id, expectedClaimHash: api.relationClaimHash(f.claim),
        surface: 'body', start, end: start + 5, unit: 'ms', evidenceId: f.evidence.id, resultId: f.result.snapshot.id,
        resultHash: f.result.snapshotHash, metricId: 'mean', rule: {conversion: {kind: 'identity'},
          rounding: {kind: 'decimal_places', places: 2, mode: 'half_away_from_zero'},
          tolerance: {absolute: 0, relative: 0, rationale: 'Exact declared rounding'}}}]}));
}

test('opt-in real drawer maps a negative tie with keyboard and immutable exact reply-loss retry under whole-stage locks', async () => {
  const f = await scene({waiting: true});
  assert.equal(calls.filter(call => call.method === 'inspectConsistency').length, 0);
  const before = f.changes(); await openReport();
  assert.equal(f.changes(), before);
  assert.equal(await page.getByTestId('artifact-consistency-unmapped').locator('li').count(), 2);
  await page.getByTestId('artifact-inspector-review').click();
  await page.getByTestId('artifact-inspector-return-review').waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-return-review').isDisabled(), false);
  await openEditor();
  await page.getByTestId('artifact-consistency-fields').getByRole('combobox', {name: '单位转换', exact: true}).selectOption('identity');
  for (const id of ['artifact-inspector-refresh', 'artifact-inspector-review', 'artifact-inspector-return-review',
    'artifact-consistency-toggle', 'artifact-consistency-refresh', 'artifact-consistency-history-open']) {
    assert.equal(await page.getByTestId(id).isDisabled(), true);
  }
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
  assert.equal(await editor().count(), 1);
  await page.getByTestId('artifact-consistency-discard').click();
  await fillMapping(f);
  const hold = f.hold('saveConsistencyReview', true);
  await page.getByTestId('artifact-consistency-save').focus(); await page.keyboard.press('Enter');
  await hold.ready.promise;
  assert.equal(await page.getByTestId('artifact-consistency-discard').isDisabled(), true);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_consistency_reviews').pluck().get(), 1);
  const first = calls.find(call => call.method === 'saveConsistencyReview').input, retryBefore = f.changes();
  f.holds.delete('saveConsistencyReview'); hold.release();
  await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').innerText(), /数值审核回执连接中断/u);
  await page.getByTestId('artifact-consistency-save').click();
  await editor().waitFor({state: 'hidden'}); await page.getByTestId('artifact-consistency-hash').waitFor();
  assert.deepEqual(calls.filter(call => call.method === 'saveConsistencyReview').map(call => call.input), [first, first]);
  assert.equal(f.changes(), retryBefore);
  assert.equal(first.bindings[0].expectedClaimHash, api.relationClaimHash(f.claim));
  const saved = f.repository.consistency.latest(f.project.id, f.artifactId);
  assert.deepEqual(saved.snapshot.actor, {kind: 'user', id: 'window:73'});
  assert.equal(saved.snapshot.material[0].calculation.expectedText, '-2.35');
  assert.equal(saved.snapshot.material[0].calculation.consistent, true);
  assert.equal(await page.getByTestId('artifact-consistency-unmapped').locator('li').count(), 1);
  assert.equal(await page.getByTestId('artifact-inspector-return-review').isDisabled(), true);
  assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
});

test('explicit affine conversion and unmapped second value can be saved as an honest inconsistency; readonly scopes send no writes', async () => {
  const f = await scene(); await openReport(); await openEditor();
  await page.getByTestId('artifact-consistency-save').click();
  assert.equal(await editor().getByRole('textbox', {name: '数值审核理由'}).evaluate(element => element.validity.valueMissing), true);
  assert.equal(calls.filter(call => call.method === 'saveConsistencyReview').length, 0);
  await fillMapping(f, {position: '1', unit: 's', conversion: 'affine', rounding: 'none'});
  await page.getByTestId('artifact-consistency-save').click();
  await editor().waitFor({state: 'hidden'}); await page.getByTestId('artifact-consistency-hash').waitFor();
  assert.match(await page.getByTestId('artifact-consistency-locations').innerText(), /数值不一致/u);
  const saved = f.repository.consistency.latest(f.project.id, f.artifactId);
  assert.equal(saved.snapshot.material[0].calculation.expectedValue, -0.0023450000000000003);
  assert.equal(saved.snapshot.material[0].calculation.observed, 17);
  assert.equal(saved.snapshot.material[0].calculation.consistent, false);
  await openEditor(); await page.evaluate(() => setWritable(false));
  assert.equal(await page.getByTestId('artifact-consistency-save').isDisabled(), true);
  const writes = calls.filter(call => call.method === 'saveConsistencyReview').length;
  for (const state of ['approved', 'archived']) {
    if (state === 'approved') f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
    else f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
    await page.evaluate(request => mount(request), f.request); await openReport(); await openEditor();
    assert.equal(await page.getByTestId('artifact-consistency-save').isDisabled(), true);
  }
  assert.equal(calls.filter(call => call.method === 'saveConsistencyReview').length, writes);
});

test('paged stored receipts remain complete after source invalidation while current reports hide previous successful data', async () => {
  const f = await scene(), receipts = [];
  for (let index = 1; index <= 12; index++) receipts.push(await declare(f, index));
  await page.evaluate(request => mount(request), f.request); await openReport();
  await page.getByTestId('artifact-consistency-history-open').click();
  const history = page.getByTestId('artifact-consistency-history'); await history.waitFor();
  assert.equal(await history.getByTestId('artifact-consistency-receipt').count(), 10);
  const hold = f.hold('getConsistencyHistory');
  await page.getByTestId('artifact-consistency-history-next').click(); await hold.ready.promise;
  assert.equal(await history.count(), 0);
  f.holds.delete('getConsistencyHistory'); hold.release(); await history.waitFor();
  assert.equal(await history.getByTestId('artifact-consistency-receipt').count(), 2);
  const raw = history.getByTestId('artifact-consistency-receipt').last().locator('details');
  await raw.locator('summary').focus(); await page.keyboard.press('Enter');
  await raw.locator('pre').waitFor({state: 'visible'});
  assert.deepEqual(JSON.parse(await raw.locator('pre').innerText()), receipts[0]);
  f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
  await page.getByTestId('artifact-consistency-refresh').click();
  await report().getByRole('alert').waitFor();
  assert.match(await report().getByRole('alert').innerText(), /指标来源已变化/u);
  assert.equal(await page.getByTestId('artifact-consistency-hash').count(), 0);
  await page.getByTestId('artifact-consistency-history-open').click(); await history.waitFor();
  assert.equal(await history.getByTestId('artifact-consistency-receipt').count(), 10);
  assert.match(await history.innerText(), /历史来源未按当前版本复核/u);
});

test('late report metric and saved review responses cannot populate or refresh a new project', async () => {
  const first = await scene(); await openReport(); await openEditor(); await fillMapping(first);
  const write = first.hold('saveConsistencyReview');
  await page.getByTestId('artifact-consistency-save').click(); await write.ready.promise;
  const second = await scene(); await openReport();
  const reads = calls.filter(call => call.method === 'inspectArtifact').length;
  first.holds.delete('saveConsistencyReview'); write.release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(calls.filter(call => call.method === 'inspectArtifact').length, reads);
  assert.equal(await page.getByTestId('artifact-consistency-hash').innerText(),
    (await second.service.inspect({projectId: second.project.id, artifactId: second.artifactId, expectedHash: null})).reportHash);
  const late = second.hold('inspectConsistency');
  await page.getByTestId('artifact-consistency-refresh').click(); await late.ready.promise;
  await page.getByTestId('artifact-consistency-hash').waitFor({state: 'hidden'});
  assert.equal(await page.getByTestId('artifact-consistency-hash').count(), 0);
  const third = await scene(); await openReport();
  second.holds.delete('inspectConsistency'); late.release();
  assert.equal(await page.getByTestId('artifact-consistency-hash').innerText(),
    (await third.service.inspect({projectId: third.project.id, artifactId: third.artifactId, expectedHash: null})).reportHash);
  await openEditor();
  const metric = third.hold('getExperimentResultEvidence');
  const fields = page.getByTestId('artifact-consistency-fields');
  await fields.getByRole('combobox', {name: '数值位置', exact: true}).selectOption('0');
  await fields.getByRole('combobox', {name: '指标证据', exact: true}).selectOption(third.evidence.id);
  await metric.ready.promise;
  const fourth = await scene(); await openReport(); await openEditor();
  third.holds.delete('getExperimentResultEvidence'); metric.release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await fields.getByText('来源指标 mean：-2.345 ms', {exact: true}).count(), 0);
  assert.equal(await fields.getByRole('combobox', {name: '指标证据', exact: true}).inputValue(), '');
  await fillMapping(fourth);
  assert.equal(await editor().getByText(`主张 ${fourth.claim.id}，结果 ${fourth.result.snapshot.id}，证据 ${fourth.evidence.id}`, {exact: true}).count(), 1);
});

test('new parent and changed source refuse saves while preserving the draft until explicit discard', async () => {
  for (const conflict of ['parent', 'source']) {
    const f = await scene(); await openReport(); await openEditor(); await fillMapping(f);
    if (conflict === 'parent') await declare(f, 1);
    else f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
    const before = f.changes();
    await page.getByTestId('artifact-consistency-save').click();
    await editor().getByRole('alert').waitFor();
    assert.match(await editor().getByRole('alert').innerText(),
      conflict === 'parent' ? /已有新版本/u : /指标来源已失效，请捕获当前版本。/u);
    assert.equal(f.changes(), before);
    assert.equal(await editor().getByText('待保存映射，共 1 项', {exact: true}).count(), 1);
    assert.equal(await editor().getByRole('textbox', {name: '数值审核理由', exact: true}).inputValue(),
      'Explicit comparison of the recorded metric and this numeric location.');
    assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), true);
    await page.getByTestId('artifact-consistency-discard').click();
    assert.equal(await editor().getByText('待保存映射，共 0 项', {exact: true}).count(), 1);
    assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), false);
    await page.getByTestId('artifact-inspector-refresh').click();
    await editor().waitFor({state: 'hidden'});
  }
});

test('a report for a newer artifact hides old-snapshot content and requires artifact refresh', async () => {
  const f = await scene();
  await declare(f, 1);
  await page.getByTestId('artifact-consistency-toggle').click();
  await page.getByTestId('artifact-consistency-artifact-changed').waitFor();
  for (const id of ['artifact-consistency-hash', 'artifact-consistency-edit', 'artifact-consistency-unmapped']) {
    assert.equal(await page.getByTestId(id).count(), 0);
  }
  await page.getByTestId('artifact-consistency-history-open').click();
  await page.getByTestId('artifact-consistency-history').waitFor();
  assert.equal(await page.getByTestId('artifact-consistency-receipt').count(), 1);
  await page.getByTestId('artifact-inspector-refresh').click();
  await page.getByTestId('artifact-consistency-hash').waitFor();
  assert.equal(await page.getByTestId('artifact-consistency-artifact-changed').count(), 0);
});

test('long explicit conversion fields and draft mapping fit both narrow themes and reduced motion', async () => {
  const f = await scene({long: true}); await openReport(); await openEditor();
  await fillMapping(f, {unit: 's', conversion: 'affine'});
  await fillMapping(f, {unit: 's', conversion: 'affine', add: false});
  await editor().getByRole('textbox', {name: '数值审核理由'}).fill('完整原文、指标、单位、舍入与容差逐项核对。'.repeat(50));
  await page.getByTestId('artifact-consistency-save').click();
  assert.match(await editor().getByRole('alert').innerText(), /先加入或清空待加入映射/u);
  assert.equal(calls.filter(call => call.method === 'saveConsistencyReview').length, 0);
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  await page.setViewportSize({width: 650, height: 900}); await page.emulateMedia({reducedMotion: 'reduce'});
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.getByTestId('artifact-consistency-fields').getByRole('spinbutton', {name: '转换比例', exact: true}).scrollIntoViewIfNeeded();
    await page.getByTestId('artifact-consistency-add').hover();
    const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
    writeFileSync(join(artifacts, `${theme}-audit.json`), JSON.stringify(audit, null, 2));
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
    assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await editor().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('select,input,textarea')].every(input => {
        const rect = input.getBoundingClientRect();
        return rect.width > 100 && rect.left >= bounds.left && rect.right <= bounds.right;
      });
    }), true);
    await page.getByTestId('artifact-consistency-fields').getByRole('spinbutton', {name: '转换比例', exact: true}).scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-fields-650.png`)});
    await editor().getByRole('textbox', {name: '数值审核理由'}).focus();
    await page.getByTestId('artifact-consistency-save').scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `${theme}-save-650.png`)});
  }
});
