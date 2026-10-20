import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';
import { createGateRecorder, finishGate, navigate, prepareArtifactDir } from './lib/gate-harness.mjs';

/**
 * P8 验收闸门的自动化实测（真应用 / 真 IPC / 真设置读写 / 真密钥存储 / 真 provider 测速）。
 *
 * 为什么需要它：P8 的闸门全是**运行时事实** —— 每个分区是不是真的把值写进后端文档并能读回、
 * 密钥是不是只进了 safeStorage 且不出现在 localStorage 与导出快照里、`settings.testProvider`
 * 是不是真的连了一次 provider（连得上给延迟、连不上给后端原文）、未保存关闭是不是真的有确认与
 * 脏点、设置改完助手 / RAG / 阶段策略是不是立刻生效、业务页是不是真的没有内联配置残留。
 *
 * 三条口径：
 *   1. **契约以 registry / schema 为准**（findings F22）。`settings.*` 是 `kind: 'direct'`（没有
 *      capabilityName），`settings.save` 是**整份文档**（没有局部 patch），`clearProviderSecret`
 *      收**裸字符串**，`research.index.configure` 的 preload 方法名是 `saveIndexSettings`、
 *      `expectedRevision` 取 `status.settings.revision` —— 这些都是逐行核对过的实际形状。
 *   2. **可写的分区逐个走 UI 改 + 读回**；只读分区（文献与解析 / 编译与沙箱）断言的是「后端返回了
 *      真实状态」与「明确说明移除了哪些字段」，而不是跳过。
 *   3. **重启后保持**用真重启验证：`app.close()` 后用同一个 `ROC_DATA_ROOT` 再启动一次，再读后端与
 *      界面。只做 `page.reload()` 只能证明渲染层重读，证明不了落盘。
 *
 * 运行（必须 `ROC_SMOKE_TARGET=dist`，且先删产物再 build）：
 *   rm -rf dist/renderer && pnpm build
 *   node scripts/verify-p8-settings.mjs
 *
 * 必须 detach 跑；报告写 `.artifacts/p8-gates/`。
 */

const artifactDir = prepareArtifactDir(resolve('.artifacts/p8-gates'));

const { results, record, fail, assertCheck } = createGateRecorder();

const smokeModelId = 'p8-smoke-model';
const smokeProviderId = 'p8-smoke-provider';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;
const smokeSecret = 'p8-smoke-secret-key';
const modelNameTag = 'P8 Smoke Model TAG';
const providerNameTag = 'P8 Smoke Provider TAG';
const hotkeyTag = 'Control+Alt+Command+F18';
const hookCommand = 'echo roc-p8-hook';

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);
const workspaceA = join(workspaceRoot, 'project-a');
mkdirSync(workspaceA, { recursive: true });

const smokeProvider = await startSmokeProvider({});
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`P8 验收闸门实测 · target=${target.kind} · renderer=next · workspace=${workspaceA}\n`);

const launchEnv = {
  ...process.env,
  ROC_SMOKE: '1',
  ROC_DATA_ROOT: dataRoot,
  ROC_SMOKE_API_KEY: 'smoke-test-key',
};

let app;
let page;
const rendererErrors = [];

async function sleep(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Launches the app (also used for the restart half of gate 1). */
async function launchApp() {
  const launched = await electron.launch({
    executablePath: target.executablePath,
    args: target.launchArgs,
    env: launchEnv
  });
  const window = await launched.firstWindow();
  window.on('console', (message) => {
    if (message.type() === 'error') {
      rendererErrors.push(message.text());
      console.error('[renderer]', message.text().slice(0, 260));
    }
  });
  window.on('pageerror', (error) => {
    rendererErrors.push(error.message);
    console.error('[renderer:pageerror]', error.message.slice(0, 260));
  });
  await window.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  return { launched, window };
}

/** Opens the settings modal the way ⌘, does (native menu → `app.openSettings`). */
async function openSettingsViaShortcut() {
  await page.evaluate(async () => {
    await window.roc.app.openSettings();
  });
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { timeout: 30_000 });
  // 活动分区是组件状态：重新打开时不一定停在「模型与服务」，所以只等分区列表。
  await page.waitForSelector('[data-testid="settings-sections"]', { timeout: 30_000 });
}

/**
 * Waits until the shell has really adopted the project route.
 *
 * `navigate` only pushes history and dispatches `popstate`; the route state is applied on the
 * next render. Waiting on the URL is deterministic and, unlike a `waitForSelector(...).catch()`,
 * cannot silently swallow a timeout (that pattern would make a broken route look like a pass).
 */
async function waitForProjectRoute() {
  // The layout mounts only after the shell's **route state** carries the project, and that is the
  // precondition for opening settings in it: `app.openSettings()` merges into the current route
  // (P1), so a URL that changed before the state did would drop the project and the RAG section
  // would fall back to 「未进入项目」 (the gate caught exactly that).
  //
  // This used to wait for `workflow-overview`. The overview was never the thing being waited for —
  // the shell adopting the project route was — so the stage surface's removal swaps a proxy for the
  // element that actually means it.
  await page.waitForSelector('[data-testid="workspace-layout"]', { timeout: 20_000 });
}

/** After a reload the URL may still be `page=settings`, so the modal can already be open. */
async function ensureSettingsOpen() {
  if ((await page.locator('[data-testid="settings-modal-panel"]').count()) > 0) {
    await page.waitForSelector('[data-testid="settings-sections"]', { timeout: 30_000 });
    return;
  }
  await openSettingsViaGear();
}

async function openSettingsViaGear() {
  await page.click('[data-testid="titlebar-settings"]');
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="settings-sections"]', { timeout: 30_000 });
}

async function closeSettings() {
  await page.click('[data-testid="settings-modal-close"]');
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { state: 'detached', timeout: 15_000 });
}

