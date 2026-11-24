import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';

let tempDir;
let app;
let page;
const rendererErrors = [];
const artifacts = join(process.cwd(), '.artifacts/settings-ui');
const clipAudit = readFileSync('scripts/ui-audit/clip-audit.js', 'utf8');

for (const field of ['settings', 'providers', 'permissions', 'hooks']) {
  test(`settings import rejects incomplete ${field} before replacing the live draft`, async () => {
    await page.evaluate(() => window.mount());
    await page.getByTestId('activity-settings').click();
    await clickSection('backup');
    await page.getByTestId('settings-export-generate').click();
    const text = await page.getByTestId('settings-export-text').inputValue();
    const document = JSON.parse(text);
    if (field === 'settings') document.settings = {};
    if (field === 'providers') document.providers = [{id: 'local', name: 'Local', endpoint: '', models: [{}]}];
    if (field === 'permissions') delete document.permissions.grants;
    if (field === 'hooks') document.hooks.hooks.PreToolUse = [{}];
    await page.getByTestId('settings-import-text').fill(JSON.stringify(document));
    await page.getByTestId('settings-import-apply').click();
    await page.getByTestId('settings-import-error').waitFor();
    assert.match(await page.getByTestId('settings-import-error').innerText(), new RegExp(field));
    assert.equal(await page.getByTestId('settings-import-ok').count(), 0);
    await page.getByTestId('settings-export-generate').click();
    const unchanged = JSON.parse(await page.getByTestId('settings-export-text').inputValue());
    delete unchanged.exportedAt;
    const original = JSON.parse(text);
    delete original.exportedAt;
    assert.deepEqual(unchanged, original, 'a refused import must retain the whole current document');
    await clickSection('app');
    const discard = page.getByTestId('settings-editor-discard-panel');
    await discard.waitFor();
    await page.getByTestId('settings-editor-discard-cancel').click();
    await discard.waitFor({state: 'detached'});
    assert.equal(await page.getByTestId('settings-import-text').inputValue(), JSON.stringify(document));
    await clickSection('app');
    await page.getByTestId('settings-editor-discard-confirm').click();
    await discard.waitFor({state: 'detached'});
    await page.getByTestId('settings-section-app-body').waitFor();
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
  });
}

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
        import { ConfirmDialog } from './src/renderer/shell/ConfirmDialog';
        import { ActivityRail } from './src/renderer/shell/ActivityRail';
        import { useKeyboardShortcuts } from './src/renderer/app/shortcuts';
        import { useAppRoute } from './src/renderer/app/use-app-route';
        import { BEFORE_NAVIGATE } from './src/renderer/app/navigation-guard';
        import { writeSettingsSection } from './src/renderer/app/ui-state';

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
            hooks: {config: {schemaVersion: 1, hooks: {}}, handlers: [], validationErrors: [], configPath: '/tmp/hooks.json', exists: false}
          };
          return {api: {
            app: {getStatus: async () => ok({appName: 'Roc', version: '0.1.0', defaultModelConfigured: false})},
            settings: {
              get: async () => ok(structuredClone(snapshot)),
              save: async request => {
                window.settingsSaveRequests.push(request);
                if (window.failNextSave) {
                  window.failNextSave = false;
                  return {ok: false, error: {code: 'INTERNAL_ERROR', message: 'Save unavailable'}};
                }
                Object.assign(snapshot, structuredClone(request));
                return ok(structuredClone(snapshot));
              },
              listRemoteModels: async request => {
                if (!window.deferRemoteModels) return ok({models: [{id: 'new-model'}, {id: 'model-one'}]});
                return new Promise(resolve => window.remoteModelRequests.push({request, resolve}));
              },
              setProviderSecret: request => new Promise(resolve => window.secretRequests.push({request, resolve})),
              clearProviderSecret: async () => ok(null),
              saveHooks: async ({config}) => { snapshot.hooks.config = structuredClone(config); return ok(snapshot.hooks); }
            },
            research: {
              getIndexStatus: async () => ok({settings: {
                projectId: 'project-1', revision: 1, kinds: ['markdown'], include: ['**/*'],
                exclude: [], watch: true, paused: false, embeddingConfigId: null
              }}),
              saveIndexSettings: async request => ok({settings: request}),
              listEmbeddingConfigs: async () => ok([
                {id: 'embedding-one', name: 'Embedding one', baseUrl: 'https://models.invalid/v1',
                  model: 'embedding-test', dimensions: 3, enabled: true, keyConfigured: true},
                {id: 'embedding-two', name: 'Embedding two', baseUrl: 'https://models.invalid/v1',
                  model: 'embedding-test', dimensions: 3, enabled: true, keyConfigured: true}
              ]),
              saveEmbeddingConfig: request => new Promise(resolve => window.embeddingRequests.push({request, resolve}))
            }
          }};
        }

        function Harness({client, routeClose}) {
          const [open, setOpen] = useState(false);
          const [ambientOpen, setAmbientOpen] = useState(false);
          const [themeOverride, setThemeOverride] = useState('system');
          const {route, navigate} = useAppRoute();
          useKeyboardShortcuts({
            onToggleSidebar: () => { window.shortcutCounts.sidebar++; },
            onToggleAssistant: () => { window.shortcutCounts.assistant++; },
            onOpenSearch: () => { window.shortcutCounts.search++; },
            onCycleTheme: () => { window.shortcutCounts.theme++; }
          });
          window.setAmbientOpen = setAmbientOpen;
          return React.createElement(React.Fragment, null,
            React.createElement('button', {
              type: 'button', 'data-testid': 'activity-settings',
              onClick: () => routeClose ? navigate({...route, page: 'settings'}) : setOpen(true)
            }, '设置'),
            React.createElement(SettingsModal, {
              open: routeClose ? route.page === 'settings' : open,
              client, projectId: null, workspacePath: null, themeOverride,
              onThemeOverrideChange: setThemeOverride, onResetUiPreferences: () => { window.resetCount++; },
              onClose: () => routeClose ? navigate({...route, page: 'research'}) : setOpen(false)
            }),
            React.createElement(ModalShell, {
              open: ambientOpen, title: '侧栏', onClose: () => setAmbientOpen(false),
              kind: 'drawer', layer: 'ambient', testId: 'sidebar-drawer'
            }, React.createElement('button', {type: 'button', 'data-testid': 'ambient-action'}, '侧栏操作'))
          );
        }

        const root = createRoot(document.getElementById('root'));
        window.unmount = () => flushSync(() => root.unmount());
        function ConfirmationFixture() {
          const [open, setOpen] = useState(true);
          return React.createElement(ConfirmDialog, {open, title: '放弃未保存的修改？',
            message: '该文稿有未保存的修改。放弃后无法恢复这些修改。',
            detail: '关闭当前编辑器前，请选择继续编辑或明确放弃这次修改。',
            confirmLabel: '放弃修改', cancelLabel: '继续编辑', testId: 'short-confirmation',
            onCancel: () => {window.confirmationActions.push('cancel');setOpen(false);},
            onConfirm: () => {window.confirmationActions.push('confirm');setOpen(false);}});
        }
        window.mountConfirmation = () => {
          window.confirmationActions = [];
          flushSync(() => root.render(React.createElement(MotionConfig, {reducedMotion: 'always'},
            React.createElement(LazyMotion, {features: domMax, strict: true},
              React.createElement(ConfirmationFixture, {key: ++generation})))));
        };
        window.mountActivityRail = () => {
          window.railActions = [];
          flushSync(() => root.render(React.createElement('div', {style: {display: 'flex', height: '100%'}},
            React.createElement(ActivityRail, {view: 'writing', themeOverride: 'light',
              onNavigate: view => window.railActions.push(view),
              onCycleTheme: () => window.railActions.push('theme'),
              onResetLayout: () => window.railActions.push('reset'),
              onOpenSettings: () => window.railActions.push('settings')})
          )));
        };
        let navigationGuard = null;
        window.setNavigationGuard = mode => {
          if (navigationGuard) window.removeEventListener(BEFORE_NAVIGATE, navigationGuard);
          navigationGuard = mode === null ? null : event => {
            if (event.detail.next.page !== 'research') return;
            window.navigationGuardCalls++;
            if (mode === 'veto') event.preventDefault();
            else window.releaseSettingsClose = event.detail.defer();
          };
          if (navigationGuard) window.addEventListener(BEFORE_NAVIGATE, navigationGuard);
        };
        let generation = 0;
        window.mount = (providers = [], routeClose = false, preserveSection = false) => {
          if (!preserveSection) writeSettingsSection('models');
          window.setNavigationGuard(null);
          window.navigationGuardCalls = 0;
          window.releaseSettingsClose = null;
          window.settingsSaveRequests = [];
          if (routeClose) history.replaceState(null, '', '?page=research');
          window.shortcutCounts = {sidebar: 0, assistant: 0, search: 0, theme: 0};
          window.resetCount = 0;
          window.deferRemoteModels = false;
          window.remoteModelRequests = [];
          window.secretRequests = [];
          window.embeddingRequests = [];
          flushSync(() => root.render(React.createElement(MotionConfig, {reducedMotion: 'user'},
            React.createElement(LazyMotion, {features: domMax, strict: true},
              React.createElement(Harness, {key: ++generation, client: createClient(providers), routeClose})
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
  page.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message));
  await page.waitForFunction(() => typeof window.mount === 'function');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.evaluate(() => window.mount());
});

after(async () => {
  try {
    await page?.evaluate(() => window.unmount?.());
    await app?.close();
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, {recursive: true, force: true});
  }
  assert.deepEqual(rendererErrors, [], 'renderer must not throw during the Radix dialog pilot');
});

