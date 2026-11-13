import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

import {createScientificReviewFixture} from '../unit/fixtures/scientific-review.mjs';

let api, directory, app, page, active;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/response-matrix-ui');
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-response-matrix-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const methods=['inspectArtifact','inspectResponseMatrix','saveResponseMatrix','getResponseMatrixHistory','getGateReviewContext'];
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
    const channel = {inspectArtifact: 'roc:research:artifact-inspect', inspectResponseMatrix: 'roc:research:response-matrix-inspect',
      saveResponseMatrix: 'roc:research:response-matrix-save', getResponseMatrixHistory: 'roc:research:response-matrix-history',
      getGateReviewContext: 'roc:research:gate-review'}[method];
    api.parseIpcRequestArgs(channel, [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], 73);
    const hold = f.holds.get(method);
    if (hold !== undefined) return new Promise(resolve => {
      hold.release = () => resolve(hold.loseReply ? {ok: false, error: {code: 'fixture_reply_lost', message: '审稿矩阵回执连接中断'}} : result);
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

async function scene({long = false, waiting = false, scientific = false, verifierVerdict = 'qualifies'} = {}) {
  const f = scientific ? createScientificReviewFixture(api, {verifierVerdict}) : createResearchFixture(api, 'writing');
  fixtures.push(f); active = f; calls.length = 0; f.holds = new Map();
  if (scientific) f.complete();
  else {
  f.repository.knowledge.upsertFromSource({id: 'response-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'synthetic-measurement.md', title: 'Synthetic measurement',
    content: 'The measured difference was -4 ms.', chunks: [{content: 'The measured difference was -4 ms.', locator: 'block:0'}],
    embeddingPolicy: 'none'});
  f.evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'response-source:chunk:0'});
  f.artifactId = f.withWorker(() => f.repository.runs.complete(f.run.id, f.project.id, {title: '审稿意见与当前修改稿',
    markdown: 'Synthetic response manuscript', claims: [
      {subjectType: 'paragraph', content: `${long ? '逐项核对原始意见、修改稿与测量来源。'.repeat(20) : ''}The measured difference was -4 ms. 𝛥 verified.`,
        status: 'supported', evidenceIds: [f.evidence.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  if (waiting) f.repository.transitionWorkflow({projectId: f.project.id, expectedStage: 'writing', action: 'complete'});
  }
  const handlers = new Map();
  const context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchResponseMatrixCapabilities(context, f.repository.responseMatrix);
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
  f.request = {projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null};
  f.inspect = () => f.repository.responseMatrix.inspect({projectId: f.project.id, artifactId: f.artifactId, expectedHash: null});
  f.history = () => f.repository.responseMatrix.history({projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 100});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  f.hold = (method, loseReply = false) => {
    const value = {ready: Promise.withResolvers(), loseReply}; f.holds.set(method, value); return value;
  };
  await page.evaluate(request => mount(request), f.request);
  await page.getByTestId('artifact-inspector-content').waitFor();
  return f;
}
const report = () => page.getByTestId('artifact-response-matrix');
const editor = () => page.getByTestId('artifact-response-editor');
const row = () => page.getByTestId('artifact-response-row');
async function openReport() {
  await page.getByTestId('artifact-response-toggle').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-response-hash').waitFor();
}
async function openEditor() {
  await page.getByTestId('artifact-response-edit').focus(); await page.keyboard.press('Enter');
  await editor().waitFor();
}
async function newComment(f, {status = 'addressed', location = true, evidence = true} = {}) {
  await page.getByTestId('artifact-response-new').click();
  await row().getByRole('textbox', {name: '审稿人', exact: true}).fill('Reviewer 1');
  await row().getByRole('textbox', {name: '原始审稿意见', exact: true}).fill('Report the signed difference and exact revised location.');
  await row().getByRole('combobox', {name: '人工处理状态', exact: true}).selectOption(status);
  if (status !== 'open') await row().getByRole('textbox', {name: '审稿回复或未采纳理由', exact: true}).fill('The current Results paragraph reports -4 ms.');
  if (location) {
    await row().getByRole('combobox', {name: '选择修改稿段落', exact: true}).selectOption(f.claim.id);
    await page.getByTestId('artifact-response-whole-paragraph').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-response-location-add"]').disabled);
    await page.getByTestId('artifact-response-location-add').focus(); await page.keyboard.press('Enter');
    await page.getByTestId('artifact-response-locations').getByText(f.claim.content, {exact: true}).waitFor();
  }
  if (evidence) await row().getByRole('checkbox', {name: `关联证据 ${f.evidence.id}`, exact: true}).check();
  await editor().getByRole('textbox', {name: '矩阵修订理由', exact: true}).fill('Human comparison with current revised text.');
}
async function declare(f, number, {status = 'open'} = {}) {
  const current = f.inspect(), parent = current.report.review;
  const rows = parent?.snapshot.request.rows ?? [{commentId: 'r1-c1', reviewer: 'Reviewer 1', comment: 'Report the signed difference.',
    status, response: status === 'open' ? '' : 'Exact paragraph now reports the signed difference.',
    locations: status === 'addressed' ? [{claimId: f.claim.id, claimHash: api.relationClaimHash(f.claim),
      start: 0, end: f.claim.content.length, text: f.claim.content}] : [], evidenceIds: [f.evidence.id]}];
  return api.withResearchHumanContext({capability: 'research.responseMatrix.save', projectId: f.project.id, windowId: 73},
    () => f.repository.responseMatrix.save({projectId: f.project.id, artifactId: f.artifactId, requestId: `history-${number}`,
      expectedArtifactVersion: current.report.artifactVersion,
      parent: parent === null ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash},
      rationale: `Human response revision ${number}.`, rows}));
}

test('lazy keyboard entry saves exact human matrix and locks the drawer across dirty draft and lost reply retry', async () => {
  const f = await scene({waiting: true});
  assert.equal(calls.some(call => call.method === 'inspectResponseMatrix'), false);
  await openReport(); await openEditor(); await newComment(f);
  const locked = ['artifact-inspector-refresh', 'artifact-inspector-review',
    'artifact-citation-coverage-toggle', 'artifact-consistency-toggle', 'artifact-response-toggle',
    'artifact-response-refresh', 'artifact-response-history-open', 'artifact-response-edit'];
  for (const id of locked) assert.equal(await page.getByTestId(id).isDisabled(), true, id);
  await page.keyboard.press('Escape');
  await page.getByTestId('artifact-draft-discard-panel').waitFor();
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await page.getByTestId('artifact-draft-discard-panel').waitFor({state:'detached'});
  assert.equal(await page.getByTestId('artifact-inspector-panel').count(), 1);
  await editor().getByRole('textbox', {name: '矩阵修订理由', exact: true}).fill('');
  await page.getByTestId('artifact-response-save').click();
  assert.equal(calls.some(call => call.method === 'saveResponseMatrix'), false);
  await editor().getByRole('textbox', {name: '矩阵修订理由', exact: true}).fill('Human comparison with current revised text.');
  const write = f.hold('saveResponseMatrix', true);
  await page.getByTestId('artifact-response-save').focus(); await page.keyboard.press('Enter'); await write.ready.promise;
  assert.equal(await page.getByTestId('artifact-response-save').isDisabled(), true);
  assert.equal(await page.getByTestId('artifact-response-discard').isDisabled(), true);
  const saved = f.history().items[0], before = f.changes();
  assert.deepEqual(saved.snapshot.actor, {kind: 'user', id: 'window:73'});
  assert.equal(saved.snapshot.request.rows[0].status, 'addressed');
  assert.deepEqual(saved.snapshot.request.rows[0].locations, [{claimId: f.claim.id, claimHash: api.relationClaimHash(f.claim),
    start: 0, end: f.claim.content.length, text: f.claim.content}]);
  write.release(); await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').innerText(), /回执连接中断/u);
  f.holds.delete('saveResponseMatrix');
  await page.getByTestId('artifact-response-save').click();
  await editor().waitFor({state: 'hidden'}); await page.getByTestId('artifact-response-hash').waitFor();
  const writes = calls.filter(call => call.method === 'saveResponseMatrix');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].input, writes[1].input);
  assert.equal(f.changes(), before); assert.equal(f.history().total, 1);
  assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
  await openEditor();
  assert.equal(await row().getByRole('textbox', {name: '审稿人', exact: true}).getAttribute('readonly'), '');
  assert.equal(await row().getByRole('textbox', {name: '原始审稿意见', exact: true}).getAttribute('readonly'), '');
  await row().getByRole('textbox', {name: '审稿回复或未采纳理由', exact: true}).fill('Uncommitted replacement');
  await page.getByTestId('artifact-response-discard').click();
  assert.equal(await row().getByRole('textbox', {name: '审稿回复或未采纳理由', exact: true}).inputValue(), saved.snapshot.request.rows[0].response);
  assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), false);
});

test('open comments stay unhandled, addressed requires location, and declined keeps an explicit human reason', async () => {
  const f = await scene(); await openReport(); await openEditor(); await newComment(f, {status: 'open', location: false, evidence: false});
  await page.getByTestId('artifact-response-save').click(); await editor().waitFor({state: 'hidden'});
  await page.getByTestId('artifact-response-comments').waitFor();
  assert.deepEqual(f.inspect().report.openCommentIds, [f.history().items[0].snapshot.request.rows[0].commentId]);
  assert.deepEqual(f.inspect().report.addressedCommentIds, []);
  await openEditor();
  await row().getByRole('combobox', {name: '人工处理状态', exact: true}).selectOption('addressed');
  await row().getByRole('textbox', {name: '审稿回复或未采纳理由', exact: true}).fill('Reply without exact location');
  await editor().getByRole('textbox', {name: '矩阵修订理由', exact: true}).fill('Review of treatment.');
  const before = calls.filter(call => call.method === 'saveResponseMatrix').length;
  await page.getByTestId('artifact-response-save').click(); await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').innerText(), /修改位置/u);
  assert.equal(calls.filter(call => call.method === 'saveResponseMatrix').length, before);
  await row().getByRole('combobox', {name: '人工处理状态', exact: true}).selectOption('declined');
  await row().getByRole('textbox', {name: '审稿回复或未采纳理由', exact: true}).fill('Negative measurements remain in the declared study.');
  await page.getByTestId('artifact-response-save').click(); await editor().waitFor({state: 'hidden'});
  await page.getByTestId('artifact-response-comments').getByText(/未采纳/u).waitFor();
  assert.equal(f.history().items[0].snapshot.request.rows[0].status, 'declined');
  assert.equal(f.history().items[0].snapshot.request.rows[0].locations.length, 0);
});

test('current source failure hides old successful report while paged complete stored history remains available', async () => {
  const f = await scene(), receipts = [];
  for (let i = 1; i <= 12; i++) receipts.push(await declare(f, i));
  await page.evaluate(request => mount(request), f.request); await openReport();
  const hold = f.hold('getResponseMatrixHistory');
  await page.getByTestId('artifact-response-history-open').click(); await hold.ready.promise;
  assert.equal(await page.getByTestId('artifact-response-history').count(), 0);
  f.holds.delete('getResponseMatrixHistory'); hold.release();
  const history = page.getByTestId('artifact-response-history'); await history.waitFor();
  assert.equal(await history.getByTestId('artifact-response-receipt').count(), 10);
  await page.getByTestId('artifact-response-history-next').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="artifact-response-history"] [data-testid="artifact-response-receipt"]').length === 2);
  const receipt = history.getByTestId('artifact-response-receipt').last();
  await receipt.locator('> summary').focus(); await page.keyboard.press('Enter');
  await receipt.locator('details summary').waitFor({state: 'visible'});
  await receipt.locator('details summary').focus(); await page.keyboard.press('Enter');
  await receipt.locator('pre').waitFor({state: 'visible'});
  assert.deepEqual(JSON.parse(await receipt.locator('pre').innerText()), receipts[0]);
  f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
  await page.getByTestId('artifact-response-refresh').click(); await report().getByRole('alert').waitFor();
  assert.match(await report().getByRole('alert').innerText(), /正文主张或来源已变化|证据来源已更新/u);
  assert.equal(await page.getByTestId('artifact-response-hash').count(), 0);
  await page.getByTestId('artifact-response-history-open').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="artifact-response-history"] [data-testid="artifact-response-receipt"]').length === 10);
  assert.match(await history.innerText(), /历史来源未按当前版本复核/u);
});

