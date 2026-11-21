import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import electronPath from 'electron';
import {_electron} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';
import {loadResearchTestApi} from '../unit/fixtures/research-test-kit.mjs';
import {createReviewExtractionFixture} from '../unit/fixtures/research-review-extraction.mjs';
import {fullTextActor as actor} from '../unit/fixtures/research-review-fulltext-screening.mjs';

test('pilot uses an explicit keyboard-selected sample, displays real missing/unjudgeable cells and preserves all review decisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-review-pilot-ui-'));
  const api = await loadResearchTestApi();
  let f, app;
  try {
    f = await createReviewExtractionFixture(api);
    const extraction = f.extract();
    extraction.fields[0].value = {kind: 'missing', reason: 'Outcome not reported in the inspected full text.'};
    extraction.studyDesign.value = {kind: 'unjudgeable', reason: 'Design cannot be judged from this report.'};
    await f.extractions.save(extraction, actor);
    const pilot = new api.ResearchReviewExtractionPilot(f.repository, f.fullFreezing, f.fulltexts, f.extractions);
    await buildViteRenderer({directory, script: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import {ReviewExtractionPilot} from './src/renderer/artifacts/ReviewExtractionPilot';
      const root=createRoot(document.getElementById('root'));
      window.mount=(props)=>flushSync(()=>root.render(<ReviewExtractionPilot {...props}
        client={{api:{research:{inspectReviewExtractionPilot:request=>window.readPilot(request)}}}}/>));
    `, style: 'body{padding:20px;color:var(--ink);background:var(--bg);font-family:-apple-system,sans-serif;font-size:13px;}'});
    await writeFile(join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',${JSON.stringify(join(directory, 'data'))});
      app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850}).loadFile(${JSON.stringify(join(directory, 'index.html'))}));`);
    app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
    const page = await app.firstWindow(), errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('readPilot', async input => {
      calls.push(input);
      api.parseIpcRequestArgs('roc:research:review-extraction-pilot', [input]);
      return {ok: true, data: await pilot.inspect(input)};
    });
    await page.waitForFunction(() => typeof window.mount === 'function');
    await page.evaluate(props => window.mount(props), {protocol: f.protocol, phase: f.fullFrozen, locked: false});
    const button = page.getByTestId('artifact-review-pilot-read');
    assert.equal(await button.isDisabled(), true);
    assert.equal(calls.length, 0);
    const checkbox = page.getByRole('checkbox').first();
    await checkbox.focus();
    await page.keyboard.press('Space');
    assert.equal(await button.isEnabled(), true);
    const before = f.changes();
    await button.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('artifact-review-pilot-report').waitFor();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].hitIds, [f.corpus.snapshot.hits[0].id]);
    assert.equal(calls[0].expectedFullFreezeHash, f.fullFrozen.freezeHash);
    const report = page.getByTestId('artifact-review-pilot-report');
    assert.match(await report.innerText(), /无法判断/u);
    assert.match(await report.innerText(), /未找到/u);
    assert.match(await report.innerText(), /Outcome not reported/u);
    assert.equal(f.changes(), before);
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.setViewportSize({width: 700, height: 850});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await checkbox.uncheck();
    assert.equal(await page.getByTestId('artifact-review-pilot-report').count(), 0);
    assert.equal(await button.isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await app?.close();
    await f?.cleanup();
    api.dispose();
    await rm(directory, {recursive: true, force: true});
  }
});
