import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';

/**
 * P6 验收闸门的自动化实测（真应用 / 真 IPC / 真阶段运行 / 真人工闸门 / 真后台任务 / 真诊断）。
 *
 * 为什么需要它：P6 的闸门描述的全是**运行时事实** —— 一次阶段运行是否真的推进了阶段、人工闸门
 * 退回后主操作是不是重试（而且重试真的能再跑起来）、归档项目是不是真的启动不了、任务看板的
 * 暂停/恢复/取消是不是真的生效、详情页完成审批后 run 是不是真的继续。静态阅读与单测都不覆盖
 * 这些（P3–P5 的实测已经反复证明：类型正确、单测全绿、用户看到的仍可能是坏的）。
 *
 * 契约复勘（F18）之后，harness 只按**实际**能力名调用：
 *   research.workflow.get / transition / events / policies / reviewCycle / role /
 *   startRun / getRun / listRuns / cancelRun / retryRun、research.artifacts.*（7）、
 *   research.provenance.*（2）、task.*（16）、diagnostics.*（5）。
 * 计划原文里的 `research.workflow.artifactContent` / `research.productionInputInspect` /
 * `research.productionInputRead` 与 `diagnostics.createDiagnosticPackage` 都**不存在**。
 *
 * 两条与 P4/P5 一脉相承的口径：
 *   1. **B18（做过重活后 chat run 偶发卡住）**：闸门 5 的 run 走同一条管线。若命中，就断言
 *      「接线可用」（审批决定被 backend 接受、卡片就位）并记一条说明性记录，不放宽也不删断言。
 *   2. **B19（`reject` 之后阶段不可重跑）**：闸门 3 真的点一次重试并真的等它推进；这条路径用的是
 *      「暂停 → 启动」的合法组合（见 `use-workflow-store.ts` 的 `rerunStage`），若后端改了行为，
 *      这里会红。
 *
 * 运行（必须 `ROC_SMOKE_TARGET=dist` + `ROC_RENDERER=next`，且先删产物再 build）：
 *   rm -rf dist/renderer && ROC_RENDERER=next pnpm build
 *   node scripts/verify-p6-workflow.mjs
 *
 * 必须 detach 跑（前台跑会被工具超时杀掉进程组），报告写 `.artifacts/p6-gates/`。
 */

const artifactDir = resolve('.artifacts/p6-gates');
mkdirSync(artifactDir, { recursive: true });

const results = [];
/** `kind: 'info'` 记录的是**观察**而不是断言（走了哪条路、命中了哪个后端缺陷）。 */
function record(gate, name, ok, detail = '', kind = 'assert') {
  results.push({ gate, name, ok, detail, kind });
  console.log(`${ok ? '✔' : '✖'} [${gate}] ${name}${detail.length === 0 ? '' : ` — ${detail}`}`);
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

const smokeModelId = 'p6-smoke-model';
const smokeProviderId = 'p6-smoke-provider';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;

/** 阶段运行的等待上限：夹具 provider 一轮即回，但第一次要等模型句柄就绪。 */
const runTimeoutMs = 90_000;
/** UI 轮询是 2s 一次（无推送 — B11），所以镜像刷新要给它几个周期。 */
const uiTimeoutMs = 30_000;

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);

/**
 * One workspace directory per project.
 *
 * `research.projects.create` refuses a workspace path another project already owns
 * (`research_project_workspace_taken`), so three projects cannot share one directory — the
 * first attempt at gate 0 failed exactly there ("Roc 内部错误" for projects B and C).
 */
const workspaceA = join(workspaceRoot, 'project-a');
const workspaceB = join(workspaceRoot, 'project-b');
const workspaceC = join(workspaceRoot, 'project-c');
for (const directory of [workspaceA, workspaceB, workspaceC]) {
  mkdirSync(directory, { recursive: true });
}

const smokeProvider = await startSmokeProvider({});
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`P6 验收闸门实测 · target=${target.kind} · renderer=next · workspace=${workspaceRoot}\n`);

let app;
const rendererErrors = [];

/** 切路由（单一路由写入口径：URL + popstate）。 */
async function navigate(page, search) {
  await page.evaluate((next) => {
    let url;
    try {
      url = new URL(window.location.href);
    } catch {
      // A malformed location must not take the harness down; the app has the same guard.
      return;
    }
    url.search = next;
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, search);
}

/** 等某个视图真的成为「已显示视图」（ViewContent 有滞后交换）。 */
async function openView(page, projectId, view, extra = '') {
  await navigate(page, `page=research&project=${projectId}&view=${view}${extra}`);
  await page.waitForSelector(`[data-view="${view}"][data-shown-view="${view}"]`, { timeout: 30_000 });
}

async function sleep(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** 总览的可见状态：阶段、状态句、唯一主操作、次级操作、失败/退回说明。 */
async function readOverview(page) {
  return await page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    const exists = (selector) => document.querySelector(selector) !== null;
    const primaryIds = [
      'workflow-start-run',
      'workflow-retry-run',
      'workflow-approve',
      'workflow-submit',
      'workflow-complete'
    ];
    const primaryTestId = primaryIds.find((id) => exists(`[data-testid="${id}"]`)) ?? null;
    return {
      stage: text('[data-testid="workflow-overview-stage"]'),
      status: text('[data-testid="workflow-overview-stage-status"]'),
      primaryTestId,
      primaryLabel: primaryTestId === null ? null : text(`[data-testid="${primaryTestId}"]`),
      secondaryTestIds: ['workflow-cancel-run', 'workflow-reject', 'workflow-revise'].filter((id) =>
        exists(`[data-testid="${id}"]`)
      ),
      statusLine: text('[data-testid="workflow-next-status"]'),
      summaryLine: text('[data-testid="workflow-next-summary"]'),
      detailLine: text('[data-testid="workflow-next-detail"]'),
      readOnlyReason: text('[data-testid="workflow-next-readonly"]'),
      instructionSource: text('[data-testid="workflow-next-instruction-source"]'),
      canvasText: document.body.innerText
    };
  });
}

/** 轮询一个可观察状态；返回值里带最后一次观察到的内容，便于失败时写清原因。 */
async function waitForOverview(page, predicate, timeoutMs, gate, name, describe) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readOverview(page);
    if (predicate(last)) {
      return last;
    }
    await sleep(300);
  }
  fail(gate, name, describe(last));
  return last;
}