test('revised manuscript shows historical dispositions and parent/source conflicts preserve the draft', async () => {
  const f = await scene(); await declare(f, 1, {status: 'addressed'});
  f.claim = f.repository.evidence.updateClaim({id: f.claim.id, expectedVersion: f.claim.version,
    content: 'The revised Results text preserves -4 ms.', status: 'supported', evidenceIds: [f.evidence.id]});
  f.repository.manuscripts.saveManuscript({artifactId: f.artifactId, sections: [{title: 'Revised Results', claimIds: [f.claim.id]}]});
  await page.evaluate(request => mount(request), f.request); await openReport();
  await page.getByTestId('artifact-response-source-changed').waitFor();
  assert.match(await page.getByTestId('artifact-response-comments').innerText(), /已处理（历史判断）/u);
  assert.equal(f.inspect().report.reviewCurrent, false);
  for (const conflict of ['parent', 'source']) {
    const next = await scene(); await openReport(); await openEditor(); await newComment(next);
    if (conflict === 'parent') await declare(next, 1);
    else next.repository.evidence.invalidateChunksOf(next.evidence.documentId);
    const before = next.changes();
    await page.getByTestId('artifact-response-save').click(); await editor().getByRole('alert').waitFor();
    assert.match(await editor().getByRole('alert').innerText(), conflict === 'parent' ? /已有新版本/u : /修改稿版本已变化/u);
    assert.equal(next.changes(), before);
    assert.equal(await row().getByRole('textbox', {name: '审稿回复或未采纳理由', exact: true}).inputValue(), 'The current Results paragraph reports -4 ms.');
    assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), true);
    await page.getByTestId('artifact-response-discard').click();
    assert.equal(await row().count(), 0);
    assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), false);
  }
});