const domainBySection = {
  app: 'general', models: 'models', 'default-model': 'models', literature: 'research', rag: 'research',
  memory: 'research', tasks: 'research', guardrail: 'security', sandbox: 'security', authorization: 'security',
  hooks: 'advanced', pilot: 'advanced', backup: 'advanced'
};
const labelBySection = {
  app: '应用基础', models: '模型与服务', 'default-model': '默认模型', literature: '文献与解析', rag: '向量与 RAG',
  memory: '记忆策略', tasks: '任务与调度', guardrail: '智能体安全', sandbox: '编译与沙箱', authorization: '授权与安全',
  hooks: 'Hooks', pilot: '受限试点', backup: '偏好与备份'
};

test('settings restores the recent section and domain only after a guarded navigation succeeds', async () => {
  await page.evaluate(() => window.mount());
  await page.getByTestId('activity-settings').click();
  await clickSection('app');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-modal-panel')).toHaveCount(0);
  await page.evaluate(() => window.mount([], false, true));
  await page.getByTestId('activity-settings').click();
  await expect(page.getByTestId('settings-section-app')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('settings-domain-general')).toHaveAttribute('aria-pressed', 'true');
  await clickSection('backup');
  await page.getByTestId('settings-import-text').fill('{');
  await clickSection('app');
  await expect(page.getByTestId('settings-editor-discard-panel')).toBeVisible();
  await page.getByTestId('settings-editor-discard-cancel').click();
  await page.evaluate(() => window.mount([], false, true));
  await page.getByTestId('activity-settings').click();
  await expect(page.getByTestId('settings-section-backup')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('settings-domain-advanced')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.mount());
});

