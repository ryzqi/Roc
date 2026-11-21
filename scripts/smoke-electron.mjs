#!/usr/bin/env node
/**
 * 新壳 smoke（P10/T10.4 重写）。
 *
 * 为什么重写：旧 smoke 套件（`tests/smoke/electron-smoke.mjs` + 13 个 `lib/electron-smoke-*.mjs`）
 * 断言的是旧壳的 DOM——旧壳在切换提交里已经删除，这些断言没有可断言的对象，也没有做别名映射的
 * 价值（「不向后兼容」的检验点）。所以这里按**新壳的关键路径**重写一遍，用新壳的 `data-testid`。
 *
 * 覆盖（T10.4 的 7 条里，本脚本负责 1、2、5、6 与 3 的浅层）：
 *   1. 启动 → `roc-app` 就绪、`app.getStatus()` 正常、无 renderer error
 *   2. 项目门户 → 新建项目（真 `research.projects.create`）→ 进入项目 → 画布渲染
 *   3. 助手发一轮 run（真 stub provider）→ 文本块出现、run 回到 idle
 *   5. 设置打开（⌘,）→ 改一个真字段 → 保存 → 脏状态条清空、没有保存错误
 *   6. 文件预览 / Git 状态 / 终端会话（真 IPC + 真 pty 输出）
 *
 * 4（审批）由 P4 的验收闸门深度覆盖，`--full` 会把它作为子进程跑一遍，
 * 而不是在这里再抄一遍断言（重复的断言会分叉）。
 *
 * 「7 人工闸门」曾由 P6 的验收闸门覆盖；P6/P7 整面已删除
 * （见 `docs/adr/0024-stage-surface-removed.md`），所以这条路径不再有闸门。
 *
 * 运行：
 *   rm -rf dist/renderer && pnpm build
 *   ROC_SMOKE_TARGET=dist node scripts/smoke-electron.mjs [--full]
 * 结果写入 `.artifacts/smoke-electron/`（result.json + 截图）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { waitForAppReady } from '../tests/smoke/lib/assertions.mjs';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';
import { auditLayout } from '../tests/smoke/lib/electron-smoke-layout-audit.mjs';

const smokeProviderId = 'p10-smoke-provider';
const smokeModelId = 'p10-smoke-model';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;

const full = process.argv.includes('--full');
const artifactDir = resolve(process.env.ROC_SMOKE_ARTIFACT_DIR ?? '.artifacts/smoke-electron');
mkdirSync(artifactDir, { recursive: true });

const results = [];
function record(gate, name, ok, detail = '') {
  results.push({ gate, name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} [${gate}] ${name}${detail.length === 0 ? '' : ` — ${detail}`}`);
  return ok;
}
function fail(gate, name, detail) {
  record(gate, name, false, detail);
  throw new Error(`[${gate}] ${name}: ${detail}`);
}
function assertCheck(gate, name, condition, detail = '') {
  if (!condition) {
    fail(gate, name, detail === '' ? 'assertion failed' : detail);
  }
  record(gate, name, true, detail);
}

const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: process.env.ROC_SMOKE_TARGET ?? 'dist' } });
const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();

let app;
let smokeProvider;
const rendererErrors = [];

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

async function terminalText(page) {
  return await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
}

async function waitForTerminalText(page, needle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await terminalText(page);
    if (last.includes(needle)) {
      return last;
    }
    await page.waitForTimeout(120);
  }
  return last;
}

try {
  seedSmokeWorkspace(workspaceRoot, remoteRoot);
  seedSmokeSkillSource(skillSourceRoot);
  smokeProvider = await startSmokeProvider({});
  console.log(`新壳 smoke: target=${target.kind}, provider=${smokeProvider.endpoint}, workspace=${workspaceRoot}\n`);
  // ---- 1 启动 -------------------------------------------------------------------
  app = await electron.launch({
    executablePath: target.executablePath,
    // ROC_DATA_ROOT isolates application data; Chromium stores UI preferences separately.
    args: [...target.launchArgs, `--user-data-dir=${join(dataRoot, 'chromium')}`],
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      rendererErrors.push(message.text());
      console.error('[renderer]', message.text().slice(0, 300));
    }
  });
  page.on('pageerror', (error) => {
    rendererErrors.push(error.message);
    console.error('[pageerror]', error.message.slice(0, 300));
  });

  await waitForAppReady(page, 'smoke-startup', artifactDir);
  const status = await page.evaluate(async () => {
    const result = await window.roc.app.getStatus();
    if (!result.ok) {
      throw new Error(JSON.stringify(result.error));
    }
    return result.data;
  });
  assertCheck('1 启动', '应用状态可读（mode / 工作目录字段存在）', typeof status.mode === 'string', `mode=${status.mode}`);
  // 冷启动落的是项目门户（没有项目时不会渲染左栏），而且这一份数据根还是空的：
  // 所以此刻应当是**空态**（`portal-empty`），网格要等项目建出来才出现。
  await page.waitForSelector('[data-testid="portal"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="portal-empty"]', { timeout: 20_000 });
  assertCheck('1 启动', '空数据根冷启动落在项目门户空态（不是上次项目、也不是工作台）', (await page.locator('[data-testid="sidebar"]').count()) === 0, '');

  // ---- 2 门户 → 项目 → 画布 -----------------------------------------------------
  const preflight = await page.evaluate(
    async (workspacePath) => {
      const unwrap = (result) => {
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.data;
      };
      unwrap(await window.roc.workspace.select({ path: workspacePath }));
      // capability 名是 `research.projects.create`，preload 方法名是 `research.createProject`
      // （F16/F20/F22 的老坑：写之前 grep `src/preload/ipc-api-generated.ts`）。
      const project = unwrap(
        await window.roc.research.createProject({
          title: 'P10 Smoke Project',
          description: 'P10 新壳 smoke',
          workspacePath
        })
      );
      return { projectId: project.id };
    },
    workspaceRoot
  );
  // 门户列表是在挂载时读的，所以经 IPC 建完项目后要重载一次页面才会出现新卡片
  // （这也顺带验证「重载不会进上次项目」）。
  await page.reload();
  await waitForAppReady(page, 'smoke-portal', artifactDir);
  await page.waitForSelector(`[data-testid="portal-card-${preflight.projectId}"]`, { timeout: 20_000 });
  assertCheck('2 门户', '新建的项目出现在门户卡网格里', true, '');
  await page.click(`[data-testid="portal-card-open-${preflight.projectId}"]`);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 20_000 });
  assertCheck('2 门户', '进入项目后画布渲染出来', true, '');
  await page.getByTestId('overview').waitFor();
  await page.getByTestId('overview-first-steps').waitFor();
  await page.getByTestId('overview-first-steps-skip').click();
  await page.getByTestId('overview-first-steps').waitFor({state: 'detached'});
  await page.reload();
  await waitForAppReady(page, 'smoke-onboarding-dismissed', artifactDir);
  await page.getByTestId('overview').waitFor();
  assertCheck('2 门户', '首次引导可跳过且刷新后保持关闭', await page.getByTestId('overview-first-steps').count() === 0);
  if (!await page.getByTestId('context-help').isVisible()) await page.getByTestId('titlebar-toggle-sidebar').click();
  await page.getByTestId('context-help').click();
  await page.getByTestId('overview-first-steps').waitFor();
  assertCheck('2 门户', '帮助入口在同一项目重开首次引导', new URL(page.url()).searchParams.get('project') === preflight.projectId);
  await page.getByTestId('overview-first-steps-skip').click();
  await page.getByTestId('activity-nav-runs').click();
  await page.getByTestId('canvas-task-center').waitFor();
  assertCheck('2 门户', '活动栏任务入口打开统一任务总览', await page.getByTestId('canvas-task-center').isVisible());
  await navigate(page, `page=research&project=${preflight.projectId}&view=discover`);
  await page.getByTestId('literature-panel-search').waitFor();
  const hub = page.getByTestId('literature-hub');
  await hub.evaluate(node => { node.dataset.smokeRetained = '1'; });
  assertCheck('2 门户', '旧发现链接迁移到总览的发现子视图',
    new URL(page.url()).searchParams.get('view') === 'overview' && new URL(page.url()).searchParams.get('subview') === 'discover');
  await navigate(page, `page=research&project=${preflight.projectId}&view=knowledge`);
  await page.getByTestId('literature-panel-rag').waitFor();
  assertCheck('2 门户', '旧知识链接迁移到文献的知识子视图',
    new URL(page.url()).searchParams.get('view') === 'library' && new URL(page.url()).searchParams.get('subview') === 'knowledge' &&
    await hub.getAttribute('data-smoke-retained') === '1');
  await page.screenshot({ path: join(artifactDir, 'canvas.png') });

  await navigate(page, `page=research&project=${preflight.projectId}&view=library`);
  await page.waitForSelector('[data-testid="literature-review-inspect"]', {timeout: 20_000});
  const reviewUrl = page.url();
  await page.locator('[data-testid="literature-review-inspect"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="artifact-review"]', {timeout: 20_000});
  await page.waitForFunction(() => document.querySelector('[data-testid="artifact-review"]')?.textContent.includes('尚无综述协议'));
  assertCheck('2 门户', '文献库键盘入口打开同壳综述检查器且路由保持当前项目', page.url() === reviewUrl);
  await page.screenshot({path: join(artifactDir, 'review-inspector.png')});
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="artifact-inspector-panel"]', {state: 'detached', timeout: 15_000});

  // ---- 6 文件预览 / Git / 终端 ---------------------------------------------------
  await navigate(page, `page=research&project=${preflight.projectId}&tool=files`);
  await page.waitForSelector('[data-testid="file-tree-row-00-overview.txt"]', { timeout: 20_000 });
  await page.click('[data-testid="file-tree-row-00-overview.txt"]');
  await page.waitForSelector('[data-testid="file-preview"]', { timeout: 20_000 });
  const previewText = (await page.locator('[data-testid="file-preview"]').textContent()) ?? '';
  assertCheck('6 工作区', '文件预览显示磁盘上的真实内容', previewText.includes('workspace overview smoke file'), previewText.slice(0, 60));
  // Escape 关掉预览（FilePreviewModal 就是 Escape/点遮罩关），否则它会盖住后面的步骤。
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="file-preview-modal-panel"]', { state: 'detached', timeout: 15_000 });

  await navigate(page, `page=research&project=${preflight.projectId}&tool=git`);
  await page.waitForSelector('[data-testid="git-panel"]', { timeout: 20_000 });
  const branch = (await page.locator('[data-testid="git-current-branch"]').textContent()) ?? '';
  assertCheck('6 工作区', 'Git 面板读到真实分支名', branch.trim().length > 0, branch.trim().slice(0, 40));

  await navigate(page, `page=research&project=${preflight.projectId}&view=writing&tool=terminal`);
  await page.waitForSelector('[data-testid="terminal-xterm"]', { timeout: 20_000 });
  await page.click('[data-testid="terminal-xterm"]');
  await page.keyboard.type("printf 'ROC_SMOKE_PTY_OK\\n'");
  await page.keyboard.press('Enter');
  const terminal = await waitForTerminalText(page, 'ROC_SMOKE_PTY_OK');
  assertCheck('6 工作区', '终端会话真的执行了命令并回显输出', terminal.includes('ROC_SMOKE_PTY_OK'), terminal.slice(-80));

  // ---- 3 助手一轮 run -----------------------------------------------------------
  // 真 run 需要一个可用的 provider：把 stub provider 写进设置并把密钥放进 safeStorage
  // （与 P4 闸门的「0 准备」同一条路径，否则 run 拿不到模型，界面只会停在那里）。
  const configured = await page.evaluate(
    async ({ providerId, modelId, modelKey, endpoint }) => {
      const current = await window.roc.settings.get();
      if (!current.ok) {
        return { error: current.error.message };
      }
      const providers = [
        ...current.data.providers.filter((provider) => provider.id !== providerId),
        {
          id: providerId,
          name: 'P10 Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: `secret:${providerId}`,
          enabled: true,
          models: [
            {
              id: modelId,
              displayName: 'P10 Smoke Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: true
            }
          ]
        }
      ];
      const saved = await window.roc.settings.save({
        settings: current.data.settings,
        providers,
        defaultModelId: modelKey,
        permissions: { ...current.data.permissions, mode: 'default' }
      });
      if (!saved.ok) {
        return { error: saved.error.message };
      }
      const secret = await window.roc.settings.setProviderSecret({ providerId, plaintext: 'smoke-test-key' });
      if (!secret.ok) {
        return { error: secret.error.message };
      }
      const after = await window.roc.settings.get();
      return {
        defaultModelId: after.ok ? after.data.defaultModelId : null,
        secretStored: after.ok
          ? after.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true
          : false
      };
    },
    { providerId: smokeProviderId, modelId: smokeModelId, modelKey: smokeModelKey, endpoint: smokeProvider.endpoint }
  );
  if (configured.error !== undefined) {
    fail('3 助手', '配置 smoke provider 与默认模型', configured.error);
  }
  assertCheck('3 助手', '默认模型指向 stub provider 且密钥进了 safeStorage', configured.defaultModelId === smokeModelKey && configured.secretStored, JSON.stringify(configured));

  await navigate(page, `page=research&project=${preflight.projectId}&view=writing&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-composer-input"]', { timeout: 20_000 });
  await page.fill('[data-testid="assistant-composer-input"]', '用一句话说明这次 smoke 在验证什么。');
  await page.focus('[data-testid="assistant-composer-input"]');
  // Synthetic events exercise the built React guards; native OS IME is a separate manual check.
  const ime = await page.getByTestId('assistant-composer-input').evaluate(input => {
    const enter = options => {
      const event = new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true,
        cancelable: true, ...options});
      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true, data: '验'}));
    const duringComposition = enter({});
    input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '验证'}));
    return {duringComposition, nativeComposing: enter({isComposing: true}),
      legacy229: enter({keyCode: 229}), companionEnter: enter({}), draft: input.value};
  });
  await page.waitForTimeout(250);
  assertCheck('3 助手', '合成 IME 组字/原生标志/229/结束伴生 Enter 均不进入提交分支',
    !ime.duringComposition && !ime.nativeComposing && !ime.legacy229 &&
    ime.companionEnter &&
    await page.getByTestId('assistant-composer-input').inputValue() === ime.draft &&
    await page.getByTestId('assistant-message-content').count() === 0,
    'Synthetic DOM events only; native input method not exercised');

  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="assistant-message-content"]', { timeout: 120_000 });
  // 空闲时状态标签本身不渲染（`statusLabel === null`），所以等的是「不再是 running / recovering」。
  await page.waitForFunction(
    () => {
      const element = document.querySelector('[data-testid="assistant-run-status"]');
      if (element === null) {
        return true;
      }
      const status = element.getAttribute('data-status');
      return status === null || (status !== 'running' && status !== 'recovering');
    },
    undefined,
    { timeout: 120_000 }
  );
  const transcript = (await page.locator('[data-testid="assistant-transcript"]').textContent()) ?? '';
  assertCheck('3 助手', '一轮 run 渲染出回答并回到 idle', transcript.trim().length > 0, transcript.slice(0, 60));
  await page.screenshot({ path: join(artifactDir, 'assistant.png') });

  const themeControl = page.getByTestId('activity-theme');
  for (const theme of ['dark', 'light', 'paper']) {
    await themeControl.click();
    await page.waitForFunction(next => document.documentElement.dataset.theme === next, theme);
  }
  await page.reload();
  await waitForAppReady(page, 'smoke-paper-theme', artifactDir);
  await page.getByTestId('assistant-composer-input').waitFor();
  await themeControl.focus();
  await page.keyboard.press('Tab');
  const appearance = await page.evaluate(() => {
    const focus = getComputedStyle(document.activeElement);
    return { theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme,
      focusWidth: focus.outlineWidth, focusStyle: focus.outlineStyle };
  });
  assertCheck('外观', '深色、浅色、暖纸可切换，暖纸刷新后保留并显示键盘焦点',
    appearance.theme === 'paper' && appearance.scheme === 'light' && appearance.focusWidth === '2px' && appearance.focusStyle === 'solid',
    JSON.stringify(appearance));

  // ---- 5 设置打开 → 改一个真字段 → 保存 ------------------------------------------
  await page.click('[data-testid="activity-settings"]');
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { timeout: 20_000 });
  await page.click('[data-testid="settings-domain-research"]');
  await page.click('[data-testid="settings-section-tasks"]');
  await page.waitForSelector('[data-testid="settings-long-running-seconds"]', { timeout: 20_000 });
  // 勾选框比数字输入更直接：一次点击就是一次 store.update。
  await page.click('[data-testid="settings-scheduler-catchup"]');
  // 注意：干净态的文案是「没有未保存的改动」，它**包含**「未保存」三个字，
  // 所以这里匹配的是「未保存 N 项」这个正向形式，并且要求保存按钮真的可用。
  await page.waitForFunction(
    () => {
      const bar = document.querySelector('[data-testid="settings-dirty-bar"]');
      const save = document.querySelector('[data-testid="settings-save"]');
      return /^未保存\s*\d+/u.test((bar?.textContent ?? '').trim()) && save !== null && !save.hasAttribute('disabled');
    },
    undefined,
    { timeout: 20_000 }
  );
  const dirtyBefore = ((await page.locator('[data-testid="settings-dirty-bar"]').textContent()) ?? '').trim();
  assertCheck('5 设置', '改一个字段后脏状态条报「未保存 N 项」且保存可用', /^未保存/u.test(dirtyBefore), dirtyBefore);
  await page.click('[data-testid="settings-save"]');
  await page.waitForFunction(
    () => {
      const bar = document.querySelector('[data-testid="settings-dirty-bar"]');
      return bar !== null && !/^未保存/u.test((bar.textContent ?? '').trim());
    },
    undefined,
    { timeout: 30_000 }
  );
  const saveError = await page.locator('[data-testid="settings-save-error"]').count();
  const afterSave = ((await page.locator('[data-testid="settings-dirty-bar"]').textContent()) ?? '').trim();
  assertCheck('5 设置', '保存成功后脏状态条显示「所有修改已保存」且没有保存错误', saveError === 0 && afterSave === '所有修改已保存', afterSave);
  await page.screenshot({ path: join(artifactDir, 'settings.png') });
  await page.click('[data-testid="settings-modal-close"]');
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { state: 'detached', timeout: 15_000 });

  // One real zoom pass supplements the renderer viewport matrix without repeating it.
  const browserWindow = await app.browserWindow(page);
  const originalWindow = await browserWindow.evaluate(window => ({bounds: window.getBounds(), zoom: window.webContents.getZoomFactor()}));
  const clipSource = readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  try {
    await browserWindow.evaluate(window => {
      window.setBounds({...window.getBounds(), width: 1184, height: 900});
    });
    await page.waitForFunction(() => document.querySelector('[data-testid=workspace-layout]')?.getAttribute('data-layout-mode') === 'balanced');
    const canvas = page.getByTestId('canvas-column');
    const right = await canvas.evaluate(node => node.getBoundingClientRect().right);
    if (!await page.getByTestId('assistant-column').isVisible()) await page.getByTestId('titlebar-toggle-assistant').click();
    await page.getByTestId('assistant-column').waitFor();
    const assistantEnd = await page.getByTestId('assistant-column').evaluate(node => node.getBoundingClientRect().right);
    const canvasStart = await canvas.evaluate(node => node.getBoundingClientRect().left);
    await page.getByTestId('titlebar-toggle-assistant').click();
    assertCheck('窗口', '1184px 下助手在画布左侧，画布右边界不移动',
      canvasStart >= assistantEnd - 1 && await canvas.evaluate(node => node.getBoundingClientRect().right) === right &&
      await page.getByTestId('assistant-drawer').count() === 0);
    await browserWindow.evaluate(window => {
      window.setBounds({...window.getBounds(), width: 1280, height: 820});
    });
    await navigate(page, `page=research&project=${preflight.projectId}&view=overview`);
    await page.getByTestId('overview').waitFor();
    await browserWindow.evaluate(window => window.webContents.setZoomFactor(1.25));
    await page.waitForFunction(() => document.querySelector('[data-testid="workspace-layout"]')?.getAttribute('data-layout-mode') === 'drawers');
    if (await page.getByTestId('sidebar-drawer').count() > 0) {
      await page.getByTestId('sidebar-drawer-close').focus();
      await page.keyboard.press('Enter');
      await page.getByTestId('sidebar-drawer').waitFor({state: 'detached'});
    }
    await page.getByTestId('titlebar-toggle-sidebar').click();
    await page.getByTestId('context-help').focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('overview-first-steps').waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'overview-first-steps-heading');
    for (const surface of ['overview', 'settings']) {
      if (surface === 'settings') {
        await navigate(page, `page=settings&project=${preflight.projectId}&view=overview`);
        await page.getByTestId('settings-modal-panel').waitFor();
      }
      // Electron stores file URL zoom separately; apply after each route change.
      await browserWindow.evaluate(window => window.webContents.setZoomFactor(1.25));
      const control = page.getByTestId(surface === 'overview' ? 'overview-first-steps-write' : 'settings-modal-close');
      await control.scrollIntoViewIfNeeded();
      await control.focus();
      const reachability = await control.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {focused: element === document.activeElement, unobscured: hit !== null && element.contains(hit),
          covering: hit?.getAttribute('data-testid') ?? hit?.tagName ?? null};
      });
      const audit = await auditLayout(page, `zoom-${surface}`);
      const clip = await page.evaluate(`(${clipSource})({viewport: true})`);
      const native = await browserWindow.evaluate(window => ({bounds: window.getBounds(), minimum: window.getMinimumSize(), zoom: window.webContents.getZoomFactor()}));
      assertCheck('缩放', `${surface} 在 1280px / 125% 下可用且无裁切`, reachability.focused && reachability.unobscured && audit.viewportOverflow.length === 0 &&
        audit.fontSizeViolations.length === 0 && audit.smallTargets.length === 0 && clip.cut === 0 &&
        native.bounds.width >= native.minimum[0] && native.zoom === 1.25, JSON.stringify({viewport: audit.viewport, native, reachability, clip: clip.cut,
          overflow: audit.viewportOverflow, smallTargets: audit.smallTargets}));
      const screenshot = await browserWindow.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString('base64'));
      writeFileSync(join(artifactDir, `zoom-${surface}.png`), Buffer.from(screenshot, 'base64'));
    }
    await page.keyboard.press('Escape');
    await page.getByTestId('settings-modal-panel').waitFor({state: 'detached'});
  } finally {
    await browserWindow.evaluate((window, previous) => {
      window.webContents.setZoomFactor(previous.zoom);
      window.setBounds(previous.bounds);
    }, originalWindow);
  }
  assertCheck('1 启动', '整轮没有 renderer error', rendererErrors.length === 0, rendererErrors.slice(0, 2).join(' | '));
} catch (error) {
  record('执行', '流程未完成', false, error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  try {
    if (app !== undefined) {
      if (results.some(entry => !entry.ok)) await app.evaluate(({BrowserWindow}) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      }).catch(error => console.error('[smoke:teardown]', error.message));
      await app.close();
    }
  } finally {
    try { await smokeProvider?.close(); }
    finally { await Promise.all([dataRoot, workspaceRoot, skillSourceRoot, remoteRoot].map(path => rm(path, {recursive: true, force: true}))); }
  }
  const failed = results.filter((entry) => !entry.ok);
  const payload = {
    target: target.kind,
    full,
    total: results.length,
    failed: failed.length,
    rendererErrors,
    results
  };
  writeFileSync(join(artifactDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\n新壳 smoke：${results.length - failed.length}/${results.length} 通过${failed.length === 0 ? '' : ` · 失败 ${failed.length}`}`);

  // 4（审批）由对应的验收闸门深度覆盖；`--full` 顺带跑一遍，而不是在这里抄一份会分叉的断言。
  // 人工闸门（原 P6）的闸门随阶段面一起删除：它的断言对象已经不存在。
  if (full && failed.length === 0) {
    for (const script of ['scripts/verify-p4-assistant.mjs']) {
      console.log(`\n=== 深度路径：${script}`);
      const child = spawnSync('node', [script], { stdio: 'inherit', env: { ...process.env, ROC_SMOKE_TARGET: process.env.ROC_SMOKE_TARGET ?? 'dist' } });
      if (child.status !== 0) {
        console.error(`${script} 失败（exit ${child.status}）`);
        process.exitCode = 1;
      }
    }
  } else if (!full) {
    console.log('（审批路径见 `pnpm verify:p4-assistant`；`--full` 会一并跑）');
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