test('late saved report and history replies cannot populate or refresh a different project', async () => {
  const first = await scene(); await openReport(); await openEditor(); await newComment(first);
  const write = first.hold('saveResponseMatrix');
  await page.getByTestId('artifact-response-save').click(); await write.ready.promise;
  const second = await scene(); await openReport();
  const reads = calls.filter(call => call.method === 'inspectArtifact').length;
  first.holds.delete('saveResponseMatrix'); write.release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(calls.filter(call => call.method === 'inspectArtifact').length, reads);
  assert.equal(await page.getByTestId('artifact-response-hash').innerText(), second.inspect().reportHash);
  const late = second.hold('inspectResponseMatrix');
  await page.getByTestId('artifact-response-refresh').click(); await late.ready.promise;
  await page.getByTestId('artifact-response-hash').waitFor({state: 'hidden'});
  const third = await scene(); await openReport();
  second.holds.delete('inspectResponseMatrix'); late.release();
  assert.equal(await page.getByTestId('artifact-response-hash').innerText(), third.inspect().reportHash);
  const history = third.hold('getResponseMatrixHistory');
  await page.getByTestId('artifact-response-history-open').click(); await history.ready.promise;
  await scene(); await openReport();
  third.holds.delete('getResponseMatrixHistory'); history.release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId('artifact-response-history').count(), 0);
});

