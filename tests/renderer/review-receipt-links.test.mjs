import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewScreeningPlanFixture, reviewScreeningActorFixture as actor} from '../unit/fixtures/research-review-screening.mjs';
import {createReviewQualityFixture} from '../unit/fixtures/research-review-quality.mjs';

let api, directory, app, page, active, windowId;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/pr09-a7d2b-ui');
const channels = {
  getReviewProtocol: 'roc:research:review-protocol-get',
  getReviewCorpus: 'roc:research:review-corpus-get',
  getReviewCorpusHit: 'roc:research:review-corpus-hit',
  getReviewReport: 'roc:research:review-report-get'
};
const tid = id => page.getByTestId(id);

before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-review-receipt-links-'));
  mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    import {ToolCallBlock} from './src/renderer/assistant/blocks/tool-call-block';
    import {ReviewLinkActionsProvider} from './src/renderer/assistant/blocks/review-link-actions';
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(channels))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    const root=createRoot(document.getElementById('root'));
    function Harness({output,projectId}) {
      const [selection,setSelection]=useState(null),[readingLocations]=useState(()=>new Map()),[reviewDrafts]=useState(()=>new Map());
      return <main><ReviewLinkActionsProvider value={{projectId,open:request=>setSelection({kind:'review',request})}}>
        <ToolCallBlock block={{id:'exact-review-call',kind:'tool_call',name:'research_review_read',status:'end',input:null,output,error:null}}/>
        {selection===null?null:<ArtifactInspector key={JSON.stringify(selection.request)} client={client} selection={selection}
          writable={true} readingLocations={readingLocations} reviewDrafts={reviewDrafts}
          onClose={()=>setSelection(null)} onOpenTask={()=>{throw new Error('readonly cannot open task')}}/>}
      </ReviewLinkActionsProvider></main>;
    }
    let generation=0;
    window.mount=(output,projectId)=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} output={output} projectId={projectId}/></LazyMotion></MotionConfig>));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}main{padding:16px;max-width:440px}'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (/Encountered two children with the same key|Each child in a list should have a unique/u.test(message.text())) errors.push(message.text());});
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const f = active; calls.push({method, input});
    api.parseIpcRequestArgs(channels[method], [input]);
    if (f.failMethod === method) return {ok: false, error: {message: 'Synthetic actual read failure'}};
    const result = await f.bridge.invoke(`research.${method}`, [input], windowId);
    if (f.deferMethod === method) return new Promise(resolve => {f.release = () => resolve(result); f.started();});
    return result;
  });
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();}
  finally {
    for (const f of fixtures) await (f.cleanup ? f.cleanup() : f.dispose());
    api?.dispose(); if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function fixture(report = false) {
  const f = report ? await createReviewQualityFixture(api) : await createReviewScreeningPlanFixture(api);
  const registry = new api.CapabilityRegistry(), context = {pluginId: 'research', capabilities: registry};
  const register = (descriptors, run) => {for (const descriptor of descriptors) registry.declare('research', descriptor); run();};
  register(api.researchSystematicReviewCapabilities, () => api.registerResearchSystematicReviewCapabilities(context, f.repository.systematicReviews));
  register(api.researchReviewCorpusCapabilities, () => api.registerResearchReviewCorpusCapabilities(context, f.corpora));
  if (report) {
    f.studies = new api.ResearchReviewStudiesRepository(f.db, f.repository, f.fullFreezing, f.fulltexts, () => f.time);
    f.assessments = new api.ResearchReviewQualityAssessmentRepository(f.db, f.repository, f.qualityPlans, f.extractions, f.fullFreezing, () => f.time);
    f.reports = new api.ResearchReviewReportService(f.db, f.repository, f.corpora, f.reviews, f.dedup, f.freezing,
      f.fullFreezing, f.studies, f.extractions, f.qualityPlans, f.assessments);
    register([api.researchReviewReportCapability], () => api.registerResearchReviewReportCapability(context, f.reports));
  }
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => registry.invoke(name, input)});
  f.read = api.createResearchTools({capabilities: registry, projectId: f.project.id, signal: new AbortController().signal,
    dispatchStage: async () => assert.fail('no stage dispatch')}).find(tool => tool.name === 'research_review_read');
  f.projectOutput = api.createToolOutputProjector({artifactStore: new api.ContextArtifactStore(f.agentDb),
    runId: 'exact-links-run', threadId: 'exact-links-thread', workspaceHash: 'exact-links-workspace'});
  fixtures.push(f); return f;
}
async function output(f, kind = 'protocol') {
  const request = kind === 'protocol' ? {kind, versionId: f.protocol.version.id} :
    kind === 'corpus' ? {kind, corpusId: f.get.corpusId, offset: 0, limit: 1} :
      {kind: 'report', corpusId: f.get.corpusId, section: 'records', offset: 0, limit: 30};
  const value = await f.read.invoke({type: 'tool_call', id: `sdk-exact-${kind}`, name: f.read.name, args: request});
  return f.projectOutput({callId: `exact-${kind}`, name: f.read.name, output: value});
}
async function mount(f, value) {
  active = f;
  await page.emulateMedia({colorScheme: 'light'}); await page.setViewportSize({width: 1100, height: 900});
  await page.evaluate(({value, projectId}) => {document.documentElement.dataset.theme = 'light'; window.mount(value, projectId);},
    {value, projectId: f.project.id});
  await tid('assistant-review-links').waitFor();
}
async function open() {
  await tid('assistant-review-link').focus(); await page.keyboard.press('Enter');
  await tid('artifact-review-readonly').waitFor();
}
async function audit(label) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="artifact-inspector-panel"]');
    return panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(panel).transform === 'none';
  });
  const source = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const result = await page.evaluate(`(${source})({root:'body',viewport:true})`);
  assert.equal(result.cut, 0); writeFileSync(join(artifacts, `${label}-audit.json`), JSON.stringify(result, null, 2));
  await page.screenshot({path: join(artifacts, `${label}.png`)});
}

