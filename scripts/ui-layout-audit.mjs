/**
 * 多视口 UI 布局审查（Playwright + Electron）。
 *
 * 先用 `pnpm build` 产出 `dist/main/index.js`（或先 `package:mac` 用已打包的 .app），
 * 目标选择逻辑见 `tests/smoke/lib/smoke-target.mjs`：优先已打包应用，其次 dist。
 * 结果写入 `.artifacts/layout-audit/`（JSON + 各视口截图）。
 *
 * P10 重写：旧版驱动的是旧壳的 `research-app-shell` / `settings-gear` 等 testid，
 * 旧壳已在切换提交里删除。这里改成新壳的三个真实状态（门户 / 项目画布 + 助手 / 设置），
 * 覆盖深浅主题、列/抽屉断点、窄窗口、任务抽屉与键盘焦点。
 */
import { _electron as electron } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { auditLayout, writeLayoutAudit } from '../tests/smoke/lib/electron-smoke-layout-audit.mjs';
import { waitForAppReady } from '../tests/smoke/lib/assertions.mjs';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';

const artifactDir = resolve(process.env.ROC_UI_AUDIT_DIR ?? '.artifacts/layout-audit');
mkdirSync(artifactDir, { recursive: true });
process.env.ROC_UI_AUDIT_DIR = artifactDir;

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);
seedSmokeSkillSource(skillSourceRoot);

const { resolveSmokeTarget } = await import('../tests/smoke/lib/smoke-target.mjs');
// 默认量 `dist`：布局审查是源码级检查，`release/` 里可能是**上一次**打包的产物（切壳前就是这种坑）。
// 想看打包形态就显式 `ROC_SMOKE_TARGET=packaged pnpm audit:layout`。
const smokeTarget = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: process.env.ROC_SMOKE_TARGET ?? 'dist' } });

let app;
let smokeProvider;
const audits = [];
const clipSource = readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
let failure = null;
let nativeMinimum;
let currentTheme;
let importedSkill = false;
let controlsChecked = 0;
const smokeApiKey = 'smoke-test-key';

const VIEWPORTS = [
  { id: 'wide', width: 1440, height: 900 },
  { id: 'columns-edge', width: 1100, height: 820 },
  { id: 'drawers-edge', width: 1099, height: 820 },
  { id: 'narrow', width: 720, height: 760 },
  { id: 'small', width: 380, height: 760 },
  { id: 'short', width: 1100, height: 540 }
];

async function capture(page, id) {
  // Ignore continuous activity indicators, but wait for entry and hover motion.
  await page.waitForFunction(() =>
    document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations))
      .every(animation => animation.playState !== 'running') &&
    [...document.querySelectorAll('[data-overlay-kind] [data-testid$="-panel"]')]
      .every(panel => Number(getComputedStyle(panel).opacity) === 1));
  const audit = await auditLayout(page, `${currentTheme}-${id}`);
  audit.clip = await page.evaluate(`(${clipSource})({viewport: true})`);
  audit.theme = currentTheme;
  audit.reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  audit.viewportEmulated = true;
  audit.belowNativeMinimum = audit.viewport.width < nativeMinimum[0];
  audits.push(audit);
  assert.deepEqual(audit.viewportOverflow, [], `${id}: viewport overflow`);
  assert.deepEqual(audit.fontSizeViolations, [], `${id}: UI text below 12px`);
  assert.equal(audit.clip.cut, 0, `${id}: clipped shadows`);
  console.log(`[layout] ${currentTheme}-${id}: passed`);
  return audit;
}

