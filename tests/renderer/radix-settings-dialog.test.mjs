import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

let tempDir;
let app;
let page;
const rendererErrors = [];
const artifacts = join(process.cwd(), '.artifacts/settings-ui');
const clipAudit = readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-radix-settings-dialog-'));
  await esbuild.build({
    stdin: {
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { LazyMotion, MotionConfig, domMax } from 'motion/react';
        import { SettingsModal } from './src/renderer/settings/SettingsModal';
        import { ModalShell } from './src/renderer/shell/ModalShell';
        import { useKeyboardShortcuts } from './src/renderer/app/shortcuts';

        const ok = data => ({ok: true, data});
        function createClient(providers = []) {
          const snapshot = {
            settings: {
              schemaVersion: 3, startup: {openAtLogin: false}, globalHotkey: null,
              memory: {charLimits: {user: 20000, agents: 20000, memory: 40000}, sessionRetentionDays: 30,
                securityScan: {promptInjection: true, credential: true, sshBackdoor: true, invisibleUnicode: true},
                autoMemory: {enabled: true, lowConfidenceTtlDays: 7, auditRetentionDays: 30, maxCandidatesPerRun: 5}},
              tasks: {longRunningThresholds: {runningSeconds: 120, toolCallCount: 20, subagentCount: 3},
                scheduler: {catchUpOnStartup: true, maxRegisteredTasks: 100}}
            },
            providerSecretStatus: providers.map(provider => ({providerId: provider.id, stored: provider.credentialRef !== null})),
            providers, defaultModelId: null,
            permissions: {schemaVersion: 3, mode: 'default', grants: []},
            hostIntegration: {startup: {effectiveOpenAtLogin: false, syncError: null}, globalHotkey: {registered: false, accelerator: null, registrationError: null}},
            hooks: {config: {schemaVersion: 1, hooks: {}}, handlers: [], errors: [], path: '/tmp/hooks.json', exists: false}
          };
          return {api: {
            app: {getStatus: async () => ok({appName: 'Roc', version: '0.1.0', defaultModelConfigured: false})},
            settings: {
              get: async () => ok(structuredClone(snapshot)),
              save: async request => {
                if (window.failNextSave) {
                  window.failNextSave = false;
                  return {ok: false, error: {code: 'INTERNAL_ERROR', message: 'Save unavailable'}};
                }
                Object.assign(snapshot, structuredClone(request));
                return ok(structuredClone(snapshot));
              },
              listRemoteModels: async () => ok({models: [{id: 'new-model'}, {id: 'model-one'}]}),
              saveHooks: async ({config}) => { snapshot.hooks.config = structuredClone(config); return ok(snapshot.hooks); }
            },
            research: {
              getIndexStatus: async () => ok({settings: {
                projectId: 'project-1', revision: 1, kinds: ['markdown'], include: ['**/*'],
                exclude: [], watch: true, paused: false, embeddingConfigId: null
              }}),
              saveIndexSettings: async request => ok({settings: request})
            }
          }};
        }

        function Harness({client}) {
          const [open, setOpen] = useState(false);
          const [ambientOpen, setAmbientOpen] = useState(false);
          const [themeOverride, setThemeOverride] = useState('system');
          useKeyboardShortcuts({
            onToggleSidebar: () => { window.shortcutCounts.sidebar++; },
            onToggleAssistant: () => { window.shortcutCounts.assistant++; },
            onOpenSearch: () => { window.shortcutCounts.search++; },
            onCycleTheme: () => { window.shortcutCounts.theme++; }
          });
          window.setAmbientOpen = setAmbientOpen;
          return React.createElement(React.Fragment, null,
            React.createElement('button', {
              type: 'button', 'data-testid': 'titlebar-settings', onClick: () => setOpen(true)
            }, '设置'),
            React.createElement(SettingsModal, {
              open, client, projectId: null, workspacePath: null, themeOverride,
              onThemeOverrideChange: setThemeOverride, onResetUiPreferences: () => { window.resetCount++; },
              onClose: () => setOpen(false)
            }),
            React.createElement(ModalShell, {
              open: ambientOpen, title: '侧栏', onClose: () => setAmbientOpen(false),
              kind: 'drawer', layer: 'ambient', testId: 'sidebar-drawer'
            }, React.createElement('button', {type: 'button', 'data-testid': 'ambient-action'}, '侧栏操作'))
          );
        }

        const root = createRoot(document.getElementById('root'));
        let generation = 0;
        window.mount = (providers = []) => {
          window.shortcutCounts = {sidebar: 0, assistant: 0, search: 0, theme: 0};
          window.resetCount = 0;
          flushSync(() => root.render(React.createElement(MotionConfig, {reducedMotion: 'user'},
            React.createElement(LazyMotion, {features: domMax, strict: true},
              React.createElement(Harness, {key: ++generation, client: createClient(providers)})
            )
          )));
        };
      `,
      resolveDir: process.cwd(),
      loader: 'jsx'
    },
    outfile: join(tempDir, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent'
  });
  mkdirSync(artifacts, {recursive: true});
  const assets = join(process.cwd(), 'dist/renderer/assets');
  writeFileSync(join(tempDir, 'app.css'), readdirSync(assets).filter(file => file.endsWith('.css'))
    .map(file => readFileSync(join(assets, file), 'utf8')).join('\n'));
  writeFileSync(join(tempDir, 'index.html'), '<html data-theme="light"><link rel="stylesheet" href="app.css"><div id="root"></div><script src="renderer.js"></script></html>');
  writeFileSync(join(tempDir, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(tempDir, 'data'))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({show: false, width: 900, height: 700});
      window.loadFile(${JSON.stringify(join(tempDir, 'index.html'))});
    });
  `);
  app = await _electron.launch({ executablePath: electronPath, args: [join(tempDir, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.evaluate(() => window.mount());
});

after(async () => {
  try {
    await app?.close();
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, {recursive: true, force: true});
  }
  assert.deepEqual(rendererErrors, [], 'renderer must not throw during the Radix dialog pilot');
});

async function selectSection(section) {
  await page.waitForFunction(() => window.matchMedia('(max-width: 719px)').matches
    ? document.querySelector('[data-testid="settings-section-select"]') !== null
    : document.querySelector('[data-testid="settings-sections"]') !== null);
  const compact = page.getByTestId('settings-section-select');
  if (await compact.count()) await compact.selectOption(section);
  else await page.getByTestId('settings-section-' + section).click();
  await page.getByTestId('settings-section-' + section + '-body').waitFor();
}

async function auditLayout(state) {
  const audit = await page.evaluate('(' + clipAudit + ')({root: "body", viewport: true})');
  assert.equal(audit.cut, 0, state + ': ' + JSON.stringify(audit));
  const overflow = await page.getByTestId('settings-panel').evaluate(el => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false, state + ' has no horizontal overflow');
  return {state, ...audit};
}

test('settings dialog layers focus, Escape, animations, shortcuts, and ambient drawers correctly', async () => {
  const opener = page.getByTestId('titlebar-settings');
  await opener.click();
  await page.getByTestId('settings-modal-panel').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-models');

  await page.getByTestId('settings-section-app').click();
  await page.getByTestId('settings-open-at-login').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-discard-panel').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-discard-cancel');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1, 'Escape closes only the nested confirmation');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-open-at-login');

  await page.getByTestId('settings-open-at-login').click();
  await page.keyboard.down('Escape');
  await page.waitForTimeout(10);
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1, 'the dialog remains mounted during its exit animation');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="settings-modal-panel"]')?.contains(document.activeElement)), true,
    'focus stays inside the dialog while it animates out');
  await page.keyboard.up('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'titlebar-settings');

  await opener.click();
  await page.getByTestId('settings-modal-panel').waitFor();
  await page.keyboard.press('Meta+b');
  await page.keyboard.press('Meta+k');
  assert.deepEqual(await page.evaluate(() => window.shortcutCounts), {sidebar: 0, assistant: 0, search: 1, theme: 0});

  await page.evaluate(() => window.setAmbientOpen(true));
  await page.getByTestId('sidebar-drawer-panel').waitFor();
  assert.deepEqual(await page.evaluate(() => ({
    settings: getComputedStyle(document.querySelector('[data-testid="settings-modal"]')).zIndex,
    ambient: getComputedStyle(document.querySelector('[data-testid="sidebar-drawer"]')).zIndex,
    focusInSettings: document.querySelector('[data-testid="settings-modal-panel"]')?.contains(document.activeElement)
  })), {settings: '50', ambient: '40', focusInSettings: true});

  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
  assert.equal(await page.getByTestId('sidebar-drawer-panel').count(), 1, 'the dialog closes before the ambient drawer');
  await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-drawer-panel').waitFor({state: 'detached'});
});