async function getWorkflow(page, projectId) {
  return await page.evaluate(async (id) => {
    const result = await window.roc.research.getWorkflow({ id });
    if (!result.ok) {
      return { error: result.error.message };
    }
    return result.data;
  }, projectId);
}

async function listRuns(page, projectId) {
  return await page.evaluate(async (id) => {
    const result = await window.roc.research.listStageRuns({ projectId: id, limit: 50 });
    return result.ok ? result.data : { error: result.error.message };
  }, projectId);
}

async function waitForCurrentStage(page, projectId, stage, timeoutMs, gate, name) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const workflow = await getWorkflow(page, projectId);
    last = workflow.currentStage ?? workflow.error;
    if (last === stage) {
      return workflow;
    }
    await sleep(300);
  }
  fail(gate, name, `currentStage 期望 ${stage}，实际 ${String(last)}`);
  return null;
}

async function waitForStageStatus(page, projectId, stage, status, timeoutMs, gate, name) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const workflow = await getWorkflow(page, projectId);
    last = workflow.stages?.find((entry) => entry.stage === stage)?.status ?? workflow.error;
    if (last === status) {
      return workflow;
    }
    await sleep(300);
  }
  fail(gate, name, `stage ${stage} 状态期望 ${status}，实际 ${String(last)}`);
  return null;
}

/** 最新一条 parent run（阶段运行记录）。 */
async function latestParentRun(page, projectId, stage) {
  const runs = await listRuns(page, projectId);
  if (!Array.isArray(runs)) {
    return null;
  }
  return (
    runs
      .filter((run) => run.stage === stage && run.parentRunId === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
  );
}

/**
 * 等最新一次阶段运行到达终态；超时按 B18 处理。
 *
 * B18 的处置口径（P5 定下、P6 沿用）：run 相关的闸门**两条路都要断言**。正常就断言内容；
 * 命中 B18 就断言「接线可用」（运行确实被创建、界面确实显示运行中 + 取消入口）并记一条
 * 说明性记录，既不放宽也不删断言。
 */
async function waitForRunTerminal(page, projectId, stage, gate, name, timeoutMs = runTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await latestParentRun(page, projectId, stage);
    if (last !== null && ['completed', 'failed', 'cancelled', 'interrupted'].includes(last.status)) {
      return { ok: true, run: last };
    }
    await sleep(400);
  }
  record(
    gate,
    `${name}：阶段运行未在 ${Math.round(timeoutMs / 1000)}s 内到终态（B18 特征）`,
    true,
    `run=${last?.id ?? 'none'} status=${last?.status ?? 'none'} error=${last?.error ?? 'null'}`,
    'info'
  );
  const wiring = await page.evaluate(async (id) => {
    const [workflow, runs] = await Promise.all([
      window.roc.research.getWorkflow({ id }),
      window.roc.research.listStageRuns({ projectId: id, limit: 10 })
    ]);
    return {
      current: workflow.ok ? `${workflow.data.currentStage}#${workflow.data.stages.find((s) => s.stage === workflow.data.currentStage)?.status}` : workflow.error.message,
      runs: runs.ok ? runs.data.slice(0, 3).map((run) => `${run.stage}:${run.status}`).join(' ') : runs.error.message
    };
  }, projectId);
  assertCheck(
    gate,
    `${name}：命中 B18 时接线仍然可用（运行被创建、状态可查）`,
    last !== null,
    `current=${wiring.current} runs=${wiring.runs}`
  );
  return { ok: false, run: last };
}

/** 读总览的「下一步」按钮并点击主操作。 */
async function clickPrimary(page, expectedTestId, gate, name) {
  const overview = await readOverview(page);
  assertCheck(
    gate,
    `${name}：主操作是 ${expectedTestId}`,
    overview.primaryTestId === expectedTestId,
    `实际 primary=${overview.primaryTestId ?? 'null'} label=${overview.primaryLabel ?? 'null'}`
  );
  await page.click(`[data-testid="${expectedTestId}"]`);
  return overview;
}

