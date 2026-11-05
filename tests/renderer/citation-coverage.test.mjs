import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {createResearchFixture, loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let api, directory, app, page, active;
const fixtures = [], errors = [], calls = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/citation-coverage-ui');
before(async () => {
  api = await loadResearchTestApi();
  directory = mkdtempSync(join(tmpdir(), 'roc-citation-coverage-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await buildViteRenderer({directory, script: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion,MotionConfig,domAnimation} from 'motion/react';
    import {ArtifactInspector} from './src/renderer/artifacts/ArtifactInspector';
    const root=createRoot(document.getElementById('root'));
    const client={api:{research:{
      inspectArtifact:input=>window.fromMain('inspectArtifact',input),
      inspectCitationCoverage:input=>window.fromMain('inspectCitationCoverage',input)
    }}};
    function Harness({initial}) {
      const [request,setRequest]=useState(initial);
      const [locations]=useState(()=>new Map());
      const [drafts]=useState(()=>new Map());
      window.selectArtifact=input=>flushSync(()=>setRequest(input));
      return <main>{request===null?null:<ArtifactInspector key={JSON.stringify(request)} client={client}
        selection={{kind:'stage',request,onReviewContext:()=>{}}} writable={true}
        readingLocations={locations} reviewDrafts={drafts} onClose={()=>setRequest(null)} onOpenTask={()=>{}}/>}</main>;
    }
    let generation=0;
    window.mount=input=>flushSync(()=>root.render(<MotionConfig reducedMotion="user"><LazyMotion features={domAnimation} strict>
      <Harness key={++generation} initial={input}/></LazyMotion></MotionConfig>));
  `, style: 'body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}'});
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:900}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fromMain', async (method, input) => {
    const f = active;
    calls.push({method, input});
    const channel = method === 'inspectArtifact' ? 'roc:research:artifact-inspect' : 'roc:research:citation-coverage';
    api.parseIpcRequestArgs(channel, [input]);
    const result = await f.bridge.invoke(`research.${method}`, [input], 72);
    if (method === 'inspectCitationCoverage' && f.held) return new Promise(resolve => {
      f.release = () => resolve(result); f.holdReady.resolve();
    });
    return result;
  });
  await page.waitForFunction(() => typeof mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {
    fixtures.forEach(f => f.close()); api?.dispose();
    if (directory) rmSync(directory, {recursive: true, force: true});
  }
  assert.deepEqual(errors, []);
});

async function scene({long = false, bibliography = false} = {}) {
  const f = createResearchFixture(api, 'writing');
  active = f; fixtures.push(f); calls.length = 0;
  f.repository.knowledge.upsertFromSource({id: 'citation-ui-source', projectId: f.project.id, sourceType: 'file',
    sourceId: 'synthetic-source.md', title: long ? '混合文本原始来源与精确引用。'.repeat(25) : 'Retained synthetic citation source',
    content: 'Actual retained synthetic measurement -4 ms.',
    chunks: [{content: 'Actual retained synthetic measurement -4 ms.', locator: 'block:3'}], embeddingPolicy: 'none'});
  f.source = f.repository.evidence.capture({projectId: f.project.id, chunkId: 'citation-ui-source:chunk:0'});
  if (bibliography) {
    f.item = f.repository.library.import([{metadata: {id: 'coverage-literature', source: 'local', externalId: 'coverage-ui',
      doi: null, title: 'Synthetic literature', authors: ['Synthetic Author'], abstract: null, publishedYear: 2026,
      citationCount: null, url: null, openAccessUrl: null, importedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z'},
    bibliography: {citationKey: 'coverage2026', entryType: 'article', fields: {title: 'Synthetic literature'}, preambles: [],
      csl: null, title: 'Synthetic literature', authors: ['Synthetic Author'], doi: null, publishedYear: 2026, abstract: null, url: null}
    }], f.project.id, {flush: false, notify: false}).items[0];
    f.source = f.repository.evidence.capture({projectId: f.project.id, chunkId: `library:${f.item.id}:chunk:0`});
  }
  const completed = f.repository.runs.complete(f.run.id, f.project.id, {title: '当前正文工件', markdown: 'Actual saved manuscript.',
    claims: [{subjectType: 'paragraph', content: long ? '当前段落与完整来源对照。'.repeat(40) : 'The measured synthetic difference is -4 ms.',
      status: 'supported', evidenceIds: [f.source.id]}],
    sections: [{title: 'Results', claimIndexes: [0]}], verdict: 'ready'});
  f.artifactId = completed.outputArtifactIds[0];
  f.claim = f.repository.evidence.listClaims({projectId: f.project.id, artifactId: f.artifactId})[0];
  f.relation = () => f.repository.evidence.relations.list({projectId: f.project.id, claimId: f.claim.id})[0];
  f.confirm = () => {
    const relation = f.relation();
    return f.repository.evidence.relations.review({projectId: f.project.id, relationId: relation.id,
      expectedVersion: relation.version, expectedClaimVersion: relation.claimVersion, expectedSourceDigest: relation.sourceDigest,
      decision: 'confirm', note: 'Human verified the exact synthetic excerpt.'}, {kind: 'user', id: 'citation-ui-reviewer'});
  };
  const handlers = new Map();
  const context = {pluginId: 'fixture', capabilities: {register(_id, descriptor, handler) {handlers.set(descriptor.name, handler);}}};
  api.registerResearchArtifactInspectorCapability(context, f.repository);
  api.registerResearchCitationCoverageCapability(context, new api.ResearchCitationCoverageService(f.repository));
  f.bridge = api.createPluginCapabilityAdapter({invokeCapability: (name, input) => handlers.get(name)(input)});
  f.request = {projectId: f.project.id, artifactId: f.artifactId, expectedVersion: null};
  f.changes = () => f.db.prepare('SELECT total_changes()').pluck().get();
  await page.evaluate(request => mount(request), f.request);
  await page.getByTestId('artifact-inspector-content').waitFor();
  return f;
}
async function openCoverage() {
  const toggle = page.getByTestId('artifact-citation-coverage-toggle');
  await toggle.focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-citation-coverage-hash').waitFor();
}
const coverage = () => page.getByTestId('artifact-citation-coverage');

test('manuscript coverage loads only on demand and keyboard exposes actual citations and source without writes', async () => {
  const f = await scene();
  assert.equal(calls.filter(call => call.method === 'inspectCitationCoverage').length, 0);
  const before = f.changes();
  await openCoverage();
  assert.equal(calls.find(call => call.method === 'inspectCitationCoverage').input.expectedHash, null);
  const paragraph = page.getByTestId('artifact-citation-paragraph-0-0');
  await paragraph.locator('summary').focus(); await page.keyboard.press('Enter');
  await paragraph.getByText('尚未确认支持', {exact: false}).waitFor({state: 'visible'});
  assert.match(await paragraph.innerText(), /尚未确认支持/u);
  assert.match(await paragraph.innerText(), new RegExp(f.source.id, 'u'));
  const source = coverage().getByText('Retained synthetic citation source', {exact: false});
  await source.focus(); await page.keyboard.press('Enter');
  await coverage().getByText(f.source.excerpt, {exact: true}).waitFor({state: 'visible'});
  assert.match(await coverage().innerText(), /block:3/u);
  assert.match(await coverage().innerText(), new RegExp(f.source.sourceVersion, 'u'));
  await page.getByTestId('artifact-citation-coverage-filter').selectOption('issues');
  assert.equal(await page.getByTestId('artifact-citation-paragraph-0-0').count(), 1);
  assert.equal(f.changes(), before);
  assert.equal(f.repository.getArtifact(f.artifactId).status, 'draft');
});

test('human relation change produces a stale report until artifact refresh, and pending refresh hides previous data', async () => {
  const f = await scene(); await openCoverage();
  const hash = await page.getByTestId('artifact-citation-coverage-hash').innerText();
  f.confirm(); f.held = true; f.holdReady = Promise.withResolvers();
  await page.getByTestId('artifact-citation-coverage-refresh').click();
  await coverage().getByRole('status').waitFor();
  assert.equal(await page.getByTestId('artifact-citation-coverage-hash').count(), 0);
  assert.equal(await page.getByTestId('artifact-citation-coverage-refresh').isDisabled(), true);
  await f.holdReady.promise;
  assert.equal(calls.at(-1).input.expectedHash, hash);
  f.held = false; f.release();
  await page.getByTestId('artifact-citation-coverage-artifact-changed').waitFor();
  assert.equal(await page.getByTestId('artifact-citation-coverage-recapture').isDisabled(), true);
  await page.getByTestId('artifact-inspector-refresh').click();
  await page.getByTestId('artifact-citation-coverage-hash').waitFor();
  await page.getByTestId('artifact-citation-coverage-filter').selectOption('unreviewed');
  await coverage().getByText('没有符合条件的段落。', {exact: true}).waitFor();
  assert.notEqual(await page.getByTestId('artifact-citation-coverage-hash').innerText(), hash);
});

test('invalidated source and missing manuscript errors remove successful report content and permit retry', async () => {
  const f = await scene(); await openCoverage();
  const row = f.db.prepare('SELECT * FROM research_manuscripts WHERE artifact_id=?').get(f.artifactId);
  f.db.prepare('DELETE FROM research_manuscripts WHERE artifact_id=?').run(f.artifactId);
  const before = f.changes();
  await page.getByTestId('artifact-citation-coverage-refresh').click();
  await coverage().getByRole('alert').waitFor();
  assert.match(await coverage().getByRole('alert').innerText(), /先保存正文/u);
  assert.equal(await page.getByTestId('artifact-citation-coverage-hash').count(), 0);
  assert.equal(f.changes(), before);
  f.db.prepare('INSERT INTO research_manuscripts (artifact_id,project_id,sections_json,latex,content_hash,claims_hash,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(row.artifact_id, row.project_id, row.sections_json, row.latex, row.content_hash, row.claims_hash, row.updated_at);
  await page.getByTestId('artifact-citation-coverage-refresh').click();
  await page.getByTestId('artifact-citation-coverage-hash').waitFor();
  f.repository.evidence.invalidateChunksOf(f.source.documentId);
  await page.getByTestId('artifact-citation-coverage-refresh').click();
  await coverage().getByRole('alert').waitFor();
  assert.match(await coverage().getByRole('alert').innerText(), /引用来源已失效/u);
  assert.equal(await page.getByTestId('artifact-citation-coverage-hash').count(), 0);
});

test('bibliography-only drift beyond the artifact snapshot is visible and requires explicit report recapture', async () => {
  const f = await scene({bibliography: true}); await openCoverage();
  const first = await page.getByTestId('artifact-citation-coverage-hash').innerText();
  const version = f.repository.inspectArtifact({...f.request}).snapshot.version;
  f.repository.library.setCitationKey(f.item.id, f.item.revision, 'revised2026');
  assert.equal(f.repository.inspectArtifact({...f.request}).snapshot.version, version);
  const before = f.changes();
  await page.getByTestId('artifact-citation-coverage-refresh').click();
  await page.getByTestId('artifact-citation-coverage-recapture').waitFor();
  assert.equal(await page.getByTestId('artifact-citation-coverage-artifact-changed').count(), 0);
  assert.equal(await page.getByTestId('artifact-citation-coverage-recapture').isDisabled(), false);
  assert.match(await coverage().innerText(), /书目版本 2，引用键 revised2026/u);
  assert.notEqual(await page.getByTestId('artifact-citation-coverage-hash').innerText(), first);
  await page.getByTestId('artifact-citation-coverage-recapture').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('artifact-citation-coverage-recapture').waitFor({state: 'hidden'});
  assert.equal(f.changes(), before);
});

test('late coverage from a previous project cannot appear in the newly selected artifact', async () => {
  const first = await scene(); first.held = true; first.holdReady = Promise.withResolvers();
  await page.getByTestId('artifact-citation-coverage-toggle').click();
  await coverage().getByRole('status').waitFor();
  await first.holdReady.promise;
  const second = await scene();
  first.held = false; first.release();
  await openCoverage();
  assert.equal(calls.at(-1).input.projectId, second.project.id);
  assert.equal(await page.getByTestId('artifact-citation-coverage-hash').innerText(),
    new api.ResearchCitationCoverageService(second.repository).inspect({
      projectId: second.project.id, artifactId: second.artifactId, expectedHash: null
    }).reportHash);
});

test('long citation source and native disclosures fit both narrow themes with reduced motion', async () => {
  await scene({long: true}); await openCoverage();
  await page.getByTestId('artifact-citation-paragraph-0-0').locator('summary').click();
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  await page.setViewportSize({width: 650, height: 900}); await page.emulateMedia({reducedMotion: 'reduce'});
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await coverage().getByRole('heading', {name: '正文引用覆盖', exact: true}).scrollIntoViewIfNeeded();
    const labelLayout = await page.getByTestId('artifact-citation-coverage-filter').evaluate(select => {
      const text = select.parentElement.querySelector('span');
      const range = document.createRange();
      range.selectNodeContents(text);
      const labelRect = text.getBoundingClientRect(), selectRect = select.getBoundingClientRect();
      return {lines: range.getClientRects().length, separated: labelRect.right <= selectRect.left,
        selectWidth: selectRect.width};
    });
    assert.equal(labelLayout.lines, 1);
    assert.equal(labelLayout.separated, true);
    assert.ok(labelLayout.selectWidth > 100);
    await page.getByTestId('artifact-citation-coverage-refresh').hover();
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
    await page.screenshot({path: join(artifacts, `${theme}-650.png`)});
  }
});