test('real assistant protocol link opens exact readonly receipt in one drawer and Escape restores its keyboard opener', async () => {
  const f = await fixture(), value = await output(f), before = f.changes(), at = calls.length;
  await mount(f, value); await open(); await tid('artifact-review-readonly-protocol').waitFor();
  assert.match(await tid('artifact-review-readonly-protocol').innerText(), new RegExp(f.protocol.versionHash));
  assert.equal(await tid('artifact-inspector-panel').count(), 1);
  assert.equal(await tid('artifact-review-new').count(), 0); assert.equal(await tid('artifact-review-save').count(), 0);
  assert.deepEqual(calls.slice(at).map(call => call.method), ['getReviewProtocol']);
  assert.equal(f.changes(), before); await audit('protocol-default');
  await tid('artifact-review-readonly-refresh').hover(); await audit('protocol-hover');
  const target = page.getByText('链接目标与校验依据', {exact: true});
  await target.click(); await target.locator('..').locator('pre').waitFor({state: 'visible'}); await audit('protocol-target-expanded');
  await page.keyboard.press('Escape'); await tid('artifact-inspector-panel').waitFor({state: 'detached'});
  assert.equal(await tid('assistant-review-link').evaluate(element => element === document.activeElement), true);
});

test('exact corpus link reads raw hit identities and frozen sources without querying a capped list or exposing record selection', async () => {
  const f = await fixture(), value = await output(f, 'corpus'), before = f.changes(), at = calls.length;
  await mount(f, value); await open(); await tid('artifact-review-corpus-record').first().waitFor();
  assert.match(await tid('artifact-review-readonly-corpus').innerText(), /准确语料原始记录 8/u);
  assert.equal(await tid('artifact-review-corpus-record').count(), 8);
  assert.equal(await tid('artifact-review-record-left').count(), 0); assert.equal(await tid('artifact-review-record-right').count(), 0);
  assert.equal(calls.slice(at).some(call => call.method.startsWith('list')), false);
  assert.equal(calls.slice(at).filter(call => call.method === 'getReviewCorpus').length, 1);
  assert.deepEqual(calls.slice(at).filter(call => call.method === 'getReviewCorpusHit').map(call => call.input.hitId), f.corpus.snapshot.hits.map(hit => hit.id));
  assert.equal(f.changes(), before); await tid('artifact-review-readonly-corpus').scrollIntoViewIfNeeded(); await audit('corpus-records');
});

test('incorrect protocol/freeze hash and actual read failures show errors without displaying a current receipt as the requested version', async () => {
  const f = await fixture(), actual = await output(f);
  for (const field of ['expectedVersionHash', 'expectedFreezeHash']) {
    const value = structuredClone(actual); api.reviewLinksPayload(value)[0].target[field] = 'a'.repeat(64);
    await mount(f, value); await open(); await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /回执与链接不一致/u);
    assert.equal(await tid('artifact-review-readonly-protocol').count(), 0);
  }
  f.failMethod = 'getReviewProtocol'; await mount(f, actual); await open(); await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Synthetic actual read failure/u);
  assert.equal(await tid('artifact-review-readonly-protocol').count(), 0);
});