async function navigate(page, search) {
  await page.evaluate((next) => {
    let url;
    try {
      url = new URL(window.location.href);
    } catch {
      return;
    }
    url.search = next;
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, search);
}

async function assertControlVisible(control) {
  // Native textarea focus only reveals its caret. Scroll the full control into
  // view first, as a user can, then measure its focus outline against each pane.
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  const clipped = await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ring = style.outlineStyle === 'none' ? 0 : Math.max(0,
      parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const cuts = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      const left = box.left + parent.clientLeft;
      const top = box.top + parent.clientTop;
      if (/(hidden|auto|scroll|clip)/u.test(css.overflowX) &&
        (rect.left - ring < left - 1 || rect.right + ring > left + parent.clientWidth + 1)) {
        cuts.push({axis: 'x', parent: parent.dataset.testid ?? parent.className,
          control: [rect.left - ring, rect.right + ring], boundary: [left, left + parent.clientWidth]});
      }
      if (/(hidden|auto|scroll|clip)/u.test(css.overflowY) &&
        (rect.top - ring < top - 1 || rect.bottom + ring > top + parent.clientHeight + 1)) {
        cuts.push({axis: 'y', parent: parent.dataset.testid ?? parent.className,
          control: [rect.top - ring, rect.bottom + ring], boundary: [top, top + parent.clientHeight]});
      }
    }
    return cuts;
  });
  assert.deepEqual(clipped, [], `${await control.getAttribute('data-testid')}: control and focus ring stay visible`);
  const covered = await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const insetX = Math.min(4, rect.width / 4);
    const insetY = Math.min(4, rect.height / 4);
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    return [[x, y], [x, rect.top + insetY], [x, rect.bottom - insetY],
      [rect.left + insetX, y], [rect.right - insetX, y]].flatMap(([left, top]) => {
      const hit = document.elementFromPoint(left, top);
      return hit !== null && element.contains(hit) ? [] : [{
        point: [left, top], covering: hit?.getAttribute('data-testid') ?? hit?.className ?? null
      }];
    });
  });
  assert.deepEqual(covered, [], `${await control.getAttribute('data-testid')}: control is not covered by another surface`);
  controlsChecked += 1;
}

async function assertFormLayout(panel) {
  const width = await panel.evaluate(element => ({client: element.clientWidth, scroll: element.scrollWidth}));
  assert.ok(width.scroll <= width.client + 1, `${await panel.getAttribute('data-testid')}: no horizontal form overflow (${JSON.stringify(width)})`);
  const controls = panel.locator('input:visible:not(:disabled), select:visible:not(:disabled), textarea:visible:not(:disabled)');
  for (const control of await controls.all()) await assertControlVisible(control);
}

async function selectSettingsSection(page, section) {
  const compact = page.getByTestId('settings-section-select');
  const navigation = await compact.count() > 0 ? compact : page.getByTestId(`settings-section-${section}`);
  await assertControlVisible(navigation);
  if (await compact.count() > 0) await compact.selectOption(section);
  else await navigation.click();
  await page.waitForFunction(section =>
    document.querySelector('[data-testid="settings-panel"]')?.id === `settings-panel-${section}`, section);
}

