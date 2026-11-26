import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
    import {AppSection} from './src/renderer/settings/sections/AppSections';
    import {recordUxEvent} from './src/renderer/app/ux-metrics';
    window.addMetrics = count => {for(let i=0;i<count;i++) recordUxEvent('screen_open', 'overview');};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>{window.clipboardCalls.push(text);
      return new Promise((resolve,reject)=>{window.finishCopy=resolve;window.refuseCopy=()=>reject(new Error('Clipboard denied'));});}}});
    import {RagSection} from './src/renderer/settings/sections/RagSection';
    import {LiteratureSection} from './src/renderer/settings/sections/ReadOnlySections';
    const ok = data => ({ok: true, data});
    const provider = {id: 'local', name: 'Local', type: 'custom', endpoint: 'http://localhost:7777/v1',
      enabled: true, credentialRef: null, models: []};
    const embedding = {id: 'embedding-a', name: 'Embedding A', baseUrl: 'http://localhost:7777/v1',
      model: 'embedding-model', dimensions: 768, enabled: true, keyConfigured: true};
    const models = {ready: true, downloading: false, selectedPack: 'compact', job: null, error: null,
      packs: [{pack: 'compact', ready: true, bytes: 20000000, installedBytes: 20000000, state: 'ready', error: null, models: []}], models: []};
    window.parsingModels = models;
    const client = {api: {
      app: {getStatus: async () => ok({appName: 'Roc', version: '0.1.0'})},
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
        getModelsStatus: async () => ok(window.parsingModels),
        downloadModels: request => {
          window.downloads.push(request);
          window.parsingModels = {...window.parsingModels, downloading: true,
            job: {pack: 'complete', phase: 'installing_wheels', bytesDone: 0, bytesTotal: 0, startedAt: new Date().toISOString()}};
          return new Promise(resolve => {window.finishDownload = resolve;});
        },
        cancelModelsDownload: async () => {
          window.parsingModels = {...window.parsingModels, downloading: false, job: null};
          window.finishDownload({ok: false, error: {message: 'Download cancelled'}});
          return ok(window.parsingModels);
        },
        removeModels: request => {
          window.removals.push(request);
          return new Promise(resolve => {window.finishRemoval = resolve;});
        }
      }
    }};
    function Harness({mode}) {
      const [draft, setDraft] = useState({providers: [provider], index: null, settings: {startup: {openAtLogin: false}, globalHotkey: null}});
      const store = {client, draft, base: {providers: [provider]}, snapshot: {providerSecretStatus: []},
        update: mutator => setDraft(current => {const next = structuredClone(current); mutator(next); return next;}),
        reload: () => {window.reloads++;}, indexStatus: null};
      return <main style={{padding: 40}}>
        {mode === 'app' ? <AppSection store={store} themeOverride="system" onThemeOverrideChange={() => {}} /> : mode === 'provider' ? <ModelsSection store={store} /> :
          mode === 'embedding' ? <RagSection store={store} /> : <LiteratureSection store={store} />}
      </main>;
    }
    const root = createRoot(document.getElementById('root'));
    let instance = 0;
    window.mount = mode => {
      window.downloads = []; window.secrets = []; window.embeddings = []; window.removals = []; window.reloads = 0; window.clipboardCalls=[];
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
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).toHaveText('保存中…');
  await expect(save.locator('svg[aria-hidden="true"]')).toBeVisible();
  await page.evaluate(() => window.finishSecret({ok: false, error: {message: 'Secret unavailable'}}));
  await expect(page.getByTestId('settings-provider-secret-error')).toContainText('Secret unavailable');
  await expect(input).toHaveValue('fixture-key');
  await expect(save).toBeEnabled();
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  await expect(save.locator('svg')).toHaveCount(0);
  await save.click();
  await page.evaluate(() => window.finishSecret({ok: true, data: {providerId: 'local', stored: true}}));
  await expect(input).toHaveValue('');
});