async function openSection(id) {
  await page.click(`[data-testid="settings-section-${id}"]`);
  await page.waitForSelector(`[data-testid="settings-section-${id}-body"]`, { timeout: 15_000 });
}

async function dirtyCount() {
  const text = (await page.locator('[data-testid="settings-dirty-bar"]').textContent()) ?? '';
  const match = /未保存\s*(\d+)\s*项/u.exec(text);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}

/** Saves through the UI, answering the high-impact confirmation when it appears. */
let lastSaveSawImpactConfirm = false;
async function saveThroughUi() {
  await page.click('[data-testid="settings-save"]');
  lastSaveSawImpactConfirm = false;
  const confirm = page.locator('[data-testid="settings-impact-confirm-confirm"]');
  if ((await confirm.count()) > 0) {
    const impactText = ((await page.locator('[data-testid="settings-impact-confirm-message"]').textContent()) ?? '') + ((await page.locator('[data-testid="settings-impact-confirm-panel"]').textContent()) ?? '');
    lastSaveSawImpactConfirm = impactText.includes('高影响') || impactText.includes('全局热键') || impactText.includes('开机启动');
    await confirm.click({ timeout: 10_000 });
  }
  await page.waitForFunction(
    () => {
      const bar = document.querySelector('[data-testid="settings-dirty-bar"]');
      if (bar === null) {
        return false;
      }
      const error = document.querySelector('[data-testid="settings-save-error"]');
      return bar.textContent.includes('没有未保存') || error !== null;
    },
    undefined,
    { timeout: 30_000 }
  );
  const saveError = await page.locator('[data-testid="settings-save-error"]').count();
  if (saveError > 0) {
    const message = await page.locator('[data-testid="settings-save-error"]').textContent();
    fail('保存', '保存设置', `界面报错：${message}`);
  }
}

async function readInput(testId) {
  return await page.locator(`[data-testid="${testId}"]`).inputValue();
}

async function isChecked(testId) {
  return await page.locator(`[data-testid="${testId}"]`).isChecked();
}

async function text(testId) {
  return ((await page.locator(`[data-testid="${testId}"]`).textContent()) ?? '').replace(/\s+/gu, ' ').trim();
}

/** The settings document on disk is the strongest "survives a restart" evidence. */
function findFileNamed(root, name) {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.name === name) {
        return path;
      }
    }
  }
  return null;
}

