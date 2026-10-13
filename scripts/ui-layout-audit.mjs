/**
 * 多视口 UI 布局审查（Playwright + Electron）。
 *
 * 先用 `pnpm build` 产出 `dist/main/index.js`（或先 `package:mac` 用已打包的 .app），
 * 目标选择逻辑见 `tests/smoke/lib/smoke-target.mjs`：优先已打包应用，其次 dist。
 * 结果写入 `.artifacts/layout-audit/`（JSON + 各视口截图）。
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
const smokeTarget = resolveSmokeTarget({});

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
  await page.waitForSelector('[data-testid="research-app-shell"]', { timeout: 10000 });

  const seededProjects = [
    {
      title: '扩散模型采样加速：可复现基准与消融研究',
      description: '比较 DDIM、DPM-Solver 与一致性蒸馏在相同算力预算下的采样质量、延迟与稳定性，产出一份可复现的基准与消融报告。'
    },
    {
      title: '单细胞转录组的批次效应校正综述',
      description: '系统梳理 Harmony、scVI 与 Seurat CCA 的适用边界，给出跨组织、跨平台的选型建议。'
    },
    {
      title: '长文检索增强生成的长上下文评测',
      description: '在 128k 上下文下评测检索增强与长上下文直接注入的差异，覆盖事实一致性、引用准确率与成本。'
    }
  ];
  for (const [index, project] of seededProjects.entries()) {
    const projectWorkspace = resolve(workspaceRoot, `project-${index + 1}`);
    mkdirSync(projectWorkspace, { recursive: true });
    const outcome = await page.evaluate(async ({ item, workspacePath }) => {
    const result = await window.roc.research.createProject({
      title: item.title,
      description: item.description,
      workspacePath,
      language: 'zh'
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
    }, { item: project, workspacePath: projectWorkspace });
    if (!outcome.ok) {
      console.error('[seed] project failed', project.title, JSON.stringify(outcome.error));
    } else {
      console.error('[seed] project created', project.title);
    }
  }
  await page.reload();
  await waitForAppReady(page, 'layout-audit-after-seed', artifactDir);
  await page.waitForSelector('[data-testid="research-app-shell"][data-shell-state="list"]', { timeout: 15000 });
  await page.waitForSelector('.research-project-card', { timeout: 10000 });
  const seededCardCount = await page.locator('.research-project-card').count();
  console.error('[seed] project cards after reload', seededCardCount);

  for (const viewport of VIEWPORTS) {
    await browserWindow.evaluate((window, size) => {
      window.setBounds({ x: window.getBounds().x, y: window.getBounds().y, width: size.width, height: size.height });
    }, viewport);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(120);

    await capture(page, `list-${viewport.id}`);

    const card = page.locator('.research-project-card').first();
    if ((await card.count()) > 0) {
      await card.evaluate((element) => element.click());
      await page.waitForSelector('[data-testid="research-app-shell"][data-shell-state="project"]', { timeout: 10000 });
      await capture(page, `project-${viewport.id}`);
      const railBack = page.locator('[data-testid="research-shell-rail-all-projects"]');
      if ((await railBack.count()) > 0) {
        await railBack.evaluate((element) => element.click());
      } else {
        await page.locator('[data-testid="research-shell-all-projects"]').evaluate((element) => element.click());
      }
      await page.waitForSelector('[data-testid="research-app-shell"][data-shell-state="list"]', { timeout: 15000 });

      const assistantTrigger = page.locator('[data-testid="research-shell-assistant"]');
      if ((await assistantTrigger.count()) > 0) {
        await assistantTrigger.evaluate((element) => element.click());
        await page.waitForSelector('[data-testid="research-assistant-overlay"]', { timeout: 10000 });
        await capture(page, `assistant-${viewport.id}`);
        const closeAssistant = page.locator('[data-testid="research-assistant-close"]');
        if ((await closeAssistant.count()) > 0) {
          await closeAssistant.evaluate((element) => element.click());
          await page.waitForSelector('[data-testid="research-assistant-overlay"]', { state: 'detached', timeout: 10000 });
        }
      }
    }

    await page.locator('[data-testid="settings-gear"]').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="settings-view"]', { timeout: 15000 });
    await capture(page, `settings-${viewport.id}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="settings-modal"]', { state: 'detached', timeout: 10000 });
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