async function assertScrollableControlVisible(control) {
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  const problems = await control.evaluate(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    const ring = style.outlineStyle === 'none' ? 0 : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const failures = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const bounds = parent.getBoundingClientRect(), css = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/u.test(css.overflowY) &&
        (box.top - ring < bounds.top + parent.clientTop - 1 || box.bottom + ring > bounds.top + parent.clientTop + parent.clientHeight + 1)) failures.push('vertical clipping');
      if (/(auto|scroll|hidden|clip)/u.test(css.overflowX) &&
        (box.left - ring < bounds.left + parent.clientLeft - 1 || box.right + ring > bounds.left + parent.clientLeft + parent.clientWidth + 1)) failures.push('horizontal clipping');
    }
    const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
    for (const [left, top] of [[x, y], [x, box.top + 4], [x, box.bottom - 4], [box.left + 4, y], [box.right - 4, y]]) {
      if (!element.contains(document.elementFromPoint(left, top))) failures.push('covered control');
    }
    return failures;
  });
  assert.deepEqual(problems, [], `${await control.getAttribute('data-testid')} remains fully visible with its focus ring`);
}

test('short viewport scrolls every activity destination and bottom action without shrinking targets', async () => {
  await page.setViewportSize({width: 360, height: 225});
  await page.evaluate(() => window.mountActivityRail());
  await page.keyboard.press('Tab');
  for (const id of ['nav-overview', 'nav-library', 'nav-writing', 'nav-runs', 'theme', 'reset-layout', 'settings']) {
    const control = page.getByTestId(`activity-${id}`);
    await assertScrollableControlVisible(control);
    const box = await control.boundingBox();
    assert.ok(box.width >= 28 && box.height >= 28, 'activity target size is retained');
    await control.press('Enter');
  }
  assert.deepEqual(await page.evaluate(() => window.railActions), ['overview', 'library', 'writing', 'runs', 'theme', 'reset', 'settings']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, 'rail scrolling does not overflow the window');
  await page.evaluate(() => window.mount());
  await page.setViewportSize({width: 900, height: 700});
});

test('short settings viewport reveals navigation, form fields, textarea and save actions in both themes', async () => {
  try {
    await page.setViewportSize({width: 360, height: 225});
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {window.mount();document.documentElement.dataset.theme = theme;}, theme);
      await page.getByTestId('activity-settings').click();
      await page.keyboard.press('Tab');
      for (const id of ['settings-search', 'settings-domain-select', 'settings-section-select']) {
        await assertScrollableControlVisible(page.getByTestId(id));
      }
      await selectSection('app');
      await assertScrollableControlVisible(page.getByTestId('settings-global-hotkey'));
      await page.getByTestId('settings-open-at-login').check();
      await assertScrollableControlVisible(page.getByTestId('settings-discard-draft'));
      await assertScrollableControlVisible(page.getByTestId('settings-save'));
      await page.getByTestId('settings-save').press('Enter');
      await expect(page.getByTestId('settings-impact-confirm-panel')).toBeVisible();
      await page.evaluate(() => window.mount());
      await page.getByTestId('activity-settings').click();
      await selectSection('backup');
      await assertScrollableControlVisible(page.getByTestId('settings-import-text'));
      const audit = await page.evaluate('(' + clipAudit + ')({root: "body", viewport: true})');
      assert.equal(audit.cut, 0, JSON.stringify(audit));
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
      await page.keyboard.press('Escape');
      await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
    }
  } finally {
    await page.evaluate(() => window.mount());
    await page.setViewportSize({width: 900, height: 700});
  }
});

