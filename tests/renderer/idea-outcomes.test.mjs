import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm, chmod} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi, createResearchFixture} from '../unit/fixtures/research-test-kit.mjs';
import {ideaCanvasContentFixture, ideaPlanBodyFixture} from '../unit/fixtures/research-idea-plan.mjs';

let api, root, f, service, results, outcomes, run, result, app, page, windowId, active;
const artifacts = resolve('.artifacts/research-optimization/xidea-a3b-ui'), calls = [], errors = [];
const routes = {
  inspectArtifact: ['roc:research:artifact-inspect', 'research.inspectArtifact'],
  getGateReviewContext: ['roc:research:gate-review', 'research.getGateReviewContext'],
  saveIdeaPlan: ['roc:research:idea-plan-save', 'research.saveIdeaPlan'],
  freezeIdeaPlan: ['roc:research:idea-plan-freeze', 'research.freezeIdeaPlan'],
  getIdeaPlan: ['roc:research:idea-plan-get', 'research.getIdeaPlan'],
  getIdeaPlanHistory: ['roc:research:idea-plan-history', 'research.getIdeaPlanHistory'],
  listExperiments: ['roc:research:experiment-list', 'research.listExperiments'],
  listExperimentResults: ['roc:research:experiment-result-list', 'research.listExperimentResults'],
  getExperimentResult: ['roc:research:experiment-result-get', 'research.getExperimentResult'],
  captureExperimentResultEvidence: ['roc:research:experiment-result-evidence-capture', 'research.captureExperimentResultEvidence'],
  saveIdeaOutcome: ['roc:research:idea-outcome-save', 'research.saveIdeaOutcome'],
  getIdeaOutcome: ['roc:research:idea-outcome-get', 'research.getIdeaOutcome'],
  getIdeaOutcomeHistory: ['roc:research:idea-outcome-history', 'research.getIdeaOutcomeHistory']
};
const definition = {id: 'mean', label: 'Latency mean', definition: 'Arithmetic mean of every declared observation', unit: 'ms', direction: 'lower'};
const human = (capability, action) => api.withResearchHumanContext({capability, projectId: f.project.id, windowId}, action);
before(async () => {
  api = await loadResearchTestApi();
  root = await realpath(await mkdtemp('/private/tmp/roc-outcome-ui-'));
  const workspace = join(root, 'workspace'), venv = join(root, 'venv'), directory = join(root, 'ui');
  for (const path of [workspace, join(venv, 'bin'), join(venv, 'lib/python3.14/site-packages'), directory, artifacts]) await mkdir(path, {recursive: true});
  const python = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
    'import sys,os,json;print(json.dumps({"executable":os.path.realpath(sys.executable),"version":sys.version.split()[0]}))'], {encoding: 'utf8'}));
  assert.match(python.version, /^3\.14\.\d+$/u);
  const executable = join(venv, 'bin/python3');
  await symlink(python.executable, executable);
  await writeFile(join(venv, 'pyvenv.cfg'), `home = ${dirname(python.executable)}\ninclude-system-site-packages = false\nversion = ${python.version}\n`);
  await writeFile(join(workspace, 'roc-python.lock.json'), JSON.stringify({
    schemaVersion: 1, python: {implementation: 'cpython', version: python.version, platform: 'darwin', architecture: 'arm64'}, distributions: []
  }));
  await writeFile(join(workspace, 'analysis.py'), `import json, os, statistics
import roc_experiment as roc
with open(os.path.join(roc.input_dir, "data.txt")) as data:
    values = [float(value) for value in data.read().split()]
with open(os.path.join(roc.output_dir, "metrics.json"), "w") as output:
    json.dump({"schemaVersion": 1, "metrics": [{"id": "mean", "value": statistics.mean(values), "unit": "ms",
        "sampleSize": len(values), "uncertainty": {"kind": "recorded", "type": "standard_deviation", "value": statistics.stdev(values)},
        "confidenceInterval": {"kind": "unavailable", "reason": "No interval estimated"},
        "effect": {"kind": "unavailable", "reason": "No control group"}}]}, output)
`);
  await writeFile(join(workspace, 'data.txt'), '-3 -2 -1\n');
  f = createResearchFixture(api, 'experiment', workspace);
  const pythonService = new api.ResearchPythonEnvironmentService(f.repository, async () => executable);
  const selection = await api.withResearchHumanContext({capability: 'research.pythonEnvironments.select', projectId: f.project.id, windowId: 72},
    () => pythonService.select({projectId: f.project.id, requestId: 'environment'}));
  service = new api.ResearchExperimentService(f.repository, new api.ResearchExperimentEnvironmentService({
    nativeRuntime: async () => assert.fail('no native tools'), typescriptRuntime: async () => assert.fail('no TypeScript')
  }, pythonService), root, {error: (...args) => errors.push(JSON.stringify(args))});
  const runtime = {kind: 'python', selectionId: selection.snapshot.id, expectedHash: selection.snapshotHash};
  const environment = await service.inspect(f.project.id, runtime);
  run = await f.withWorker(() => service.start({projectId: f.project.id, ownerRunId: f.run.id, requestId: 'actual-run', label: 'Actual negative mean',
    engine: 'python', sourceVersion: 1, source: {kind: 'file', path: 'analysis.py'}, inputPaths: ['data.txt'], parameters: {},
    seed: 73, arguments: [], runtime, expectedEnvironmentHash: environment.hash, timeoutMs: 5000, network: 'disabled'}));
  const deadline = Date.now() + 20000;
  while (['preparing', 'running'].includes(run.status) && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 20)); run = f.repository.experiments.get(f.project.id, run.id);
  }
  assert.equal(run.status, 'completed', run.error);
  results = new api.ResearchExperimentResultService(f.repository, service);
  outcomes = new api.ResearchIdeaOutcomeService(f.repository, results);
  const handlers = new Map(), context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchIdeaPlanCapabilities(context, f.repository.ideaPlans);
  api.registerResearchIdeaOutcomeCapabilities(context, f.repository.ideaOutcomes, outcomes);
  api.registerResearchExperimentResultCapabilities(context, f.repository.experimentResults, results);
  api.registerResearchExperimentCapabilities(context, f.repository.experiments, service);
  const bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {StageArtifactInspector} from './src/renderer/artifacts/StageArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(routes))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    function Harness({request,writable}) {
      const [open,setOpen]=useState(true),[locations]=useState(()=>new Map());
      return <main><button onClick={()=>setOpen(true)}>打开工件</button>{open?<StageArtifactInspector client={client}
        request={request} writable={writable} readingLocations={locations} onClose={()=>setOpen(false)}
        onOpenTask={()=>setOpen(false)} onReviewContext={()=>{}}/>:null}</main>;
    }
    let generation=0;
    window.mount=(request,writable=true)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} request={request} writable={writable}/></LazyMotion></MotionConfig>));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(root, 'userData'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1000,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  const output = run.files.find(file => file.path === 'metrics.json' && file.area === 'output');
  result = await human('research.experimentResults.review', () => results.review({
    projectId: f.project.id, requestId: 'actual-result', runId: run.id, expectedInputHash: run.inputHash,
    resultPath: output.path, expectedResultHash: output.sha256, definitions: [definition],
    method: {name: 'Arithmetic mean', rationale: 'All observations', assumptions: 'Synthetic fixture', limitations: 'No inference'}
  }));
  await page.exposeFunction('callMain', async (method, input) => {
    calls.push({method, input}); api.parseIpcRequestArgs(routes[method][0], [input]);
    const scene = active;
    const reply = method === 'inspectArtifact' ? {ok: true, data: f.repository.inspectArtifact(input)} :
      method === 'getGateReviewContext' ? {ok: true, data: f.repository.readGateReviewContext(input)} :
      await bridge.invoke(routes[method][1], [input], windowId);
    if (method === 'getIdeaOutcome' && !reply.ok) scene.verificationError = reply.error;
    if (scene.loseReply === method) {
      delete scene.loseReply; assert.equal(reply.ok, true);
      return {ok: false, error: {code: 'fixture_reply_lost', category: 'degraded', message: '连接中断，已写入回执未送达。', retryable: true}};
    }
    if (scene.defer === method) return new Promise(done => {scene.finish = () => done(reply);});
    return reply;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => {
  try {await app?.close(); await service?.shutdown(); f?.close(); api?.dispose();}
  finally {if (root) await rm(root, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
function canvas(body = ideaPlanBodyFixture()) {
  f.db.prepare('UPDATE research_projects SET current_stage=? WHERE id=?').run('ideation', f.project.id);
  f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage=?").run(f.project.id, 'ideation');
  const artifact = f.repository.createArtifact({projectId: f.project.id, stage: 'ideation', kind: 'idea_canvas', title: 'Frozen synthetic method', path: null});
  const savedCanvas = f.repository.ideas.save({...ideaCanvasContentFixture(), artifactId: artifact.id, expectedVersion: null});
  const saved = human('research.ideaPlans.save', () => f.repository.ideaPlans.save({
    projectId: f.project.id, artifactId: artifact.id, requestId: `plan-${artifact.id}`,
    canvas: {version: savedCanvas.version, contentHash: savedCanvas.contentHash}, parent: null, revisionReason: null, body
  }));
  const frozen = human('research.ideaPlans.freeze', () => f.repository.ideaPlans.freeze({
    projectId: f.project.id, artifactId: artifact.id, versionId: saved.version.id, expectedHash: saved.versionHash,
    requestId: `freeze-${artifact.id}`, reviewNote: 'Engineering fixture only'
  }));
  return {artifact, frozen, savedCanvas};
}
async function scene(c = canvas(), writable = true) {
  active = {}; calls.length = 0;
  const request = {projectId: f.project.id, artifactId: c.artifact.id, expectedVersion: null};
  await page.evaluate(({request, writable}) => mount(request, writable), {request, writable});
  await page.getByTestId('artifact-idea-outcomes').waitFor(); return c;
}
async function choose(c) {
  await page.getByTestId('artifact-idea-outcome-open').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-idea-outcome-plan').filter({hasText: '方法版本 1 '}).click();
  await page.getByTestId('artifact-idea-outcome-selected-plan').waitFor();
  await page.getByTestId('artifact-idea-outcome-runs').click();
  await page.getByLabel('实际实验运行', {exact: true}).selectOption(run.id);
  await page.getByTestId('artifact-idea-outcome-result').filter({hasText: result.snapshot.id}).click();
  await page.getByTestId('artifact-idea-outcome-form').waitFor();
  assert.equal(c.frozen.version.id, calls.find(call => call.method === 'getIdeaPlan').input.versionId);
}
async function fill(verdict = 'contradicts') {
  await page.getByLabel('Latency mean 实测指标', {exact: true}).selectOption('metric:mean');
  await page.getByLabel('人工结果评估', {exact: true}).selectOption(verdict);
  await page.getByLabel('结果评估审核说明', {exact: true}).fill('Retain observed negative result and frozen expectation.');
}
const history = c => f.repository.ideaOutcomes.history({projectId: f.project.id, artifactId: c.artifact.id, versionId: c.frozen.version.id, offset: 0, limit: 100});
test('keyboard outcome selection has no implicit result reads or verdict and saves real negative value with frozen expectations', async () => {
  const c = await scene(), baseline = f.repository.inspectArtifact({projectId: f.project.id, artifactId: c.artifact.id, expectedVersion: null});
  assert.deepEqual(calls.map(call => call.method), ['inspectArtifact']);
  await choose(c);
  assert.equal(await page.getByLabel('人工结果评估', {exact: true}).inputValue(), '');
  assert.equal(await page.getByLabel('Latency mean 实测指标', {exact: true}).inputValue(), '');
  await fill();
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), true);
  assert.equal(await page.getByTestId('artifact-idea-plan-revise').isDisabled(), true);
  await page.keyboard.press('Escape'); await expect(page.getByTestId('artifact-inspector-panel')).toBeVisible();
  await page.getByTestId('artifact-idea-outcome-save').focus(); await page.keyboard.press('Enter');
  await page.getByText('反驳假设 评估版本 1', {exact: false}).waitFor();
  const receipt = history(c).items[0];
  assert.equal(receipt.snapshot.actor.id, `window:${windowId}`);
  assert.equal(receipt.snapshot.material.result.snapshot.result.metrics[0].value, -2);
  assert.equal(receipt.snapshot.material.plan.version.request.body.metrics[0].expectedOutcome, 'A negative mean difference');
  assert.deepEqual(receipt.snapshot.material.executionTime, {startedAt: run.startedAt, endedAt: run.endedAt});
  const current = f.repository.inspectArtifact({projectId: f.project.id, artifactId: c.artifact.id, expectedVersion: baseline.snapshot.version});
  assert.equal(current.status, 'stale'); assert.equal(current.snapshot.ideaOutcomes[0].outcomeHash, receipt.snapshotHash);
  assert.equal(current.snapshot.evidence[0].evidence.id, receipt.snapshot.material.evidence[0].id);
});
test('lost outcome reply retries the identical request without a second Evidence or assessment while drawer controls stay locked', async () => {
  const c = await scene(); await choose(c); await fill();
  active.loseReply = 'saveIdeaOutcome';
  await page.getByTestId('artifact-idea-outcome-save').click(); await page.getByRole('alert').filter({hasText: '连接中断'}).waitFor();
  assert.equal(history(c).total, 1);
  assert.match(await page.getByTestId('artifact-idea-outcome-form').innerText(), /评估失败时这些证据仍保留/u);
  active.defer = 'saveIdeaOutcome';
  const changes = f.db.prepare('SELECT total_changes()').pluck().get();
  await page.getByTestId('artifact-idea-outcome-save').click();
  await page.getByText('正在关联指标证据并保存评估，请等待回执。', {exact: true}).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-idea-outcome-save"]').disabled);
  assert.equal(await page.getByTestId('artifact-idea-outcome-discard').isDisabled(), true);
  await page.keyboard.press('Escape'); await expect(page.getByTestId('artifact-inspector-panel')).toBeVisible();
  while (!active.finish) await new Promise(done => setTimeout(done, 20));
  const writes = calls.filter(call => call.method === 'saveIdeaOutcome');
  assert.deepEqual(writes[0].input, writes[1].input); assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
  active.finish(); delete active.defer;
  await page.getByText('反驳假设 评估版本 1', {exact: false}).waitFor(); assert.equal(history(c).total, 1);
});
test('explicit noncomparable mappings and missing reasons preserve planned values without inferring support', async () => {
  const body = ideaPlanBodyFixture(); body.metrics[0].unit = 's';
  body.metrics.push({...body.metrics[0], id: 'tail', label: 'Tail latency', expectedOutcome: 'Small tail'});
  const c = await scene(canvas(body)); await choose(c);
  await fill('contradicts');
  await page.getByLabel('Tail latency 实测指标', {exact: true}).selectOption('__missing');
  await page.getByLabel('Tail latency 缺失原因', {exact: true}).fill('No tail measurement was emitted.');
  await page.getByTestId('artifact-idea-outcome-save').click();
  await page.getByRole('alert').filter({hasText: '请选择不可比'}).waitFor();
  assert.equal(calls.filter(call => call.method === 'captureExperimentResultEvidence').length, 0);
  await page.getByLabel('人工结果评估', {exact: true}).selectOption('not_comparable');
  await page.getByTestId('artifact-idea-outcome-save').click();
  await page.getByText('不可比 评估版本 1', {exact: false}).waitFor();
  assert.deepEqual(history(c).items[0].snapshot.material.differences, [
    {plannedMetricId: 'mean', fields: ['unit']}, {plannedMetricId: 'tail', fields: ['missing_metric']}
  ]);
});
test('historical frozen methods remain assessable below a newer draft, with paged stored history and exact revision parents', async () => {
  const c = canvas();
  const evidence = await human('research.experimentResults.captureEvidence', () => results.captureEvidence({
    projectId: f.project.id, resultId: result.snapshot.id, expectedHash: result.snapshotHash, metricId: 'mean'
  }));
  let latest = await human('research.ideaOutcomes.save', () => outcomes.save({
    projectId: f.project.id, artifactId: c.artifact.id, requestId: `initial-${c.artifact.id}`,
    plan: {versionId: c.frozen.version.id, versionHash: c.frozen.versionHash, freezeHash: c.frozen.freezeHash},
    result: {resultId: result.snapshot.id, expectedHash: result.snapshotHash},
    metrics: [{kind: 'measured', plannedMetricId: 'mean', evidenceId: evidence.id}],
    verdict: 'contradicts', reviewNote: 'Retain actual negative mean', parent: null, revisionReason: null
  }));
  const earliest = latest;
  for (let index = 0; index < 11; index++) latest = human('research.ideaOutcomes.save', () => f.repository.ideaOutcomes.save({
    ...latest.snapshot.request, requestId: `revision-${c.artifact.id}-${index}`,
    parent: {outcomeId: latest.snapshot.id, outcomeHash: latest.snapshotHash},
    revisionReason: `Human review ${index + 1}`, reviewNote: `Retain observed result ${index + 1}`
  }, latest.snapshot.material));
  const nextPlan = human('research.ideaPlans.save', () => f.repository.ideaPlans.save({
    ...c.frozen.version.request, requestId: `draft-${c.artifact.id}`,
    parent: {versionId: c.frozen.version.id, versionHash: c.frozen.versionHash}, revisionReason: 'New method, still draft'
  }));
  const nextFrozen = human('research.ideaPlans.freeze', () => f.repository.ideaPlans.freeze({
    projectId: f.project.id, artifactId: c.artifact.id, versionId: nextPlan.version.id, expectedHash: nextPlan.versionHash,
    requestId: `freeze-next-${c.artifact.id}`, reviewNote: 'Second synthetic frozen method'
  }));
  const nextOutcome = await human('research.ideaOutcomes.save', () => outcomes.save({
    ...earliest.snapshot.request, requestId: `outcome-next-${c.artifact.id}`,
    plan: {versionId: nextFrozen.version.id, versionHash: nextFrozen.versionHash, freezeHash: nextFrozen.freezeHash}
  }));
  human('research.ideaPlans.save', () => f.repository.ideaPlans.save({
    ...nextFrozen.version.request, requestId: `draft-third-${c.artifact.id}`,
    parent: {versionId: nextFrozen.version.id, versionHash: nextFrozen.versionHash}, revisionReason: 'Third method, still draft'
  }));
  await scene(c); await choose(c);
  assert.equal(await page.getByTestId('artifact-idea-outcome-history-select').count(), 10);
  await page.getByTestId('artifact-idea-outcome-discard').click();
  await page.getByRole('button', {name: '下一页评估', exact: true}).click();
  await page.getByTestId('artifact-idea-outcome-history-select').filter({hasText: '评估版本 1 '}).click();
  await expect(page.getByTestId('artifact-idea-outcome-stored')).toContainText(earliest.snapshotHash);
  assert.equal(await page.getByTestId('artifact-idea-outcome-verified').count(), 0);
  await page.getByTestId('artifact-idea-outcome-verify').click();
  await page.getByTestId('artifact-idea-outcome-verified').waitFor();
  assert.equal(calls.filter(call => call.method === 'getIdeaOutcome').at(-1).input.expectedHash, earliest.snapshotHash);
  await fill('inconclusive');
  await page.getByLabel('结果评估修订原因', {exact: true}).fill('No causal inference from this fixture.');
  const baseline = f.repository.inspectArtifact({projectId: f.project.id, artifactId: c.artifact.id, expectedVersion: null});
  await page.getByTestId('artifact-idea-outcome-save').click();
  await page.getByText('结果不确定 评估版本 13', {exact: false}).waitFor();
  const receipt = history(c).items[0];
  assert.deepEqual(receipt.snapshot.request.parent, {outcomeId: latest.snapshot.id, outcomeHash: latest.snapshotHash});
  const current = f.repository.inspectArtifact({projectId: f.project.id, artifactId: c.artifact.id, expectedVersion: baseline.snapshot.version});
  assert.equal(current.status, 'stale'); assert.equal(current.snapshot.ideaPlan.freeze, null);
  assert.equal(current.snapshot.ideaOutcomes.length, 2);
  assert.equal(current.snapshot.ideaOutcomes.find(head => head.planVersionId === c.frozen.version.id).outcomeHash, receipt.snapshotHash);
  assert.equal(current.snapshot.ideaOutcomes.find(head => head.planVersionId === nextFrozen.version.id).outcomeHash, nextOutcome.snapshotHash);
});
test('late result and save replies cannot restore an earlier Canvas or clear a new Canvas draft guard', async () => {
  const c = await scene(); await choose(c); await fill();
  active.defer = 'saveIdeaOutcome'; const held = active;
  await page.getByTestId('artifact-idea-outcome-save').click();
  while (!held.finish) await new Promise(done => setTimeout(done, 20));
  const other = await scene();
  await page.getByTestId('artifact-idea-plan-revise').click();
  await page.getByLabel('可证伪条件', {exact: true}).fill('New scope unsaved content.');
  held.finish();
  await page.getByText('方法计划含未保存修改，保存或放弃后可关闭工件。', {exact: true}).waitFor();
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), true);
  assert.equal(await page.getByTestId('artifact-idea-outcome-form').count(), 0);
  await page.keyboard.press('Escape'); await expect(page.getByTestId('artifact-inspector-panel')).toBeVisible();
  assert.equal(history(c).total, 1); assert.equal(history(other).total, 0);
  await page.getByTestId('artifact-idea-plan-discard').click();
  await scene(c); await page.getByTestId('artifact-idea-outcome-open').click();
  await page.getByTestId('artifact-idea-outcome-plan').first().click();
  await page.getByTestId('artifact-idea-outcome-runs').click();
  await page.getByLabel('实际实验运行', {exact: true}).selectOption(run.id);
  active.defer = 'getExperimentResult'; const heldRead = active;
  await page.getByTestId('artifact-idea-outcome-result').filter({hasText: result.snapshot.id}).click();
  while (!heldRead.finish) await new Promise(done => setTimeout(done, 20));
  await scene(other); heldRead.finish();
  assert.equal(await page.getByTestId('artifact-idea-outcome-form').count(), 0);
});
test('narrow light/dark drawer retains visible focus, local scrolling and unclipped shadows with reduced motion', async () => {
  const c = await scene(); await choose(c); await fill();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(650, 900));
  await page.emulateMedia({reducedMotion: 'reduce'});
  const auditSource = await readFile(resolve('.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8'), audits = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    const note = page.getByLabel('结果评估审核说明', {exact: true});
    await note.scrollIntoViewIfNeeded(); await note.focus(); await expect(note).toBeFocused();
    assert.equal(await note.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    for (const state of ['editing', 'hover', 'expanded']) {
      if (state === 'hover') await page.getByTestId('artifact-idea-outcome-save').hover();
      if (state === 'expanded') {
        const summary = page.locator('[data-reading-key="raw-snapshot-summary"]');
        await summary.focus(); await page.keyboard.press('Enter');
        await expect(page.locator('[data-reading-key="raw-snapshot"] pre')).toBeVisible();
      }
      const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      audits.push({theme, state, ...audit}); assert.equal(audit.cut, 0); assert.equal(audit.hidden, 3);
      assert.deepEqual(audit.issues.map(issue => issue.side).sort(), ['bottom', 'right', 'top']);
    }
    await page.locator('[data-reading-key="raw-snapshot-summary"]').click();
    await note.scrollIntoViewIfNeeded(); await note.focus();
    assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({path: join(artifacts, `${theme}-outcome.png`)});
  }
  await writeFile(join(artifacts, 'audits.json'), JSON.stringify(audits, null, 2)); assert.equal(history(c).total, 0);
});
test('source drift removes current verification while stored historical receipts remain readable in archived scope', async () => {
  const c = await scene(); await choose(c); await fill();
  await page.getByTestId('artifact-idea-outcome-save').click(); await page.getByText('反驳假设 评估版本 1', {exact: false}).waitFor();
  f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  await scene(c); await page.getByTestId('artifact-idea-outcome-open').click(); await page.getByTestId('artifact-idea-outcome-plan').first().click();
  await page.getByTestId('artifact-idea-outcome-history-select').first().click();
  await page.getByTestId('artifact-idea-outcome-verify').click(); await page.getByTestId('artifact-idea-outcome-verified').waitFor();
  const path = join(f.repository.experiments.root(f.project.id, run.id), 'input/analysis.py'), original = await readFile(path);
  try {
    await chmod(path, 0o600); await writeFile(path, Buffer.concat([original, Buffer.from('\n# host drift\n')]));
    const receipt = history(c).items[0];
    await assert.rejects(outcomes.get({projectId: f.project.id, artifactId: c.artifact.id,
      outcomeId: receipt.snapshot.id, expectedHash: receipt.snapshotHash}), /research_experiment_snapshot_changed/u);
    await page.getByTestId('artifact-idea-outcome-verify').click();
    await page.getByRole('alert').filter({hasText: '实际实验文件已变化，无法复核结果评估。'}).waitFor();
    assert.equal(active.verificationError.code, 'research_experiment_snapshot_changed');
    assert.equal(await page.getByTestId('artifact-idea-outcome-verified').count(), 0);
    await expect(page.getByTestId('artifact-idea-outcome-stored')).toContainText(history(c).items[0].snapshotHash);
    assert.equal(history(c).total, 1);
  } finally {await writeFile(path, original); await chmod(path, 0o400);}
});
