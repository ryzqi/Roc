import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {unknownExperiment, createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let api, directory, app, page, active;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/journal-compliance-ui');
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-journal-ui-')); mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const methods=['inspectArtifact','inspectJournalCompliance','saveJournalCompliance','getJournalComplianceHistory','listFigures'];
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
    const f = active; calls.push({method, input});
    const channel = {inspectArtifact: 'roc:research:artifact-inspect', inspectJournalCompliance: 'roc:research:journal-inspect',
      saveJournalCompliance: 'roc:research:journal-save', getJournalComplianceHistory: 'roc:research:journal-history',
      listFigures: 'roc:research:figure-list'}[method];
    api.parseIpcRequestArgs(channel, [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], 73);
    const hold = f.holds.get(method);
    if (hold !== undefined) return new Promise(resolve => {
      hold.release = () => resolve(hold.loseReply ? {ok: false, error: {code: 'fixture_reply_lost', message: '投稿检查回执连接中断'}} : result);
      hold.ready.resolve();
    });
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => {
  if (page !== undefined && !page.isClosed()) await page.evaluate(() => window.unmount?.());
  try {await app?.close();} finally {
    fixtures.forEach(f => {f.close(); rmSync(f.root, {recursive: true, force: true});}); api?.dispose();
    if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});
async function scene() {
  const root = mkdtempSync(join(tmpdir(), 'roc-journal-material-'));
  const f = createResearchFixture(api, 'writing', root); f.root = root;
  fixtures.push(f); active = f; calls.length = 0; f.holds = new Map();
  f.repository.knowledge.upsertFromSource({id: 'journal-ui-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'synthetic.md', title: 'Synthetic source', content: 'Measured difference was -4 ms.',
    chunks: [{content: 'Measured difference was -4 ms.', locator: 'block:0'}], embeddingPolicy: 'none'});
  f.evidence = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'journal-ui-source:chunk:0'});
  f.artifactId = f.withWorker(() => f.repository.runs.complete(f.run.id, f.project.id, {title: '合成投稿规则验收', markdown: 'Synthetic manuscript',
    claims: [{experiment: {...unknownExperiment}, subjectType: 'paragraph', content: 'Measured difference was -4 ms.', status: 'supported', evidenceIds: [f.evidence.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'})).outputArtifactIds[0];
  f.service = new api.ResearchJournalComplianceService(f.repository, {verify: async () => assert.fail('no figure selected')});
  const handlers = new Map(), context = {pluginId: 'fixture', capabilities: {
    register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}
  }};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchJournalComplianceCapabilities(context, f.service, f.repository.journalCompliance);
  handlers.set('research.figure.list', input => f.repository.figures.list(input.projectId, input.limit));
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
  f.request = {projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null};
  f.inspect = (selection = null) => f.service.inspect({projectId: f.project.id, artifactId: f.artifactId, selection, expectedHash: null});
  f.history = () => f.repository.journalCompliance.history({projectId: f.project.id, artifactId: f.artifactId, offset: 0, limit: 100});
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  f.hold = (method, loseReply = false) => {
    const value = {ready: Promise.withResolvers(), loseReply}; f.holds.set(method, value); return value;
  };
  await page.evaluate(request => mount(request), f.request);
  await page.getByTestId('artifact-inspector-content').waitFor();
  return f;
}
const editor = () => page.getByTestId('artifact-journal-editor'), report = () => page.getByTestId('artifact-journal-compliance');
const text = (label, value) => editor().getByRole('textbox', {name: label, exact: true}).fill(value);
const select = (label, value) => editor().getByRole('combobox', {name: label, exact: true}).selectOption(value);
async function openReport() {
  await page.getByTestId('artifact-journal-toggle').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-journal-hash').waitFor();
}
async function openEditor() {
  await page.getByTestId('artifact-journal-edit').focus(); await page.keyboard.press('Enter'); await editor().waitFor();
}
async function profile() {
  await text('期刊名称', 'Synthetic engineering journal'); await text('文章类型', 'Synthetic article');
  await text('投稿阶段', 'Initial submission'); await text('规则版本', 'Synthetic-1');
  await editor().getByLabel('规则日期', {exact: true}).fill('2026-11-06');
  await select('日期来源', 'human_transcription'); await text('资料获取时间（ISO 8601，含时区）', '2026-11-06T00:00:00.000Z');
}
async function rule(kind, name = kind) {
  await page.getByTestId('artifact-journal-rule-new').click(); await text('规则名称', name);
  await text('规则来源 URL', 'https://example.org/synthetic-journal/rules');
  await text('规则原文', 'Synthetic engineering requirement, not a real journal policy.');
  await select('要求性质', 'required'); await select('检查类型', kind);
}
async function prepare() {
  await profile(); await rule('sections', 'Exact sections'); await text('必需小节标题（每行一个）', 'Results\nMethods');
  await text('投稿检查修订理由', 'Human selected synthetic rules and compared current sources.');
}
async function preview() {
  await page.getByTestId('artifact-journal-preview').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-journal-preview-result').waitFor();
}
async function declare(f, version, selection) {
  const current = (await f.inspect(selection)).report, parent = current.review;
  return api.withResearchHumanContext({capability: 'research.journalCompliance.save', projectId: f.project.id, windowId: 73},
    () => f.service.save({projectId: f.project.id, artifactId: f.artifactId, requestId: `journal-ui-${version}`,
      expectedArtifactVersion: current.artifactVersion, expectedMaterialHash: current.materialHash,
      parent: parent === null ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash},
      rationale: `Human selected synthetic version ${version}`, selection: selection ?? current.selection}));
}

test('lazy native form requires explicit rules and preview, locks the drawer, and retries a lost save receipt exactly', async () => {
  const f = await scene();
  assert.equal(calls.some(call => call.method === 'inspectJournalCompliance' || call.method === 'listFigures'), false);
  await openReport(); await openEditor();
  assert.equal(await editor().getByLabel('期刊名称', {exact: true}).inputValue(), '');
  assert.equal(await editor().getByLabel('日期来源', {exact: true}).inputValue(), '');
  assert.equal(await page.getByTestId('artifact-journal-save').isDisabled(), true);
  await page.getByTestId('artifact-journal-preview').click(); await editor().getByRole('alert').waitFor();
  assert.equal(calls.filter(call => call.method === 'inspectJournalCompliance').length, 1);
  await prepare();
  for (const id of ['artifact-inspector-refresh', 'artifact-citation-coverage-toggle', 'artifact-consistency-toggle',
    'artifact-response-toggle', 'artifact-journal-toggle', 'artifact-journal-refresh', 'artifact-journal-history-open']) {
    assert.equal(await page.getByTestId(id).isDisabled(), true, id);
  }
  await page.keyboard.press('Escape'); await page.getByTestId('artifact-draft-discard-panel').waitFor();
  await page.getByTestId('artifact-draft-discard-cancel').click();
  await page.getByTestId('artifact-draft-discard-panel').waitFor({state:'detached'});
  assert.equal(await page.getByTestId('artifact-inspector-panel').count(), 1);
  await preview(); assert.match(await page.getByTestId('artifact-journal-preview-result').innerText(), /不通过/u);
  await text('规则原文', 'Changed synthetic requirement.');
  assert.equal(await page.getByTestId('artifact-journal-preview-result').count(), 0);
  assert.equal(await page.getByTestId('artifact-journal-save').isDisabled(), true);
  await preview();
  const write = f.hold('saveJournalCompliance', true);
  await page.getByTestId('artifact-journal-save').focus(); await page.keyboard.press('Enter'); await write.ready.promise;
  assert.equal(await page.getByTestId('artifact-journal-discard').isDisabled(), true);
  const saved = f.history().items[0], before = f.changes();
  assert.equal(saved.snapshot.actor.id, 'window:73'); assert.equal(saved.snapshot.checks[0].status, 'fail');
  write.release(); await editor().getByRole('alert').waitFor(); f.holds.delete('saveJournalCompliance');
  await page.getByTestId('artifact-journal-save').click(); await editor().waitFor({state: 'hidden'});
  await page.getByTestId('artifact-journal-hash').waitFor();
  const writes = calls.filter(call => call.method === 'saveJournalCompliance');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].input, writes[1].input);
  assert.equal(f.history().total, 1); assert.equal(f.changes(), before);
  assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
});

test('all six rule kinds retain guidance failures and independent manual judgment with real selected supplements', async () => {
  const f = await scene(); writeFileSync(join(f.root, 'supplement.txt'), 'Synthetic supplement');
  await openReport(); await openEditor(); await prepare(); await select('要求性质', 'guidance');
  await rule('reference_count'); await editor().getByLabel('引用数量上限', {exact: true}).fill('0');
  await rule('reference_fields'); await editor().getByRole('checkbox', {name: 'DOI', exact: true}).check();
  await rule('figure_files'); await select('图稿格式', 'pdf');
  await editor().getByLabel('文件字节上限', {exact: true}).fill('1024');
  await editor().getByLabel('栅格最低 DPI（可留空）', {exact: true}).fill('300');
  await page.getByTestId('artifact-journal-preview').click(); await editor().getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('artifact-journal-preview-result').count(), 0);
  await editor().getByLabel('栅格最低 DPI（可留空）', {exact: true}).fill('');
  await rule('supplements'); await text('必需补充文件相对路径（每行一个）', 'supplement.txt');
  await text('所选补充文件相对路径（每行一个）', 'supplement.txt');
  await rule('manual'); await select('人工核对范围', 'structure'); await select('人工判断', 'pass');
  await text('人工判断理由', 'Human checked the synthetic structure.');
  await preview(); await page.getByTestId('artifact-journal-save').click(); await editor().waitFor({state: 'hidden'});
  const saved = f.history().items[0];
  assert.deepEqual(saved.snapshot.checks.map(check => check.status), ['fail', 'fail', 'manual', 'manual', 'pass', 'manual']);
  assert.equal(saved.snapshot.request.selection.profile.rules[0].authority, 'guidance');
  assert.equal(saved.snapshot.request.selection.manualReviews[0].decision, 'pass');
  assert.equal(saved.snapshot.material.supplements[0].size, 20);
  await page.getByTestId('artifact-journal-receipt').locator('> summary').click();
  await page.getByTestId('artifact-journal-receipt').getByText('人工判断：通过', {exact: false}).waitFor();
  assert.match(await page.getByTestId('artifact-journal-receipt').innerText(), /人工判断：通过/u);
});