test('native 400 percent zoom preserves save and discard confirmation controls and guards', async () => {
  // A fresh native window has no device metrics left from earlier CSS viewport
  // cases; clearing another CDP session does not reliably clear their override.
  const previousPage = page;
  const created = app.waitForEvent('window');
  await app.evaluate(({BrowserWindow}, entry) => {
    const window = new BrowserWindow({show: true, width: 1440, height: 900, useContentSize: true});
    void window.loadFile(entry);
  }, join(tempDir, 'index.html'));
  page = await created;
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => rendererErrors.push(error.stack ?? error.message));
  const browserWindow = await app.browserWindow(page);
  try {
    await page.waitForFunction(() => typeof window.mount === 'function');
    await browserWindow.evaluate(window => window.setContentSize(1440, 900));
    const nativeSize = await browserWindow.evaluate(window => {window.webContents.setZoomFactor(4);return window.getContentSize();});
    assert.deepEqual(nativeSize, [1440, 900]);
    await page.waitForFunction(size => Math.abs(innerWidth - size[0] / 4) <= 1 && Math.abs(innerHeight - size[1] / 4) <= 1, nativeSize);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {window.mount();document.documentElement.dataset.theme = theme;}, theme);
      await page.getByTestId('activity-settings').press('Enter');
      await selectSection('app');
      const startup = page.getByTestId('settings-open-at-login');
      await assertScrollableControlVisible(startup);
      await startup.press('Space');
      await expect(startup).toBeChecked();
      const save = page.getByTestId('settings-save');
      await assertScrollableControlVisible(save);
      await save.press('Enter');
      const confirm = page.getByTestId('settings-impact-confirm-panel');
      await confirm.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-impact-confirm-cancel');
      await assertScrollableControlVisible(page.getByTestId('settings-impact-confirm-message'));
      for (const action of ['close', 'confirm', 'cancel']) await assertScrollableControlVisible(page.getByTestId(`settings-impact-confirm-${action}`));
      await page.getByTestId('settings-impact-confirm-cancel').press('Enter');
      await confirm.waitFor({state: 'detached'});
      await expect(startup).toBeChecked();
      assert.equal(await page.evaluate(() => window.settingsSaveRequests.length), 0, 'cancelling confirmation never saves');
      await save.press('Enter');
      await confirm.waitFor();
      await assertScrollableControlVisible(page.getByTestId('settings-impact-confirm-confirm'));
      await page.getByTestId('settings-impact-confirm-confirm').press('Enter');
      await confirm.waitFor({state: 'detached'});
      await expect(save).toBeDisabled();
      assert.equal(await page.evaluate(() => window.settingsSaveRequests.length), 1);
      await assertScrollableControlVisible(startup);
      await startup.press('Space');
      await page.getByTestId('settings-modal-close').press('Enter');
      const discard = page.getByTestId('settings-discard-panel');
      await discard.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-discard-cancel');
      await assertScrollableControlVisible(page.getByTestId('settings-discard-message'));
      for (const action of ['close', 'confirm', 'cancel']) await assertScrollableControlVisible(page.getByTestId(`settings-discard-${action}`));
      const audit = await page.evaluate('(' + clipAudit + ')({root: "body", viewport: true})');
      assert.equal(audit.cut, 0, JSON.stringify(audit));
      await page.getByTestId('settings-discard-cancel').press('Enter');
      await discard.waitFor({state: 'detached'});
      await expect(startup).not.toBeChecked();
      await page.getByTestId('settings-modal-close').press('Enter');
      await discard.waitFor();
      await assertScrollableControlVisible(page.getByTestId('settings-discard-confirm'));
      await page.getByTestId('settings-discard-confirm').press('Enter');
      await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
      assert.equal(await page.evaluate(() => window.settingsSaveRequests.length), 1, 'discard never writes the changed draft');
    }
  } finally {
    await browserWindow.evaluate(window => {window.webContents.setZoomFactor(1);window.destroy();});
    page = previousPage;
  }
});