test('reset confirmation accepts real pointer clicks and Escape leaves settings open', async () => {
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-section-backup').click();
  await page.getByTestId('settings-reset-ui').click();
  await page.getByTestId('settings-reset-confirm-panel').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-reset-confirm-panel').waitFor({state: 'detached'});
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1);
  assert.equal(await page.evaluate(() => window.resetCount), 0);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-reset-ui');

  await page.getByTestId('settings-reset-ui').click();
  await page.getByTestId('settings-reset-confirm-confirm').click();
  await page.getByTestId('settings-reset-confirm-panel').waitFor({state: 'detached'});
  assert.equal(await page.evaluate(() => window.resetCount), 1);
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-reset-ui');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('discard requires confirmation, retains settings, and appearance changes apply immediately', async () => {
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-section-app').click();
  await page.getByTestId('settings-open-at-login').check();
  await page.getByTestId('settings-section-backup').click();
  await page.getByTestId('settings-section-app').click();
  assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), true, 'tab navigation retains the draft');
  await page.getByTestId('settings-discard-draft').click();
  await page.getByTestId('settings-discard-cancel').click();
  assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), true);
  await page.getByTestId('settings-discard-draft').click();
  await page.getByTestId('settings-discard-confirm').click();
  assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), false);
  assert.equal(await page.getByTestId('settings-modal-panel').isVisible(), true, 'explicit discard keeps the settings open');
  await page.getByTestId('settings-theme-dark').click();
  assert.equal(await page.getByTestId('settings-theme-dark').getAttribute('aria-pressed'), 'true');
  await page.getByTestId('settings-density-compact').click();
  assert.equal(await page.getByTestId('settings-density-compact').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('settings-save').isEnabled(), false, 'appearance preferences do not enter the backend draft');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('backup preview, import validation and settings layout work in both themes with zero shadow cuts', async () => {
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-section-backup').click();
  assert.equal(await page.getByTestId('settings-export-text').count(), 0);
  await page.getByTestId('settings-export-generate').click();
  assert.equal(JSON.parse(await page.getByTestId('settings-export-text').inputValue()).schemaVersion, 1);
  assert.equal(await page.getByTestId('settings-export-text').getAttribute('readonly'), '');
  await page.getByTestId('settings-import-text').fill('{invalid');
  await page.getByTestId('settings-import-apply').click();
  await page.getByTestId('settings-import-error').waitFor();
  assert.equal(await page.getByTestId('settings-save').isEnabled(), false);
  const exported = JSON.parse(await page.getByTestId('settings-export-text').inputValue());
  exported.settings.startup.openAtLogin = true;
  await page.getByTestId('settings-import-text').fill(JSON.stringify(exported));
  await page.getByTestId('settings-import-apply').click();
  await page.getByTestId('settings-import-ok').waitFor();
  await page.getByTestId('settings-section-app').click();
  assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), true);
  await page.getByTestId('settings-discard-draft').click();
  await page.getByTestId('settings-discard-confirm').click();
  await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});

  const audits = [];
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({reducedMotion});
    for (const theme of ['light', 'dark']) {
      await selectSection('app');
      await page.getByTestId('settings-theme-' + theme).click();
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1440, 800, 640]) {
        await page.setViewportSize({width, height: 850});
        for (const section of ['models', 'app', 'backup']) {
          await selectSection(section);
          await page.waitForTimeout(150);
          const overflow = await page.getByTestId('settings-panel').evaluate(el => el.scrollWidth > el.clientWidth + 1);
          assert.equal(overflow, false, section + ' has no horizontal overflow');
          const save = await page.getByTestId('settings-save').boundingBox();
          const panel = await page.getByTestId('settings-modal-panel').boundingBox();
          assert.ok(save.y >= panel.y && save.y + save.height <= panel.y + panel.height, 'save remains visible');
          const audit = await page.evaluate('(' + clipAudit + ')({root: "body", viewport: true})');
          audits.push({section, theme, width, reducedMotion, ...audit});
          assert.equal(audit.cut, 0, JSON.stringify(audit));
          if (reducedMotion === 'no-preference') await page.screenshot({path: join(artifacts, section + '-' + theme + '-' + width + '.png')});
        }
      }
    }
  }
  writeFileSync(join(artifacts, 'clip-audit.json'), JSON.stringify(audits, null, 2));
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('compact navigation keeps all sections, drafts and keyboard focus across window resizing', async () => {
  await page.setViewportSize({width: 640, height: 850});
  await page.evaluate(() => window.mount());
  await page.getByTestId('titlebar-settings').click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-select');
  assert.equal(await page.getByTestId('settings-section-select').locator('option').count(), 13);
  await selectSection('app');
  await page.getByTestId('settings-open-at-login').check();
  assert.match(await page.getByTestId('settings-section-select').locator('option:checked').textContent(), /未保存/u);
  await selectSection('backup');
  await selectSection('app');
  assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), true);
  await page.getByTestId('settings-section-select').focus();
  await page.setViewportSize({width: 900, height: 850});
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-app');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-models');
  await page.setViewportSize({width: 640, height: 850});
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-select');
  assert.equal(await page.getByTestId('settings-section-select').inputValue(), 'models');
  await page.getByTestId('settings-discard-draft').click();
  await page.getByTestId('settings-discard-confirm').click();
  await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

