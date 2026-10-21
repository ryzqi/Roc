import { _electron as electron } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';
import { createGateRecorder, finishGate, navigate, prepareArtifactDir } from './lib/gate-harness.mjs';

/**
 * P4 验收闸门的自动化实测（真应用 / 真 IPC / 真 DeepAgent run / 真工具执行）。
 *
 * 为什么需要它：P4 的闸门 1–8 描述的全是**运行时行为** —— 一轮 run 是否真的流式渲染出
 * 文本+推理+工具调用、工具审批卡是否真的拦下了 `delete_file`、回答提问后 run 是否真的续跑、
 * 取消后是否回到可提交状态、关面板/切项目后是否恢复、500 条消息时虚拟化是否真的生效。
 * 静态阅读与单测都不覆盖这些（P3 的实测已经证明：类型正确、单测全绿、用户看到的是坏的）。
 *
 * 它**不**替代 P10 的 smoke：这里只覆盖 P4 的闸门，并显式以 `ROC_SMOKE_TARGET=dist` 运行
 * （后者很重要：`resolveSmokeTarget` 默认优先用 `release/mac-arm64/Roc.app`，
 * 那可能是过期的打包产物，P3 已经踩过两次）。
 *
 * 运行：
 *   rm -rf dist/renderer && pnpm build
 *   node scripts/verify-p4-assistant.mjs
 * 结果写入 `.artifacts/p4-gates/`（report.json + 截图）。
 */

const artifactDir = prepareArtifactDir(resolve('.artifacts/p4-gates'));

const { results, record, fail, assertCheck } = createGateRecorder();

const smokeModelId = 'p4-smoke-model';
const smokeProviderId = 'p4-smoke-provider';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;

/** Gate 6 target. The plan says "500 条消息"; see the deviation note in the report. */
const gate6TargetMessages = 500;
// Iteration aid only: the acceptance run uses the default (250 runs → 500 messages).
const gate6Runs = Number.parseInt(process.env.P4_GATE6_RUNS ?? '', 10) || Math.ceil(gate6TargetMessages / 2);

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);
seedSmokeSkillSource(skillSourceRoot);

const smokeProvider = await startSmokeProvider({});
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`P4 验收闸门实测 · target=${target.kind} · renderer=next · provider=${smokeProvider.endpoint}\n`);

let app;
let page;
let restartOnlyFinished = false;
const rendererErrors = [];

function observeRendererErrors(targetPage) {
  targetPage.on('console', (message) => {
    if (message.type() === 'error') {
      rendererErrors.push(message.text());
      console.error('[renderer]', message.text().slice(0, 300));
    }
  });
  targetPage.on('pageerror', (error) => {
    rendererErrors.push(error.message);
    console.error('[renderer:pageerror]', error.message.slice(0, 300));
  });
}

async function trackFinishedRuns(targetPage) {
  await targetPage.evaluate(() => {
    window.__p4FinishedRuns = [];
    window.roc.chat.onRunEvent((raw) => {
      const event = raw !== null && typeof raw === 'object' && !('type' in raw) && 'event' in raw ? raw.event : raw;
      if (event !== null && typeof event === 'object' && ['run_completed', 'run_cancelled', 'run_failed'].includes(event.type)) {
        window.__p4FinishedRuns.push(event.runId);
      }
    });
  });
}

async function launchSmokeApp() {
  const launched = await electron.launch({
    executablePath: target.executablePath,
    args: target.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });
  const launchedPage = await launched.firstWindow();
  observeRendererErrors(launchedPage);
  return { app: launched, page: launchedPage };
}

