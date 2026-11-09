import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

let directory, app, page;
const errors = [];
const artifacts = join(process.cwd(), '.artifacts/model-provider-settings');

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-provider-settings-ui-'));
  mkdirSync(artifacts, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { LazyMotion, MotionConfig, domMax } from 'motion/react';
        import { ModelsSection } from './src/renderer/settings/sections/ModelsSection';
        const root = createRoot(document.getElementById('root'));
        let generation = 0;
        function Harness({ seed }) {
          const [draft, setDraft] = useState(seed);
          window.currentDraft = draft;
          const store = {
            draft, snapshot: { providerSecretStatus: [] }, client: {}, reload() {},
            update(mutator) {
              setDraft(previous => {
                const next = structuredClone(previous);
                mutator(next);
                return next;
              });
            }
          };
          return <ModelsSection store={store} />;
        }
        window.mount = seed => flushSync(() => root.render(
          <MotionConfig reducedMotion="user"><LazyMotion features={domMax} strict>
            <Harness key={++generation} seed={seed} />
          </LazyMotion></MotionConfig>
        ));
      `,
      resolveDir: process.cwd(), loader: 'tsx'
    },
    outfile: join(directory, 'app.js'), bundle: true, platform: 'browser', format: 'iife', logLevel: 'silent'
  });
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(directory, 'app.css'), readdirSync(assets).filter(file => file.endsWith('.css'))
    .map(file => readFileSync(join(assets, file), 'utf8')).join('\n'));
  writeFileSync(join(directory, 'index.html'), `<html data-theme="light"><link rel="stylesheet" href="app.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,sans-serif}</style>
    <div id="root"></div><script src="app.js"></script></html>`);
  writeFileSync(join(directory, 'main.cjs'), `
    const {app,BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show:false,width:1100,height:720})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(directory, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
});

after(async () => {
  try { await app?.close(); } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
});

test('empty settings distinguish loading and support adding the first provider by keyboard', async () => {
  await page.evaluate(() => window.mount(null));
  await page.getByTestId('settings-models-unavailable').waitFor();
  await page.evaluate(() => window.mount({ providers: [], defaultModelId: null }));
  await page.getByTestId('settings-models-empty').waitFor();
  assert.equal(await page.getByTestId('settings-models-unavailable').count(), 0);
  await page.getByTestId('settings-provider-add').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('settings-provider-name').waitFor();
  assert.equal(await page.evaluate(() => window.currentDraft.providers.length), 1);
  assert.equal(await page.getByTestId('settings-provider-type').locator('option').count(), 7);
  await page.getByTestId('settings-provider-name').fill('My provider');
  await page.getByTestId('settings-provider-endpoint').fill('https://private.example/v1');
  assert.equal(await page.evaluate(() => window.currentDraft.providers[0].name), 'My provider');
});

test('former built-ins allow edits, cancel removal and remove their default-model reference', async () => {
  for (const type of ['nvidia', 'openrouter', 'llama_cpp']) {
    await page.evaluate(type => window.mount({
      providers: [{ id: type, type, name: type, endpoint: 'https://original.example/v1',
        credentialRef: null, enabled: true, models: [] }],
      defaultModelId: type + ':model'
    }), type);
    assert.equal(await page.getByTestId('settings-provider-builtin').count(), 0);
    assert.equal(await page.getByTestId('settings-provider-name').isEnabled(), true);
    assert.equal(await page.getByTestId('settings-provider-type').isEnabled(), true);
    assert.equal(await page.getByTestId('settings-provider-endpoint').isEnabled(), true);
    await page.getByTestId('settings-provider-name').fill('Edited ' + type);
    await page.getByTestId('settings-provider-endpoint').fill('https://edited.example/v1');
    await page.getByTestId('settings-provider-remove').click();
    await page.getByTestId('settings-provider-remove-confirm-cancel').click();
    assert.equal(await page.evaluate(() => window.currentDraft.providers.length), 1);
    await page.getByTestId('settings-provider-remove').click();
    await page.getByTestId('settings-provider-remove-confirm-confirm').click();
    await page.getByTestId('settings-models-empty').waitFor();
    assert.deepEqual(await page.evaluate(() => window.currentDraft), { providers: [], defaultModelId: null });
    assert.equal(await page.getByTestId('settings-provider-add').isVisible(), true);
  }
});

test('empty state fits light and dark desktop layouts', async () => {
  await page.evaluate(() => window.mount({ providers: [], defaultModelId: null }));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1100, 800]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal(await page.getByTestId('settings-section-models-body')
        .evaluate(element => element.scrollWidth > element.clientWidth), false);
    }
    await page.screenshot({ path: join(artifacts, `empty-${theme}.png`) });
  }
});
