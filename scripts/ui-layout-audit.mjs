/**
 * 多视口 UI 布局审查（Playwright + Electron）。
 *
 * 先用 `pnpm build` 产出 `dist/main/index.js`（或先 `package:mac` 用已打包的 .app），
 * 目标选择逻辑见 `tests/smoke/lib/smoke-target.mjs`：优先已打包应用，其次 dist。
 * 结果写入 `.artifacts/layout-audit/`（JSON + 各视口截图）。
 *
 * P10 重写：旧版驱动的是旧壳的 `research-app-shell` / `settings-gear` 等 testid，
 * 旧壳已在切换提交里删除。这里改成新壳的三个真实状态（门户 / 项目画布 + 助手 / 设置），
 * 覆盖视口宽度的三档（宽 / 标准 / 紧凑）。
 */
import { _electron as electron } from '@playwright/test';
import { mkdirSync } from 'node:fs';
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

const VIEWPORTS = [
  { id: 'wide', width: 1440, height: 900 },
  { id: 'standard', width: 1180, height: 820 },
  { id: 'compact', width: 980, height: 760 }
];

async function capture(page, id) {
  const audit = await auditLayout(page, id);
  audits.push(audit);
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
    args: smokeTarget.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });
  const page = await app.firstWindow();
  const browserWindow = await app.browserWindow(page);
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

  for (const viewport of VIEWPORTS) {
    await browserWindow.evaluate((window, size) => {
      window.setBounds({ x: window.getBounds().x, y: window.getBounds().y, width: size.width, height: size.height });
    }, viewport);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(120);

    await navigate(page, 'page=research');
    await page.waitForSelector(`[data-testid="portal-card-${project.id}"]`, { timeout: 15_000 });
    await capture(page, `portal-${viewport.id}`);

    await navigate(page, `${projectQuery}&view=latex`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 15_000 });
    await capture(page, `canvas-${viewport.id}`);

    // 助手在宽窗是**中列**（左栏 | 助手 | 画布，见 ADR 0023），在窄窗是抽屉；
    // 两种形态都要审。
    await navigate(page, `${projectQuery}&view=latex&assistant=1`);
    await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="assistant-composer-input"]', { timeout: 15_000 });
    await capture(page, `assistant-${viewport.id}`);

    await page.click('[data-testid="titlebar-settings"]');
    await page.waitForSelector('[data-testid="settings-modal-panel"]', { timeout: 15_000 });
    await capture(page, `settings-${viewport.id}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="settings-modal-panel"]', { state: 'detached', timeout: 15_000 });
  }
} catch (error) {
  writeLayoutAudit(artifactDir, {
    passed: false,
    error: error instanceof Error ? error.message : String(error),
    audits
  });
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

writeLayoutAudit(artifactDir, { audits, viewports: VIEWPORTS });