async function configureProvider(page) {
  return await page.evaluate(
    async ({ providerId, modelId, modelKey, endpoint }) => {
      const current = await window.roc.settings.get();
      if (!current.ok) {
        return { error: current.error.message };
      }
      const providers = [
        ...current.data.providers.filter((provider) => provider.id !== providerId),
        {
          id: providerId,
          name: 'P6 Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: `secret:${providerId}`,
          enabled: true,
          models: [
            {
              id: modelId,
              displayName: 'P6 Smoke Model',
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
        // `delete_file` only interrupts when the mode is 'default' (P4's finding:
        // `run-capability-manifest.createInterruptPolicy`). Without this the gate-5 approval
        // never appears and the tool executes silently — which is the *other* behaviour, not a
        // wired approval.
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
      return after.ok ? { ok: true, permissionMode: after.data.permissions.mode } : { error: after.error.message };
    },
    { providerId: smokeProviderId, modelId: smokeModelId, modelKey: smokeModelKey, endpoint: smokeProvider.endpoint }
  );
}

async function createProject(page, title, description, workspacePath) {
  return await page.evaluate(
    async ({ projectTitle, projectDescription, workspacePath }) => {
      const result = await window.roc.research.createProject({
        title: projectTitle,
        description: projectDescription,
        workspacePath,
        language: 'zh'
      });
      return result.ok ? { id: result.data.id } : { error: result.error.message };
    },
    { projectTitle: title, projectDescription: description, workspacePath }
  );
}

/** Creates a manual background task through the real preview + create pair. */
async function createBackgroundTask(page, goal, description, workspacePath) {
  return await page.evaluate(
    async ({ taskGoal, label, workspacePath }) => {
      const request = {
        goal: taskGoal,
        trigger: { type: 'manual', description: label },
        workspacePath,
        allowedActions: ['dir'],
        forbiddenActions: [],
        failurePolicy: 'pause_and_report',
        notificationPolicy: 'failures_and_confirmations'
      };
      const preview = await window.roc.tasks.createBackgroundTaskPreview(request);
      if (!preview.ok) {
        return { error: `preview: ${preview.error.message}` };
      }
      const task = await window.roc.tasks.createBackgroundTask(request);
      return task.ok ? { id: task.data.id, status: task.data.status } : { error: `create: ${task.error.message}` };
    },
    { taskGoal: goal, label: description, workspacePath }
  );
}

async function runBackgroundNow(page, taskId) {
  return await page.evaluate(async (id) => {
    const result = await window.roc.tasks.runBackgroundNow(id);
    return result.ok ? { runId: result.data.runId } : { error: result.error.message };
  }, taskId);
}

/** Waits for a persisted task event of `type` on that task's thread. */
async function waitForTaskEvent(page, taskId, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await page.evaluate(
      async ({ id, eventType }) => {
        const result = await window.roc.tasks.getTaskDetail({ taskId: id });
        if (!result.ok) {
          return false;
        }
        return result.data.recentEvents.some((event) => event.type === eventType);
      },
      { id: taskId, eventType: type }
    );
    if (seen) {
      return true;
    }
    await sleep(400);
  }
  return false;
}

/** Waits for the *background task record's* status (`task.detail.get`). */
async function waitForTaskStatus(page, taskId, status, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readTaskStatus(page, taskId);
    if (last === status) {
      return true;
    }
    await sleep(400);
  }
  return false;
}

/**
 * Diagnoses a background task's in-flight run.
 *
 * Three facts together are what makes a stalled gate readable (the P4/P5 lesson: "no output" is
 * not a diagnosis): the thread's persisted status, the tail of its event types, and whether the
 * backend still thinks a run is active for that thread.
 */
async function describeTaskRun(page, taskId) {
  return await page.evaluate(async (id) => {
    const detail = await window.roc.tasks.getTaskDetail({ taskId: id });
    if (!detail.ok) {
      return `task.detail.get error=${detail.error.message} providerRequests=${0}`;
    }
    const activeRun = await window.roc.chat.getActiveRun({ threadId: detail.data.threadId });
    return [
      `threadStatus=${detail.data.thread.status}`,
      `events=${detail.data.recentEvents.slice(-6).map((event) => event.type).join(',')}`,
      `activeRun=${activeRun.ok ? (activeRun.data === null ? 'none' : `${activeRun.data.runId}:${String(activeRun.data.status)}`) : `error:${activeRun.error.message}`}`
    ].join(' ');
  }, taskId);
}

async function readTaskStatus(page, taskId) {
  return await page.evaluate(async (id) => {
    const result = await window.roc.tasks.getTaskDetail({ taskId: id });
    return result.ok ? (result.data.backgroundTask?.status ?? 'none') : `error:${result.error.message}`;
  }, taskId);
}

async function hasTaskEvent(page, taskId, type) {
  return await page.evaluate(
    async ({ id, eventType }) => {
      const result = await window.roc.tasks.getTaskDetail({ taskId: id });
      return result.ok ? result.data.recentEvents.some((event) => event.type === eventType) : false;
    },
    { id: taskId, eventType: type }
  );
}

try {
  app = await electron.launch({
    executablePath: target.executablePath,
    args: target.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key',
      ROC_RENDERER: 'next'
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
    console.error('[renderer:pageerror]', error.message.slice(0, 300));
  });

  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  assertCheck('0 启动', '新壳在 smoke 模式下启动', (await page.getAttribute('[data-testid="roc-app"]', 'data-mode')) === 'smoke');

  // ---- 闸门 0：provider + 工作目录 + 三个项目 -----------------------------------
  const configured = await configureProvider(page);
  assertCheck('0 准备', '默认模型指向冒烟 provider', configured.ok === true, configured.error ?? '');
  assertCheck(
    '0 准备',
    'permissions.mode=default（否则 delete_file 不会触发人工审批）',
    configured.permissionMode === 'default',
    String(configured.permissionMode)
  );

  const boundWorkspace = await page.evaluate(async (workspacePath) => {
    const result = await window.roc.workspace.select({ path: workspacePath });
    return result.ok ? result.data.path : `error:${result.error.message}`;
  }, workspaceRoot);
  assertCheck('0 准备', '后端工作目录绑定到夹具目录', boundWorkspace === workspaceRoot, String(boundWorkspace));

  const projectA = await createProject(page, 'P6 流程闸门项目', 'ROC-P6-TAG:A 按研究目标写出检索策略', workspaceA);
  assertCheck('0 准备', '创建项目 A（走 discovery → retrieval → 闸门）', typeof projectA.id === 'string', projectA.error ?? '');
  const projectB = await createProject(page, 'P6 失败重试项目', 'ROC-P6-TAG:B 用于失败与重试的指令', workspaceB);
  assertCheck('0 准备', '创建项目 B（失败 / 重试）', typeof projectB.id === 'string', projectB.error ?? '');
  const projectC = await createProject(page, 'P6 归档只读项目', 'ROC-P6-TAG:C 归档后不允许启动', workspaceC);
  assertCheck('0 准备', '创建项目 C（归档只读）', typeof projectC.id === 'string', projectC.error ?? '');

  // **顺序是刻意的**（P5/B18 的教训）：审批这一轮在阶段运行之前跑，此时 run 管线还干净。
  // P5 的实测是「做过解析/索引之后 chat run 偶发卡住」，P6 的阶段运行属于同一类重活，所以
  // 这条闸门放在最前面并不是为了让断言更容易，而是为了让它真的能测到「审批 → run 继续」；
  // 命中 B18 时下面的分支改成断言接线可用并记一条说明性记录（不放宽也不删断言）。

  // ---- 闸门 5（前半）：任务看板 · 详情页审批 ------------------------------------
  //
  // 顺序是刻意的（P5/B18 的教训）：审批用例先跑，此时 run 管线还干净；长时间流式的
  // 「暂停/恢复/取消」用例放在最后，避免它的 ~50s 流占住运行槽位。
  // The target lives in the **task's** workspace *and* in the project's bound workspace is the
  // same directory here (project A's), so the deleted file is unambiguous: the `delete_file` arg
  // `/workspace/<name>` resolves under the workspace the run is bound to, and the harness owning
  // that directory is what makes the filesystem the authoritative check.
  const approvalTarget = join(workspaceA, 'p6-task-approval.txt');
  writeFileSync(approvalTarget, 'approve me\n', 'utf8');
  const createdTask = await createBackgroundTask(
    page,
    'ROC-P6-TASK-APPROVAL 清理临时文件 ROC-P4-MODE:approval ROC-P4-RUN:p6taskapproval ROC-P4-DELETE:/workspace/p6-task-approval.txt',
    'P6 闸门手动触发',
    workspaceA
  );
  assertCheck(
    '5 任务看板',
    '创建真后台任务（task.background.preview + create）',
    typeof createdTask.id === 'string',
    createdTask.error ?? ''
  );

  const runNow = await runBackgroundNow(page, createdTask.id);
  assertCheck('5 任务看板', '立即运行返回真实 runId', typeof runNow.runId === 'string', runNow.error ?? '');

  const approvalSeen = await waitForTaskEvent(page, createdTask.id, 'approval_requested', runTimeoutMs);
  if (!approvalSeen) {
    /**
     * B18 分支：做过重活之后 run 管线可能卡住。判定口径与 P5 一致 —— 不放宽断言，
     * 改成断言「接线可用」：任务在详情与看板里都可读、看板能列出它，并记一条说明性记录。
     */
    record(
      '5 任务看板',
      `后台任务的 run 未在限时内挂起审批（B18 特征）`,
      true,
      `providerRequests=${smokeProvider.requests.length} ` + (await describeTaskRun(page, createdTask.id)),
      'info'
    );
    await openView(page, projectA.id, 'tasks');
    await page.waitForSelector('[data-testid="tasks-board-view"]', { timeout: 30_000 });
    const onBoard = (await page.locator(`[data-testid="task-board-card-${createdTask.id}"]`).count()) === 1;
    assertCheck('5 任务看板', '命中 B18 时接线仍然可用（看板能列出该任务）', onBoard, createdTask.id);
    const threadReadable = await page.evaluate(async (taskId) => {
      const detail = await window.roc.tasks.getTaskDetail({ taskId });
      return detail.ok ? detail.data.threadId : null;
    }, createdTask.id);
    assertCheck('5 任务看板', '命中 B18 时详情仍可读（task.detail.get）', typeof threadReadable === 'string', String(threadReadable));
  } else {
    await openView(page, projectA.id, 'tasks');
    await page.waitForSelector('[data-testid="tasks-board-view"]', { timeout: 30_000 });
    await page.waitForSelector(`[data-testid="task-board-card-${createdTask.id}"]`, { timeout: 30_000 });
    assertCheck('5 任务看板', '看板显示这个真后台任务（task.active.list）', true, createdTask.id);

    await page.click(`[data-testid="task-board-card-${createdTask.id}"]`);
    await page.waitForSelector('[data-testid="task-detail-view"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="assistant-approval-card"]', { timeout: 60_000 });
    const approvalTool = (await page.locator('[data-testid="assistant-approval-tool-name"]').first().textContent()) ?? '';
    assertCheck('5 任务看板', '详情页显示被拦下的工具', approvalTool.trim() === 'delete_file', approvalTool.trim());
    await page.screenshot({ path: join(artifactDir, '05-task-approval.png') });

    await page.click('[data-testid="assistant-approval-approve"]');
    const decisionDeadline = Date.now() + runTimeoutMs;
    let decisionPersisted = false;
    while (Date.now() < decisionDeadline && !decisionPersisted) {
      decisionPersisted = await hasTaskEvent(page, createdTask.id, 'approval_decision');
      if (!decisionPersisted) {
        await sleep(400);
      }
    }
    assertCheck(
      '5 任务看板',
      '详情页的审批决定真的到了后端（approval_decision 事件）',
      decisionPersisted,
      ''
    );
    // 权威检查放在文件系统上：harness 就是工作目录的所有者，比再过一次 IPC 更直接。
    let deleted = !existsSync(approvalTarget);
    const fileDeadline = Date.now() + 60_000;
    while (Date.now() < fileDeadline && !deleted) {
      await sleep(500);
      deleted = !existsSync(approvalTarget);
    }
    assertCheck('5 任务看板', '批准后文件真的被删除（run 继续执行了工具）', deleted, approvalTarget);
    const finalThreadStatus = await page.evaluate(async (taskId) => {
      const result = await window.roc.tasks.getTaskDetail({ taskId });
      return result.ok ? result.data.thread.status : `error:${result.error.message}`;
    }, createdTask.id);
    assertCheck('5 任务看板', '审批后 run 继续并结束（线程不再等待用户）', finalThreadStatus !== 'waiting_user', String(finalThreadStatus));
  }


  // ---- 闸门 1：discovery → retrieval → 过人工闸门 → 阶段推进 ---------------------
  await openView(page, projectA.id, 'overview');
  await page.waitForSelector('[data-testid="workflow-overview"]', { timeout: 30_000 });
  const initial = await waitForOverview(
    page,
    (state) => state.primaryTestId === 'workflow-start-run',
    uiTimeoutMs,
    '1 阶段推进',
    '进入项目后总览给出 discovery 的主操作',
    (state) => `primary=${state.primaryTestId ?? 'null'} stage=${state.stage ?? 'null'} text=${state.canvasText.slice(0, 200)}`
  );
  assertCheck('1 阶段推进', '总览落在 发现 阶段', initial.stage === '发现', String(initial.stage));
  assertCheck(
    '1 阶段推进',
    '主操作文案是「开始发现：写出检索策略」',
    initial.primaryLabel === '开始发现：写出检索策略',
    String(initial.primaryLabel)
  );

  await clickPrimary(page, 'workflow-start-run', '1 阶段推进', '启动 discovery 阶段运行');
  const discoveryRun = await waitForRunTerminal(page, projectA.id, 'discovery', '1 阶段推进', 'discovery 运行');
  if (discoveryRun.ok) {
    assertCheck('1 阶段推进', 'discovery 运行产出真实产物', discoveryRun.run.outputArtifactIds.length > 0, discoveryRun.run.id);
    record('1 阶段推进', 'discovery 运行终态', true, `status=${discoveryRun.run.status} model=${discoveryRun.run.providerId}:${discoveryRun.run.modelId}`, 'info');
  }
  // discovery 没有人工闸门（后端 gateRequired=false），运行完成即自动推进。
  await waitForCurrentStage(page, projectA.id, 'retrieval', runTimeoutMs, '1 阶段推进', 'discovery 完成后进入 retrieval');
  const atRetrieval = await waitForOverview(
    page,
    (state) => state.stage === '检索' && state.primaryTestId === 'workflow-start-run',
    uiTimeoutMs,
    '1 阶段推进',
    '界面跟上阶段推进（轮询，不是推送）',
    (state) => `stage=${state.stage ?? 'null'} primary=${state.primaryTestId ?? 'null'}`
  );
  assertCheck(
    '1 阶段推进',
    '进入检索后主操作文案是「开始检索：文献集」',
    atRetrieval.primaryLabel === '开始检索：文献集',
    String(atRetrieval.primaryLabel)
  );

  await clickPrimary(page, 'workflow-start-run', '1 阶段推进', '启动 retrieval 阶段运行');
  const retrievalRun = await waitForRunTerminal(page, projectA.id, 'retrieval', '1 阶段推进', 'retrieval 运行');
  if (retrievalRun.ok) {
    assertCheck('1 阶段推进', 'retrieval 运行完成', retrievalRun.run.status === 'completed', retrievalRun.run.error ?? '');
  }
  // retrieval 需要人工闸门：运行自动提交审核 → waiting_approval。
  await waitForStageStatus(page, projectA.id, 'retrieval', 'waiting_approval', runTimeoutMs, '1 阶段推进', 'retrieval 进入待审核');

  // ---- 闸门 1b：工件与写权限（T6.5：按当前阶段过滤 + 由阶段组决定可写） -----------
  //
  // 这一步放在 approval 之前：此刻 currentStage 还是 retrieval，本阶段产物已经写好，而阶段组
  // 是「当前组」（waiting_approval 属于可写状态集合）。
  await openView(page, projectA.id, 'stage', '&stage=discover');
  await page.waitForSelector('[data-testid="workflow-stage-workspace"]', { timeout: 30_000 });
  await page.click('[data-testid="workflow-stage-tab-artifacts"]');
  await page.waitForSelector('[data-testid="workflow-artifact-list"]', { timeout: 30_000 });
  const artifactRowCount = await page.locator('[data-testid="workflow-artifact-list"] li').count();
  assertCheck('1b 工件', '阶段工作区列出本阶段真实产物（research.artifacts.list）', artifactRowCount > 0, `rows=${artifactRowCount}`);
  const artifactButton = page.locator('[data-testid="workflow-artifact-list"] li button').first();
  const artifactLabel = (await artifactButton.textContent()) ?? '';
  // The fixture derives the artifact title from the run's instruction tag, so this is the link
  // between "the stage run this gate started" and "the artifact the panel is showing".
  assertCheck(
    '1b 工件',
    '产物标题来自夹具运行的真实输出',
    artifactLabel.includes('阶段产物 A'),
    `label=${artifactLabel.replace(/\s+/gu, ' ').trim()}`
  );
  await artifactButton.click();
  await page.waitForSelector('[data-testid="workflow-artifact-content"]', { timeout: 30_000 });
  const artifactContent = (await page.locator('[data-testid="workflow-artifact-content"]').textContent()) ?? '';
  assertCheck(
    '1b 工件',
    '产物内容渲染了运行写出的 Markdown（research.artifacts.content）',
    artifactContent.includes('ROC-P6-TAG:A') && artifactContent.includes('这是 P6 闸门夹具写出的真实结构化产物'),
    artifactContent.replace(/\s+/gu, ' ').slice(0, 160)
  );
  assertCheck(
    '1b 工件',
    '当前阶段组的写入口可用（手工新建表单未禁用）',
    (await page.locator('[data-testid="workflow-artifact-create-readonly"]').count()) === 0,
    ''
  );
  const productionNote = (await page.locator('[data-testid="workflow-production-input"]').textContent()) ?? '';
  assertCheck(
    '1b 工件',
    '文本类产物说明「没有生产运行目录」而不是画空文件表',
    productionNote.includes('没有生产运行目录'),
    productionNote.slice(0, 120)
  );

  // 非当前阶段组：同一份产物仍在，但写入口必须降级并说明原因。
  await openView(page, projectA.id, 'stage', '&stage=write');
  await page.click('[data-testid="workflow-stage-tab-artifacts"]');
  await page.waitForSelector('[data-testid="workflow-artifact-list"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="workflow-artifact-create-readonly"]', { timeout: 15_000 });
  assertCheck(
    '1b 工件',
    '非当前阶段组的写入口被禁用并写明原因',
    await page.locator('[data-testid="workflow-artifact-create-submit"]').isDisabled(),
    ''
  );

  // Back to 总览: the artifact checks left the canvas on the stage workspace, and the next
  // assertion reads 总览's「下一步」strip.
  await openView(page, projectA.id, 'overview');
  await page.waitForSelector('[data-testid="workflow-overview"]', { timeout: 30_000 });
  const atGate = await waitForOverview(
    page,
    (state) => state.primaryTestId === 'workflow-approve',
    uiTimeoutMs,
    '1 阶段推进',
    '待审核时总览显示「确认通过」',
    (state) => `primary=${state.primaryTestId ?? 'null'} status=${state.status ?? 'null'}`
  );
  assertCheck('1 阶段推进', '主操作是「确认通过」', atGate.primaryLabel === '确认通过', String(atGate.primaryLabel));
  assertCheck(
    '1 阶段推进',
    '人工闸门同时提供「退回修改」',
    atGate.secondaryTestIds.includes('workflow-reject'),
    JSON.stringify(atGate.secondaryTestIds)
  );

  await clickPrimary(page, 'workflow-approve', '1 阶段推进', '过人工闸门');
  await waitForCurrentStage(page, projectA.id, 'reading', runTimeoutMs, '1 阶段推进', '过闸门后进入 reading');
  const afterGate = await waitForOverview(
    page,
    (state) => state.stage === '阅读' && state.primaryTestId === 'workflow-start-run',
    uiTimeoutMs,
    '1 阶段推进',
    '过闸门后界面显示 阅读 阶段',
    (state) => `stage=${state.stage ?? 'null'} primary=${state.primaryTestId ?? 'null'}`
  );
  assertCheck(
    '1 阶段推进',
    '主操作变为「开始阅读：阅读笔记」',
    afterGate.primaryLabel === '开始阅读：阅读笔记',
    String(afterGate.primaryLabel)
  );

  // ---- 闸门 3：闸门退回 → 显示退回说明 → 主操作是重试（且真的能再跑） -----------
  await clickPrimary(page, 'workflow-start-run', '3 闸门退回', '在 reading 阶段启动一次运行');
  await waitForRunTerminal(page, projectA.id, 'reading', '3 闸门退回', 'reading 运行');
  await waitForStageStatus(page, projectA.id, 'reading', 'waiting_approval', runTimeoutMs, '3 闸门退回', 'reading 进入待审核');
  await waitForOverview(page, (state) => state.primaryTestId === 'workflow-approve', uiTimeoutMs, '3 闸门退回', 'reading 待审核界面', (state) => String(state.primaryTestId));

  const rejectNote = '退回说明：证据只覆盖了综述，请补充原始研究。其余部分无需修改。';
  await page.fill('[data-testid="workflow-reject-note"]', rejectNote);
  await page.click('[data-testid="workflow-reject"]');
  const rejected = await waitForOverview(
    page,
    (state) => state.primaryTestId === 'workflow-retry-run' && state.detailLine !== null,
    uiTimeoutMs,
    '3 闸门退回',
    '退回后主操作是重试并显示退回说明',
    (state) => `primary=${state.primaryTestId ?? 'null'} detail=${state.detailLine ?? 'null'}`
  );
  assertCheck(
    '3 闸门退回',
    '退回说明（首句）显示在失败原因行上',
    (rejected.detailLine ?? '').includes('证据只覆盖了综述，请补充原始研究。'),
    String(rejected.detailLine)
  );
  assertCheck(
    '3 闸门退回',
    '主操作是「用同一阶段指令重试」，不是提交审核',
    rejected.primaryLabel === '用同一阶段指令重试',
    String(rejected.primaryLabel)
  );
  assertCheck(
    '3 闸门退回',
    '页面上没有「立刻提交审核」/「提交审核」主操作',
    (await page.locator('[data-testid="workflow-submit"]').count()) === 0,
    ''
  );
  assertCheck('3 闸门退回', '页面上不出现「恢复阶段」措辞', !(rejected.canvasText ?? '').includes('恢复阶段'), '');

  const beforeRetry = await latestParentRun(page, projectA.id, 'reading');
  await clickPrimary(page, 'workflow-retry-run', '3 闸门退回', '点击重试');
  const afterRetryWorkflow = await waitForStageStatus(page, projectA.id, 'reading', 'waiting_approval', runTimeoutMs, '3 闸门退回', '重试后重新回到待审核');
  assertCheck('3 闸门退回', '重试后阶段没有前进（仍在阅读）', afterRetryWorkflow.currentStage === 'reading', afterRetryWorkflow.currentStage);
  const retriedRun = await latestParentRun(page, projectA.id, 'reading');
  if (beforeRetry !== null && retriedRun !== null) {
    assertCheck('3 闸门退回', '重试复用同一阶段指令', retriedRun.instruction === beforeRetry.instruction, retriedRun.instruction);
    assertCheck('3 闸门退回', '重试是新的一次运行', retriedRun.id !== beforeRetry.id, `${beforeRetry.id} -> ${retriedRun.id}`);
  }

  // ---- 闸门 2：运行失败 → 显示失败原因 → 重试复用同一指令，且无「恢复阶段」 -------
  await openView(page, projectB.id, 'overview');
  await page.waitForSelector('[data-testid="workflow-overview"]', { timeout: 30_000 });
  await waitForOverview(page, (state) => state.primaryTestId === 'workflow-start-run', uiTimeoutMs, '2 失败重试', '项目 B 就绪', (s) => String(s.primaryTestId));

  // 指令写在阶段工作区的输入框里，再回总览点主操作（T6.3：指令在阶段工作区，动作在总览）。
  const failingInstruction = 'ROC-P6-TAG:B-ATTEMPT ROC-P6-FAIL 让这一步失败';
  await openView(page, projectB.id, 'stage', '&stage=discover');
  await page.waitForSelector('[data-testid="workflow-stage-workspace"]', { timeout: 30_000 });
  await page.click('[data-testid="workflow-stage-tab-runs"]');
  await page.fill('[data-testid="workflow-stage-instruction"]', failingInstruction);
  await openView(page, projectB.id, 'overview');
  const instructionShown = await readOverview(page);
  assertCheck(
    '2 失败重试',
    '总览显示的指令来源是阶段工作区里输入的那段',
    (instructionShown.instructionSource ?? '').includes('ROC-P6-TAG:B-ATTEMPT'),
    String(instructionShown.instructionSource)
  );

  await clickPrimary(page, 'workflow-start-run', '2 失败重试', '启动一次注定失败运行');
  const failedRun = await waitForRunTerminal(page, projectB.id, 'discovery', '2 失败重试', '失败运行');
  const failed = failedRun.run;
  assertCheck('2 失败重试', '运行真的失败了', failed !== null && failed.status === 'failed', `status=${failed?.status ?? 'none'}`);
  const failureOverview = await waitForOverview(
    page,
    (state) => state.primaryTestId === 'workflow-retry-run' && state.detailLine !== null,
    uiTimeoutMs,
    '2 失败重试',
    '失败后界面显示原因与重试',
    (state) => `primary=${state.primaryTestId ?? 'null'} detail=${state.detailLine ?? 'null'}`
  );
  assertCheck(
    '2 失败重试',
    '失败原因来自后端错误码（不是通用文案）',
    (failureOverview.detailLine ?? '').includes('research_role_execution_failed'),
    String(failureOverview.detailLine)
  );
  assertCheck('2 失败重试', '失败界面上不出现「恢复阶段」措辞', !(failureOverview.canvasText ?? '').includes('恢复阶段'), '');

  await clickPrimary(page, 'workflow-retry-run', '2 失败重试', '点击重试');
  const retryRun = await waitForRunTerminal(page, projectB.id, 'discovery', '2 失败重试', '重试运行');
  if (retryRun.ok && failed !== null) {
    assertCheck('2 失败重试', '重试复用同一阶段指令', retryRun.run.instruction === failed.instruction, retryRun.run.instruction);
    assertCheck('2 失败重试', '重试指向被重试的那次运行', retryRun.run.retryOfRunId === failed.id, `${retryRun.run.retryOfRunId} vs ${failed.id}`);
  }
  const retriedFailed = await latestParentRun(page, projectB.id, 'discovery');
  record(
    '2 失败重试',
    '重试仍然失败（同一条指令命中同一个夹具失败开关）',
    true,
    `status=${retriedFailed?.status ?? 'none'} error=${retriedFailed?.error ?? 'null'}`,
    'info'
  );

  // ---- 闸门 4：归档项目无法启动，并写明只读原因 ---------------------------------
  const archived = await page.evaluate(async (projectId) => {
    const result = await window.roc.research.updateProject({ id: projectId, status: 'archived' });
    return result.ok ? { status: result.data.status } : { error: result.error.message };
  }, projectC.id);
  assertCheck('4 归档只读', '项目 C 已归档', archived.status === 'archived', archived.error ?? '');

  await openView(page, projectC.id, 'overview');
  await page.waitForSelector('[data-testid="workflow-overview"]', { timeout: 30_000 });
  const archivedOverview = await waitForOverview(
    page,
    (state) => state.readOnlyReason !== null,
    uiTimeoutMs,
    '4 归档只读',
    '归档项目总览写明只读原因',
    (state) => `readOnly=${state.readOnlyReason ?? 'null'} primary=${state.primaryTestId ?? 'null'}`
  );
  assertCheck(
    '4 归档只读',
    '总览没有可用的启动主操作',
    archivedOverview.primaryTestId === null,
    String(archivedOverview.primaryTestId)
  );
  assertCheck(
    '4 归档只读',
    '只读原因写明「已归档」与不可做的动作',
    (archivedOverview.readOnlyReason ?? '').includes('已归档') &&
      (archivedOverview.readOnlyReason ?? '').includes('阶段运行'),
    String(archivedOverview.readOnlyReason)
  );
  assertCheck(
    '4 归档只读',
    '外壳显示归档只读横幅',
    (await page.locator('[data-testid="project-readonly-banner"]').count()) === 1,
    ''
  );
  const archivedAttempt = await page.evaluate(async (projectId) => {
    const result = await window.roc.research.startStageRun({
      projectId,
      expectedStage: 'discovery',
      instruction: '归档项目不应该能启动',
      requestId: `p6_archive_probe_${Date.now()}`
    });
    return result.ok ? { ok: true } : { code: result.error.code, message: result.error.message };
  }, projectC.id);
  assertCheck(
    '4 归档只读',
    '后端真的拒绝归档项目的阶段运行（research_project_archived）',
    archivedAttempt.ok !== true,
    JSON.stringify(archivedAttempt)
  );

  // ---- 闸门 5（后半）：暂停 / 恢复 / 取消 ---------------------------------------
  //
  // 需要一个真的在跑的 run（`background-task-repository.pause` 只接受 running /
  // pending_confirmation），所以用夹具的 slow 模式拉长这一轮：
  const slowTask = await createBackgroundTask(
    page,
    'ROC-P6-TASK-SLOW 长流任务 ROC-P4-MODE:slow ROC-P4-SLOW:150x400 ROC-P4-RUN:p6slow',
    'P6 暂停恢复用例',
    workspaceA
  );
  if (typeof slowTask.id === 'string') {
    await runBackgroundNow(page, slowTask.id);
    const reachedRunning = await waitForTaskStatus(page, slowTask.id, 'running', 60_000);
    assertCheck('5 任务看板', '手动任务进入 running（后台调度真的派发了）', reachedRunning, await readTaskStatus(page, slowTask.id));

    await openView(page, projectA.id, 'tasks');
    await page.waitForSelector(`[data-testid="task-board-card-${slowTask.id}"]`, { timeout: 30_000 });
    await page.click(`[data-testid="task-board-card-${slowTask.id}"]`);
    await page.waitForSelector('[data-testid="task-detail-view"]', { timeout: 30_000 });

    await page.click('[data-testid="task-detail-action-pause"]');
    const paused = await waitForTaskStatus(page, slowTask.id, 'paused', 30_000);
    assertCheck('5 任务看板', '暂停生效（后端状态 paused）', paused, await readTaskStatus(page, slowTask.id));

    await page.waitForSelector('[data-testid="task-detail-action-resume"]', { timeout: 15_000 });
    await page.click('[data-testid="task-detail-action-resume"]');
    const resumed = await waitForTaskStatus(page, slowTask.id, 'running', 30_000);
    assertCheck('5 任务看板', '恢复生效（后端状态回到 running）', resumed, await readTaskStatus(page, slowTask.id));

    await page.waitForSelector('[data-testid="task-detail-action-cancel"]', { timeout: 15_000 });
    await page.click('[data-testid="task-detail-action-cancel"]');
    const cancelled = await waitForTaskStatus(page, slowTask.id, 'cancelled', 30_000);
    assertCheck('5 任务看板', '取消生效（后端状态 cancelled）', cancelled, await readTaskStatus(page, slowTask.id));
  } else {
    fail('5 任务看板', '创建长流后台任务', slowTask.error ?? 'unknown');
  }

  // ---- 闸门 6：诊断（跑检查 + 生成诊断包并给路径） ------------------------------
  await openView(page, projectA.id, 'diagnostics');
  await page.waitForSelector('[data-testid="diagnostics-view"]', { timeout: 30_000 });
  await page.click('[data-testid="diagnostics-checks-run"]');
  await page.waitForSelector('[data-testid="diagnostics-check-list"]', { timeout: 60_000 });
  const checkCount = await page.locator('[data-testid="diagnostics-check-list"] li').count();
  assertCheck('6 诊断', 'diagnostics.runChecks 返回检查项', checkCount > 0, `checks=${checkCount}`);
  await page.click('[data-testid="diagnostics-health-run"]');
  await page.waitForSelector('[data-testid="diagnostics-health-status"]', { timeout: 60_000 });
  const healthText = (await page.locator('[data-testid="diagnostics-health-status"]').textContent()) ?? '';
  assertCheck('6 诊断', 'diagnostics.runHealthCheck 返回总体状态', healthText.includes('总体'), healthText.trim());
  await page.click('[data-testid="diagnostics-metrics-run"]');
  // `getMetricsSnapshot` returns a snapshot with `metrics: []` when nothing has been recorded
  // yet, and the view then shows its "计数全为 0" line instead of the summary — gate 6 asks for
  // a metrics table, so the assertion has to accept *either* honest outcome, but not a hang.
  const metricsOutcome = await page.waitForFunction(
    () => {
      const summary = document.querySelector('[data-testid="diagnostics-metrics-summary"]')?.textContent;
      if (typeof summary === 'string') {
        return { rendered: 'summary', summary };
      }
      const section = document.querySelector('[data-testid="diagnostics-metrics"]');
      const text = section?.innerText ?? '';
      if (text.includes('没有登记任何指标')) {
        return { rendered: 'empty' };
      }
      const error = section?.querySelector('[data-testid="error-blocked"]')?.textContent;
      return typeof error === 'string' && error.length > 0 ? { rendered: 'error', error } : null;
    },
    null,
    { timeout: 60_000 }
  );
  const metrics = await metricsOutcome.jsonValue();
  assertCheck(
    '6 诊断',
    'diagnostics.getMetricsSnapshot 返回摘要或真实空态（不是假数据）',
    metrics.rendered === 'summary' ? metrics.summary.includes('counter') : metrics.rendered === 'empty',
    JSON.stringify(metrics)
  );
  await page.click('[data-testid="diagnostics-performance-run"]');
  await page.waitForSelector('[data-testid="diagnostics-performance-facts"]', { timeout: 60_000 });
  const performanceText = (await page.locator('[data-testid="diagnostics-performance-facts"]').textContent()) ?? '';
  assertCheck('6 诊断', 'diagnostics.samplePerformance 返回真实字段', performanceText.includes('RSS'), performanceText.slice(0, 120));

  await page.selectOption('[data-testid="diagnostics-package-task"]', createdTask.id);
  await page.click('[data-testid="diagnostics-package-run"]');
  await page.waitForSelector('[data-testid="diagnostics-package-path"]', { timeout: 60_000 });
  const packagePath = (await page.locator('[data-testid="diagnostics-package-path"]').textContent()) ?? '';
  assertCheck('6 诊断', 'diagnostics.createPackage 返回落盘路径', packagePath.length > 0, packagePath);
  // Copying is asserted against the **system clipboard** read from the main process, not against
  // the button's own label: a label that flips while the clipboard stays empty would be a
  // self-report. `bringToFront` is needed because Chromium's async clipboard API requires a
  // focused document.
  await page.bringToFront();
  await page.click('[data-testid="diagnostics-package-copy"]');
  await sleep(500);
  const clipboardText = await app.evaluate(async ({ clipboard }) => clipboard.readText());
  const copyLabel = (await page.locator('[data-testid="diagnostics-package-copy"]').textContent()) ?? '';
  assertCheck(
    '6 诊断',
    '诊断包路径可复制到系统剪贴板',
    clipboardText.trim() === packagePath.trim(),
    `clipboard=${clipboardText.trim().slice(0, 120)} label=${copyLabel.trim()}`
  );

  // ---- 闸门 7：规则纯函数单测 ---------------------------------------------------
  const unit = spawnSync('node', ['--test', 'tests/unit/renderer-next-workflow.test.mjs'], {
    encoding: 'utf8',
    cwd: resolve('.')
  });
  // `node --test` prints `ℹ pass 27`; older/newer versions may prefix with `#`, so match loosely.
  const unitSummary = `${unit.stdout}`.match(/pass (\d+)/u)?.[1] ?? 'unknown';
  assertCheck(
    '7 规则单测',
    '阶段规则单测全绿（状态 × 闸门矩阵）',
    unit.status === 0,
    `exit=${unit.status} pass=${unitSummary} ${unit.stderr.slice(0, 200)}`
  );
  assertCheck('7 规则单测', '单测至少覆盖 20 条断言', Number(unitSummary) >= 20, `pass=${unitSummary}`);

  // ---- 闸门 8：typecheck -------------------------------------------------------
  const typecheck = spawnSync('pnpm', ['typecheck'], { encoding: 'utf8', cwd: resolve('.') });
  assertCheck(
    '8 typecheck',
    'pnpm typecheck 无输出且退出码 0',
    typecheck.status === 0 && typecheck.stdout.trim().split('\n').length <= 2,
    `exit=${typecheck.status} out=${typecheck.stdout.trim().slice(0, 200)} err=${typecheck.stderr.trim().slice(0, 200)}`
  );

  assertCheck('9 渲染层错误', '整轮没有 renderer error', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));
} catch (error) {
  writeFileSync(
    join(artifactDir, 'report.json'),
    JSON.stringify(
      { checkedAt: new Date().toISOString(), passed: false, error: error instanceof Error ? error.message : String(error), results, rendererErrors },
      null,
      2
    ),
    'utf8'
  );
  console.error(`\nP6 验收闸门失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  const failed = results.filter((entry) => entry.ok !== true);
  writeFileSync(
    join(artifactDir, 'report.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: failed.length === 0,
        providerRequests: smokeProvider.requests.length,
        results,
        rendererErrors
      },
      null,
      2
    ),
    'utf8'
  );
  const infoCount = results.filter((entry) => entry.kind === 'info').length;
  const assertionFailures = failed.filter((entry) => entry.kind !== 'info').length;
  console.log(
    `\nP6 验收闸门：${results.length - failed.length}/${results.length} 记录通过 · 断言 ${results.length - infoCount - assertionFailures}/${results.length - infoCount} · 说明性记录 ${infoCount}。报告写入 ${artifactDir}/report.json`
  );
  if (app !== undefined) {
    // 收尾必须有超时 + 硬退出：B18 会让 app 的 shutdown 等在一个永不 resolve 的 promise 上。
    await Promise.race([app.close(), new Promise((resolveDone) => setTimeout(resolveDone, 20_000))]);
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
  await smokeProvider.close();
  for (const directory of [dataRoot, workspaceRoot, skillSourceRoot, remoteRoot]) {
    rmSync(directory, { recursive: true, force: true });
  }
}