try {
  smokeProvider = await startSmokeProvider({});
  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: [`--user-data-dir=${dataRoot}/chromium`, ...smokeTarget.launchArgs],
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: smokeApiKey
    }
  });
  const page = await app.firstWindow();
  const browserWindow = await app.browserWindow(page);
  nativeMinimum = await browserWindow.evaluate(window => window.getMinimumSize());
  // Preserve the product minimum. Emulate renderer viewports below it so native
  // display corrections cannot race a test-only window minimum override.
  await page.emulateMedia({reducedMotion: 'reduce'});
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error('[renderer]', message.text());
    }
  });
  page.on('pageerror', (error) => console.error('[renderer:pageerror]', error.message));
  await waitForAppReady(page, 'layout-audit', artifactDir);
  // 冷启动落门户（没有项目时不渲染左栏），所以先等门户容器。
  await page.waitForSelector('[data-testid="portal"]', { timeout: 15_000 });

  // 种一个项目：门户卡网格要有卡才能审查「门户」这一态。
  const project = await page.evaluate(async ({ workspacePath, endpoint, apiKey }) => {
    const unwrap = (result) => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data;
    };
    // Exercise the populated model editor and its nested picker with isolated
    // local data. A fresh profile has no provider, so it only renders empty state.
    const providerId = 'layout-audit-provider';
    const modelId = 'layout-audit-model';
    const current = unwrap(await window.roc.settings.get());
    unwrap(await window.roc.settings.save({
      settings: current.settings,
      providers: [...current.providers, {
        id: providerId,
        name: 'Layout Audit Provider',
        type: 'openai_compatible',
        endpoint,
        credentialRef: `secret:${providerId}`,
        enabled: true,
        models: [{
          id: modelId,
          displayName: 'Layout Audit Model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsImages: false
        }]
      }],
      defaultModelId: `${providerId}:${modelId}`,
      permissions: current.permissions
    }));
    unwrap(await window.roc.settings.setProviderSecret({
      providerId, plaintext: apiKey
    }));
    unwrap(await window.roc.workspace.select({ path: workspacePath }));
    // capability 是 `research.projects.create`，preload 方法名是 `research.createProject`。
    return unwrap(
      await window.roc.research.createProject({
        title: '布局审查项目',
        description: 'layout audit',
        workspacePath
      })
    );
  }, { workspacePath: workspaceRoot, endpoint: smokeProvider.endpoint, apiKey: smokeApiKey });

  // 门户列表在挂载时读一次，所以经 IPC 建完项目要重载页面才会出现新卡片。
  await page.reload();
  await waitForAppReady(page, 'layout-audit-after-seed', artifactDir);
  await page.waitForSelector(`[data-testid="portal-card-${project.id}"]`, { timeout: 20_000 });

  const projectQuery = `page=research&project=${project.id}`;

  for (const theme of ['light', 'dark']) {
  currentTheme = theme;
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  for (const viewport of VIEWPORTS) {
    await browserWindow.evaluate((window, size) => {
      const [minWidth, minHeight] = window.getMinimumSize();
      window.setBounds({ ...window.getBounds(), width: Math.max(size.width, minWidth), height: Math.max(size.height, minHeight) });
    }, viewport);
    await page.setViewportSize({width: viewport.width, height: viewport.height});
    // Exercise the real correction handler: it must preserve native constraints
    // without changing the renderer viewport used for responsive layout checks.
    await app.evaluate(({screen}) => screen.emit('display-metrics-changed', screen.getPrimaryDisplay(), ['workArea']));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => innerWidth), viewport.width, 'actual renderer width');
    assert.deepEqual(await browserWindow.evaluate(window => window.getMinimumSize()), nativeMinimum);
    assert.ok(await browserWindow.evaluate(window => window.getBounds().width >= window.getMinimumSize()[0]),
      'native minimum remains enforced');

    await navigate(page, 'page=research');
    await page.waitForSelector(`[data-testid="portal-card-${project.id}"]`, { timeout: 15_000 });
    await capture(page, `portal-${viewport.id}`);
    await page.getByTestId('portal-new-project').click();
    await page.getByTestId('portal-create-dialog-panel').waitFor();
    await assertFormLayout(page.getByTestId('portal-create-dialog-panel'));
    await capture(page, `project-form-${viewport.id}`);
    await page.getByTestId('project-form-cancel').click();
    await page.getByTestId('portal-create-dialog-panel').waitFor({state: 'detached'});

    await navigate(page, `${projectQuery}&view=latex`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 15_000 });
    await capture(page, `canvas-${viewport.id}`);

    const managementOpener = page.getByTestId('titlebar-management');
    await managementOpener.focus();
    await page.keyboard.press('Enter');
    const management = page.getByTestId('management-panel-panel');
    await management.waitFor({state: 'visible'});
    await page.getByTestId('mgmt-tab-tasks').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('mgmt-panel-tasks').waitFor({state: 'visible'});
    await page.getByTestId('mgmt-research-tasks').waitFor();
    await page.getByTestId('mgmt-research-tasks').getByText('当前项目还没有科研任务。', {exact: true}).waitFor();
    await assertControlVisible(page.getByTestId('mgmt-task-select'));
    await capture(page, `research-tasks-${viewport.id}`);
    for (const tab of ['memory', 'skills', 'mcp', 'tasks']) {
      await page.getByTestId(`mgmt-tab-${tab}`).click();
      const panel = page.getByTestId(`mgmt-panel-${tab}`);
      await panel.waitFor({state: 'visible'});
      await assertFormLayout(panel);
      await capture(page, `management-${tab}-${viewport.id}`);
      if (tab === 'mcp') {
        const more = panel.locator('summary[aria-label$="的更多操作"]').first();
        await more.click();
        for (const action of await panel.locator('details[open] button').all()) await assertControlVisible(action);
        await capture(page, `management-mcp-actions-${viewport.id}`);
        await page.keyboard.press('Escape');
        assert.equal(await management.isVisible(), true, 'MCP action Escape keeps management open');
        await panel.getByTestId('mgmt-mcp-create').click();
        await panel.getByTestId('mgmt-mcp-custom').click();
        await assertFormLayout(panel.getByTestId('mgmt-mcp-editor'));
        await capture(page, `management-mcp-editor-${viewport.id}`);
        await panel.getByTestId('mgmt-mcp-cancel').click();
      }
      if (tab === 'tasks') {
        await panel.getByTestId('mgmt-tasks-create').click();
        await assertFormLayout(panel.getByTestId('mgmt-task-editor'));
        await capture(page, `management-task-editor-${viewport.id}`);
        await panel.getByTestId('mgmt-task-editor-cancel').click();
      }
      if (tab === 'skills') {
        if (!importedSkill) {
          await panel.getByTestId('mgmt-skills-import-path').fill(skillSourceRoot);
          await panel.getByTestId('mgmt-skills-import-run').click();
          await panel.getByTestId('mgmt-skills-import-result').waitFor();
          importedSkill = true;
        }
        await panel.locator('[data-testid^="mgmt-skill-select-"]').filter({hasText: 'smoke-skill'}).click();
        const files = page.getByTestId('mgmt-skill-files-panel');
        await files.waitFor();
        await page.getByTestId('mgmt-skill-entry-SKILL.md').click();
        await page.getByTestId('mgmt-skill-preview-markdown').waitFor();
        await assertControlVisible(page.getByTestId('mgmt-skill-preview-close'));
        await capture(page, `skill-files-${viewport.id}`);
        await page.keyboard.press('Escape');
        await files.waitFor({state: 'detached'});
      }
    }
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press(index < 12 ? 'Tab' : 'Shift+Tab');
      assert.equal(await management.evaluate(panel => panel.contains(document.activeElement)), true,
        'management drawer traps keyboard focus');
    }
    await capture(page, `tasks-${viewport.id}`);
    await page.keyboard.press('Escape');
    await management.waitFor({state: 'detached'});
    assert.equal(await managementOpener.evaluate(button => button === document.activeElement), true,
      'management drawer returns keyboard focus');

    // Close the ambient sidebar before interacting with the canvas beneath it.
    // Restore it below to audit both drawers together with the assistant.
    const sidebarDrawer = page.getByTestId('sidebar-drawer');
    const sidebarWasOpen = await sidebarDrawer.count() > 0;
    if (sidebarWasOpen) {
      await page.getByTestId('sidebar-drawer-close').click();
      await sidebarDrawer.waitFor({state: 'detached'});
    }
    for (const view of ['memory', 'skills', 'mcp', 'terminal', 'literature']) {
      await navigate(page, `${projectQuery}&view=${view}`);
      await page.getByTestId(view === 'literature' ? 'literature-hub' : view === 'terminal' ? 'terminal-view' : `mgmt-view-panel-${view}`).waitFor({state: 'visible'});
      await capture(page, `view-${view}-${viewport.id}`);
    }
    for (const tab of ['reader', 'notes', 'radar', 'rag', 'wiki', 'graph', 'monitors']) {
      await page.getByTestId(`literature-subview-${tab}`).click();
      await page.getByTestId(`literature-panel-${tab}`).waitFor({state: 'visible'});
      await assertControlVisible(page.getByTestId('literature-hub-import'));
      await capture(page, `literature-${tab}-${viewport.id}`);
    }
    await page.getByTestId('literature-hub-import').click();
    await page.getByTestId('literature-import-dialog-panel').waitFor();
    await page.getByTestId('literature-import-tab-manual').click();
    await assertFormLayout(page.getByTestId('literature-import-dialog-panel'));
    await capture(page, `literature-import-${viewport.id}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('literature-import-dialog-panel').waitFor({state: 'detached'});
    if (sidebarWasOpen) await page.getByTestId('titlebar-toggle-sidebar').click();

    // 助手在宽窗是**中列**（左栏 | 助手 | 画布，见 ADR 0023），在窄窗是抽屉；
    // 两种形态都要审。
    await navigate(page, `${projectQuery}&view=latex&assistant=1`);
    await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="assistant-composer-input"]', { timeout: 15_000 });
    const layout = await page.evaluate(() => ({
      mode: document.querySelector('[data-testid="workspace-layout"]')?.getAttribute('data-layout-mode') ?? null,
      sidebarColumn: document.querySelector('[data-testid="sidebar-column"]') !== null,
      assistantColumn: document.querySelector('[data-testid="assistant-column"]') !== null,
      sidebarDrawer: document.querySelector('[data-testid="sidebar-drawer"]') !== null,
      assistantDrawer: document.querySelector('[data-testid="assistant-drawer"]') !== null
    }));
    const expectedMode = viewport.width < 1100 ? 'drawers' : 'columns';
    if (layout.mode !== expectedMode) {
      throw new Error(`assistant layout mode ${layout.mode} at ${viewport.width}px; expected ${expectedMode}`);
    }
    if (viewport.width < 1100 && (layout.sidebarColumn || layout.assistantColumn || !layout.sidebarDrawer || !layout.assistantDrawer)) {
      throw new Error(`assistant drawers are incomplete at ${viewport.width}px: ${JSON.stringify(layout)}`);
    }
    if (viewport.width >= 1100 && (!layout.sidebarColumn || !layout.assistantColumn || layout.sidebarDrawer || layout.assistantDrawer)) {
      throw new Error(`assistant columns are incomplete at ${viewport.width}px: ${JSON.stringify(layout)}`);
    }
    await capture(page, `assistant-${viewport.id}`);
    await page.getByTestId('assistant-model-settings').hover();
    await capture(page, `assistant-hover-${viewport.id}`);
    await page.getByTestId('assistant-model-settings').click();
    await page.getByTestId('assistant-model-picker').waitFor();
    await capture(page, `assistant-models-${viewport.id}`);
    // An empty model list still needs Escape to close only this popover.
    await page.keyboard.press('Escape');
    await page.getByTestId('assistant-model-picker').waitFor({state: 'detached'});
    assert.equal(await page.getByTestId('assistant-panel').isVisible(), true, 'popover Escape keeps the assistant open');
    if (viewport.id === 'wide') {
      const divider = page.getByTestId('divider-assistant');
      await divider.focus();
      for (let index = 0; index < 12; index += 1) await page.keyboard.press('Shift+ArrowLeft');
      await page.waitForFunction(() => {
        const handle = document.querySelector('[data-testid="divider-assistant"]');
        return handle.getAttribute('aria-valuenow') === handle.getAttribute('aria-valuemin');
      });
      await page.getByTestId('assistant-model-settings').click();
      const menu = await page.getByTestId('assistant-model-picker').boundingBox();
      const column = await page.getByTestId('assistant-column').boundingBox();
      assert.ok(menu.x >= column.x && menu.x + menu.width <= column.x + column.width,
        'model menu stays inside the minimum assistant column');
      await capture(page, `assistant-minimum-${viewport.id}`);
      await page.keyboard.press('Escape');
      await divider.focus();
      await page.keyboard.press('Home');
    }
    const composerInput = page.getByTestId('assistant-composer-input');
    await composerInput.fill(Array.from({length: 30}, (_, index) => `研究笔记 ${index + 1}：保留长内容与换行。`).join('\n'));
    const composerDimensions = await composerInput.evaluate(element => ({height: element.clientHeight, scroll: element.scrollHeight}));
    assert.ok(composerDimensions.height <= 200 && composerDimensions.scroll > composerDimensions.height,
      'long drafts scroll inside a bounded input');
    await capture(page, `assistant-long-${viewport.id}`);
    await composerInput.fill('');

    // Native menu navigation remains reachable while ambient drawers cover the titlebar.
    await navigate(page, `page=settings&project=${project.id}&view=latex&assistant=1`);
    await page.waitForSelector('[data-testid="settings-modal-panel"]', { timeout: 15_000 });
    await page.keyboard.press('Tab');
    assert.equal(await page.getByTestId('settings-modal-panel').evaluate(panel => panel.contains(document.activeElement)), true);
    const settingsBody = await page.getByTestId('settings-panel').evaluate(panel => ({
      width: panel.clientWidth, scrollWidth: panel.scrollWidth
    }));
    assert.ok(settingsBody.width >= 240, 'settings form retains a usable column');
    assert.ok(settingsBody.scrollWidth <= settingsBody.width + 1, 'settings form has no horizontal clipping');
    await capture(page, `settings-${viewport.id}`);
    for (const section of ['models', 'default-model', 'rag', 'literature', 'sandbox', 'guardrail',
      'app', 'tasks', 'authorization', 'hooks', 'memory', 'pilot', 'backup']) {
      await selectSettingsSection(page, section);
      const panel = page.getByTestId('settings-panel');
      await assertFormLayout(panel);
      await capture(page, `settings-${section}-${viewport.id}`);
    }
    await page.getByTestId('settings-modal-scrim').click({position: {x: 4, y: 4}});
    assert.equal(await page.getByTestId('settings-modal-panel').count(), 1, 'form backdrop does not dismiss settings');
    await selectSettingsSection(page, 'models');
    const remoteModelOpener = page.getByTestId('settings-model-pull');
    await remoteModelOpener.click();
    await page.getByTestId('settings-provider-models-pull-panel').waitFor();
    await assertFormLayout(page.getByTestId('settings-provider-models-pull-panel'));
    await capture(page, `settings-remote-models-${viewport.id}`);
    await page.getByTestId('settings-provider-models-pull-endpoint').fill(smokeProvider.endpoint);
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-provider-models-pull-panel').waitFor({state: 'detached'});
    assert.equal(await remoteModelOpener.evaluate(button => button === document.activeElement), true,
      'nested model dialog returns focus to settings');
    await selectSettingsSection(page, 'app');
    await page.getByTestId('settings-open-at-login').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-discard-panel').waitFor();
    await capture(page, `settings-unsaved-${viewport.id}`);
    await page.getByTestId('settings-discard-cancel').click();
    await page.getByTestId('settings-discard-panel').waitFor({state: 'detached'});
    await page.getByTestId('settings-open-at-login').click();
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="settings-modal-panel"]', { state: 'detached', timeout: 15_000 });
  }
  // Verify final positions under the ordinary system motion preference as well.
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await browserWindow.evaluate(window => window.setBounds({...window.getBounds(), width: 1440, height: 900}));
  await page.setViewportSize({width: 1440, height: 900});
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await navigate(page, `${projectQuery}&view=latex&assistant=1`);
  await page.getByTestId('assistant-panel').waitFor();
  await capture(page, 'normal-motion-default');
  await page.getByTestId('assistant-model-settings').hover();
  await capture(page, 'normal-motion-hover');
  await page.getByTestId('assistant-model-settings').click();
  await page.getByTestId('assistant-model-picker').waitFor();
  await capture(page, 'normal-motion-expanded');
  await page.keyboard.press('Escape');
  await page.getByTestId('assistant-model-picker').waitFor({state: 'detached'});
  await navigate(page, `page=settings&project=${project.id}&view=latex&assistant=1`);
  await page.getByTestId('settings-modal-panel').waitFor();
  await capture(page, 'normal-motion-final-position');
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
  await page.emulateMedia({reducedMotion: 'reduce'});
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  // Persist the measured result before teardown: a failed check can leave a
  // protected draft open in this disposable app.
  writeLayoutAudit(artifactDir, {passed: failure === null, error: failure, nativeMinimum,
    controlsChecked,
    target: smokeTarget, reducedMotion: ['reduce', 'no-preference'],
    narrowScope: 'emulated renderer viewport in disposable Electron window; native minimum and display correction remain enforced',
    audits, viewports: VIEWPORTS});
  if (app !== undefined) {
    if (failure !== null) {
      await app.evaluate(({BrowserWindow}) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      }).catch(error => console.error('[layout:teardown]', error.message));
    }
    await app.close();
  }
  if (smokeProvider !== undefined) {
    await smokeProvider.close();
  }
  spawnSync('pnpm', ['rebuild', 'better-sqlite3', '--pending=false'], {
    cwd: resolve('.'),
    stdio: 'inherit',
    shell: false
  });
}
