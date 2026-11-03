import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {execFileSync} from 'node:child_process';

let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/research-optimization/review-ui');
const timestamp = '2026-11-03T00:00:00.000Z';
function candidate(overrides = {}) {
  const record = {id: 'crossref:review', externalId: '10.1234/review', source: 'crossref', doi: '10.1234/review',
    title: 'Synthetic candidate review', authors: ['Synthetic Author'], publishedYear: 2026, abstract: null,
    citationCount: 100, url: null, openAccessUrl: null, importedAt: timestamp, updatedAt: timestamp};
  return {candidateId: 'candidate-review', identity: 'doi:10.1234/review', record, score: 1 / 61,
    origins: [{source: 'crossref', externalId: record.externalId, rank: 1, retrievedAt: timestamp, metadataHash: 'a'.repeat(64),
      record, identifiers: [], rawIdentifiers: null,
      review: {publicationType: 'journal-article', copies: [{field: 'license[0]', locationUrl: null,
        version: 'am', license: 'https://example.test/accepted-license'}],
        retraction: {status: 'unknown', field: null},
        updates: [{type: 'correction', doi: '10.1234/target', label: 'Correction', source: 'publisher'}]}},
      {source: 'openalex', externalId: 'W1', rank: 2, retrievedAt: timestamp, metadataHash: 'b'.repeat(64),
        record: {...record, source: 'openalex', externalId: 'W1', title: 'Alternate synthetic title'}, identifiers: [], rawIdentifiers: {},
        review: {publicationType: 'article', copies: [{field: 'primary_location', locationUrl: 'https://example.test/published-copy',
          version: 'publishedVersion', license: 'cc-by'}], retraction: {status: 'retracted', field: 'is_retracted'}, updates: []}}],
    contributions: [{source: 'crossref', rank: 1, score: 1 / 61}], aliases: ['doi:10.1234/review'],
    conflicts: [{field: 'title', values: [{source: 'crossref', externalId: record.externalId, value: record.title},
      {source: 'openalex', externalId: 'W1', value: 'Alternate synthetic title'}]}],
    identityConflicts: [{alias: 'pmid:123', doiIdentities: ['doi:10.1234/review', 'doi:10.1234/other']}],
    versionRelations: [], selectionReason: 'source_priority_then_rank_then_metadata_hash',
    matchedLibraryItemId: null, archived: false, missingFields: [], ...overrides};
}
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-review-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await esbuild.build({stdin: {contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, MotionConfig, domAnimation} from 'motion/react';
    import {ImportDialog} from './src/renderer/literature/ImportDialog';
    const root = createRoot(document.getElementById('root'));
    let generation = 0;
    function Harness({candidates}) {
      const [open, setOpen] = useState(false);
      return React.createElement(React.Fragment, null,
        React.createElement('button', {id: 'review-open', onClick: () => setOpen(true)}, '打开检索'),
        React.createElement(ImportDialog, {open, initialTab: 'search', onClose: () => setOpen(false),
          selectedItem: null, canAttachToSelection: false, pickFile: async () => null,
          searchLiterature: async () => ({ok: true, result: {schemaVersion: 13, strategy: null,
            executionId: 'search-exec-review', searchId: 'search-review', candidates, total: candidates.length,
            status: 'complete', warnings: [], sources: [], nextOffset: null}}),
          addCandidate: async (searchId, candidateId) => {
            window.adds.push({searchId, candidateId});
            return {ok: true, createdCount: 1, duplicateCount: 0};
          }}));
    }
    window.mount = candidates => { window.adds = []; flushSync(() => root.render(
      React.createElement(MotionConfig, {reducedMotion:'user'},
        React.createElement(LazyMotion, {features:domAnimation, strict:true},
          React.createElement(Harness, {key: ++generation, candidates}))))); };
  `, resolveDir: process.cwd(), loader: 'js'}, outfile: join(directory, 'app.js'),
    bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent',
    plugins: process.env.ROC_REVIEW_BASELINE === '1' ? [{name: 'fixed-review-baseline', setup(build) {
      build.onLoad({filter: /ImportDialog\.tsx$/}, () => ({
        contents: execFileSync('git', ['show', '07319ba:src/renderer/literature/ImportDialog.tsx'], {encoding: 'utf8'}),
        loader: 'tsx', resolveDir: join(process.cwd(), 'src/renderer/literature')
      }));
    }}] : []});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}</style>
    <div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow} = require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show:false,width:1100,height:720}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});
after(async () => {
  try {await app?.close();} finally {if (directory) rmSync(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, []);
});
async function search(candidates) {
  await page.evaluate(candidates => mount(candidates), candidates);
  await page.locator('#review-open').click();
  await page.locator('[data-testid="literature-import-search"]').fill('synthetic review');
  await page.locator('[data-testid="literature-import-search-submit"]').click();
  await page.locator('[data-testid="literature-candidate"]').first().waitFor();
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="literature-import-dialog-panel"]');
    return panel && getComputedStyle(panel).opacity === '1' && getComputedStyle(panel).transform === 'none';
  });
}
async function inspectState(label) {
  const source = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const audit = await page.evaluate(`(${source})({root:'body',viewport:true})`);
  writeFileSync(join(artifacts, `${label}-audit.json`), JSON.stringify(audit, null, 2));
  assert.equal(audit.cut, 0);
  await page.screenshot({path: join(artifacts, `${label}.png`)});
}
test('candidate review exposes source conflicts and scoped declarations through keyboard details and separate add', async () => {
  await search([candidate()]);
  const row = page.locator('[data-testid="literature-candidate"]');
  assert.match(await row.innerText(), /来源标记已撤稿/u);
  assert.match(await row.innerText(), /出版版本/u);
  assert.match(await row.innerText(), /Correction/u);
  assert.deepEqual(await page.evaluate(() => adds), []);
  await inspectState('default');
  await row.locator('button').hover();
  await inspectState('hover');
  const toggle = row.locator('summary');
  await toggle.focus();
  await page.keyboard.press('Enter');
  const review = row.locator('[data-testid="literature-candidate-review"]');
  await review.waitFor({state: 'visible'});
  assert.match(await review.innerText(), /适用副本 https:\/\/example.test\/published-copy/u);
  assert.match(await review.innerText(), /标题冲突/u);
  assert.match(await review.innerText(), /身份冲突 pmid:123/u);
  assert.match(await review.innerText(), /更新对象 DOI 10.1234\/target/u);
  assert.match(await review.innerText(), /引用量不代表可信度/u);
  await inspectState('expanded');
  await row.locator('button').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => adds.length === 1);
  assert.deepEqual(await page.evaluate(() => adds), [{searchId: 'search-review', candidateId: 'candidate-review'}]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'review-open');
});
test('unknown review stays unknown and archived candidate remains disabled', async () => {
  const paper = candidate({archived: true, conflicts: [], identityConflicts: []});
  paper.origins = [{...paper.origins[0], review: {publicationType: null, copies: [], updates: [],
    retraction: {status: 'unknown', field: null}}}];
  await search([paper]);
  const row = page.locator('[data-testid="literature-candidate"]');
  const text = await row.innerText();
  assert.match(text, /未知/u);
  assert.equal(text.includes('来源未报告撤稿'), false);
  assert.equal(await row.locator('button').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => adds), []);
});
test('long review remains scrollable and readable at 1099 boundary with light dark and reduced motion', async () => {
  const paper = candidate();
  paper.record.title = '长标题与完整元数据'.repeat(60);
  paper.origins[0].record.title = paper.record.title;
  paper.origins[0].review.copies[0].license = 'https://example.test/license/' + 'long'.repeat(150);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await search([paper]);
  await page.locator('[data-testid="literature-candidate-review-toggle"]').click();
  const auditSource = readFileSync(join(process.cwd(), '.agents/skills/desktop-agent-ui/scripts/clip-audit.js'), 'utf8');
  const audits = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1100, 1099, 800]) {
      await page.setViewportSize({width, height: 720});
      const list = page.locator('ul[aria-label="检索结果"]');
      await list.focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.querySelector('ul[aria-label="检索结果"]').scrollTop > 0);
      const layout = await list.evaluate(element => ({
        scrollable: element.scrollHeight > element.clientHeight, scrolled: element.scrollTop > 0,
        overflow: element.scrollWidth > element.clientWidth, outline: getComputedStyle(element).outlineWidth,
        bodyOverflow: document.body.scrollWidth > document.body.clientWidth
      }));
      assert.equal(layout.scrollable, true);
      assert.equal(layout.scrolled, true);
      assert.equal(layout.overflow, false);
      assert.notEqual(layout.outline, '0px');
      assert.equal(layout.bodyOverflow, false);
      await page.screenshot({path: join(artifacts, `${theme}-${width}.png`)});
      const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      audits.push({theme, width, audit});
      writeFileSync(join(artifacts, 'shadow-audits.json'), JSON.stringify(audits, null, 2));
      assert.equal(audit.cut, 0);
    }
  }
  writeFileSync(join(artifacts, 'shadow-audits.json'), JSON.stringify(audits, null, 2));
});