const modelProviders = [{
    id: 'provider-one', type: 'custom', name: 'Example provider', endpoint: 'https://models.example/v1',
    credentialRef: 'secret:provider-one', enabled: true, models: [{id: 'model-one', displayName: 'Model One', enabled: true,
      supportsStreaming: true, supportsToolCalls: true, supportsImages: false, options: {temperature: 0.7, maxTokens: 4096}}]
}];

test('Escape cancels model, provider and secret confirmations without closing settings or losing focus', async () => {
  await page.setViewportSize({width: 900, height: 850});
  await page.evaluate(providers => window.mount(providers), modelProviders);
  await page.getByTestId('titlebar-settings').click();
  for (const [trigger, dialog] of [
    ['settings-model-remove-0', 'settings-model-remove-confirm'],
    ['settings-provider-remove', 'settings-provider-remove-confirm'],
    ['settings-provider-secret-clear', 'settings-secret-clear-confirm']
  ]) {
    await page.getByTestId(trigger).click();
    await page.getByTestId(dialog + '-panel').waitFor();
    await page.keyboard.press('Escape');
    await page.getByTestId(dialog + '-panel').waitFor({state: 'detached'});
    assert.equal(await page.getByTestId('settings-modal-panel').isVisible(), true, 'Escape must close only ' + dialog);
    await page.waitForFunction(trigger => document.activeElement?.getAttribute('data-testid') === trigger, trigger);
  }
  assert.equal(await page.getByTestId('settings-model-id-0').inputValue(), 'model-one');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('validation jumps to its section and a failed save retains the draft for retry', async () => {
  await page.evaluate(providers => window.mount(providers), modelProviders);
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-provider-name').fill('');
  await selectSection('app');
  await page.getByTestId('settings-save').click();
  await page.getByTestId('settings-issue-jump-models').click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-panel');
  assert.equal(await page.getByTestId('settings-provider-name').inputValue(), '');
  await page.getByTestId('settings-provider-name').fill('Updated provider');
  await page.evaluate(() => { window.failNextSave = true; });
  await page.getByTestId('settings-save').click();
  await page.getByTestId('settings-save-error').waitFor();
  assert.match(await page.getByTestId('settings-save-error').textContent(), /Save unavailable/u);
  assert.equal(await page.getByTestId('settings-provider-name').inputValue(), 'Updated provider');
  assert.equal(await page.getByTestId('settings-save').isEnabled(), true);
  await page.getByTestId('settings-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-save"]')?.disabled === true);
  assert.match(await page.getByTestId('settings-dirty-bar').textContent(), /所有修改已保存/u);
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('populated model settings, expanded controls and nested dialogs have zero shadow cuts', async () => {
  await page.evaluate(providers => window.mount(providers), modelProviders);
  await page.getByTestId('titlebar-settings').click();
  const audits = [];
  for (const theme of ['light', 'dark']) {
    await selectSection('app');
    await page.getByTestId('settings-theme-' + theme).click();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 640]) {
      await page.setViewportSize({width, height: 850});
      await selectSection('models');
      await page.getByTestId('settings-provider-name').waitFor();
      await page.waitForTimeout(150);
      audits.push({theme, width, ...await auditLayout('populated')});
      await page.screenshot({path: join(artifacts, 'models-populated-' + theme + '-' + width + '.png')});
      await page.getByTestId('settings-model-advanced-0').locator('summary').click();
      await page.waitForFunction(() => getComputedStyle(
        document.querySelector('[data-testid="settings-model-advanced-0"]'), '::details-content'
      ).opacity === '1');
      await page.getByTestId('settings-model-temperature-0').hover();
      audits.push({theme, width, ...await auditLayout('expanded-hover')});
      await page.screenshot({path: join(artifacts, 'models-expanded-' + theme + '-' + width + '.png')});
      await page.getByTestId('settings-model-remove-0').click();
      await page.getByTestId('settings-model-remove-confirm-panel').waitFor();
      await page.waitForTimeout(150);
      audits.push({theme, width, ...await auditLayout('remove-confirm')});
      await page.screenshot({path: join(artifacts, 'models-confirm-' + theme + '-' + width + '.png')});
      await page.keyboard.press('Escape');
      await page.getByTestId('settings-model-remove-confirm-panel').waitFor({state: 'detached'});
      await page.getByTestId('settings-model-pull').click();
      await page.getByTestId('settings-provider-models-pull-fetch').click();
      await page.getByTestId('settings-provider-models-pull-option-new-model').waitFor();
      audits.push({theme, width, ...await auditLayout('remote-models')});
      await page.screenshot({path: join(artifacts, 'models-pull-' + theme + '-' + width + '.png')});
      assert.equal(await page.getByTestId('settings-provider-models-pull-option-model-one').isDisabled(), true);
      await page.getByTestId('settings-provider-models-pull-cancel').click();
      await page.getByTestId('settings-provider-models-pull-panel').waitFor({state: 'detached'});
      // Unmount the section to reset native details before the next size.
      await selectSection('app');
    }
  }
  writeFileSync(join(artifacts, 'clip-audit-populated.json'), JSON.stringify(audits, null, 2));
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});
