import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

let tempDir;
let app;
let page;
const rendererErrors = [];

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
        function createClient() {
          const snapshot = {
            settings: {startup: {openAtLogin: false}, globalHotkey: null},
            providers: [], defaultModelId: null,
            permissions: {schemaVersion: 3, mode: 'default', grants: []},
            hooks: {config: {schemaVersion: 1, hooks: {}}}
          };
          return {api: {
            settings: {
              get: async () => ok(structuredClone(snapshot)),
              save: async request => { Object.assign(snapshot, structuredClone(request)); return ok(structuredClone(snapshot)); },
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
              onThemeOverrideChange: setThemeOverride, onResetUiPreferences: () => {},
              onClose: () => setOpen(false)
            }),
            React.createElement(ModalShell, {
              open: ambientOpen, title: '侧栏', onClose: () => setAmbientOpen(false),
              kind: 'drawer', layer: 'ambient', testId: 'sidebar-drawer'
            }, React.createElement('button', {type: 'button', 'data-testid': 'ambient-action'}, '侧栏操作'))
          );
        }

        const root = createRoot(document.getElementById('root'));
        window.mount = () => {
          window.shortcutCounts = {sidebar: 0, assistant: 0, search: 0, theme: 0};
          flushSync(() => root.render(React.createElement(MotionConfig, {reducedMotion: 'user'},
            React.createElement(LazyMotion, {features: domMax, strict: true},
              React.createElement(Harness, {client: createClient()})
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
  writeFileSync(join(tempDir, 'index.html'), '<div id="root"></div><script src="renderer.js"></script>');
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