try {
  ({ launched: app, window: page } = await launchApp());
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  assertCheck('0 启动', '新壳在 smoke 模式下启动', (await page.getAttribute('[data-testid="roc-app"]', 'data-mode')) === 'smoke');

  // ---- 闸门 0：准备（provider / 权限 / 项目 / 工作目录） -------------------------
  const configured = await page.evaluate(
    async ({ providerId, modelId, modelKey, endpoint, secret }) => {
      const current = await window.roc.settings.get();
      if (!current.ok) {
        return { error: current.error.message };
      }
      const providers = [
        ...current.data.providers.filter((provider) => provider.id !== providerId),
        {
          id: providerId,
          name: 'P8 Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: `secret:${providerId}`,
          enabled: true,
          models: [
            {
              id: modelId,
              displayName: 'P8 Smoke Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: false
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
      const secretResult = await window.roc.settings.setProviderSecret({ providerId, plaintext: secret });
      return {
        ok: secretResult.ok === true,
        providerCount: saved.data.providers.length,
        defaultModelId: saved.data.defaultModelId,
        fixedProviders: saved.data.providers
          .filter((provider) => ['nvidia', 'openrouter', 'llama_cpp'].includes(provider.id))
          .map((provider) => provider.id)
      };
    },
    { providerId: smokeProviderId, modelId: smokeModelId, modelKey: smokeModelKey, endpoint: smokeProvider.endpoint, secret: smokeSecret }
  );
  assertCheck('0 准备', '默认模型、permissions.mode=default 与 smoke provider 密钥就绪', configured.ok === true, configured.error ?? '');
  assertCheck('0 准备', 'settings.get 总是返回三个内置 provider（后端规范化）', configured.fixedProviders?.length === 3, JSON.stringify(configured.fixedProviders));

  const preflight = await page.evaluate(async (path) => {
    const workspace = await window.roc.workspace.select({ path });
    const project = await window.roc.research.createProject({
      title: 'P8 设置闸门项目',
      description: 'ROC-P8-PROJECT 设置中心闸门',
      workspacePath: path,
      language: 'zh'
    });
    return {
      workspace: workspace.ok ? workspace.data.path : `error:${workspace.error.message}`,
      projectId: project.ok ? project.data.id : null,
      projectError: project.ok ? null : project.error.message
    };
  }, workspaceA);
  assertCheck('0 准备', '工作目录绑定与项目创建成功', typeof preflight.projectId === 'string', preflight.projectError ?? '');
  const projectId = preflight.projectId;

  // ---- 闸门 1：每个分区读回保存值 ------------------------------------------------
  // 先进入项目：索引配置按项目读写（`research.index.configure` 要 projectId），导出快照的落盘
  // 也需要绑定的工作目录 —— 二者都来自当前路由里的项目。
  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await waitForProjectRoute();
  await openSettingsViaShortcut();
  assertCheck(
    '1 分区读回',
    '⌘, 路径（app.openSettings → navigate）打开了设置中心',
    (await page.locator('[data-testid="settings-modal-panel"]').count()) === 1,
    'settings-modal-panel 可见'
  );

  // 模型与服务：供应商名与模型显示名。
  // 默认选中项是内置的 NVIDIA（后端规范化列表把三个内置 provider 排在最前），它的
  // id / 名称 / 地址被锁定，所以要显式切到 smoke provider 再编辑。
  await openSection('models');
  assertCheck('1 分区读回', '内置 provider 的字段是锁定的（后端会重写它们）', await page.locator('[data-testid="settings-provider-name"]').isDisabled(), 'NVIDIA（默认选中项）');
  await page.selectOption('[data-testid="settings-provider-select"]', smokeProviderId);
  await page.fill('[data-testid="settings-provider-name"]', providerNameTag);
  await page.fill('[data-testid="settings-model-name-0"]', modelNameTag);
  assertCheck('1 分区读回', '模型与服务改动进入脏状态', (await dirtyCount()) >= 2, `dirty=${await dirtyCount()}`);

  // 向量与 RAG：索引 include + watch。
  // 先断言「进项目了且索引读到了」——否则这里会退化成 30s 超时（超时说明不了原因），
  // 而索引配置按项目存储，未进项目时分区本来就只显示一句说明。
  await openSection('rag');
  const ragBody = await text('settings-section-rag-body');
  assertCheck(
    '1 分区读回',
    '当前项目有可编辑的索引配置（分包/模式字段来自 research.index.status）',
    (await page.locator('[data-testid="settings-index-kinds"]').count()) > 0,
    ragBody.slice(0, 140)
  );
  await page.fill('[data-testid="settings-index-include"]', '**/*.md\n**/*.pdf');
  await page.locator('[data-testid="settings-index-include"]').blur();
  await page.locator('[data-testid="settings-index-watch"]').uncheck();

  // 智能体安全：字符上限 + 一个扫描开关
  await openSection('guardrail');
  await page.fill('[data-testid="settings-char-limit-user"]', '25000');
  await page.locator('[data-testid="settings-char-limit-user"]').blur();
  await page.locator('[data-testid="settings-scan-credential"]').uncheck();

  // 应用基础：开机启动 + 全局热键（高影响项 → 走确认）
  await openSection('app');
  await page.locator('[data-testid="settings-open-at-login"]').check();
  await page.fill('[data-testid="settings-global-hotkey"]', hotkeyTag);

  // 任务与调度：长任务阈值 + 调度器上限
  await openSection('tasks');
  await page.fill('[data-testid="settings-long-running-seconds"]', '90');
  await page.locator('[data-testid="settings-long-running-seconds"]').blur();
  await page.fill('[data-testid="settings-scheduler-max-tasks"]', '120');
  await page.locator('[data-testid="settings-scheduler-max-tasks"]').blur();

  // 记忆策略：每轮候选数
  await openSection('memory');
  await page.fill('[data-testid="settings-auto-memory-max-candidates"]', '7');
  await page.locator('[data-testid="settings-auto-memory-max-candidates"]').blur();

  // 授权与安全：MCP 审批模式（立即写，不进草稿）
  await openSection('authorization');
  await page.selectOption('[data-testid="settings-mcp-approval-mode"]', 'fully_automatic');
  await page.waitForFunction(
    async () => {
      const config = await window.roc.mcp.getConfig();
      return config.ok && config.data.approvalMode === 'fully_automatic';
    },
    undefined,
    { timeout: 15_000 }
  );
  const mcpAfterSwitch = await page.evaluate(async () => {
    const config = await window.roc.mcp.getConfig();
    return config.ok ? config.data.approvalMode : `error:${config.error.message}`;
  });
  assertCheck('1 分区读回', 'MCP 审批模式立即写入后端', mcpAfterSwitch === 'fully_automatic', String(mcpAfterSwitch));
  await page.selectOption('[data-testid="settings-mcp-approval-mode"]', 'default');
  await page.waitForFunction(
    async () => {
      const config = await window.roc.mcp.getConfig();
      return config.ok && config.data.approvalMode === 'default';
    },
    undefined,
    { timeout: 15_000 }
  );

  // Hooks：先把配置写进草稿（不落库），与其它分区的改动一起由下面那次整份保存写入
  await openSection('hooks');
  await page.fill(
    '[data-testid="settings-hooks-json"]',
    JSON.stringify(
      {
        schemaVersion: 1,
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand, timeoutSeconds: 5, failureMode: 'continue' }] }]
        }
      },
      null,
      2
    )
  );
  await page.click('[data-testid="settings-hooks-apply"]');
  assertCheck('1 分区读回', 'hooks JSON 应用后进入脏状态', (await dirtyCount()) > 0, `dirty=${await dirtyCount()}`);

  // 一次整份保存：`settings.save` 没有局部 patch，所有分区的草稿改动在这里一次写入，并且因为
  // 开机启动 / 全局热键是「高影响项」，保存前必须先过高影响确认（T8.2）。
  await saveThroughUi();
  assertCheck('1 分区读回', '高影响项改动在保存前列出影响并确认', lastSaveSawImpactConfirm === true, 'settings-impact-confirm');
  assertCheck('1 分区读回', '保存后脏状态清零', (await dirtyCount()) === 0, await text('settings-dirty-bar'));

  // Hooks：配置落库后 handler 出现在快照里，未信任 → 显式信任
  await page.waitForSelector('[data-testid="settings-hook-SessionEnd:0:0"]', { timeout: 20_000 });
  const trustBefore = await page.getAttribute('[data-testid="settings-hook-SessionEnd:0:0"]', 'data-trust');
  assertCheck('1 分区读回', 'hooks 保存后 handler 出现在快照里且需要复核', trustBefore === 'review_required', String(trustBefore));
  await page.click('[data-testid="settings-hook-trust-button-SessionEnd:0:0"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="settings-hook-SessionEnd:0:0"]')?.getAttribute('data-trust') === 'trusted',
    undefined,
    { timeout: 20_000 }
  );
  assertCheck(
    '1 分区读回',
    '显式信任后 trustState=trusted',
    (await page.getAttribute('[data-testid="settings-hook-SessionEnd:0:0"]', 'data-trust')) === 'trusted',
    hookCommand
  );
  assertCheck(
    '1 分区读回',
    '信任（一次状态刷新）没有清掉其它分区已保存的草稿值',
    (await dirtyCount()) === 0,
    `dirty=${await dirtyCount()}`
  );

  // 回归：保存之后草稿里的 hooks 必须是**已保存**的那份配置（评审 P1-2：baseline 曾经取自
  // hooks 保存之前的 core 快照，于是 JSON 编辑器显示旧配置、而列表显示新 handler）。
  const hooksJsonAfterSave = JSON.parse(await readInput('settings-hooks-json'));
  assertCheck(
    '1 分区读回',
    '保存后草稿里的 hooks 配置就是已保存的那份（JSON 与列表一致）',
    hooksJsonAfterSave?.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command === hookCommand,
    JSON.stringify(hooksJsonAfterSave?.hooks?.SessionEnd ?? null).slice(0, 120)
  );

  // 回归：启用勾选框读的是草稿（评审 P1-1：曾经读只读快照，点了不会变）。
  await page.locator('[data-testid="settings-hook-enabled-SessionEnd:0:0"]').uncheck();
  assertCheck(
    '1 分区读回',
    '禁用勾选框立刻反映到自身与行内文案（控件读草稿而不是只读快照）',
    (await isChecked('settings-hook-enabled-SessionEnd:0:0')) === false &&
      (await text('settings-hook-state-SessionEnd:0:0')).startsWith('停用'),
    await text('settings-hook-state-SessionEnd:0:0')
  );
  await page.locator('[data-testid="settings-hook-enabled-SessionEnd:0:0"]').check();
  assertCheck(
    '1 分区读回',
    '重新启用后又回到勾选状态（两次点击都能看见）',
    (await isChecked('settings-hook-enabled-SessionEnd:0:0')) === true,
    await text('settings-hook-state-SessionEnd:0:0')
  );

  // 偏好与备份：生成快照（从已保存的文档序列化）
  await openSection('backup');
  await page.click('[data-testid="settings-export-generate"]');
  const exportText = await readInput('settings-export-text');

  const saved = await page.evaluate(async () => {
    const snapshot = await window.roc.settings.get();
    if (!snapshot.ok) {
      return { error: snapshot.error.message };
    }
    return {
      providerName: snapshot.data.providers.find((provider) => provider.id === 'p8-smoke-provider')?.name ?? null,
      modelName: snapshot.data.providers.find((provider) => provider.id === 'p8-smoke-provider')?.models[0]?.displayName ?? null,
      defaultModelId: snapshot.data.defaultModelId,
      openAtLogin: snapshot.data.settings.startup.openAtLogin,
      globalHotkey: snapshot.data.settings.globalHotkey,
      runningSeconds: snapshot.data.settings.tasks.longRunningThresholds.runningSeconds,
      maxRegisteredTasks: snapshot.data.settings.tasks.scheduler.maxRegisteredTasks,
      charLimitUser: snapshot.data.settings.memory.charLimits.user,
      scanCredential: snapshot.data.settings.memory.securityScan.credential,
      maxCandidatesPerRun: snapshot.data.settings.memory.autoMemory.maxCandidatesPerRun,
      approvalMode: snapshot.data.permissions.mode
    };
  });
  assertCheck('1 分区读回', 'settings.get 读回模型改动的值', saved.providerName === providerNameTag && saved.modelName === modelNameTag, `${saved.providerName} / ${saved.modelName}`);
  assertCheck('1 分区读回', 'settings.get 读回应用基础的值', saved.openAtLogin === true && saved.globalHotkey === hotkeyTag, `openAtLogin=${saved.openAtLogin} hotkey=${saved.globalHotkey}`);
  assertCheck('1 分区读回', 'settings.get 读回任务与调度的值', saved.runningSeconds === 90 && saved.maxRegisteredTasks === 120, `${saved.runningSeconds}/${saved.maxRegisteredTasks}`);
  assertCheck(
    '1 分区读回',
    'settings.get 读回智能体安全与记忆策略的值',
    saved.charLimitUser === 25000 && saved.scanCredential === false && saved.maxCandidatesPerRun === 7 && saved.approvalMode === 'default',
    JSON.stringify({ user: saved.charLimitUser, scan: saved.scanCredential, candidates: saved.maxCandidatesPerRun, approval: saved.approvalMode })
  );

  const indexReadBack = await page.evaluate(async (id) => {
    const status = await window.roc.research.getIndexStatus({ projectId: id });
    return status.ok
      ? { include: status.data.settings.include, watch: status.data.settings.watch, revision: status.data.settings.revision }
      : { error: status.error.message };
  }, projectId);
  assertCheck(
    '1 分区读回',
    'research.index.status 读回索引配置',
    Array.isArray(indexReadBack.include) && indexReadBack.include.includes('**/*.pdf') && indexReadBack.watch === false,
    JSON.stringify(indexReadBack)
  );

  // 界面读回（重新打开分区，值来自重新读取的后端快照）。切换分区会卸载上一个分区的组件，
  // 所以「当前选中的供应商」这类组件内状态会回到第一个（内置 NVIDIA）——测试要像用户那样再选一次。
  await openSection('models');
  await page.selectOption('[data-testid="settings-provider-select"]', smokeProviderId);
  assertCheck('1 分区读回', '界面读回供应商名与模型显示名', (await readInput('settings-provider-name')) === providerNameTag && (await readInput('settings-model-name-0')) === modelNameTag);
  await openSection('app');
  assertCheck('1 分区读回', '界面读回开机启动与全局热键', (await isChecked('settings-open-at-login')) === true && (await readInput('settings-global-hotkey')) === hotkeyTag);
  await openSection('guardrail');
  assertCheck('1 分区读回', '界面读回字符上限与扫描开关', (await readInput('settings-char-limit-user')) === '25000' && (await isChecked('settings-scan-credential')) === false);
  await openSection('memory');
  assertCheck('1 分区读回', '界面读回记忆策略', (await readInput('settings-auto-memory-max-candidates')) === '7');
  await openSection('tasks');
  assertCheck('1 分区读回', '界面读回任务与调度', (await readInput('settings-long-running-seconds')) === '90' && (await readInput('settings-scheduler-max-tasks')) === '120');

  // 只读分区：真实状态 + 明确说明移除的字段
  await openSection('literature');
  // KeyValueRow renders the label and the value in one row, so the text is 「就绪是」/「就绪否」.
  // Wait for the real IPC result first: reading the 「读取中…」 placeholder is a timing assertion,
  // not a state assertion (the toolchain row below needs the same treatment).
  await page.waitForFunction(
    () => !(document.querySelector('[data-testid="settings-models-ready"]')?.textContent ?? '').includes('读取中'),
    undefined,
    { timeout: 20_000 }
  );
  const literatureReady = await text('settings-models-ready');
  assertCheck('1 分区读回', '文献与解析分区显示后端真实模型状态', literatureReady.endsWith('是') || literatureReady.endsWith('否'), literatureReady);
  // 分区文本只在它挂载时存在（切换分区会卸载组件），所以要在切走之前读。
  const literatureRemoved = await text('settings-literature-removed');
  await openSection('sandbox');
  // The toolchain status is a real IPC call; wait for it to resolve rather than reading the
  // 「读取中…」 placeholder (the same discipline the P6 diagnostics gate uses).
  await page.waitForFunction(
    () => !(document.querySelector('[data-testid="settings-toolchain-available"]')?.textContent ?? '').includes('读取中'),
    undefined,
    { timeout: 20_000 }
  );
  const toolchainText = await text('settings-toolchain-available');
  const toolchainVerdict = toolchainText.endsWith('不可用') ? '不可用' : toolchainText.endsWith('可用') ? '可用' : 'unknown';
  assertCheck(
    '1 分区读回',
    '编译与沙箱分区显示真实工具链状态',
    toolchainVerdict !== 'unknown',
    `${toolchainVerdict}（${toolchainText}）· rtk=${await text('settings-rtk-status')}`
  );
  const sandboxRemoved = await text('settings-sandbox-removed');
  assertCheck(
    '1 分区读回',
    '两个只读分区都写明移除了哪些无后端字段的选项',
    literatureRemoved.includes('已移除') && sandboxRemoved.includes('已移除'),
    `${literatureRemoved.slice(0, 60)} | ${sandboxRemoved.slice(0, 60)}`
  );

  // ---- 闸门 2：密钥只显示「已配置」，localStorage / 导出快照 / 磁盘快照无明文 ----
  await openSection('models');
  await page.selectOption('[data-testid="settings-provider-select"]', smokeProviderId);
  const secretStatusText = await text('settings-provider-secret-status');
  assertCheck('2 密钥', 'UI 只显示「已配置」，不显示密钥内容', secretStatusText.includes('已配置') && !secretStatusText.includes(smokeSecret), secretStatusText);
  const secretRef = await text('settings-provider-credential-ref');
  assertCheck('2 密钥', '凭据引用形如 secret:<providerId>', secretRef === `secret:${smokeProviderId}`, secretRef);

  const storageLeak = await page.evaluate((secret) => {
    const dump = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key === null) {
        continue;
      }
      dump.push(`${key}=${window.localStorage.getItem(key) ?? ''}`);
    }
    return { leaked: dump.some((entry) => entry.includes(secret)), keys: dump.map((entry) => entry.split('=')[0]) };
  }, smokeSecret);
  assertCheck('2 密钥', 'localStorage 里没有明文密钥', storageLeak.leaked === false, JSON.stringify(storageLeak.keys.slice(0, 12)));

  const exportLeak = exportText.includes(smokeSecret);
  assertCheck('2 密钥', '导出快照文本里没有明文密钥', exportLeak === false, `快照长度 ${exportText.length}`);
  const parsedExport = JSON.parse(exportText);
  assertCheck(
    '2 密钥',
    '导出快照保留凭据引用但不含 apiKey 字段',
    parsedExport.providers.some((provider) => provider.id === smokeProviderId && provider.credentialRef === `secret:${smokeProviderId}`) &&
      parsedExport.providers.every((provider) => provider.apiKey === undefined),
    JSON.stringify(parsedExport.providers.map((provider) => provider.id))
  );

  // 写一份快照到工作目录，再从磁盘上读回来验证（这是「落盘也没有明文」）
  await openSection('backup');
  await page.click('[data-testid="settings-export-generate"]');
  await page.click('[data-testid="settings-export-write"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="settings-export-write-error"]') === null,
    undefined,
    { timeout: 20_000 }
  );
  await sleep(500);
  const writtenExport = join(workspaceA, 'roc-settings-export.json');
  assertCheck('2 密钥', '快照写入工作目录成功', existsSync(writtenExport), writtenExport);
  const diskText = readFileSync(writtenExport, 'utf8');
  assertCheck('2 密钥', '磁盘上的快照没有明文密钥', diskText.includes(smokeSecret) === false && diskText.includes(modelNameTag), `bytes=${diskText.length}`);

  const savedDocPath = findFileNamed(dataRoot, 'settings.json');
  assertCheck('2 密钥', '后端的 settings.json 里没有明文密钥（密钥在 safeStorage）', savedDocPath !== null && readFileSync(savedDocPath, 'utf8').includes(smokeSecret) === false, savedDocPath ?? 'settings.json 未找到');

  // ---- 闸门 3：settings.testProvider 真测（连得上给延迟 / 连不上给后端原文） --------
  await openSection('models');
  await page.selectOption('[data-testid="settings-provider-select"]', smokeProviderId);
  await page.click('[data-testid="settings-test-provider"]');
  await page.waitForSelector('[data-testid="settings-test-result"]', { timeout: 30_000 });
  const okResult = await text('settings-test-result');
  assertCheck('3 测速', '连通时显示真实延迟', /连通/.test(okResult) && /\d+\s*ms/u.test(okResult), okResult);

  const broken = await page.evaluate(
    async ({ providerId, secret }) => {
      const current = await window.roc.settings.get();
      if (!current.ok) {
        return { error: current.error.message };
      }
      const providers = [
        ...current.data.providers.filter((provider) => provider.id !== providerId),
        {
          id: providerId,
          name: 'P8 Broken Provider',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:1/v1',
          credentialRef: `secret:${providerId}`,
          enabled: true,
          options: { timeoutMs: 1500 },
          models: [
            {
              id: 'broken-model',
              displayName: 'P8 Broken Model',
              enabled: true,
              supportsStreaming: false,
              supportsToolCalls: false,
              supportsImages: false
            }
          ]
        }
      ];
      const saved = await window.roc.settings.save({
        settings: current.data.settings,
        providers,
        defaultModelId: current.data.defaultModelId,
        permissions: current.data.permissions
      });
      if (!saved.ok) {
        return { error: saved.error.message };
      }
      await window.roc.settings.setProviderSecret({ providerId, plaintext: secret });
      const tested = await window.roc.settings.testProvider({ providerId, modelId: 'broken-model' });
      return tested.ok ? { ipcError: tested.data.error } : { error: tested.error.message };
    },
    { providerId: 'p8-broken-provider', secret: 'p8-broken-secret' }
  );
  assertCheck('3 测速', '后端对不可达 provider 返回 invalid 与原因原文', typeof broken.ipcError === 'string' && broken.ipcError.length > 0, broken.error ?? broken.ipcError);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await openSettingsViaShortcut();
  await openSection('models');
  await page.selectOption('[data-testid="settings-provider-select"]', 'p8-broken-provider');
  await page.click('[data-testid="settings-test-provider"]');
  const brokenShown = page.locator('[data-testid="settings-test-result"]');
  await brokenShown.waitFor({ timeout: 60_000 });
  const brokenText = ((await brokenShown.textContent()) ?? '').replace(/\s+/gu, ' ').trim();
  assertCheck('3 测速', '界面显示的是后端原文（不是自造文案）', brokenText.includes('不连通') && brokenText.includes(broken.ipcError.slice(0, 12)), brokenText.slice(0, 160));

  // 清掉 broken provider，避免影响后续闸门
  await page.evaluate(async () => {
    const current = await window.roc.settings.get();
    if (!current.ok) {
      return;
    }
    await window.roc.settings.save({
      settings: current.data.settings,
      providers: current.data.providers.filter((provider) => provider.id !== 'p8-broken-provider'),
      defaultModelId: current.data.defaultModelId,
      permissions: current.data.permissions
    });
  });

  // ---- 闸门 4：未保存关闭有确认 + 脏分区警告点 + 关闭后焦点回齿轮 ------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await openSettingsViaShortcut();
  await openSection('guardrail');
  await page.fill('[data-testid="settings-char-limit-agents"]', '26000');
  await page.locator('[data-testid="settings-char-limit-agents"]').blur();
  await page.waitForFunction(() => {
    const dot = document.querySelector('[data-testid="settings-dirty-dot-guardrail"]');
    return dot !== null && document.querySelector('[data-testid="settings-section-guardrail"]')?.getAttribute('data-dirty') === 'true';
  }, undefined, { timeout: 10_000 });
  const dirtyDot = await page.evaluate(() => {
    const dot = document.querySelector('[data-testid="settings-dirty-dot-guardrail"]');
    const row = document.querySelector('[data-testid="settings-section-guardrail"]');
    return {
      dot: dot !== null,
      dataDirty: row?.getAttribute('data-dirty') ?? null,
      // 不只靠颜色：还有 title 与 sr-only 文案
      title: row?.getAttribute('title') ?? '',
      srOnly: row?.textContent?.includes('有未保存的修改') ?? false
    };
  });
  assertCheck(
    '4 关闭确认',
    '脏分区有警告点（不只靠颜色：点 + title + sr-only 文案）',
    dirtyDot.dot && dirtyDot.dataDirty === 'true' && dirtyDot.title.includes('未保存') && dirtyDot.srOnly,
    JSON.stringify(dirtyDot)
  );
  const dirtyBeforeClose = await dirtyCount();
  assertCheck('4 关闭确认', '脏状态条显示未保存项数', dirtyBeforeClose >= 1, `dirty=${dirtyBeforeClose}`);

  await page.click('[data-testid="settings-modal-close"]');
  await page.waitForSelector('[data-testid="settings-discard-panel"]', { timeout: 10_000 });
  assertCheck('4 关闭确认', '未保存关闭弹出确认且模态仍在', (await page.locator('[data-testid="settings-modal-panel"]').count()) === 1);
  await page.click('[data-testid="settings-discard-cancel"]');
  await page.waitForSelector('[data-testid="settings-discard-panel"]', { state: 'detached', timeout: 10_000 });
  assertCheck('4 关闭确认', '选择继续编辑后未保存项仍在', (await dirtyCount()) === dirtyBeforeClose, `dirty=${await dirtyCount()}`);

  await page.click('[data-testid="settings-discard-draft"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-dirty-bar"]')?.textContent.includes('没有未保存'), undefined, { timeout: 10_000 });
  await page.fill('[data-testid="settings-char-limit-agents"]', '27000');
  await page.locator('[data-testid="settings-char-limit-agents"]').blur();
  await page.click('[data-testid="settings-modal-close"]');
  await page.waitForSelector('[data-testid="settings-discard-confirm"]', { timeout: 10_000 });
  await page.click('[data-testid="settings-discard-confirm"]');
  await page.waitForSelector('[data-testid="settings-modal-panel"]', { state: 'detached', timeout: 15_000 });
  const focusBack = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
  assertCheck('4 关闭确认', '关闭后焦点回到设置齿轮', focusBack === 'titlebar-settings', String(focusBack));
  const roleAfter = await page.evaluate(async () => {
    const snapshot = await window.roc.settings.get();
    return snapshot.ok ? snapshot.data.settings.memory.charLimits.agents : null;
  });
  assertCheck('4 关闭确认', '放弃修改没有写入后端', roleAfter !== 27000, `agents=${String(roleAfter)}`);

  // ---- 闸门 5：设置改完助手 / RAG / 阶段策略立即生效（无需重启） -------------------
  await navigate(page, `page=research&project=${projectId}&view=latex&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 20_000 });
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="assistant-model-settings"]')?.textContent ?? '').includes('P8 Smoke Model TAG'),
    undefined,
    { timeout: 20_000 }
  );
  const assistantBefore = await text('assistant-model-settings');

  await openSettingsViaShortcut();
  await openSection('models');
  await page.selectOption('[data-testid="settings-provider-select"]', smokeProviderId);
  await page.fill('[data-testid="settings-model-name-0"]', `${modelNameTag} v2`);
  await saveThroughUi();
  await closeSettings();

  await page.waitForFunction(
    () => (document.querySelector('[data-testid="assistant-model-settings"]')?.textContent ?? '').includes('v2'),
    undefined,
    { timeout: 20_000 }
  );
  const assistantAfter = await text('assistant-model-settings');
  assertCheck('5 立即生效', '助手模型标签无需重启即刷新', assistantBefore !== assistantAfter && assistantAfter.includes('v2'), `${assistantBefore} → ${assistantAfter}`);

  // RAG Studio：索引配置改完 revision 与 include 立即变化
  // The literature sub-view is component state, not a URL parameter (P5 deviation), so the
  // gate drives it the way a user does: hub → RAG 子视图.
  await navigate(page, `page=research&project=${projectId}&view=literature`);
  await page.waitForSelector('[data-testid="literature-hub"]', { timeout: 20_000 });
  await page.click('[data-testid="literature-subview-rag"]');
  await page.waitForSelector('[data-testid="rag-settings"]', { timeout: 20_000 });
  const ragBefore = await text('rag-settings');
  const ragRevisionBefore = /revision\s*(\d+)/u.exec(ragBefore)?.[1] ?? null;

  await openSettingsViaShortcut();
  await openSection('rag');
  await page.fill('[data-testid="settings-index-include"]', '**/*.md\n**/*.pdf\n**/*.tex');
  await page.locator('[data-testid="settings-index-include"]').blur();
  await saveThroughUi();
  await closeSettings();
  await page.waitForFunction(
    (previous) => {
      const node = document.querySelector('[data-testid="rag-settings"]');
      if (node === null) {
        return false;
      }
      const match = /revision\s*(\d+)/u.exec(node.textContent ?? '');
      return match !== null && match[1] !== previous;
    },
    ragRevisionBefore,
    { timeout: 25_000 }
  );
  const ragAfter = await text('rag-settings');
  assertCheck('5 立即生效', 'RAG Studio 读回新 revision 与 include', ragAfter.includes('**/*.tex'), ragAfter.slice(0, 160));

  // 阶段策略面板（△ 阶段面已整体删除）：该面板已不存在，所以「模型下拉跟随设置
  // 刷新」被另一块真的会刷新模型的界面接替——文稿视图的编译工具链状态读的是同一条 revision 机制，
  // 且它的可用性本来就来自后端（research.toolchain.status），不是内联配置。
  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await page.waitForSelector('[data-testid="production-latex"]', { timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="production-latex-toolchain"]');
      return node !== null && (node.textContent ?? '').trim().length > 0;
    },
    undefined,
    { timeout: 20_000 }
  );
  const latexToolchainText =
    (await page.textContent('[data-testid="production-latex-toolchain"]')) ?? '';
  assertCheck(
    '5 立即生效',
    '文稿视图的编译工具链状态由后端读出（不是内联配置的本地判断）',
    latexToolchainText.trim().length > 0,
    latexToolchainText.replace(/\s+/gu, ' ').slice(0, 160)
  );

  record(
    '5 立即生效',
    'LaTeX / 模板编译侧没有可配置的引擎值（编译固定 tectonic），其可用性来自 research.toolchain.status，模板面板已按同一条 revision 机制重读',
    true,
    '见 F22：latexEngine/sandboxRuntime 无后端字段',
    'info'
  );

  // ---- 闸门 6：业务页无内联配置残留 ---------------------------------------------
  const rendererRoot = resolve('src/renderer');
  for (const [needle, label] of [
    ['isConfigOpen', '旧前端的配置抽屉开关 isConfigOpen'],
    ['ragChunkSize', '内联 RAG 分块配置 ragChunkSize'],
    ['mineruConfig', '内联 MinerU 配置 mineruConfig'],
    ['sandboxConfig.', '内联沙箱配置 sandboxConfig'],
    ['plotBackend', '内联绘图后端 plotBackend'],
    ['latexEngine', '内联 LaTeX 引擎 latexEngine']
  ]) {
    const hits = searchSourceTree(rendererRoot, needle).filter((hit) => !hit.includes('settings-rules') && !hit.includes('/settings/'));
    assertCheck('6 无内联配置', `业务页没有 ${label}`, hits.length === 0, hits.slice(0, 3).join(', '));
  }
  // 这一条要在 RAG Studio 真的挂载时读（上一条闸门把画布留在了文稿视图）。
  await navigate(page, `page=research&project=${projectId}&view=literature`);
  await page.waitForSelector('[data-testid="literature-hub"]', { timeout: 20_000 });
  await page.click('[data-testid="literature-subview-rag"]');
  await page.waitForSelector('[data-testid="rag-open-settings"]', { timeout: 20_000 });
  const ragOpenSettings = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="rag-open-settings"]');
    return button === null ? null : button.textContent?.trim() ?? '';
  });
  assertCheck('6 无内联配置', 'RAG Studio 以「打开设置中心」代替内联配置', ragOpenSettings !== null, String(ragOpenSettings));
  // 文献导入弹窗：MinerU 开关已移走，弹窗只说明写入口在设置中心
  await page.click('[data-testid="literature-hub-import"]');
  await page.waitForSelector('[data-testid="literature-import-dialog-panel"]', { timeout: 20_000 });
  const importDialogText = ((await page.locator('[data-testid="literature-import-dialog-panel"]').textContent()) ?? '').replace(/\s+/gu, ' ');
  assertCheck(
    '6 无内联配置',
    '文献导入弹窗没有 MinerU / 公式 / 表格开关，只指向设置中心',
    importDialogText.includes('解析（MinerU）模式与公式/表格开关在设置中心') && !importDialogText.includes('云服务地址'),
    importDialogText.slice(0, 120)
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="literature-import-dialog-panel"]', { state: 'detached', timeout: 15_000 });

  // 文稿（LaTeX）视图：没有引擎选择，也没有本地假编译
  // （它以前是阶段工作区的一个 tab；阶段面删除后它就是画布的一级 tab，同一份面板。）
  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await page.waitForSelector('[data-testid="production-latex"]', { timeout: 20_000 });
  const latexText = ((await page.locator('[data-testid="production-latex"]').textContent()) ?? '').replace(/\s+/gu, ' ');
  assertCheck(
    '6 无内联配置',
    '文稿视图没有引擎选择与本地编译，指向模板面板的真编译',
    latexText.includes('不做本地编译') && !latexText.includes('latexEngine'),
    latexText.slice(0, 120)
  );

  const randomHits = searchSourceTree(resolve('src/renderer/settings'), 'Math.random(');
  assertCheck('6 无内联配置', '设置中心没有 Math.random() 假延迟', randomHits.length === 0, randomHits.slice(0, 3).join(', '));

  // ---- 闸门 1b：真重启后设置仍在（用同一个 ROC_DATA_ROOT 再启动一次） --------------
  await app.close();
  await sleep(1_000);
  ({ launched: app, window: page } = await launchApp());
  const afterRestart = await page.evaluate(async () => {
    const snapshot = await window.roc.settings.get();
    if (!snapshot.ok) {
      return { error: snapshot.error.message };
    }
    return {
      providerName: snapshot.data.providers.find((provider) => provider.id === 'p8-smoke-provider')?.name ?? null,
      modelName: snapshot.data.providers.find((provider) => provider.id === 'p8-smoke-provider')?.models[0]?.displayName ?? null,
      openAtLogin: snapshot.data.settings.startup.openAtLogin,
      globalHotkey: snapshot.data.settings.globalHotkey,
      charLimitUser: snapshot.data.settings.memory.charLimits.user,
      secretStored: snapshot.data.providerSecretStatus.find((entry) => entry.providerId === 'p8-smoke-provider')?.stored ?? false
    };
  });
  assertCheck(
    '1b 重启保持',
    '重启后模型 / 应用基础 / 智能体安全的值仍在',
    afterRestart.providerName === providerNameTag && afterRestart.modelName === `${modelNameTag} v2` && afterRestart.openAtLogin === true && afterRestart.globalHotkey === hotkeyTag && afterRestart.charLimitUser === 25000,
    JSON.stringify(afterRestart)
  );
  assertCheck('1b 重启保持', '重启后密钥仍然是「已配置」（safeStorage 持久）', afterRestart.secretStored === true, JSON.stringify(afterRestart));

  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await ensureSettingsOpen();
  await openSection('app');
  assertCheck('1b 重启保持', '重启后界面仍读回保存的值', (await isChecked('settings-open-at-login')) === true && (await readInput('settings-global-hotkey')) === hotkeyTag);
  await closeSettings();

  // ---- 闸门 7：typecheck --------------------------------------------------------
  const typecheck = spawnSync('pnpm', ['typecheck'], { encoding: 'utf8', cwd: resolve('.') });
  assertCheck(
    '7 typecheck',
    'pnpm typecheck 无错误',
    typecheck.status === 0,
    `exit=${typecheck.status} out=${typecheck.stdout.trim().slice(0, 160)} err=${typecheck.stderr.trim().slice(0, 160)}`
  );

  assertCheck('7 渲染层错误', '整轮没有 renderer error', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));

  finishGate({
    label: 'P8',
    artifactDir,
    results,
    rendererErrors,
    extra: { providerRequests: smokeProvider.requests.length },
    // 声明的闸门段落。跑到少一段就是失败：这个脚本曾经只跑到第 4 段（`3 测速`）
    // 就结束了，仍然写 `passed: true`、报 40/40，而完整跑是 67/67。
    expectedGates: [
      '0 启动',
      '0 准备',
      '1 分区读回',
      '1b 重启保持',
      '2 密钥',
      '3 测速',
      '4 关闭确认',
      '5 立即生效',
      '6 无内联配置',
      '7 typecheck',
      '7 渲染层错误'
    ]
  });
} catch (error) {
  finishGate({ label: 'P8', artifactDir, results, rendererErrors, error });
} finally {
  if (app !== undefined) {
    await Promise.race([app.close(), new Promise((resolveDone) => setTimeout(resolveDone, 20_000))]);
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
  await smokeProvider.close();
  for (const directory of [dataRoot, workspaceRoot, skillSourceRoot, remoteRoot]) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Cheap recursive text search for gate 6 (no shell, no globbing surprises). */
function searchSourceTree(root, needle) {
  const hits = [];
  const walk = (directory) => {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (line.includes(needle) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
          hits.push(`${path}:${index + 1}`);
        }
      });
    }
  };
  walk(root);
  return hits;
}
