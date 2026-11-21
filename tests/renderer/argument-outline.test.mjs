import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {createResearchFixture, loadResearchTestApi, unknownExperiment} from '../unit/fixtures/research-test-kit.mjs';

let api, app, page, directory, active, windowId;
const fixtures = [], calls = [], errors = [];
const routes = {
  inspectArtifact: ['roc:research:artifact-inspect', 'research.inspectArtifact'],
  listArtifacts: ['roc:research:artifacts-list', 'research.listArtifacts'],
  inspectArgumentOutline: ['roc:research:argument-outline-inspect', 'research.inspectArgumentOutline'],
  saveArgumentOutline: ['roc:research:argument-outline-save', 'research.saveArgumentOutline'],
  getArgumentOutlineHistory: ['roc:research:argument-outline-history', 'research.getArgumentOutlineHistory'],
  materializeArgumentOutline: ['roc:research:argument-outline-materialize', 'research.materializeArgumentOutline']
};
before(async () => {
  api = await loadResearchTestApi();
  directory = await mkdtemp(join(tmpdir(), 'roc-outline-ui-'));
  await buildViteRenderer({directory, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}', script: `
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
    app.whenReady().then(()=>new BrowserWindow({show:false,width:960,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  windowId = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.id);
  await page.exposeFunction('callMain', async (method, input) => {
    calls.push({method, input}); api.parseIpcRequestArgs(routes[method][0], [input]);
    const f = active, result = await f.bridge.invoke(routes[method][1], [input], windowId);
    if (f.loseReply === method) {
      delete f.loseReply; assert.equal(result.ok, true, JSON.stringify(result));
      return {ok: false, error: {code: 'fixture_reply_lost', category: 'degraded', retryable: true, message: '大纲已保存，回执未送达。'}};
    }
    if (f.defer === method) await new Promise(done => {f.release = done;});
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
  const projectId = f.project.id;
  const notes = f.repository.createArtifact({projectId, stage: 'reading', kind: 'reading_notes', title: 'Source notes', path: null});
  const evidence = (id, content) => {
    f.repository.knowledge.upsertFromSource({id, projectId, sourceType: 'file', sourceId: `${id}.txt`, title: id,
      content, chunks: [{content, locator: 'block:0'}], embeddingPolicy: 'none'});
    return f.repository.evidence.capture({projectId, chunkId: `${id}:chunk:0`});
  };
  const original = evidence('original', 'The original measured setting.'), counter = evidence('counter', 'An unconfirmed boundary condition.');
  const claim = f.repository.evidence.createClaim({projectId, artifactId: notes.id, subjectType: 'paragraph',
    status: 'supported', content: 'The reported improvement applies to the measured setting.', evidenceIds: [original.id], experiment: {...unknownExperiment}});
  const pending = f.repository.evidence.createClaim({projectId, artifactId: notes.id, subjectType: 'paragraph',
    status: 'hypothesis', content: 'Generalization remains a hypothesis.', evidenceIds: [counter.id], experiment: {...unknownExperiment}});
  const propose = (kind, source) => f.repository.evidence.relations.propose({projectId, claimId: claim.id,
    expectedClaimVersion: claim.version, evidenceId: source.id,
    expectedSourceDigest: api.relationSourceDigest(f.repository.evidence.inspectEvidence(source.id, projectId)),
    kind, condition: null, supersedesRelationId: null}, {kind: 'agent', id: f.run.id});
  const support = propose('supports', original);
  f.repository.evidence.relations.review({projectId, relationId: support.id, expectedVersion: support.version,
    expectedClaimVersion: claim.version, expectedSourceDigest: support.sourceDigest, decision: 'confirm', note: 'Read the original setting.'},
  {kind: 'user', id: 'window:73'});
  propose('contradicts', counter);
  f.repository.runs.terminate(f.run.id, projectId, 'cancelled', 'fixture_ready');
  f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(notes.id);
  f.db.prepare("UPDATE research_projects SET current_stage='writing',status='active' WHERE id=?").run(projectId);
  f.db.prepare("UPDATE research_stage_states SET status='ready' WHERE project_id=? AND stage='writing'").run(projectId);
  const handlers = new Map(), context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchArgumentOutlineCapabilities(context, f.repository.argumentOutlines);
  handlers.set('research.artifacts.list', input => f.repository.listArtifacts(input.projectId));
  return {...f, notes, claim, pending,
    bridge: api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)})};
}

test('real matrix and explicit outline produce one unapproved manuscript without transferring scientific confirmation', async () => {
  active = scene(); const f = active, projectId = f.project.id;
  await page.evaluate(request => window.mount(request), {projectId, artifactId: f.notes.id, expectedVersion: null});
  await page.getByTestId('artifact-outline-toggle').waitFor();
  assert.deepEqual(calls.map(call => call.method), ['inspectArtifact']);
  await page.getByTestId('artifact-outline-toggle').focus(); await page.keyboard.press('Enter');
  const panel = page.getByTestId('artifact-outline');
  await panel.getByTestId('artifact-outline-matrix').locator('summary').first().click();
  await expect(panel.getByTestId('artifact-outline-matrix').getByText(f.claim.content, {exact: true})).toBeVisible();
  await expect(panel.getByTestId('artifact-outline-matrix').getByText(f.pending.content, {exact: true})).toBeVisible();
  const matrices = await panel.getByTestId('artifact-outline-matrix').innerText();
  assert.match(matrices, /支持[\s\S]*确认 1[\s\S]*提议 0/u);
  assert.match(matrices, /反对[\s\S]*确认 0[\s\S]*提议 1/u);
  await panel.getByRole('button', {name: '添加章节', exact: true}).click();
  await panel.getByLabel('章节标题', {exact: true}).fill('Results');
  await panel.getByLabel('本节问题', {exact: true}).fill('What is supported in the measured setting?');
  await panel.getByRole('checkbox', {name: f.claim.content, exact: true}).check();
  await expect(panel.getByRole('checkbox', {name: `${f.pending.content}（依据待处理）`, exact: true})).toBeDisabled();
  await panel.getByLabel('适用条件（每行一项）', {exact: true}).fill('Measured population\nRecorded configuration');
  await panel.getByLabel('论证缺口（每行一项）', {exact: true}).fill('External replication is not recorded.');
  await panel.getByLabel('大纲修订理由', {exact: true}).fill('Keep the setting and counterevidence explicit.');
  await expect(page.getByTestId('artifact-inspector-refresh')).toBeDisabled();
  f.loseReply = 'saveArgumentOutline';
  await panel.getByTestId('artifact-outline-save').click();
  await expect(panel.getByRole('alert')).toContainText('回执未送达');
  await panel.getByTestId('artifact-outline-save').click();
  await expect(panel).toContainText('大纲版本 1');
  const saved = f.repository.argumentOutlines.inspect({projectId, artifactId: f.notes.id}).latest;
  assert.equal(saved.snapshot.actor.id, `window:${windowId}`);
  assert.deepEqual(saved.snapshot.request.sections[0].claimIds, [f.claim.id]);
  assert.deepEqual(saved.snapshot.request.sections[0].conditions, ['Measured population', 'Recorded configuration']);
  assert.deepEqual(calls.filter(call => call.method === 'saveArgumentOutline').map(call => call.input), [saved.snapshot.request, saved.snapshot.request]);
  await panel.getByRole('button', {name: '从大纲生成正文', exact: true}).click();
  await panel.getByLabel('新正文标题', {exact: true}).fill('Evidence synthesis');
  const audit = await readFile('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(620, 800));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await panel.getByLabel('新正文标题', {exact: true}).focus();
    assert.equal((await page.evaluate(`(${audit})({root:'body',viewport:true})`)).cut, 0);
    assert.equal(await panel.evaluate(element => element.scrollWidth > element.clientWidth), false);
  }
  f.defer = 'materializeArgumentOutline';
  await panel.getByTestId('artifact-outline-materialize').click();
  await expect(page.getByTestId('artifact-inspector-close')).toBeDisabled();
  await expect.poll(() => typeof f.release).toBe('function'); f.release();
  await panel.getByTestId('artifact-outline-materialized').waitFor();
  const generated = f.repository.listArtifacts(projectId).find(artifact => artifact.kind === 'manuscript');
  assert.equal(generated.status, 'draft'); assert.equal(generated.title, 'Evidence synthesis');
  const claims = f.repository.evidence.listClaims({projectId, artifactId: generated.id});
  assert.equal(claims.length, 1); assert.equal(claims[0].content, f.claim.content);
  assert.equal(f.repository.evidence.relations.forArtifact(generated.id, projectId).length, 0);
  assert.throws(() => f.repository.evidence.assertReviewedSupport(claims[0]), error => error.code === 'research_relation_review_required');
  assert.equal(f.repository.evidence.listClaims({projectId, artifactId: f.notes.id}).length, 2);
});
