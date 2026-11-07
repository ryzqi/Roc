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

const artifactDir = resolve('.artifacts/layout-audit');
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

const VIEWPORTS = [
  { id: 'wide', width: 1440, height: 900 },
  { id: 'columns-edge', width: 1100, height: 820 },
  { id: 'drawers-edge', width: 1099, height: 820 },
  { id: 'narrow', width: 720, height: 760 },
  { id: 'small', width: 380, height: 760 }
];

async function capture(page, id) {
  const audit = await auditLayout(page, `${currentTheme}-${id}`);
  audit.clip = await page.evaluate(`(${clipSource})({viewport: true})`);
  audit.theme = currentTheme;
  audit.minimumOverridden = audit.viewport.width < nativeMinimum[0];
  audits.push(audit);
  assert.deepEqual(audit.viewportOverflow, [], `${id}: viewport overflow`);
  assert.equal(audit.clip.cut, 0, `${id}: clipped shadows`);
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

try {
  smokeProvider = await startSmokeProvider({});
  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: [`--user-data-dir=${dataRoot}/chromium`, ...smokeTarget.launchArgs],
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });
  const page = await app.firstWindow();
  const browserWindow = await app.browserWindow(page);
  nativeMinimum = await browserWindow.evaluate(window => window.getMinimumSize());
  // Record the actual product minimum. Narrow sizes exercise the built renderer in a
  // disposable Electron window; they do not establish a supported native minimum.
  await browserWindow.evaluate(window => window.setMinimumSize(380, 640));
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
  const project = await page.evaluate(async (workspacePath) => {
    const unwrap = (result) => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data;
    };
    unwrap(await window.roc.workspace.select({ path: workspacePath }));
    // capability 是 `research.projects.create`，preload 方法名是 `research.createProject`。
    return unwrap(
      await window.roc.research.createProject({
        title: '布局审查项目',
        description: 'layout audit',
        workspacePath
      })
    );
  }, workspaceRoot);

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
      window.setBounds({ x: window.getBounds().x, y: window.getBounds().y, width: size.width, height: size.height });
    }, viewport);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => innerWidth), viewport.width, 'actual renderer width');

    await navigate(page, 'page=research');
    await page.waitForSelector(`[data-testid="portal-card-${project.id}"]`, { timeout: 15_000 });
    await capture(page, `portal-${viewport.id}`);

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
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="settings-modal-panel"]', { state: 'detached', timeout: 15_000 });
  }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app !== undefined) {
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

writeLayoutAudit(artifactDir, {passed: failure === null, error: failure, nativeMinimum,
  target: smokeTarget, reducedMotion: 'reduce',
  narrowScope: 'built renderer in disposable Electron window with overridden native minimum',
  audits, viewports: VIEWPORTS});