test('readonly approved archived and inactive-stage matrices send no save requests', async () => {
  for (const state of ['client', 'approved', 'archived', 'inactive']) {
    const f = await scene();
    if (state === 'client') await page.evaluate(() => setWritable(false));
    else {
      if (state === 'approved') f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifactId);
      if (state === 'archived') f.db.prepare("UPDATE research_projects SET status='archived' WHERE id=?").run(f.project.id);
      if (state === 'inactive') f.db.prepare("UPDATE research_projects SET current_stage='export' WHERE id=?").run(f.project.id);
      await page.evaluate(request => mount(request), f.request);
    }
    await openReport(); await openEditor();
    assert.equal(await page.getByTestId('artifact-response-new').isDisabled(), true, state);
    assert.equal(await page.getByTestId('artifact-response-save').isDisabled(), true, state);
    assert.equal(calls.some(call => call.method === 'saveResponseMatrix'), false, state);
  }
});

test('current draft preserves whitespace UTF-16 selection and can discard an unrecorded new opinion', async () => {
  const f = await scene(); await openReport(); await openEditor();
  await newComment(f, {location: false, evidence: false});
  await row().getByRole('combobox', {name: '选择修改稿段落', exact: true}).selectOption(f.claim.id);
  const start = f.claim.content.indexOf(' 𝛥'), end = start + ' 𝛥 '.length;
  await row().getByRole('spinbutton', {name: '起始字符', exact: true}).fill(String(start));
  await row().getByRole('spinbutton', {name: '结束字符', exact: true}).fill(String(end));
  await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-response-location-add"]').disabled);
  await page.getByTestId('artifact-response-location-add').click();
  await page.getByTestId('artifact-response-save').click(); await editor().waitFor({state: 'hidden'});
  assert.equal(f.history().items[0].snapshot.request.rows[0].locations[0].text, ' 𝛥 ');
  assert.equal(f.history().items[0].snapshot.request.rows[0].locations[0].end - start, 4);
  await openEditor(); await page.getByTestId('artifact-response-new').click();
  await row().getByRole('textbox', {name: '原始审稿意见', exact: true}).fill('Unrecorded opinion');
  await page.getByTestId('artifact-response-remove-new').click();
  assert.equal(await row().count(), 0);
  await page.getByTestId('artifact-response-discard').click();
  assert.equal(await row().getByRole('textbox', {name: '原始审稿意见', exact: true}).inputValue(),
    'Report the signed difference and exact revised location.');
  assert.equal(f.history().total, 1);
});