test('material and parent changes refuse stale saves, preserve edits, and allow explicit discard', async () => {
  for (const conflict of ['material', 'parent']) {
    const f = await scene(); writeFileSync(join(f.root, 'supplement.txt'), 'Original synthetic supplement');
    await openReport(); await openEditor(); await prepare();
    await text('所选补充文件相对路径（每行一个）', 'supplement.txt'); await preview();
    const selected = calls.filter(call => call.method === 'inspectJournalCompliance').at(-1).input.selection;
    if (conflict === 'parent') await declare(f, 1, selected);
    else writeFileSync(join(f.root, 'supplement.txt'), 'Changed synthetic supplement');
    const before = f.changes();
    await page.getByTestId('artifact-journal-save').click(); await editor().getByRole('alert').waitFor();
    assert.match(await editor().getByRole('alert').innerText(), conflict === 'parent' ? /已有新版本/u : /已变化/u);
    assert.equal(f.changes(), before);
    assert.equal(await editor().getByLabel('期刊名称', {exact: true}).inputValue(), 'Synthetic engineering journal');
    await page.getByTestId('artifact-journal-discard').click();
    assert.equal(await editor().getByLabel('期刊名称', {exact: true}).inputValue(), '');
    assert.equal(await page.getByTestId('artifact-inspector-refresh').isDisabled(), false);
  }
});

