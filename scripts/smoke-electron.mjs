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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { waitForAppReady } from '../tests/smoke/lib/assertions.mjs';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';

const smokeProviderId = 'p10-smoke-provider';
const smokeModelId = 'p10-smoke-model';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;

const full = process.argv.includes('--full');
const artifactDir = resolve('.artifacts/smoke-electron');
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

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);
seedSmokeSkillSource(skillSourceRoot);
const smokeProvider = await startSmokeProvider({});
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`新壳 smoke · target=${target.kind} · provider=${smokeProvider.endpoint} · workspace=${workspaceRoot}\n`);

let app;
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
  // ---- 1 启动 -------------------------------------------------------------------
  app = await electron.launch({
    executablePath: target.executablePath,
    args: target.launchArgs,
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
  await page.screenshot({ path: join(artifactDir, 'canvas.png') });

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

  await navigate(page, `page=research&project=${preflight.projectId}&view=terminal`);
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

  await navigate(page, `page=research&project=${preflight.projectId}&view=latex&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-composer-input"]', { timeout: 20_000 });
  await page.fill('[data-testid="assistant-composer-input"]', '用一句话说明这次 smoke 在验证什么。');
  await page.focus('[data-testid="assistant-composer-input"]');
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

  // ---- 5 设置打开 → 改一个真字段 → 保存 ------------------------------------------
  await page.click('[data-testid="titlebar-settings"]');
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { timeout: 20_000 });
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
  assertCheck('5 设置', '保存成功后脏状态条回到「没有未保存的改动」且没有保存错误', saveError === 0, afterSave);
  await page.screenshot({ path: join(artifactDir, 'settings.png') });
  await page.click('[data-testid="settings-modal-close"]');
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { state: 'detached', timeout: 15_000 });

  assertCheck('1 启动', '整轮没有 renderer error', rendererErrors.length === 0, rendererErrors.slice(0, 2).join(' | '));
} finally {
  if (app !== undefined) {
    await app.close().catch(() => {});
  }
  await smokeProvider.close?.();
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
      const child = spawnSync('node', [script], { stdio: 'inherit', env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
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