test('candidate positions refuse whole save and long controls fit narrow themes reduced motion and exact clip audit', async () => {
  const f = await scene({long: true}); await openReport(); await openEditor(); await newComment(f);
  await row().getByRole('combobox', {name: '选择修改稿段落', exact: true}).selectOption(f.claim.id);
  await page.getByTestId('artifact-response-whole-paragraph').click();
  await page.getByTestId('artifact-response-save').click(); await editor().getByRole('alert').waitFor();
  assert.match(await editor().getByRole('alert').innerText(), /先关联或清空/u);
  assert.equal(calls.some(call => call.method === 'saveResponseMatrix'), false);
  await editor().getByRole('textbox', {name: '矩阵修订理由', exact: true}).fill('保留原始审稿意见，逐项核对修改位置与当前证据。'.repeat(50));
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  await page.setViewportSize({width: 650, height: 900}); await page.emulateMedia({reducedMotion: 'reduce'});
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const state of ['fields', 'save']) {
      if (state === 'fields') await row().getByRole('spinbutton', {name: '起始字符', exact: true}).scrollIntoViewIfNeeded();
      else {
        await editor().getByRole('textbox', {name: '矩阵修订理由', exact: true}).focus();
        await page.getByTestId('artifact-response-save').scrollIntoViewIfNeeded();
      }
      await page.getByTestId(state === 'fields' ? 'artifact-response-location-add' : 'artifact-response-save').hover();
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
      assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await editor().evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll('select,input:not([type="checkbox"]),textarea')].every(control => {
          const rect = control.getBoundingClientRect();
          return rect.width > 100 && rect.left >= bounds.left && rect.right <= bounds.right;
        });
      }), true);
      await page.screenshot({path: join(artifacts, `${theme}-${state}-650.png`)});
    }
  }
});