test('stored history pages remain readable when current sources fail and hide data until real replies', async () => {
  const f = await scene(); await openReport(); await openEditor(); await prepare(); await preview();
  const selected = calls.filter(call => call.method === 'inspectJournalCompliance').at(-1).input.selection;
  await page.getByTestId('artifact-journal-discard').click();
  for (let version = 1; version <= 12; version++) await declare(f, version, selected);
  await page.evaluate(request => mount(request), f.request); await openReport();
  f.repository.evidence.invalidateChunksOf(f.evidence.documentId);
  await page.getByTestId('artifact-journal-refresh').click(); await report().getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('artifact-journal-hash').count(), 0);
  const hold = f.hold('getJournalComplianceHistory');
  await page.getByTestId('artifact-journal-history-open').click(); await hold.ready.promise;
  assert.equal(await page.getByTestId('artifact-journal-history').count(), 0);
  f.holds.delete('getJournalComplianceHistory'); hold.release();
  const history = page.getByTestId('artifact-journal-history'); await history.waitFor();
  assert.equal(await history.getByTestId('artifact-journal-receipt').count(), 10);
  await page.getByTestId('artifact-journal-history-next').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="artifact-journal-history"] [data-testid="artifact-journal-receipt"]').length === 2);
  assert.match(await history.innerText(), /历史材料未按当前来源复核/u);
  await history.getByTestId('artifact-journal-receipt').last().locator('> summary').click();
  await history.getByTestId('artifact-journal-receipt').last().getByText('2026-11-06，人工整理日期', {exact: true}).waitFor();
  assert.match(await history.getByTestId('artifact-journal-receipt').last().innerText(), /人工整理日期/u);
});