test('long actual report output preserves its exact link and displays conserved counts with unreviewed studies and source Evidence', async () => {
  const f = await fixture(true), value = await output(f, 'report'), before = f.changes(), report = f.reports.get(f.get);
  assert.equal(value.kind, 'tool_result_artifact'); assert.equal(api.reviewLinksPayload(value)[0].target.expectedBodyHash, report.bodyHash);
  await mount(f, value); await open(); await tid('artifact-review-report-body').waitFor();
  const counts = await tid('artifact-review-report-counts').innerText();
  assert.match(counts, /识别记录 8 = 移除重复 0 \+ 筛选记录 8/u);
  assert.match(counts, /人工声明研究 尚未审核，未报告/u);
  assert.match(await tid('artifact-review-report-body').innerText(), new RegExp(report.bodyHash));
  assert.equal(await tid('artifact-review-study-form').count(), 0); assert.equal(f.changes(), before);
  await tid('artifact-review-report-counts').scrollIntoViewIfNeeded(); await audit('report-default');
});

test('report mutation after tool capture rejects the old body hash and a newly read exact link opens the new human record', async () => {
  const f = await fixture(true), original = await output(f, 'report');
  await f.qualityPlans.create(f.qualityInput(), actor);
  const before = f.changes(); await mount(f, original); await open(); await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /报告内容已变化/u);
  assert.equal(await tid('artifact-review-report-body').count(), 0);
  const latest = await output(f, 'report'); assert.notEqual(api.reviewLinksPayload(latest)[0].target.expectedBodyHash, api.reviewLinksPayload(original)[0].target.expectedBodyHash);
  await mount(f, latest); await open(); await tid('artifact-review-report-body').waitFor();
  assert.match(await tid('artifact-review-report-body').innerText(), new RegExp(api.reviewLinksPayload(latest)[0].target.expectedBodyHash));
  assert.equal(f.changes(), before);
});

test('archive and reparse keep the exact old report body readable with changed source state in a dark narrow drawer', async () => {
  const f = await fixture(true), value = await output(f, 'report');
  f.reparse(); f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
  const before = f.changes(); await mount(f, value);
  await page.emulateMedia({colorScheme: 'dark'}); await page.setViewportSize({width: 650, height: 820});
  await page.evaluate(() => {document.documentElement.dataset.theme = 'dark';});
  await open(); await tid('artifact-review-report-body').waitFor();
  assert.match(await tid('artifact-review-report-body').innerText(), /全文来源引用已变化/u);
  assert.match(await tid('artifact-review-report-body').innerText(), new RegExp(api.reviewLinksPayload(value)[0].target.expectedBodyHash));
  assert.equal(f.changes(), before); await tid('artifact-review-report-counts').scrollIntoViewIfNeeded(); await audit('report-archive-dark650');
});

test('late readonly completion from a prior project cannot replace the newly opened exact receipt', async () => {
  const prior = await fixture(), next = await fixture(), oldOutput = await output(prior), newOutput = await output(next);
  prior.deferMethod = 'getReviewProtocol'; const started = new Promise(resolve => {prior.started = resolve;});
  await mount(prior, oldOutput); await open(); await started;
  await mount(next, newOutput); await open(); await tid('artifact-review-readonly-protocol').waitFor();
  prior.deferMethod = null; prior.release();
  assert.match(await tid('artifact-review-readonly-protocol').innerText(), new RegExp(next.protocol.versionHash));
  assert.equal((await tid('artifact-review-readonly-protocol').innerText()).includes(prior.protocol.versionHash), false);
});

test('foreign project and invalid structured links cannot invoke an inspector and previews alone cannot create links', async () => {
  const f = await fixture(), value = await output(f), at = calls.length;
  const foreign = structuredClone(value); api.reviewLinksPayload(foreign)[0].projectId = 'foreign-project';
  await mount(f, foreign); assert.equal(await tid('assistant-review-link').isDisabled(), true);
  assert.equal(await tid('artifact-inspector-panel').count(), 0);
  const invalid = structuredClone(value); api.reviewLinksPayload(invalid)[0].target.versionId = '';
  active = f; await page.evaluate(({invalid, projectId}) => window.mount(invalid, projectId), {invalid, projectId: f.project.id});
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /链接无效/u);
  assert.equal(await tid('assistant-review-link').count(), 0);
  await page.evaluate(projectId => window.mount({kind: 'tool_result_artifact', preview: '{"versionId":"guessed"}'}, projectId), f.project.id);
  assert.equal(await tid('assistant-review-link').count(), 0); assert.equal(calls.length, at);
});
