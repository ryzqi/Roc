import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';

let api, app, page, directory, active, windowId;
const fixtures = [], errors = [], calls = [];
const routes = {inspectArtifact: ['roc:research:artifact-inspect', 'research.inspectArtifact'],
  listArtifacts: ['roc:research:artifacts-list', 'research.listArtifacts'],
  inspectResearchImpact: ['roc:research:impact-inspect', 'research.inspectResearchImpact'],
  startResearchRepair: ['roc:research:impact-repair', 'research.startResearchRepair']};

before(async () => {
  api = await loadResearchTestApi();
  directory = await mkdtemp(join(tmpdir(), 'roc-impact-ui-'));
  await buildViteRenderer({directory, style: 'body{margin:0;font-family:-apple-system,sans-serif;background:var(--bg);color:var(--ink)}', script: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domMax} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const client={api:{research:Object.fromEntries(${JSON.stringify(Object.keys(routes))}.map(method=>[method,input=>window.callMain(method,input)]))}};
    const root=createRoot(document.getElementById('root'));
    function Harness({request}) {
      const [open,setOpen]=useState(true),[locations]=useState(()=>new Map()),[drafts]=useState(()=>new Map());
      return open?<ArtifactInspector client={client} selection={{kind:'stage',request,onReviewContext:()=>{}}} writable
        readingLocations={locations} reviewDrafts={drafts} onClose={()=>setOpen(false)} onOpenTask={()=>{}}/>:null;
    }
    window.mount=request=>flushSync(()=>root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
      <Harness request={request}/></LazyMotion></MotionConfig>));
    window.unmount=()=>flushSync(()=>root.render(null));
  `});
  await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:900,height:800}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    const scene = active;
    calls.push({method, input});
    api.parseIpcRequestArgs(routes[method][0], [input]);
    const result = await scene.bridge.invoke(routes[method][1], [input], windowId);
    if (scene.defer === method) await new Promise(done => {scene.release = done;});
    if (scene.loseReply === method) {
      delete scene.loseReply; assert.equal(result.ok, true, JSON.stringify(result));
      return {ok: false, error: {code: 'fixture_reply_lost', category: 'degraded', retryable: true, message: '连接中断，修复计划回执未送达。'}};
    }
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});

after(async () => {
  try {if (page && !page.isClosed()) await page.evaluate(() => window.unmount?.()); await app?.close();}
  finally {for (const f of fixtures) await f.close(); api?.dispose(); if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});

function scene() {
  const f = createResearchFixture(api, 'reading'); fixtures.push(f);
  const source = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes',
    title: 'Change source', path: null});
  const retained = f.repository.createArtifact({projectId: f.project.id, stage: 'reading', kind: 'reading_notes',
    title: 'Retained independent source', path: null});
  f.repository.runs.terminate(f.run.id, f.project.id, 'cancelled', 'fixture_ready');
  f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE project_id=?").run(f.project.id);
  const handlers = new Map();
  const context = {pluginId: 'fixture', capabilities: {register(_pluginId, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchImpactCapabilities(context, f.repository.impact, f.repository.repairs);
  handlers.set('research.artifacts.list', input => f.repository.listArtifacts(input.projectId));
  return {...f, source, retained,
    bridge: api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)})};
}

test('keyboard impact repair retains independent artifacts and an exact lost-reply plan after verifying chosen inputs', async () => {
  active = scene(); const f = active;
  const request = {projectId: f.project.id, artifactId: f.source.id, expectedVersion: null};
  const retainedBefore = f.repository.getArtifact(f.retained.id);
  const retainedVersion = f.repository.inspectArtifact({projectId: f.project.id, artifactId: f.retained.id, expectedVersion: null}).snapshot.version;
  await page.evaluate(request => window.mount(request), request);
  await page.getByTestId('artifact-impact-toggle').waitFor();
  assert.deepEqual(calls.map(call => call.method), ['inspectArtifact']);
  await page.getByTestId('artifact-impact-toggle').focus(); await page.keyboard.press('Enter');
  const panel = page.getByTestId('artifact-impact');
  await expect(panel.getByRole('region', {name: '受影响工件'})).toContainText(f.source.id);
  const report = f.repository.impact.inspect({projectId: f.project.id,
    source: {kind: 'artifact', artifactId: f.source.id, expectedVersion: f.repository.inspectArtifact(request).snapshot.version}});
  assert.deepEqual(report.preservedArtifactIds, [f.retained.id]);
  await panel.getByTestId('artifact-impact-repair-open').click();
  await panel.getByRole('checkbox', {name: 'Change source（阅读）', exact: true}).check();
  await panel.getByRole('checkbox', {name: /^Retained independent source/u}).check();
  await panel.getByLabel('修复理由').fill('Rebuild selected notes from the retained approved source.');
  await expect(page.getByTestId('artifact-inspector-refresh')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await expect(panel.getByRole('checkbox', {name: 'Change source（阅读）', exact: true})).toBeChecked();
  const audit = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(620, 800));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await panel.getByLabel('修复理由').focus();
    assert.equal((await page.evaluate(`(${audit})({root:'body',viewport:true})`)).cut, 0);
    assert.equal(await panel.evaluate(element => element.scrollWidth > element.clientWidth), false);
  }
  f.defer = 'startResearchRepair'; f.loseReply = 'startResearchRepair';
  await panel.getByTestId('artifact-impact-repair-start').click();
  await expect(page.getByTestId('artifact-inspector-close')).toBeDisabled();
  await expect.poll(() => typeof f.release).toBe('function');
  f.release(); delete f.defer;
  await expect(panel.getByRole('alert')).toContainText('修复计划回执未送达');
  const first = calls.find(call => call.method === 'startResearchRepair').input;
  assert.deepEqual(first.targetArtifactIds, [f.source.id]);
  assert.equal(first.expectedReportHash, report.reportHash);
  assert.deepEqual(first.inputs, [{stage: 'reading', artifacts: [{artifactId: f.retained.id,
    expectedVersion: retainedVersion}]}]);
  const inputReads = calls.filter(call => call.method === 'inspectArtifact' && call.input.artifactId === f.retained.id).length;
  await panel.getByTestId('artifact-impact-repair-start').click();
  await expect(page.getByTestId('artifact-inspector-panel')).toContainText('已被替代');
  assert.deepEqual(calls.filter(call => call.method === 'startResearchRepair').map(call => call.input), [first, first]);
  assert.equal(calls.filter(call => call.method === 'inspectArtifact' && call.input.artifactId === f.retained.id).length, inputReads);
  assert.deepEqual(f.repository.getArtifact(f.retained.id), retainedBefore);
  assert.equal(f.db.prepare('SELECT count(*) FROM research_repairs').pluck().get(), 1);
});
