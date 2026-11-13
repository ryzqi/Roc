import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electronPath from 'electron';
import {_electron, expect} from '@playwright/test';
import {buildViteRenderer} from './fixtures/build-vite-renderer.mjs';

let directory, app, page;
const errors = [];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-settings-write-guards-'));
  await buildViteRenderer({directory, style: 'html,body,#root{height:100%;margin:0}', script: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {LazyMotion, domMax, MotionConfig} from 'motion/react';
    import {ModelsSection} from './src/renderer/settings/sections/ModelsSection';
    import {RagSection} from './src/renderer/settings/sections/RagSection';
    import {LiteratureSection} from './src/renderer/settings/sections/ReadOnlySections';
    const ok = data => ({ok: true, data});
    const provider = {id: 'local', name: 'Local', type: 'custom', endpoint: 'http://localhost:7777/v1',
      enabled: true, credentialRef: null, models: []};
    const embedding = {id: 'embedding-a', name: 'Embedding A', baseUrl: 'http://localhost:7777/v1',
      model: 'embedding-model', dimensions: 768, enabled: true, keyConfigured: true};
    const models = {ready: true, downloading: false, selectedPack: 'compact', job: null, error: null,
      packs: [{pack: 'compact', ready: true, bytes: 20000000, installedBytes: 20000000, state: 'ready', error: null, models: []}], models: []};
    const client = {api: {
      settings: {
        setProviderSecret: request => {
          window.secrets.push(request);
          return new Promise(resolve => {window.finishSecret = resolve;});
        },
        clearProviderSecret: async () => ok({}),
      },
      research: {
        listEmbeddingConfigs: async () => ok([embedding]),
        saveEmbeddingConfig: request => {
          window.embeddings.push(request);
          return new Promise(resolve => {window.finishEmbedding = resolve;});
        },
        getModelsStatus: async () => ok(models),
        removeModels: request => {
          window.removals.push(request);
          return new Promise(resolve => {window.finishRemoval = resolve;});
        }
      }
    }};
    function Harness({mode}) {
      const [draft, setDraft] = useState({providers: [provider], index: null});
      const store = {client, draft, base: {providers: [provider]}, snapshot: {providerSecretStatus: []},
        update: mutator => setDraft(current => {const next = structuredClone(current); mutator(next); return next;}),
        reload: () => {window.reloads++;}, indexStatus: null};
      return <main style={{padding: 40}}>
        {mode === 'provider' ? <ModelsSection store={store} /> :
          mode === 'embedding' ? <RagSection store={store} /> : <LiteratureSection store={store} />}
      </main>;
    }
    const root = createRoot(document.getElementById('root'));
    let instance = 0;
    window.mount = mode => {
      window.secrets = []; window.embeddings = []; window.removals = []; window.reloads = 0;
      flushSync(() => root.render(<MotionConfig reducedMotion="always"><LazyMotion features={domMax} strict>
        <Harness key={++instance} mode={mode} />
      </LazyMotion></MotionConfig>));
    };
    window.mount('provider');
  `});
  await writeFile(join(directory, 'main.cjs'), `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(directory, 'data'))});
    app.whenReady().then(() => new BrowserWindow({show: false, width: 1100, height: 800})
      .loadFile(${JSON.stringify(join(directory, 'index.html'))}));
  `);
  app = await _electron.launch({executablePath: electronPath, args: [join(directory, 'main.cjs')]});
  page = await app.firstWindow();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('settings-provider-secret-input').waitFor();
});
after(async () => {
  try {await app?.close();} finally {if (directory) await rm(directory, {recursive: true, force: true});}
  assert.deepEqual(errors, [], 'settings writes must surface errors in the UI');
});

test('provider secret writes freeze transient input and preserve a refused key for retry', async () => {
  await page.evaluate(() => window.mount('provider'));
  const input = page.getByTestId('settings-provider-secret-input');
  const save = page.getByTestId('settings-provider-secret-save');
  await input.fill('fixture-key');
  await save.evaluate(button => {button.click(); button.click();});
  assert.equal(await page.evaluate(() => window.secrets.length), 1);
  await expect(input).toBeDisabled();
  await page.evaluate(() => window.finishSecret({ok: false, error: {message: 'Secret unavailable'}}));
  await expect(page.getByTestId('settings-provider-secret-error')).toContainText('Secret unavailable');
  await expect(input).toHaveValue('fixture-key');
  await save.click();
  await page.evaluate(() => window.finishSecret({ok: true, data: {providerId: 'local', stored: true}}));
  await expect(input).toHaveValue('');
});

test('embedding writes freeze all replacement paths and retain failed input', async () => {
  await page.evaluate(() => window.mount('embedding'));
  const name = page.getByTestId('settings-embedding-name');
  const key = page.getByTestId('settings-embedding-apikey');
  await name.fill('Submitted embedding');
  await key.fill('fixture-key');
  await page.getByTestId('settings-embedding-save').evaluate(button => {button.click(); button.click();});
  assert.equal(await page.evaluate(() => window.embeddings.length), 1);
  for (const id of ['settings-embedding-name', 'settings-embedding-baseurl', 'settings-embedding-model',
    'settings-embedding-dimensions', 'settings-embedding-apikey', 'settings-embedding-enabled',
    'settings-embedding-add', 'settings-embedding-pull', 'settings-embedding-select-embedding-a']) {
    await expect(page.getByTestId(id)).toBeDisabled();
  }
  await page.evaluate(() => window.finishEmbedding({ok: false, error: {message: 'Embedding refused'}}));
  await expect(page.getByTestId('settings-embedding-save-error')).toContainText('Embedding refused');
  await expect(name).toHaveValue('Submitted embedding');
  await expect(key).toHaveValue('fixture-key');
  await page.getByTestId('settings-embedding-save').click();
  await page.evaluate(() => window.finishEmbedding({ok: true, data: {
    id: 'embedding-a', name: 'Submitted embedding', baseUrl: 'http://localhost:7777/v1',
    model: 'embedding-model', dimensions: 768, enabled: true, keyConfigured: true
  }}));
  await expect(key).toHaveValue('');
  await expect(name).toHaveValue('Submitted embedding');
});

test('uninstalling a parsing pack requires confirmation and reports a refused removal', async () => {
  await page.evaluate(() => window.mount('models'));
  await page.getByTestId('settings-models-remove').click();
  assert.equal(await page.evaluate(() => window.removals.length), 0);
  await expect(page.getByTestId('settings-models-remove-confirm-panel')).toBeVisible();
  await page.getByTestId('settings-models-remove-confirm-cancel').click();
  await page.getByTestId('settings-models-remove-confirm-panel').waitFor({state: 'detached'});
  await page.getByTestId('settings-models-remove').click();
  await page.getByTestId('settings-models-remove-confirm-confirm').click();
  assert.equal(await page.evaluate(() => window.removals.length), 1);
  await page.evaluate(() => window.finishRemoval({ok: false, error: {message: 'Model pack in use'}}));
  await expect(page.getByTestId('settings-models-remove-error')).toContainText('Model pack in use');
  await expect(page.getByTestId('settings-models-remove')).toBeEnabled();
});