test('unrelated and unverifiable advice keeps its label, rationale and coverage in the artifact inspector', async () => {
  for (const [verdict, label, count] of [['unrelated', '与主张无关', 1], ['unable_to_verify', '无法核验', 0]]) {
    const f = await scene({scientific: true, verifierVerdict: verdict});
    const verifier = f.inspect().report.scientificReviews.find(report => report.output.kind === 'verifier');
    await page.evaluate(request => mount(request), {...f.request, artifactId: verifier.artifactId});
    const scientific = page.getByTestId('artifact-scientific-review');
    const summary = scientific.locator('summary').first();
    await summary.waitFor();
    assert.equal(await summary.innerText(), `${label}：${f.claim.content}`);
    await summary.press('Enter');
    await scientific.getByText(verifier.output.suggestions[0].rationale, {exact: true}).first().waitFor();
    assert.match(await scientific.innerText(), new RegExp(`已检查 ${count} / 1 条证据`));
    if (verdict === 'unable_to_verify') {
      await scientific.getByText('未检查原因：Required source inspection was unavailable.', {exact: true}).waitFor();
    }
    await scientific.getByText('绑定当前材料，待人工判断', {exact: true}).waitFor();
    await page.screenshot({path: join(artifacts, `scientific-${verdict}.png`)});
  }
});

test('independent opinions remain immutable and human responses bind current verification through keyboard controls', async () => {
  const f = await scene({scientific: true});
  assert.equal(f.repository.getArtifact(f.artifactId).status, 'approved');
  await openReport(); await openEditor();
  const reports = f.inspect().report.scientificReviews;
  const reviewer = reports.find(report => report.output.kind === 'reviewer');
  const verifier = reports.find(report => report.output.kind === 'verifier');
  await editor().getByRole('combobox', {name: '纳入独立审稿意见'}).selectOption(`${reviewer.artifactId}:f1`);
  assert.equal(await row().getByRole('textbox', {name: '原始审稿意见', exact: true}).getAttribute('readonly'), '');
  assert.match(await page.getByTestId('artifact-response-linked-finding').innerText(), /Retain uncertainty/);
  await row().getByRole('combobox', {name: '人工处理状态'}).selectOption('addressed');
  await row().getByRole('textbox', {name: '审稿回复或未采纳理由'}).fill('Human checked the exact qualifying paragraph.');
  await row().getByRole('combobox', {name: '选择修改稿段落'}).selectOption(f.claim.id);
  await page.getByTestId('artifact-response-whole-paragraph').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="artifact-response-location-add"]').disabled);
  await page.getByTestId('artifact-response-location-add').click();
  await editor().getByRole('textbox', {name: '矩阵修订理由'}).fill('Review the independent opinion.');
  await page.getByTestId('artifact-response-save').click();
  assert.equal(calls.some(call => call.method === 'saveResponseMatrix'), false);
  await row().getByRole('combobox', {name: '当前稿件核验记录'}).selectOption(verifier.artifactId);
  await page.getByTestId('artifact-response-save').focus(); await page.keyboard.press('Enter');
  await editor().waitFor({state: 'hidden'});
  const saved = f.history().items[0].snapshot.request.rows[0];
  assert.deepEqual(saved.finding, {artifactId: reviewer.artifactId, reportHash: reviewer.reportHash, findingId: 'f1',
    reverification: {artifactId: verifier.artifactId, reportHash: verifier.reportHash}});
  assert.equal(f.repository.getWorkflow(f.project.id).currentStage, 'review');

  await page.evaluate(request => mount(request), {...f.request, artifactId: verifier.artifactId});
  const scientific = page.getByTestId('artifact-scientific-review');
  await scientific.getByText('绑定当前材料，待人工判断').waitFor();
  const summary = scientific.locator('summary').first();
  await summary.press('Enter');
  await scientific.getByText('替代解释：Sampling variation remains possible.', {exact: true}).waitFor();
  await scientific.evaluate(async node => {
    await Promise.all(node.getAnimations({subtree: true}).map(animation => animation.finished));
  });
  assert.match(await scientific.innerText(), /Sampling variation remains possible/);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.setViewportSize({width: 560, height: 900});
    await scientific.scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, `scientific-review-${theme}.png`)});
    assert.equal(await scientific.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  }
  await page.setViewportSize({width: 1100, height: 900});
  f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
  await page.evaluate(request => mount(request), {...f.request, artifactId: verifier.artifactId});
  await scientific.getByText('历史意见，材料已变化').waitFor();
  assert.match(await scientific.innerText(), /证据或来源已变化/);
});