test('short shared confirmation reveals its complete actions and preserves cancel-first focus', async () => {
  try {
    await page.setViewportSize({width: 360, height: 225});
    for (const theme of ['light', 'dark']) for (const outcome of ['cancel', 'confirm']) {
      await page.evaluate(theme => {window.mountConfirmation();document.documentElement.dataset.theme = theme;}, theme);
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'short-confirmation-cancel');
      await assertScrollableControlVisible(page.getByTestId('short-confirmation-message'));
      for (const action of ['close', 'cancel', 'confirm']) await assertScrollableControlVisible(page.getByTestId(`short-confirmation-${action}`));
      const audit = await page.evaluate('(' + clipAudit + ')({root: "body", viewport: true})');
      assert.equal(audit.cut, 0, JSON.stringify(audit));
      await page.getByTestId(`short-confirmation-${outcome}`).press('Enter');
      await page.getByTestId('short-confirmation-panel').waitFor({state: 'detached'});
      assert.deepEqual(await page.evaluate(() => window.confirmationActions), [outcome]);
    }
  } finally {
    await page.evaluate(() => window.mount());
    await page.setViewportSize({width: 900, height: 700});
  }
});

async function clickSection(section) {
  const domain = domainBySection[section];
  const compactDomain = page.getByTestId('settings-domain-select');
  const compact = page.getByTestId('settings-section-select');
  if (await compact.count()) {
    if (await compactDomain.inputValue() !== domain) await compactDomain.selectOption(domain);
    await compact.selectOption(section);
    return;
  }
  await page.getByTestId('settings-search').fill(labelBySection[section]);
  const button = page.getByTestId('settings-section-' + section);
  await button.waitFor({state: 'visible'});
  await button.click();
  await page.getByTestId('settings-search').fill('');
}
async function selectSection(section) {
  await page.waitForFunction(() => window.matchMedia('(max-width: 719px)').matches
    ? document.querySelector('[data-testid="settings-section-select"]') !== null
    : document.querySelector('[data-testid="settings-sections"]') !== null);
  await clickSection(section);
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
  await page.evaluate(() => window.mount());
  const opener = page.getByTestId('activity-settings');
  await opener.click();
  await page.getByTestId('settings-modal-panel').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-models');

  await clickSection('app');
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
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'activity-settings');

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

test('nested settings Escape belongs to the confirmation from its first focus event', async () => {
  await page.evaluate(() => window.mount());
  await page.getByTestId('activity-settings').click();
  await clickSection('app');
  await page.getByTestId('settings-open-at-login').click();
  await page.evaluate(() => {
    window.firstConfirmationEscape = null;
    const onFocus = event => {
      if (event.target?.getAttribute('data-testid') !== 'settings-discard-cancel') return;
      document.removeEventListener('focusin', onFocus);
      // Enter at the exact focus handoff, before a subsequent render can repair listener order.
      const escape = new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true, cancelable: true});
      event.target.dispatchEvent(escape);
      window.firstConfirmationEscape = {target: event.target.getAttribute('data-testid'), handled: escape.defaultPrevented};
    };
    document.addEventListener('focusin', onFocus);
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.firstConfirmationEscape !== null);
  assert.deepEqual(await page.evaluate(() => window.firstConfirmationEscape), {target: 'settings-discard-cancel', handled: true});
  await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1);
  assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), true, 'Escape preserves the dirty setting');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-open-at-login');
  await page.getByTestId('settings-open-at-login').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});