async function openAssistant(page, projectId) {
  // 视图写死为 `latex`：这里需要的只是「进入项目 + 助手打开」，而 `latex` 是 `?view=` 缺省时的
  // 落点。之前是一个 `view = 'overview'` 的参数，而那个面在 P10 已删——导航被静默归一成 `latex`，
  // 而调用方只传两个参数，所以那个参数从来没用过。删掉它，而不是把默认值换成另一个面。
  await navigate(page, `page=research&project=${projectId}&view=latex&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="assistant-composer-input"]', { timeout: 20_000 });
}

async function waitForStatus(page, status, timeoutMs = 90_000) {
  await page.waitForSelector(`[data-testid="assistant-run-status"][data-status="${status}"]`, { timeout: timeoutMs });
}

async function currentStatus(page) {
  const element = page.locator('[data-testid="assistant-run-status"]');
  if ((await element.count()) === 0) {
    return null;
  }
  return await element.getAttribute('data-status');
}

async function revealLatestTranscript(page) {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="assistant-scroll-bottom"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  if (clicked) {
    await page.waitForTimeout(100);
  }
}

/**
 * Waits for one session row, and on timeout reports **why** instead of only "selector not found".
 *
 * The 会话 tab renders three distinct states (loading spinner text / error bar / empty state),
 * and a bare `waitForSelector` timeout cannot tell them apart — the first P4 acceptance run
 * spent a 20s timeout on `session-row-…` without saying whether the list was empty or broken.
 */
async function waitForSessionRow(page, threadId, gate) {
  try {
    await page.waitForSelector(`[data-testid="session-row-${threadId}"]`, { timeout: 20_000 });
  } catch (error) {
    fail(gate, `会话列表中找不到 ${threadId}`, await describeSessionList(page, threadId));
    throw error;
  }
}

/** Human-readable snapshot of the 会话 tab, used in failure details. */
async function describeSessionList(page, threadId) {
  return await page.evaluate(async (target) => {
    const panel = document.querySelector('[data-testid="sidebar-panel-sessions"]');
    const rowTestIds = [...document.querySelectorAll('[data-testid^="session-row-"]')].map((node) =>
      node.getAttribute('data-testid')
    );
    const loading = document.querySelector('[data-testid="session-list-loading"]') !== null;
    const errorNode = document.querySelector('[data-testid="session-list-error"]');
    const empty = document.querySelector('[data-testid="sidebar-empty-sessions"]') !== null;
    const snapshot = await window.roc.tasks.getSnapshot();
    const backend = snapshot.ok
      ? snapshot.data.threads
          .map((thread) => `${thread.id.slice(0, 24)}(kind=${thread.kind},status=${thread.status})`)
          .join(', ')
      : `error=${snapshot.error.message}`;
    return [
      `panel=${panel === null ? 'missing' : 'present'}`,
      `loading=${String(loading)}`,
      `empty=${String(empty)}`,
      `error=${errorNode === null ? 'none' : (errorNode.textContent ?? '').trim()}`,
      `wanted=${target}`,
      `rows=[${rowTestIds.join(', ')}]`,
      `backendThreads=[${backend}]`
    ].join(' ');
  }, threadId);
}

let p4RunCounter = 0;

/**
 * Tags a scripted prompt with a per-run nonce.
 *
 * The scripted provider identifies its turn by the newest prompt in the shared thread history
 * and derives the tool-call ids from the same marker, so a second run on the same thread cannot
 * be mistaken for a continuation of the first.
 */
function p4Prompt(text) {
  p4RunCounter += 1;
  return `${text} ROC-P4-RUN:r${p4RunCounter}-${Date.now().toString(36)}`;
}

async function sendPrompt(page, text) {
  await page.fill('[data-testid="assistant-composer-input"]', '');
  await page.fill('[data-testid="assistant-composer-input"]', text);
  await page.focus('[data-testid="assistant-composer-input"]');
  await page.keyboard.press('Enter');
}

async function transcriptText(page) {
  const element = page.locator('[data-testid="assistant-transcript"]');
  if ((await element.count()) === 0) {
    return '';
  }
  return (await element.textContent()) ?? '';
}

async function waitForTranscript(page, needle, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await transcriptText(page);
    if (last.includes(needle)) {
      return last;
    }
    await page.waitForTimeout(120);
  }
  return last;
}

/** Expands an activity block that the auto-collapse has already closed. */
async function expandBlock(page, testId) {
  const details = page.locator(`[data-testid="${testId}"]`);
  if ((await details.count()) === 0) {
    throw new Error(`block ${testId} not found`);
  }
  if ((await details.getAttribute('open')) === null) {
    await page.click(`[data-testid="${testId}-summary"]`);
  }
}

async function verifyCrashCheckpointResume(threadId, projectId) {
  const restartPrompt = p4Prompt(
    '验收闸门 5：先列工作区，再在慢流期间崩溃恢复。 ROC-P4-MODE:restart ROC-P4-SLOW:200x80 ROC-P4-SLOW-TAG:P4CR'
  );
  const restartNonce = /ROC-P4-RUN:([A-Za-z0-9_-]+)/u.exec(restartPrompt)?.[1];
  if (restartNonce === undefined) throw new Error('P4 restart fixture prompt has no run nonce.');
  const restartCallId = `call_p4_restart_ls_${restartNonce}`;
  await sendPrompt(page, restartPrompt);
  await waitForStatus(page, 'running', 30_000);
  await waitForTranscript(page, 'P4CR-0005', 60_000);
  const activeRunResult = await page.evaluate(async (activeThreadId) =>
    await window.roc.chat.getActiveRun({ threadId: activeThreadId }), threadId);
  const restartRunId = activeRunResult.ok ? activeRunResult.data?.runId : undefined;
  assertCheck('5 恢复', '慢流中可定位正在运行的 run', typeof restartRunId === 'string', activeRunResult.ok ? '' : activeRunResult.error.message);
  if (typeof restartRunId !== 'string') throw new Error('P4 restart run was not active before process kill.');

  const crashedProcess = app.process();
  const processExit = new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Electron did not exit after SIGKILL.')), 15_000);
    crashedProcess.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
  if (!crashedProcess.kill('SIGKILL')) throw new Error('Could not SIGKILL the P4 smoke Electron process.');
  const killed = await processExit;
  assertCheck('5 恢复', 'Electron 进程被强制终止（模拟崩溃）', killed.signal === 'SIGKILL', JSON.stringify(killed));
  app = undefined;

  ({ app, page } = await launchSmokeApp());
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  await trackFinishedRuns(page);
  await openAssistant(page, projectId);
  await page.click('[data-testid="sidebar-tab-sessions"]');
  await waitForSessionRow(page, threadId, '5 恢复');
  await page.click(`[data-testid="session-row-${threadId}"]`);
  await page.waitForSelector('[data-testid="assistant-activity-task-acceptance"]', { timeout: 30_000 });
  const latestAcceptance = page.locator('[data-testid="assistant-activity-task-acceptance"]').last();
  if ((await latestAcceptance.getAttribute('open')) === null) await latestAcceptance.locator('summary').click();
  const checkpointResume = page.locator('[data-testid="assistant-task-resume-checkpoint"]');
  await checkpointResume.waitFor({ state: 'visible', timeout: 30_000 });
  assertCheck('5 恢复', '重启后的持久验收卡允许检查点续跑', true, restartRunId);
  await checkpointResume.click();
  await page.waitForTimeout(1_000);
  const checkpointDispatch = await page.evaluate(async ({ activeThreadId, runId }) => {
    const status = document.querySelector('[data-testid="assistant-run-status"]')?.getAttribute('data-status') ?? null;
    const error = document.querySelector('[data-testid="assistant-errors"]')?.textContent?.trim() ?? null;
    const [active, replay] = await Promise.all([
      window.roc.chat.getActiveRun({ threadId: activeThreadId }),
      window.roc.chat.getRunEvents({ runId, afterSequence: 0 })
    ]);
    return {
      status,
      error,
      active: active.ok ? active.data : active.error.message,
      events: replay.ok ? replay.data.events.map((entry) => entry.event.type) : replay.error.message
    };
  }, { activeThreadId: threadId, runId: restartRunId });
  if (checkpointDispatch.status !== 'running' && checkpointDispatch.status !== 'recovering') {
    throw new Error(`Checkpoint dispatch did not enter running state: ${JSON.stringify(checkpointDispatch)}`);
  }
  await waitForStatus(page, 'running', 30_000);
  await waitForStatus(page, 'completed', 90_000);
  const recoveredText = await waitForTranscript(page, 'P4CR-0200', 30_000);
  assertCheck('5 恢复', '进程重启后从已执行工具的检查点完成慢流', recoveredText.includes('P4CR-0200'), '');
  const assistantErrorCount = await page.locator('[data-testid="assistant-errors"]').count();
  assertCheck('5 恢复', '续跑后清除旧的重启中断错误提示', assistantErrorCount === 0,
    assistantErrorCount === 0 ? '' : (await page.locator('[data-testid="assistant-errors"]').textContent()) ?? '');
  const restartEvents = await page.evaluate(async (runId) => await window.roc.chat.getRunEvents({ runId, afterSequence: 0 }), restartRunId);
  const runEvents = restartEvents.ok ? restartEvents.data.events.map((entry) => entry.event) : [];
  const continuationCount = runEvents.filter((event) => event.type === 'run_continued').length;
  const toolStarts = runEvents.filter((event) => event.type === 'assistant_block' && event.block.kind === 'tool_call' &&
    event.block.callId === restartCallId && event.block.phase === 'start').length;
  assertCheck('5 恢复', '恢复事件只续跑一次且不重复执行 ls', continuationCount === 1 && toolStarts === 1,
    `continued=${continuationCount} ls-starts=${toolStarts}${restartEvents.ok ? '' : ` error=${restartEvents.error.message}`}`);
  await page.screenshot({ path: join(artifactDir, '05-crash-checkpoint-resume.png') });
}

/**
 * Static source assertions (gates 7 and the R9 side of it).
 *
 * These are source-level facts, so they live here rather than in a "did the app not crash"
 * check: a fake-streaming timer or a Blob URL added later would still render a plausible run.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

function listSourceFiles(dir) {
  const root = resolve(dir);
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}

try {
  ({ app, page } = await launchSmokeApp());

  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  // Deterministic start state, and deliberately a hostile one: clear `ui-state`, then pin the
  // sidebar to 会话 so the session list is **mounted before the first thread exists** (the tab
  // selection is persisted, so this is a real user state — see findings F15). Gate 1 then proves
  // the list refreshes via `tasks.onUpdated` instead of staying on its first empty snapshot.
  await page.evaluate(() => {
    window.localStorage.clear();
    window.localStorage.setItem('roc.ui.sidebar.tab', 'sessions');
    window.localStorage.setItem('roc.ui.theme.override', 'light');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  assertCheck('0 启动', '新壳在 smoke 模式下启动', (await page.getAttribute('[data-testid="roc-app"]', 'data-mode')) === 'smoke');
  const lightTheme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.documentElement).getPropertyValue('--app-zinc-950').trim()
  }));
  assertCheck('0 启动', '助手壳可使用浅色主题', lightTheme.theme === 'light' && lightTheme.background !== '', JSON.stringify(lightTheme));
  await page.evaluate(() => window.localStorage.setItem('roc.ui.theme.override', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  const darkTheme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.documentElement).getPropertyValue('--app-zinc-950').trim()
  }));
  assertCheck('0 启动', '助手壳可使用深色主题并切换调色板', darkTheme.theme === 'dark' && darkTheme.background !== lightTheme.background,
    `light=${lightTheme.background} dark=${darkTheme.background}`);

  // ---- 准备：provider + 默认模型 + 审批模式 ------------------------------------
  // 闸门 2 需要 `approvalPolicy.kind === 'required'` 的工具。默认权限是 fully_automatic，
  // 因此没有任何工具需要审批（见 run-capability-manifest 的 createInterruptPolicy）——
  // 唯一由设置驱动、且默认就注册的工具是 delete_file，所以把 permissions.mode 设为 'default'。
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
          name: 'P4 Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: `secret:${providerId}`,
          enabled: true,
          models: [
            {
              id: modelId,
              displayName: 'P4 Smoke Model',
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
      // Re-read after the write: the snapshot returned by `save` predates the secret.
      const afterSecret = await window.roc.settings.get();
      if (!afterSecret.ok) {
        return { error: afterSecret.error.message };
      }
      return {
        defaultModelId: afterSecret.data.defaultModelId,
        permissionMode: afterSecret.data.permissions.mode,
        secretStored:
          afterSecret.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true
      };
    },
    { providerId: smokeProviderId, modelId: smokeModelId, modelKey: smokeModelKey, endpoint: smokeProvider.endpoint }
  );
  if (configured.error !== undefined) {
    fail('0 准备', '配置 provider 与默认模型', configured.error);
  }
  assertCheck('0 准备', '默认模型指向 smoke provider', configured.defaultModelId === smokeModelKey, configured.defaultModelId);
  assertCheck('0 准备', '审批模式为 default（delete_file 需要审批）', configured.permissionMode === 'default', configured.permissionMode);
  assertCheck('0 准备', 'provider 密钥已写入 safeStorage', configured.secretStored === true, '');

  const project = await page.evaluate(
    async ({ workspacePath }) =>
      await window.roc.research.createProject({
        title: 'P4 gate project',
        description: 'P4 assistant acceptance gate harness project.',
        workspacePath
      }),
    { workspacePath: workspaceRoot }
  );
  if (!project.ok) {
    fail('0 准备', '创建项目', project.error.message);
  }
  const projectId = project.data.id;

  /** Resolves when the given run reaches a terminal state, via the live event stream. */
  await trackFinishedRuns(page);

  await openAssistant(page, projectId);
  assertCheck('0 准备', '助手面板与输入区可用', true, '');

  // ---- 闸门 6（前半）：模型来自配置，不是写死的 ---------------------------------
  const modelLabel = (await page.locator('[data-testid="assistant-model-settings"]').textContent()) ?? '';
  assertCheck('6 头部', '模型标签来自 settings.get 的真实 provider/model', modelLabel.includes('P4 Smoke Model'), modelLabel.trim());

  // ---- 闸门 1：真发一轮 run（文本流式 + 推理 + 工具调用） -----------------------
  await sendPrompt(page, p4Prompt('验收闸门 1：列一下工作目录。 ROC-P4-MODE:tool'));
  await waitForStatus(page, 'running', 30_000);
  const reasoningStreaming = await waitForTranscript(page, 'P4-推理片段', 60_000);
  assertCheck(
    '1 真跑一轮',
    '推理增量进入转录（无阻断的推理文本）',
    reasoningStreaming.includes('先列出工作目录'),
    'reasoning_content'
  );
  await waitForStatus(page, 'completed', 90_000);
  const toolDone = await waitForTranscript(page, 'P4-TOOL-DONE', 30_000);
  assertCheck('1 真跑一轮', '结束态为 completed', (await currentStatus(page)) === 'completed', '');
  assertCheck('1 真跑一轮', '文本流式渲染出结束段', toolDone.includes('P4-TOOL-DONE'), '');
  const acceptanceVisible = await page.locator('[data-testid="assistant-activity-task-acceptance"]').textContent();
  assertCheck('1 真跑一轮', '轻量问答验收进入助手时间线', acceptanceVisible?.includes('已满足') === true, acceptanceVisible ?? '');

  await expandBlock(page, 'assistant-activity-tool');
  const toolBody = (await page.locator('[data-testid="assistant-tool-body"]').textContent()) ?? '';
  assertCheck(
    '1 真跑一轮',
    '工具调用块显示真实工作区内容（工具真的执行了）',
    toolBody.includes('00-overview.txt'),
    toolBody.replace(/\s+/gu, ' ').trim().slice(0, 80)
  );
  await expandBlock(page, 'assistant-activity-reasoning');
  const reasoningBody = (await page.locator('[data-testid="assistant-reasoning-body"]').textContent()) ?? '';
  assertCheck('1 真跑一轮', '推理块展开后含推理原文', reasoningBody.includes('先列出工作目录'), '');
  assertCheck('1 真跑一轮', '完成后提供复制回答入口', (await page.locator('[data-testid="assistant-copy-answer"]').count()) > 0, '');
  await page.screenshot({ path: join(artifactDir, '01-run-tool.png') });

  const threadsAfterFirstRun = await page.evaluate(async () => await window.roc.tasks.getSnapshot());
  const chatThreads = threadsAfterFirstRun.ok ? threadsAfterFirstRun.data.threads.filter((thread) => thread.kind === 'chat') : [];
  if (chatThreads.length === 0) {
    fail('1 真跑一轮', 'run 创建了 chat 会话', 'no chat thread in tasks.getSnapshot()');
  }
  const threadId = chatThreads[0].id;
  record('1 真跑一轮', 'run 创建了 chat 会话', true, threadId);
  // 回归：会话面板在第一条消息之前就已挂载（tab 持久化为 sessions，见闸门 0），所以这一行
  // 只能是 `tasks.onUpdated` 推送刷新的结果 —— 只读一次快照会得到永久的「暂无会话」。
  const sessionRowAppeared = await page
    .waitForSelector(`[data-testid="session-row-${threadId}"]`, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  assertCheck(
    '1 真跑一轮',
    '先挂载的会话列表在 run 结束后刷新出新会话（订阅 tasks.onUpdated）',
    sessionRowAppeared,
    sessionRowAppeared ? '' : await describeSessionList(page, threadId)
  );

  if (process.env.P4_RESTART_ONLY === '1') {
    await verifyCrashCheckpointResume(threadId, projectId);
    finishGate({
      label: 'P4 崩溃恢复', artifactDir, results, rendererErrors,
      expectedGates: ['0 启动', '0 准备', '1 真跑一轮', '5 恢复']
    });
    restartOnlyFinished = true;
    throw new Error('P4_RESTART_ONLY_COMPLETE');
  }

  // ---- 闸门 2：工具审批（批准 + 拒绝各一次） ------------------------------------
  const approveTarget = join(workspaceRoot, 'p4-approval-ok.txt');
  const rejectTarget = join(workspaceRoot, 'p4-approval-reject.txt');
  writeFileSync(approveTarget, 'approve me\n', 'utf8');
  writeFileSync(rejectTarget, 'reject me\n', 'utf8');

  await sendPrompt(page, p4Prompt('验收闸门 2：删除一个文件。 ROC-P4-MODE:approval ROC-P4-DELETE:/workspace/p4-approval-ok.txt'));
  await waitForStatus(page, 'waiting_user', 60_000);
  await revealLatestTranscript(page);
  await page.waitForSelector('[data-testid="assistant-approval-card"]', { timeout: 20_000 });
  const approvalToolName = (await page.locator('[data-testid="assistant-approval-tool-name"]').textContent()) ?? '';
  assertCheck('2 审批', '审批卡显示被拦下的工具名', approvalToolName.trim() === 'delete_file', approvalToolName.trim());
  const approvalCardText = (await page.locator('[data-testid="assistant-approval-card"]').textContent()) ?? '';
  assertCheck('2 审批', '审批卡显示工具参数', approvalCardText.includes('p4-approval-ok.txt'), '');
  const decisionsText = (await page.locator('[data-testid="assistant-approval-decisions"]').textContent()) ?? '';
  assertCheck('2 审批', '审批卡显示可用决策', decisionsText.includes('approve'), decisionsText.trim());
  assertCheck('2 审批', '等待审批期间输入区不可提交', await page.locator('[data-testid="assistant-composer-input"]').isDisabled(), '');
  assertCheck(
    '2 审批',
    '等待审批期间既不提供发送也不提供停止（决定属于卡片）',
    (await page.locator('[data-testid="assistant-composer-send"]').count()) === 0 &&
      (await page.locator('[data-testid="assistant-composer-stop"]').count()) === 0 &&
      (await page.locator('[data-testid="assistant-composer-suspended"]').count()) === 1,
    ''
  );
  await page.screenshot({ path: join(artifactDir, '02-approval-card.png') });

  await page.locator('[data-testid="assistant-approval-approve"]').focus();
  const keyboardFocusedApprove = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-testid') === 'assistant-approval-approve'
  );
  assertCheck('2 审批', '批准决策按钮可获得键盘焦点', keyboardFocusedApprove, '');
  await page.keyboard.press('Enter');
  await waitForStatus(page, 'completed', 90_000);
  await waitForTranscript(page, 'P4-APPROVAL-DONE', 30_000);
  assertCheck('2 审批', '批准后 run 继续并完成', (await currentStatus(page)) === 'completed', '');
  assertCheck('2 审批', '批准后文件真的被删除（审批决定到了后端）', !existsSync(approveTarget), 'p4-approval-ok.txt 不存在');
  assertCheck('2 审批', '批准后卡片消失', (await page.locator('[data-testid="assistant-approval-card"]').count()) === 0, '');

  const rejectPrompt = p4Prompt('验收闸门 2：删除另一个文件。 ROC-P4-MODE:approval ROC-P4-DELETE:/workspace/p4-approval-reject.txt');
  await sendPrompt(page, rejectPrompt);
  await waitForStatus(page, 'waiting_user', 60_000);
  await revealLatestTranscript(page);
  const rejectCardVisible = await page.waitForSelector('[data-testid="assistant-approval-card"]', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!rejectCardVisible) {
    const rejectionState = await page.evaluate(async ({ activeThreadId }) => {
      const active = await window.roc.chat.getActiveRun({ threadId: activeThreadId });
      const runId = active.ok ? active.data?.runId ?? null : null;
      const replay = runId === null ? null : await window.roc.chat.getRunEvents({ runId, afterSequence: 0 });
      return {
        runId,
        status: document.querySelector('[data-testid="assistant-run-status"]')?.getAttribute('data-status') ?? null,
        error: document.querySelector('[data-testid="assistant-errors"]')?.textContent?.trim() ?? null,
        active: active.ok ? active.data : active.error.message,
        events: replay?.ok ? replay.data.events.map((entry) => entry.event.type === 'run_failed'
          ? `run_failed:${entry.event.code}` : entry.event.type) : replay?.error.message ?? [],
        approvalCards: [...document.querySelectorAll('[data-testid*="approval"], [data-testid*="interrupt"]')]
          .map((node) => node.getAttribute('data-testid')),
        transcript: document.querySelector('[data-testid="assistant-transcript"]')?.textContent?.slice(-800) ?? null
      };
    }, { activeThreadId: threadId });
    const matchingRequests = smokeProvider.requests.filter((request) =>
      JSON.stringify(request.body?.messages ?? []).includes(rejectPrompt.split(' ROC-P4-RUN:')[1] ?? '__missing__')
    ).length;
    await page.screenshot({ path: join(artifactDir, '02-approval-reject-missing.png') });
    fail('2 审批', '拒绝场景显示审批卡', JSON.stringify({ rejectPrompt, matchingRequests, ...rejectionState }));
  }
  await page.click('[data-testid="assistant-approval-reject"]');
  await waitForStatus(page, 'completed', 90_000);
  const rejectOutcome = await waitForTranscript(page, 'P4-APPROVAL-DONE', 30_000);
  assertCheck('2 审批', '拒绝后 run 按后端语义结束（completed + 结束段）', rejectOutcome.includes('P4-APPROVAL-DONE'), '');
  assertCheck('2 审批', '拒绝后文件仍在（决定真的被遵守）', existsSync(rejectTarget), 'p4-approval-reject.txt 仍存在');
  assertCheck('2 审批', '拒绝后卡片消失', (await page.locator('[data-testid="assistant-approval-card"]').count()) === 0, '');

  // ---- 闸门 3：提问中断 → 回答后续跑 -------------------------------------------
  await sendPrompt(page, p4Prompt('验收闸门 3：先问一个问题。 ROC-P4-MODE:question'));
  await waitForStatus(page, 'waiting_user', 60_000);
  await revealLatestTranscript(page);
  await page.waitForSelector('[data-testid="assistant-question-card"]', { timeout: 20_000 });
  const questionText = (await page.locator('[data-testid="assistant-question-card"]').textContent()) ?? '';
  assertCheck('3 提问', '提问卡显示问题与候选回答', questionText.includes('这次运行要按哪个口径继续？') && questionText.includes('按最小范围继续'), '');
  await page.waitForSelector('[data-testid="assistant-waiting-note"]', { timeout: 10_000 });
  assertCheck('3 提问', '提问中断期间输入区可用', !(await page.locator('[data-testid="assistant-composer-input"]').isDisabled()), '');
  const sendLabel = (await page.locator('[data-testid="assistant-composer-send"]').textContent()) ?? '';
  assertCheck('3 提问', '提交按钮变为「回复」', sendLabel.includes('回复'), sendLabel.trim());
  assertCheck('3 提问', '提问期间不显示停止按钮', (await page.locator('[data-testid="assistant-composer-stop"]').count()) === 0, '');
  await page.screenshot({ path: join(artifactDir, '03-question-card.png') });

  await sendPrompt(page, '按最小范围继续');
  await waitForStatus(page, 'completed', 90_000);
  const answerEcho = await waitForTranscript(page, 'P4-QUESTION-ANSWER', 20_000);
  assertCheck(
    '3 提问',
    '回答经 resumeRun(question) 回到模型（结束段回显回答）',
    answerEcho.includes('P4-QUESTION-ANSWER:按最小范围继续'),
    ''
  );

  // ---- 闸门 4：取消运行 ---------------------------------------------------------
  await sendPrompt(page, p4Prompt('验收闸门 4：慢流。 ROC-P4-MODE:slow ROC-P4-SLOW:400x100 ROC-P4-SLOW-TAG:G4S'));
  await waitForStatus(page, 'running', 30_000);
  await page.waitForSelector('[data-testid="assistant-composer-stop"]', { timeout: 20_000 });
  await waitForTranscript(page, 'G4S-0005', 30_000);
  assertCheck('4 取消', '运行中显示停止按钮且输入区锁定', await page.locator('[data-testid="assistant-composer-input"]').isDisabled(), '');
  await page.click('[data-testid="assistant-composer-stop"]');
  await waitForStatus(page, 'cancelled', 60_000);
  assertCheck('4 取消', 'run_cancelled 后状态为已取消', (await currentStatus(page)) === 'cancelled', '');
  assertCheck('4 取消', '取消后停止按钮消失', (await page.locator('[data-testid="assistant-composer-stop"]').count()) === 0, '');
  assertCheck('4 取消', '取消后输入区回到可用', !(await page.locator('[data-testid="assistant-composer-input"]').isDisabled()), '');

  await sendPrompt(page, p4Prompt('验收闸门 4：取消后还能继续提交。 ROC-P4-MODE:many'));
  await waitForStatus(page, 'completed', 60_000);
  assertCheck('4 取消', '取消后可以再发一轮并跑完', (await currentStatus(page)) === 'completed', '');

  // ---- 闸门 5：关面板 / 切项目后恢复 -------------------------------------------
  await sendPrompt(page, p4Prompt('验收闸门 5：慢流，关掉面板再回来。 ROC-P4-MODE:slow ROC-P4-SLOW:400x100 ROC-P4-SLOW-TAG:G5S'));
  await waitForStatus(page, 'running', 30_000);
  await waitForTranscript(page, 'G5S-0008', 30_000);
  const beforeClose = await transcriptText(page);
  assertCheck('5 恢复', '运行中出现流式内容', beforeClose.includes('G5S-'), '');

  await page.click('[data-testid="titlebar-toggle-assistant"]');
  await page.waitForSelector('[data-testid="assistant-panel"]', { state: 'detached', timeout: 10_000 });
  assertCheck('5 恢复', '关闭助手面板后组件真的卸载', (await page.locator('[data-testid="assistant-panel"]').count()) === 0, '');
  await page.waitForTimeout(1_500);
  await page.click('[data-testid="titlebar-toggle-assistant"]');
  await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 20_000 });
  await waitForStatus(page, 'running', 30_000);
  const afterReopen = await waitForTranscript(page, 'G5S-0003', 30_000);
  assertCheck(
    '5 恢复',
    '重开后进行中的 run 恢复运行态（runId 只能来自 chat.getActiveRun + 事件回放）',
    (await currentStatus(page)) === 'running',
    `status=${await currentStatus(page)}`
  );
  assertCheck('5 恢复', '重开后转录含关闭前已产生的内容', afterReopen.includes('G5S-0003'), '');

  const secondProject = await page.evaluate(
    async ({ workspacePath }) =>
      await window.roc.research.createProject({
        title: 'P4 gate project two',
        description: 'Second project for the P4 project-switch gate.',
        workspacePath
      }),
    { workspacePath: remoteRoot }
  );
  if (!secondProject.ok) {
    fail('5 恢复', '创建项目 2', secondProject.error.message);
  }
  await navigate(page, `page=research&project=${secondProject.data.id}&view=latex&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 20_000 });
  await page.waitForTimeout(500);
  // 切项目会清空 threadId，所以“看不到转录”必须是**主动**结果：助手还在、输入区可用、
  // 且面板处于“还没选会话”的空态，而不是面板根本不在。
  const emptyStateText = (await page.locator('[data-testid="assistant-transcript"]').count()) === 0
    ? ''
    : ((await page.locator('[data-testid="assistant-transcript"]').textContent()) ?? '');
  assertCheck(
    '5 恢复',
    '切到另一个项目后不显示上一个项目的会话转录',
    (await page.locator('[data-testid="assistant-composer-input"]').count()) === 1 &&
      !emptyStateText.includes('G5S'),
    emptyStateText.trim().slice(0, 80)
  );
  await page.click('[data-testid="sidebar-tab-sessions"]');
  const listedInSecondProject = await describeSessionList(page, threadId);
  await navigate(page, `page=research&project=${projectId}&view=latex&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 20_000 });
  await page.click('[data-testid="sidebar-tab-sessions"]');
  await waitForSessionRow(page, threadId, '5 恢复');
  await page.click(`[data-testid="session-row-${threadId}"]`);
  await waitForStatus(page, 'running', 30_000);
  const afterSwitchBack = await waitForTranscript(page, 'G5S-0003', 30_000);
  assertCheck(
    '5 恢复',
    '切项目再回来后重新选会话，run 与转录一起恢复',
    afterSwitchBack.includes('G5S-0003') && (await currentStatus(page)) === 'running',
    `status=${await currentStatus(page)}；另一个项目的会话列表：${listedInSecondProject}`
  );

  await waitForStatus(page, 'completed', 120_000);
  const afterComplete = await transcriptText(page);
  assertCheck('5 恢复', '慢流跑完后转录保留完整内容', afterComplete.includes('G5S-0400'), '');
  await page.screenshot({ path: join(artifactDir, '05-restored-run.png') });

  // ---- 闸门 5：真实进程崩溃后从工具检查点续跑 -------------------------------
  await verifyCrashCheckpointResume(threadId, projectId);

  // ---- 闸门 6：500 条消息时虚拟化仍生效 ----------------------------------------
  await navigate(page, `page=research&project=${projectId}&view=latex&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 20_000 });
  const seeding = await seedManyRuns(page, { threadId, projectId, workspacePath: workspaceRoot, runs: gate6Runs });
  assertCheck(
    '6 虚拟化',
    `会话累积到 ${gate6TargetMessages} 条消息（${seeding.runs} 轮 run）`,
    seeding.totalMessages >= gate6TargetMessages,
    `messages=${seeding.totalMessages}（user=${seeding.userMessages} + assistant=${seeding.assistantMessages}）` +
      ` events=${seeding.events} pages=${seeding.pages} elapsed=${seeding.elapsedMs} ms`
  );

  await page.click('[data-testid="sidebar-tab-sessions"]');
  await waitForSessionRow(page, threadId, '6 虚拟化');
  await page.click(`[data-testid="session-row-${threadId}"]`);
  await page.waitForSelector('[data-testid="assistant-transcript"]', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="assistant-transcript"]');
    return node !== null && Number.parseInt(node.getAttribute('data-message-count') ?? '0', 10) > 0;
  }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  const windowMessages = Number.parseInt(
    (await page.getAttribute('[data-testid="assistant-transcript"]', 'data-message-count')) ?? '0',
    10
  );
  const renderedRows = await page.locator('[data-testid^="assistant-message-"]').count();
  // `windowMessages >= 40` is a floor, not a target: it must be comfortably larger than what the
  // viewport can display, otherwise “rows < window” could hold because the window was tiny
  // rather than because the list is virtualised. Measured acceptance run: window=134 rows=27.
  assertCheck(
    '6 虚拟化',
    '转录窗口里持有的消息数远大于同时渲染的 DOM 行数',
    windowMessages >= 40 && renderedRows > 0 && renderedRows < windowMessages,
    `window=${windowMessages} rows=${renderedRows}`
  );
  // 这条是**既定设计的偏离**（登记在 `phases/P4-assistant.md` 的偏离表）：会话继续增长时，
  // 转录窗口按**事件数**（`maxRetainedPersistedEvents = 400`）保留，而不是把 500 条全挂在树上；
  // 更早的消息仍可向上分页取回（闸门 5）。所以 window 必须 < 总消息数，否则“窗口”名不副实。
  assertCheck(
    '6 虚拟化',
    '窗口有界（回放窗口按事件数保留，不随会话无限增长）',
    windowMessages < gate6TargetMessages && windowMessages < seeding.totalMessages,
    `window=${windowMessages} < total=${seeding.totalMessages}（< ${gate6TargetMessages}）`
  );
  // 交互仍可用：输入框能接受输入、滚动不报错。
  await page.fill('[data-testid="assistant-composer-input"]', '闸门 6 期间输入仍然可用');
  assertCheck(
    '6 虚拟化',
    '大历史下输入区仍可交互',
    (await page.inputValue('[data-testid="assistant-composer-input"]')) === '闸门 6 期间输入仍然可用',
    ''
  );
  await page.fill('[data-testid="assistant-composer-input"]', '');
  const rowsBeforeWheel = await page.locator('[data-testid^="assistant-message-"]').count();
  // 真滚一下：光标先移到转录上（`wheel` 只作用于光标下的元素），上滚后「回到最新」按钮是
  // 一个**可观察**的状态（`atBottomStateChange`），比“那个 div 还在不在”有意义得多。
  await page.locator('[data-testid="assistant-transcript-host"]').hover();
  await page.mouse.wheel(0, -4000);
  const scrollBottomAppeared = await page
    .waitForSelector('[data-testid="assistant-scroll-bottom"]', { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  const rowsAfterWheel = await page.locator('[data-testid^="assistant-message-"]').count();
  assertCheck(
    '6 虚拟化',
    '大历史下滚动仍可用（上滚后出现「回到最新」）',
    scrollBottomAppeared && rowsAfterWheel > 0,
    `rows ${rowsBeforeWheel} → ${rowsAfterWheel}，window=${windowMessages}，scroll-bottom=${String(scrollBottomAppeared)}`
  );
  if (scrollBottomAppeared) {
    await page.click('[data-testid="assistant-scroll-bottom"]');
    await page.waitForTimeout(400);
    assertCheck(
      '6 虚拟化',
      '「回到最新」能回到尾端（按钮随之消失）',
      (await page.locator('[data-testid="assistant-scroll-bottom"]').count()) === 0,
      ''
    );
  }
  await page.screenshot({ path: join(artifactDir, '06-virtualized.png') });

  // ---- 闸门 7：无假流式代码残留 ------------------------------------------------
  const assistantTimerHits = [];
  for (const file of listSourceFiles('src/renderer/assistant')) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/setInterval|setTimeout/u.test(line)) {
        assistantTimerHits.push(`${file}:${index + 1}`);
      }
    });
  }
  const allowedTimerFiles = ['blocks/use-activity-block-state.ts'];
  const unexpectedTimerHits = assistantTimerHits.filter(
    (hit) => !allowedTimerFiles.some((allowed) => hit.includes(allowed))
  );
  assertCheck(
    '7 无假流式',
    'assistant/ 下只有 activity 块的 1s 自动收起在用定时器',
    unexpectedTimerHits.length === 0,
    unexpectedTimerHits.length === 0 ? assistantTimerHits.join(', ') : unexpectedTimerHits.join(', ')
  );

  const objectUrlHits = [];
  for (const file of listSourceFiles('src/renderer')) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/URL\.createObjectURL\s*\(/u.test(code)) {
      objectUrlHits.push(file);
    }
  }
  assertCheck('7 无假流式', 'renderer 代码里没有 Blob URL（R9）', objectUrlHits.length === 0, objectUrlHits.join(', '));

  // ---- 闸门 8：typecheck -------------------------------------------------------
  const typecheck = spawnSync('pnpm', ['typecheck'], { cwd: resolve('.'), encoding: 'utf8' });
  assertCheck(
    '8 typecheck',
    'pnpm typecheck 通过',
    typecheck.status === 0,
    (typecheck.stdout ?? '').trim().slice(0, 200)
  );

  assertCheck('0 健康', '整轮流程没有 renderer 错误', rendererErrors.length === 0, rendererErrors.slice(0, 2).join(' | '));

  finishGate({
    label: 'P4',
    artifactDir,
    results,
    rendererErrors,
    extra: { gate6: seeding, providerRequests: smokeProvider.requests.length },
    // 声明的闸门段落。跑到少一段就是失败。
    expectedGates: [
      '0 启动',
      '0 准备',
      '0 健康',
      '1 真跑一轮',
      '2 审批',
      '3 提问',
      '4 取消',
      '5 恢复',
      '6 头部',
      '6 虚拟化',
      '7 无假流式',
      '8 typecheck'
    ]
  });
} catch (error) {
  if (!restartOnlyFinished) finishGate({ label: 'P4', artifactDir, results, rendererErrors, error });
} finally {
  if (app !== undefined) {
    await app.close();
  }
  await smokeProvider.close();
  if (process.env.P4_KEEP_DATA_ON_FAILURE === '1' && process.exitCode !== 0) {
    console.error(`保留失败诊断数据：${dataRoot}`);
  } else {
    rmSync(dataRoot, { recursive: true, force: true });
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(skillSourceRoot, { recursive: true, force: true });
  rmSync(remoteRoot, { recursive: true, force: true });
}

/**
 * Gate 6 seeding: start `runs` scripted runs on one thread and wait for each to finish.
 *
 * Completion is observed on the page's own `chat.onRunEvent` stream rather than by polling
 * `getActiveRun` per run: polling would add an IPC round trip per iteration to a loop that is
 * already the slowest part of the harness.
 */
async function seedManyRuns(page, { threadId, projectId, workspacePath, runs }) {
  const startedAt = Date.now();
  for (let index = 1; index <= runs; index += 1) {
    const started = await page.evaluate(
      async ({ input, mode, threadId: thread, projectId: project, workspacePath: workspace }) => {
        const result = await window.roc.chat.startRun({
          input,
          mode,
          threadId: thread,
          researchProjectId: project,
          workspacePath: workspace,
          enabledCapabilities: { mcpServers: [], skills: [] }
        });
        return result.ok ? { runId: result.data.runId } : { error: result.error.message };
      },
      {
        input: p4Prompt(`闸门 6 第 ${index} 轮 ROC-P4-MODE:many`),
        mode: 'chat',
        threadId,
        projectId,
        workspacePath
      }
    );
    if (started.error !== undefined) {
      throw new Error(`gate 6 run ${index} failed to start: ${started.error}`);
    }
    await page.waitForFunction((runId) => window.__p4FinishedRuns.includes(runId), started.runId, {
      timeout: 60_000,
      polling: 50
    });
    if (index % 25 === 0) {
      console.log(`   … 闸门 6 已跑 ${index}/${runs} 轮，用时 ${Date.now() - startedAt} ms`);
    }
  }
  const counted = await page.evaluate(async ({ threadId: thread }) => {
    // 分页方向很关键：`cursor: null` 返回的是**最新**一页，所以只能往更早的方向翻
    // （`direction: 'before'` + `oldestSequence`），翻到 `hasMoreBefore === false` 为止。
    // 早先的版本从这里接着用 `direction: 'after'`，而最新一页之后本就没有事件，
    // 于是循环在第一页之后立刻 break —— 统计窗口永远只有那 200 条，看不到整条会话。
    let cursor = null;
    let pages = 0;
    let events = 0;
    let oldestSeen = null;
    const eventTypes = {};
    const userMessageEvents = [];
    const runsWithAssistantMessage = new Set();
    for (;;) {
      const result = await window.roc.tasks.getThreadMessages({ threadId: thread, limit: 200, cursor });
      if (!result.ok) {
        return { error: result.error.message };
      }
      const page = result.data;
      pages += 1;
      for (const event of page.items) {
        events += 1;
        eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
        if (event.type === 'message' && event.payload !== undefined) {
          if (event.payload.role === 'user') {
            userMessageEvents.push(event.runId);
          } else if (event.payload.role === 'assistant') {
            runsWithAssistantMessage.add(event.runId);
          }
        }
      }
      if (!page.hasMoreBefore) {
        return {
          pages,
          events,
          eventTypes,
          // 与 `buildPersistedTranscriptMessages` 同口径：一条 user 消息事件 = 一条转录消息；
          // 每轮 run 的 assistant 侧合并成**一条**消息草稿。
          userMessages: userMessageEvents.length,
          assistantMessages: runsWithAssistantMessage.size,
          totalMessages: userMessageEvents.length + runsWithAssistantMessage.size,
          runs: new Set([...userMessageEvents, ...runsWithAssistantMessage]).size
        };
      }
      if (page.oldestSequence === null) {
        return { error: 'page reported more older events but returned no items' };
      }
      // 自证：游标必须严格朝更早的方向前进，否则这次统计本身就是错的。
      if (oldestSeen !== null && page.oldestSequence >= oldestSeen) {
        return { error: `before-cursor did not advance: ${page.oldestSequence} >= ${oldestSeen}` };
      }
      oldestSeen = page.oldestSequence;
      cursor = { direction: 'before', sequence: page.oldestSequence };
      if (pages > 500) {
        return { error: `pagination did not terminate after ${pages} pages` };
      }
    }
  }, { threadId });
  if (counted.error !== undefined) {
    throw new Error(`gate 6 could not page the thread history: ${counted.error}`);
  }
  return {
    requestedRuns: runs,
    runs: counted.runs,
    events: counted.events,
    pages: counted.pages,
    userMessages: counted.userMessages,
    assistantMessages: counted.assistantMessages,
    // 消息数从**持久化消息事件**数出来，不是 runs × 2 推出来的：这样闸门断言自证。
    totalMessages: counted.totalMessages,
    eventTypes: counted.eventTypes,
    elapsedMs: Date.now() - startedAt
  };
}
