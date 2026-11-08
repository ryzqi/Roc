import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import electronPath from 'electron';
import {_electron} from '@playwright/test';

let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/knowledge-wiki');
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-wiki-ui-'));
  mkdirSync(artifacts, {recursive: true});
  await build({stdin: {contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {WikiView} from './src/renderer/literature/WikiView';
    const root = createRoot(document.getElementById('root'));
    window.mount = props => flushSync(() => root.render(React.createElement(WikiView,
      {...props, onOpenClaim: id => window.opened = id, onRefresh: () => window.refreshed = true})));
  `, resolveDir: process.cwd(), loader: 'js'}, outfile: join(directory, 'app.js'),
    bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(name => name.endsWith('.css'))
    .map(name => readFileSync(join(assets, name), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,sans-serif}#root{height:100vh}</style>
    <div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `const {app,BrowserWindow} = require('electron');
    app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show:false,width:1100,height:720}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
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
function fixture() {
  const evidence = [{id:'e1', projectId:'p1', title:'Synthetic measured evidence', excerpt:'Original immutable excerpt.',
    locator:'results.csv:row:1', sourceType:'experiment', sourceId:'s1', chunkId:'chunk-1'}];
  const claims = [{id:'c1', content:'Synthetic supported declaration', evidenceIds:['e1'], status:'supported', version:1}];
  return {claims, evidence, libraryItems:[], snapshot:{claims, sources:evidence.map(evidence => ({evidence,
    referenceStatus:'recorded', invalidatedAt:null, sourceLocator:null})), relations:[]}};
}
test('Wiki renders current review and invalidation honestly, and refresh and graph remain keyboard accessible', async () => {
  const props = fixture();
  const mount = () => page.evaluate(props => window.mount(props), props);
  await mount();
  const body = page.locator('[data-testid="wiki-body"]');
  assert.match(await body.innerText(), /待人工审核/u);
  props.snapshot.relations = [{id:'r1',claimId:'c1',claimVersion:1,evidenceId:'e1',kind:'qualifies',status:'confirmed',
    condition:'Only for this sample',reviewer:{id:'Synthetic reviewer',kind:'user'}}];
  await mount();
  assert.match(await body.innerText(), /人工确认有条件支持/u);
  assert.match(await body.innerText(), /Only for this sample/u);
  props.snapshot.relations[0].kind = 'contradicts';
  await mount();
  assert.match(await body.innerText(), /存在已确认反对/u);
  props.snapshot.relations[0].status = 'invalidated';
  props.snapshot.sources[0].referenceStatus = 'superseded';
  await mount();
  assert.match(await body.innerText(), /来源或审核已失效/u);
  assert.match(await body.innerText(), /Original immutable excerpt/u);
  assert.match(await body.innerText(), /来源已失效，保留历史摘录/u);
  await page.locator('[data-testid="wiki-refresh"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.refreshed), true);
  await page.locator('[data-testid="wiki-page-graph-c1"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.opened), 'c1');
  const auditSource = readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1100, 800]) {
      await page.setViewportSize({width,height:720});
      await page.locator('[data-testid="wiki-refresh"]').hover();
      const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
      writeFileSync(join(artifacts, `review-${theme}-${width}.json`), JSON.stringify(audit));
      assert.equal(audit.cut, 0);
      assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
      await page.screenshot({path:join(artifacts, `review-${theme}-${width}.png`)});
    }
  }
});