test('reset confirmation accepts real pointer clicks and Escape leaves settings open', async () => {
  await page.getByTestId('activity-settings').click();
  await clickSection('backup');
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

test('settings search retains native editing keys and section navigation stays on its tabs', async () => {
  await page.setViewportSize({width: 900, height: 850});
  await page.evaluate(() => window.mount());
  await page.getByTestId('activity-settings').click();
  const search = page.getByTestId('settings-search');
  await search.fill('模型');
  for (const key of ['End', 'Home', 'ArrowDown', 'ArrowUp']) {
    await search.focus();
    await page.keyboard.press(key);
    assert.equal(await search.evaluate(element => document.activeElement === element), true, `${key} keeps search focus`);
    assert.equal(await page.getByTestId('settings-panel').getAttribute('id'), 'settings-panel-models', `${key} does not change the section`);
  }
  await page.getByTestId('settings-section-models').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-default-model');
  await page.getByTestId('settings-section-models').click();
  await page.getByTestId('settings-section-default-model').click();
  await page.getByTestId('settings-section-models').click();
  await expect(page.getByTestId('settings-section-models')).toBeFocused();
  await expect(page.getByTestId('settings-panel')).toHaveCount(1);
  await expect(page.getByTestId('settings-panel')).toHaveAttribute('id', 'settings-panel-models');
  await expect(page.getByTestId('settings-panel').locator('input, select, button').first()).toBeEnabled();
  await search.fill('没有该设置');
  await page.getByTestId('settings-search-empty').waitFor();
  await page.setViewportSize({width: 640, height: 850});
  const compactSearch = page.getByTestId('settings-search');
  await compactSearch.fill('Hooks');
  const compact = page.getByTestId('settings-section-select');
  assert.equal(await compact.inputValue(), '', 'a filtered-out section must not appear selected');
  await compact.selectOption('hooks');
  assert.equal(await page.getByTestId('settings-panel').getAttribute('id'), 'settings-panel-hooks');
  await compactSearch.fill('没有该设置');
  assert.equal(await compact.isDisabled(), true);
  await page.getByTestId('settings-search-empty').waitFor();
  await page.setViewportSize({width: 900, height: 850});
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('Escape closes an open native settings select before the settings dialog', async () => {
  await page.setViewportSize({width: 900, height: 850});
  await page.evaluate(() => window.mount());
  await page.getByTestId('activity-settings').click();
  await selectSection('guardrail');
  const select = page.getByTestId('settings-approval-mode');
  const original = await select.inputValue();
  await select.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-approval-mode"]')?.matches(':open'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid="settings-approval-mode"]')?.matches(':open'));
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1, 'first Escape only closes the native picker');
  assert.equal(await select.inputValue(), original);
  assert.equal(await select.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('discard requires confirmation, retains settings, and appearance changes apply immediately', async () => {
  await page.getByTestId('activity-settings').click();
  await clickSection('app');
  await page.getByTestId('settings-open-at-login').check();
  await clickSection('backup');
  await clickSection('app');
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
  await page.getByTestId('activity-settings').click();
  await clickSection('backup');
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
  await clickSection('app');
  assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), true);
  await expect(page.getByRole('group', {name: '外观', exact: true})).toHaveAccessibleDescription('立即切换界面主题；自动模式跟随系统。');
  await expect(page.getByRole('group', {name: '界面密度', exact: true})).toHaveAccessibleDescription('立即调整列表行高、控件与面板间距。');
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
      for (const width of [1440, 1280, 1184, 800, 640]) {
        await page.setViewportSize({width, height: 850});
        for (const section of ['models', 'app', 'backup']) {
          await selectSection(section);
          await page.waitForTimeout(150);
          const overflow = await page.getByTestId('settings-panel').evaluate(el => el.scrollWidth > el.clientWidth + 1);
          assert.equal(overflow, false, section + ' has no horizontal overflow');
          if (width >= 1184) {
            const navigation = await page.locator('.settings-navigation').boundingBox();
            const form = await page.locator('.settings-form-content').boundingBox();
            assert.ok(navigation.width >= 200 && navigation.width <= 220, 'desktop categories retain a stable readable width');
            assert.ok(form.width >= 560 && form.width <= 700, 'desktop forms retain the intended reading measure');
          }
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
  await page.getByTestId('activity-settings').click();
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
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-app');
  await page.setViewportSize({width: 640, height: 850});
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'settings-section-select');
  assert.equal(await page.getByTestId('settings-section-select').inputValue(), 'app');
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

test('transient provider drafts survive settings close, section and provider changes until confirmed', async () => {
  const providers = [...modelProviders, {...modelProviders[0], id: 'provider-two', name: 'Second provider'}];
  await page.setViewportSize({width: 900, height: 850});
  await page.evaluate(providers => window.mount(providers), providers);
  await page.getByTestId('activity-settings').click();
  const input = page.getByTestId('settings-provider-secret-input');
  await input.fill('transient fixture credential');
  assert.equal(await page.getByTestId('settings-dirty-bar').textContent(), '编辑内容尚未保存');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-discard-panel').waitFor();
  await page.getByTestId('settings-discard-cancel').click();
  await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});
  assert.equal(await input.inputValue(), 'transient fixture credential');
  await clickSection('app');
  await page.getByTestId('settings-editor-discard-panel').waitFor();
  await page.getByTestId('settings-editor-discard-cancel').click();
  await page.getByTestId('settings-editor-discard-panel').waitFor({state: 'detached'});
  assert.equal(await input.inputValue(), 'transient fixture credential');
  await page.getByTestId('settings-provider-select').selectOption('provider-two');
  await page.getByTestId('settings-editor-discard-panel').waitFor();
  assert.equal(await page.getByTestId('settings-provider-select').inputValue(), 'provider-one');
  await page.getByTestId('settings-editor-discard-confirm').click();
  await page.getByTestId('settings-editor-discard-panel').waitFor({state: 'detached'});
  assert.equal(await page.getByTestId('settings-provider-select').inputValue(), 'provider-two');
  assert.equal(await input.inputValue(), '');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('transient settings writes block unmount and expose failure without losing input', async () => {
  const providers = [...modelProviders, {...modelProviders[0], id: 'provider-two', name: 'Second provider'}];
  await page.evaluate(providers => window.mount(providers), providers);
  await page.getByTestId('activity-settings').click();
  await page.getByTestId('settings-provider-secret-input').fill('pending fixture credential');
  await page.getByTestId('settings-provider-secret-save').click();
  await page.waitForFunction(() => window.secretRequests.length === 1);
  assert.equal(await page.getByTestId('settings-domain-general').isDisabled(), true);
  assert.equal(await page.getByTestId('settings-section-models-body').count(), 1);
  assert.equal(await page.getByTestId('settings-provider-select').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1);
  assert.equal(await page.evaluate(() => {
    const event = new Event('beforeunload', {cancelable: true});
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), true);
  await page.evaluate(() => window.secretRequests[0].resolve({ok: false, error: {message: 'Secret write refused'}}));
  await page.getByTestId('settings-provider-secret-error').waitFor();
  assert.equal(await page.getByTestId('settings-provider-secret-input').inputValue(), 'pending fixture credential');
  await page.evaluate(() => window.mount());
});

test('embedding drafts are protected across configuration, section and close transitions', async () => {
  await page.evaluate(() => window.mount());
  await page.getByTestId('activity-settings').click();
  await selectSection('rag');
  await page.getByTestId('settings-embedding-name').fill('Retained embedding');
  await page.getByTestId('settings-embedding-select-embedding-two').click();
  await page.getByTestId('settings-editor-discard-panel').waitFor();
  await page.getByTestId('settings-editor-discard-cancel').click();
  await page.getByTestId('settings-editor-discard-panel').waitFor({state: 'detached'});
  assert.equal(await page.getByTestId('settings-embedding-name').inputValue(), 'Retained embedding');
  await page.getByTestId('settings-embedding-apikey').fill('embedding fixture credential');
  await page.getByTestId('settings-embedding-save').click();
  await page.waitForFunction(() => window.embeddingRequests.length === 1);
  assert.equal(await page.getByTestId('settings-domain-general').isDisabled(), true);
  assert.equal(await page.getByTestId('settings-section-rag-body').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByTestId('settings-modal-panel').count(), 1);
  await page.evaluate(() => window.embeddingRequests[0].resolve({ok: false, error: {message: 'Embedding write refused'}}));
  await page.getByTestId('settings-embedding-save-error').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-discard-panel').waitFor();
  await page.getByTestId('settings-discard-cancel').click();
  await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});
  assert.equal(await page.getByTestId('settings-embedding-name').inputValue(), 'Retained embedding');
  await clickSection('app');
  await page.getByTestId('settings-editor-discard-confirm').click();
  await page.getByTestId('settings-editor-discard-panel').waitFor({state: 'detached'});
  await page.getByTestId('settings-section-app-body').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('remote model fetch freezes request fields until it completes', async () => {
  await page.setViewportSize({width: 900, height: 850});
  await page.evaluate(providers => window.mount(providers), modelProviders);
  await page.evaluate(() => { window.deferRemoteModels = true; });
  await page.getByTestId('activity-settings').click();
  await page.getByTestId('settings-model-pull').click();
  await page.getByTestId('settings-provider-models-pull-fetch').click();
  await page.waitForFunction(() => window.remoteModelRequests.length === 1);
  assert.equal(await page.getByTestId('settings-provider-models-pull-endpoint').isDisabled(), true);
  assert.equal(await page.getByTestId('settings-provider-models-pull-key').isDisabled(), true);
  assert.equal(await page.getByTestId('settings-provider-models-pull-confirm').isDisabled(), true);
  await page.evaluate(() => window.remoteModelRequests[0].resolve({ok: true, data: {models: [{id: 'fetched-model'}]}}));
  await page.getByTestId('settings-provider-models-pull-option-fetched-model').waitFor();
  assert.equal(await page.getByTestId('settings-provider-models-pull-endpoint').isEnabled(), true);
  await page.getByTestId('settings-provider-models-pull-endpoint').fill('https://another.example/v1');
  assert.equal(await page.getByTestId('settings-provider-models-pull-option-fetched-model').count(), 0,
    'changing the endpoint invalidates models from the old request');
  await page.getByTestId('settings-provider-models-pull-cancel').click();
  await page.getByTestId('settings-provider-models-pull-panel').waitFor({state: 'detached'});
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('remote model results and errors cannot enter a reopened picker', async () => {
  await page.evaluate(providers => window.mount(providers), modelProviders);
  await page.evaluate(() => { window.deferRemoteModels = true; });
  await page.getByTestId('activity-settings').click();
  await page.getByTestId('settings-model-pull').click();
  await page.getByTestId('settings-provider-models-pull-fetch').click();
  await page.waitForFunction(() => window.remoteModelRequests.length === 1);
  await page.getByTestId('settings-provider-models-pull-cancel').click();
  await page.getByTestId('settings-provider-models-pull-panel').waitFor({state: 'detached'});
  await page.getByTestId('settings-model-pull').click();
  await page.getByTestId('settings-provider-models-pull-panel').waitFor();
  await page.evaluate(() => window.remoteModelRequests[0].resolve({ok: true, data: {models: [{id: 'old-session-model'}]}}));
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('settings-provider-models-pull-list').count(), 0,
    'a response from the previous open session must be discarded');
  await page.getByTestId('settings-provider-models-pull-fetch').click();
  await page.waitForFunction(() => window.remoteModelRequests.length === 2);
  await page.evaluate(() => window.remoteModelRequests[1].resolve({ok: false, error: {code: 'INTERNAL_ERROR', message: 'Remote unavailable'}}));
  await page.getByTestId('settings-provider-models-pull-error').waitFor();
  await page.getByTestId('settings-provider-models-pull-cancel').click();
  await page.getByTestId('settings-provider-models-pull-panel').waitFor({state: 'detached'});
  await page.getByTestId('settings-model-pull').click();
  await page.getByTestId('settings-provider-models-pull-panel').waitFor();
  assert.equal(await page.getByTestId('settings-provider-models-pull-error').count(), 0);
  assert.equal(await page.getByTestId('settings-provider-models-pull-fetch').isEnabled(), true);
  await page.getByTestId('settings-provider-models-pull-cancel').click();
  await page.getByTestId('settings-provider-models-pull-panel').waitFor({state: 'detached'});
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
});

test('Escape cancels model, provider and secret confirmations without closing settings or losing focus', async () => {
  await page.setViewportSize({width: 900, height: 850});
  await page.evaluate(providers => window.mount(providers), modelProviders);
  await page.getByTestId('activity-settings').click();
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
  await page.getByTestId('activity-settings').click();
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
  await page.getByTestId('activity-settings').click();
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

for (const draft of ['shared', 'credential']) {
  test(`settings routed discard closes ${draft} edits after one confirmation`, async () => {
    await page.setViewportSize({width: 900, height: 700});
    await page.evaluate(providers => window.mount(providers, true), draft === 'credential' ? modelProviders : []);
    await page.getByTestId('activity-settings').click();
    const input = draft === 'shared'
      ? page.getByTestId('settings-open-at-login')
      : page.getByTestId('settings-provider-secret-input');
    if (draft === 'shared') {
      await selectSection('app');
      await input.check();
    } else {
      await input.fill('unsaved fixture credential');
    }
    await page.getByTestId('settings-modal-close').click();
    await page.getByTestId('settings-discard-cancel').click();
    await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});
    if (draft === 'shared') assert.equal(await input.isChecked(), true);
    else assert.equal(await input.inputValue(), 'unsaved fixture credential');
    await page.getByTestId('settings-modal-close').click();
    await page.getByTestId('settings-discard-confirm').click();
    await page.getByTestId('settings-modal-panel').waitFor({state: 'detached', timeout: 3000});
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('page')), 'research');
    assert.deepEqual(await page.evaluate(() => window.settingsSaveRequests), [], 'discard never writes settings');
    assert.equal(await page.evaluate(() => window.secretRequests.length), 0, 'discard never writes a credential');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'activity-settings');
    await page.getByTestId('activity-settings').click();
    if (draft === 'shared') {
      await selectSection('app');
      assert.equal(await input.isChecked(), false);
    } else {
      assert.equal(await input.inputValue(), '');
    }
    await page.getByTestId('settings-modal-close').click();
    await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
  });
}

for (const guard of ['defer', 'veto']) {
  test(`settings routed discard respects another surface's ${guard}`, async () => {
    await page.setViewportSize({width: 900, height: 700});
    await page.evaluate(() => window.mount([], true));
    await page.getByTestId('activity-settings').click();
    await selectSection('app');
    await page.getByTestId('settings-open-at-login').check();
    await page.evaluate(guard => window.setNavigationGuard(guard), guard);
    await page.getByTestId('settings-modal-close').click();
    await page.getByTestId('settings-discard-confirm').click();
    await page.getByTestId('settings-discard-panel').waitFor({state: 'detached', timeout: 3000});
    assert.equal(await page.getByTestId('settings-modal-panel').count(), 1, 'the other surface keeps navigation blocked');
    assert.equal(await page.getByTestId('settings-open-at-login').isChecked(), false, 'only the explicitly discarded settings reset');
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('page')), 'settings');
    assert.equal(await page.evaluate(() => window.navigationGuardCalls), 1, 'one close navigation reaches all guards');
    assert.deepEqual(await page.evaluate(() => window.settingsSaveRequests), []);
    if (guard === 'defer') {
      await page.evaluate(() => window.releaseSettingsClose());
    } else {
      await page.evaluate(() => window.setNavigationGuard(null));
      await page.getByTestId('settings-modal-close').click();
    }
    await page.getByTestId('settings-modal-panel').waitFor({state: 'detached', timeout: 3000});
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('page')), 'research');
  });
}