test('missing supplement keeps its error and can be explicitly removed through stored-rule editing and a fresh preview', async () => {
  const f = await scene(); writeFileSync(join(f.root, 'supplement.txt'), 'Synthetic supplement');
  await openReport(); await openEditor(); await prepare();
  await text('所选补充文件相对路径（每行一个）', 'supplement.txt'); await preview();
  await page.getByTestId('artifact-journal-save').click(); await editor().waitFor({state: 'hidden'});
  await page.getByTestId('artifact-journal-hash').waitFor();
  rmSync(join(f.root, 'supplement.txt'));
  await page.getByTestId('artifact-journal-refresh').click(); await report().getByRole('alert').waitFor();
  assert.match(await report().getByRole('alert').innerText(), /补充文件不存在/u);
  await page.getByTestId('artifact-journal-history-open').click(); await page.getByTestId('artifact-journal-history').waitFor();
  await page.getByTestId('artifact-journal-repair').click(); await editor().waitFor();
  assert.equal(await page.getByTestId('artifact-journal-save').isDisabled(), true);
  assert.equal(await page.getByTestId('artifact-journal-preview-result').count(), 0);
  assert.match(await report().getByRole('alert').innerText(), /补充文件不存在/u);
  await text('所选补充文件相对路径（每行一个）', '');
  await text('投稿检查修订理由', 'Human removed an unavailable optional supplement.');
  await preview(); await page.getByTestId('artifact-journal-save').click(); await editor().waitFor({state: 'hidden'});
  assert.equal(f.history().total, 2); assert.deepEqual(f.history().items[0].snapshot.request.selection.supplementPaths, []);
});

test('late preview save and history replies never refresh or populate another project and readonly states send no writes', async () => {
  const first = await scene(); await openReport(); await openEditor(); await prepare();
  const inspect = first.hold('inspectJournalCompliance');
  await page.getByTestId('artifact-journal-preview').click(); await inspect.ready.promise;
  const second = await scene(); await openReport();
  first.holds.delete('inspectJournalCompliance'); inspect.release();
  await openEditor(); assert.equal(await page.getByTestId('artifact-journal-preview-result').count(), 0);
  await prepare(); await preview();
  const write = second.hold('saveJournalCompliance');
  await page.getByTestId('artifact-journal-save').click(); await write.ready.promise;
  const third = await scene(); await openReport();
  const before = calls.filter(call => call.method === 'inspectArtifact').length;
  second.holds.delete('saveJournalCompliance'); write.release();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(calls.filter(call => call.method === 'inspectArtifact').length, before);
  const history = third.hold('getJournalComplianceHistory');
  await page.getByTestId('artifact-journal-history-open').click(); await history.ready.promise;
  await scene(); await openReport(); third.holds.delete('getJournalComplianceHistory'); history.release();
  assert.equal(await page.getByTestId('artifact-journal-history').count(), 0);
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
    assert.equal(await page.getByTestId('artifact-journal-rule-new').isDisabled(), true, state);
    assert.equal(await page.getByTestId('artifact-journal-preview').isDisabled(), true, state);
    assert.equal(await page.getByTestId('artifact-journal-save').isDisabled(), true, state);
    assert.equal(calls.some(call => call.method === 'saveJournalCompliance'), false, state);
  }
});

test('long rule fields fit narrow light and dark themes with keyboard focus reduced motion and exact clip audit', async () => {
  await scene(); await openReport(); await openEditor(); await prepare();
  await text('规则名称', '长规则名称用于验证原生桌面选择控件与边界。'.repeat(10));
  await text('规则原文', '逐项核对投稿结构、引用格式及材料来源。'.repeat(80));
  await text('投稿检查修订理由', '人工核对规则日期和真实材料。'.repeat(60));
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  await page.setViewportSize({width: 650, height: 900}); await page.emulateMedia({reducedMotion: 'reduce'});
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const state of ['fields', 'preview']) {
      const target = state === 'fields' ? editor().getByLabel('规则原文', {exact: true}) : page.getByTestId('artifact-journal-preview');
      await target.focus(); await target.scrollIntoViewIfNeeded(); await target.hover();
      assert.equal(await target.evaluate(element => element === document.activeElement), true);
      const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      writeFileSync(join(artifacts, `${theme}-${state}-audit.json`), JSON.stringify(audit, null, 2));
      assert.equal(audit.cut, 0); assert.equal(audit.hidden, 3);
      const panelPath = await page.getByTestId('artifact-inspector-panel').evaluate(element => {
        const parts = [];
        for (let item = element; item && item !== document.body && parts.length < 4; item = item.parentElement) {
          parts.unshift(`${item.tagName.toLowerCase()}${[...item.classList].slice(0, 3).map(name => `.${name}`).join('')}`);
        }
        return parts.join(' > ');
      });
      assert.deepEqual(audit.issues.map(issue => [issue.el, issue.kind, issue.side, issue.level, issue.gap, issue.why]).sort(),
        ['bottom', 'right', 'top'].map(side => [panelPath, 'box-shadow', side, 'hidden', 0, 'overflow:hidden']).sort());
      assert.equal(await page.getByTestId('artifact-inspector-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await editor().evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll('select,input:not([type="checkbox"]),textarea')].every(control => {
          const rect = control.getBoundingClientRect(); return rect.width > 100 && rect.left >= bounds.left && rect.right <= bounds.right;
        });
      }), true);
      await page.screenshot({path: join(artifacts, `${theme}-${state}-650.png`)});
    }
  }
});