test('embedding writes freeze all replacement paths and retain failed input', async () => {
  await page.evaluate(() => window.mount('embedding'));
  const id = page.getByTestId('settings-embedding-id');
  await expect(id).toBeEnabled();
  await expect(id).toHaveAttribute('readonly', '');
  await expect(id).toHaveAccessibleName('标识');
  await expect(id).toHaveAccessibleDescription('只读');
  await id.focus();
  await expect(id).toBeFocused();
  await id.press('Meta+A');
  assert.equal(await id.evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd)), 'embedding-a');
  await id.press('Backspace');
  await expect(id).toHaveValue('embedding-a');
  const name = page.getByTestId('settings-embedding-name');
  const key = page.getByTestId('settings-embedding-apikey');
  await name.fill('Submitted embedding');
  await key.fill('fixture-key');
  await page.getByTestId('settings-embedding-save').evaluate(button => {button.click(); button.click();});
  assert.equal(await page.evaluate(() => window.embeddings.length), 1);
  assert.equal(await page.evaluate(() => window.embeddings[0].id), 'embedding-a');
  for (const id of ['settings-embedding-id', 'settings-embedding-name', 'settings-embedding-baseurl', 'settings-embedding-model',
    'settings-embedding-dimensions', 'settings-embedding-apikey', 'settings-embedding-enabled',
    'settings-embedding-add', 'settings-embedding-pull', 'settings-embedding-select-embedding-a']) {
    await expect(page.getByTestId(id)).toBeDisabled();
  }
  await page.evaluate(() => window.finishEmbedding({ok: false, error: {message: 'Embedding refused'}}));
  await expect(page.getByTestId('settings-embedding-save-error')).toContainText('Embedding refused');
  await expect(name).toHaveValue('Submitted embedding');
  await expect(key).toHaveValue('fixture-key');
  await expect(id).toBeEnabled();
  await expect(id).toHaveAttribute('readonly', '');
  await page.getByTestId('settings-embedding-save').click();
  await page.evaluate(() => window.finishEmbedding({ok: true, data: {
    id: 'embedding-a', name: 'Submitted embedding', baseUrl: 'http://localhost:7777/v1',
    model: 'embedding-model', dimensions: 768, enabled: true, keyConfigured: true
  }}));
  await expect(key).toHaveValue('');
  await expect(name).toHaveValue('Submitted embedding');
});

test('new embedding identifiers remain editable', async () => {
  await page.evaluate(() => window.mount('embedding'));
  await expect(page.getByTestId('settings-embedding-id')).toHaveAttribute('readonly', '');
  await page.getByTestId('settings-embedding-add').click();
  const id = page.getByTestId('settings-embedding-id');
  await expect(id).toBeEditable();
  await expect(id).not.toHaveAttribute('aria-describedby');
  await id.fill('new-embedding');
  await expect(id).toHaveValue('new-embedding');
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


test('application session diagnostics copy only the bounded anonymous events and expose clipboard failure', async () => {
  await page.evaluate(() => {window.mount('app'); window.addMetrics(510);});
  const disclosure = page.getByTestId('settings-session-diagnostics');
  const copy = page.getByTestId('settings-copy-ux-metrics');
  await expect(copy).toBeHidden();
  await disclosure.locator('summary').focus();
  await page.keyboard.press('Enter');
  await copy.click();
  await expect(copy).toBeDisabled();
  await expect(copy).toContainText('正在复制');
  const payload = JSON.parse(await page.evaluate(() => window.clipboardCalls[0]));
  assert.equal(payload.events.length, 500);
  assert.ok(payload.events.every(event => Object.keys(event).sort().join(',') === 'elapsedMs,event,surface'));
  assert.ok(payload.events.every(event => event.event === 'screen_open' && event.surface === 'overview'));
  await page.evaluate(() => window.refuseCopy());
  await expect(disclosure.getByRole('alert')).toContainText('Clipboard denied');
  await copy.click();
  await page.evaluate(() => window.finishCopy());
  await expect(copy).toContainText('已复制诊断');
  await expect(disclosure.getByRole('alert')).toHaveCount(0);
  const auditSource = await readFile('scripts/ui-audit/clip-audit.js', 'utf8');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme=theme, theme);
    await page.setViewportSize({width:480,height:800});
    await copy.hover();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(await copy.evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 12));
    const audit = await page.evaluate(`(${auditSource})({root:'body',viewport:true})`);
    assert.equal(audit.cut,0);
    if(process.env.ROC_UI_CAPTURE_DIR) await page.screenshot({path:join(process.env.ROC_UI_CAPTURE_DIR,`session-diagnostics-${theme}.png`)});
  }
});


test('complete parsing shows installation phases, hides unsupported import and can cancel a pending download', async () => {
  await page.evaluate(() => {
    window.parsingModels = {ready: false, downloading: false, selectedPack: 'complete', job: null, error: null,
      packs: [{pack: 'complete', ready: false, bytes: 1220236780, installedBytes: 0, state: 'missing', error: null, models: []}], models: []};
    window.mount('literature');
  });
  await expect(page.getByTestId('settings-models-list')).toContainText('OvisOCR3 8-bit');
  await expect(page.getByTestId('settings-models-import')).toHaveCount(0);
  await page.getByTestId('settings-models-download').click();
  await expect(page.getByTestId('settings-models-cancel')).toBeEnabled();
  await expect(page.getByTestId('settings-models-progress')).toContainText('安装运行依赖');
  assert.deepEqual(await page.evaluate(() => window.downloads), [{pack: 'complete'}]);
  await page.getByTestId('settings-models-cancel').click();
  await expect(page.getByTestId('settings-models-download-error')).toContainText('Download cancelled');
  await expect(page.getByTestId('settings-models-cancel')).toBeDisabled();
});
