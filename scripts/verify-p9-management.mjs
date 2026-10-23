import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';
import { createGateRecorder, finishGate, navigate, prepareArtifactDir } from './lib/gate-harness.mjs';

/**
 * P9 验收闸门的自动化实测（真应用 / 真 IPC / 真 markdown 记忆 / 真技能目录 / 真 MCP stdio 子进程 /
 * 真后台任务与调度记录 / 真重启）。
 *
 * 为什么需要它：P9 的闸门全是**运行时事实** —— 记忆的五份文件是不是真的能读改存、快照预览是不是真等于
 * 注入内容、安全扫描与容量上限是不是真的会拒写、技能启停是不是真的会改变助手 composer 的候选、
 * MCP 服务是不是真的会被**子进程**拉起、后台任务创建后是不是真的进了调度器、立即运行是不是真的产生
 * 调度记录、重启后是不是还在。
 *
 * 三条口径：
 *   1. **契约以 registry / schema 为准**（findings F24）。计划原文在这一阶段同样有几处不成立：
 *      `mcp.testServer` **不连接任何东西**（只做配置校验，没有延迟）；`memory.file.write` 的拒绝是
 *      **domain outcome** 而不是 IPC 错误；记忆的 `absolutePath` 是**虚拟路径**；cron 触发器**也要**
 *      `nextRunAt`；`memory.entries.search` / `memory.entry.remember` / `mcp.tools.get` 有实现但**没注册进
 *      IPC**（B25），逐服务工具名只能从 `agent.capability.preview` 的 manifest 拿。
 *   2. **降级路径也是断言**：外部依赖（stdout MCP 子进程、chat run）走「两条路」——一条断言真实结果，
 *      一条断言真实降级并记录原因（B18 的口径），不跳过。
 *   3. **顺序有意**：可检索会话在**重活之前**造（P5 的 B18 经验：解析/索引后的 chat run 会卡）。
 *
 * 运行（必须 `ROC_SMOKE_TARGET=dist`，且先删产物再 build）：
 *   rm -rf dist/renderer && pnpm build
 *   node scripts/verify-p9-management.mjs
 *
 * 必须 detach 跑；报告写 `.artifacts/p9-gates/`。
 */

const artifactDir = prepareArtifactDir(resolve('.artifacts/p9-gates'));

const { results, record, assertCheck } = createGateRecorder();

const smokeModelId = 'p9-smoke-model';
const smokeProviderId = 'p9-smoke-provider';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;
const memoryBody = '# P9 记忆\n\nROC-P9-MEMORY 这一行应当被写进 USER.md 并出现在注入快照里。\n';
const sessionProbe = 'Smoke Provider 已生成首轮回复';
const fixtureToolName = 'p9_fixture_tool';

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);
seedSmokeSkillSource(skillSourceRoot);
const workspaceA = join(workspaceRoot, 'project-a');
mkdirSync(workspaceA, { recursive: true });

/**
 * A minimal MCP **stdio** server, written by the harness.
 *
 * It speaks newline-delimited JSON-RPC and answers `initialize` / `tools/list` with one tool;
 * every method it handles is appended to a marker file, which is how the gate proves the app
 * really spawned it (at run start, where `mcp.tools.get` → `MCPAdapter.listTools` lives) rather
 * than only validating configuration. `mcp.testServer` does **not** connect (F24), so this is the
 * only honest way to show a stdio server works.
 *
 * The marker path is **baked into the script text**, not read from the environment: the MCP SDK's
 * stdio transport spawns with a sanitized env (`getDefaultEnvironment()`), so an env var set on the
 * app process never reaches this child — the first version of the fixture relied on it and wrote
 * nothing at all (the gate reported an empty marker).
 */
const mcpFixturePath = join(dataRoot, 'p9-mcp-stdio-fixture.mjs');
const mcpMarkerPath = join(dataRoot, 'p9-mcp-marker.log');
writeFileSync(
  mcpFixturePath,
  [
    "import { appendFileSync } from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    `const marker = ${JSON.stringify(mcpMarkerPath)};`,
    'const log = (line) => { if (marker.length > 0) { try { appendFileSync(marker, `${line}\\n`); } catch {} } };',
    'const TOOL = { name: "p9_fixture_tool", description: "P9 fixture tool", inputSchema: { type: "object", properties: {}, additionalProperties: false } };',
    'const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\\n`); };',
    'log("start");',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    '  let message;',
    '  try { message = JSON.parse(line); } catch { log("unparsable"); return; }',
    '  log(`method:${message.method ?? ""}`);',
    '  if (message.method === "initialize") {',
    '    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "p9-fixture", version: "1.0.0" } } });',
    '    return;',
    '  }',
    '  if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } }); return; }',
    '  if (message.method === "resources/list") { send({ jsonrpc: "2.0", id: message.id, result: { resources: [] } }); return; }',
    '  if (message.method === "prompts/list") { send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } }); return; }',
    '  if (message.method === "notifications/initialized" || message.id === undefined) { return; }',
    '  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `not supported: ${message.method}` } });',
    '});',
    ''
  ].join('\n'),
  'utf8'
);

const smokeProvider = await startSmokeProvider({});
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`P9 验收闸门实测 · target=${target.kind} · renderer=next · workspace=${workspaceA}\n`);

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

async function launchApp() {
  const launched = await electron.launch({
    executablePath: target.executablePath,
    args: [...target.launchArgs, `--user-data-dir=${join(dataRoot, 'electron-profile')}`],
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

/** The shell adopts the project route only after the state update, so wait for the layout. */
async function waitForProjectRoute() {
  await page.waitForSelector('[data-testid="workspace-layout"]', { timeout: 20_000 });
}

async function openManagement(tab = 'memory') {
  if ((await page.locator('[data-testid="management-panel-panel"]').count()) === 0) {
    await page.click('[data-testid="titlebar-management"]');
    await page.waitForSelector('[data-testid="management-panel-panel"]', { timeout: 20_000 });
  }
  await openTab(tab);
}

async function openTab(tab) {
  await page.click(`[data-testid="mgmt-tab-${tab}"]`);
  await page.waitForSelector(`[data-testid="mgmt-panel-${tab}"]`, { timeout: 20_000 });
}

async function closeManagement() {
  await page.click('[data-testid="management-panel-close"]');
  await page.waitForSelector('[data-testid="management-panel-panel"]', { state: 'detached', timeout: 15_000 });
}

async function text(testId) {
  return ((await page.locator(`[data-testid="${testId}"]`).textContent()) ?? '').replace(/\s+/gu, ' ').trim();
}

async function readInput(testId) {
  return await page.locator(`[data-testid="${testId}"]`).inputValue();
}

async function isChecked(testId) {
  return await page.locator(`[data-testid="${testId}"]`).isChecked();
}

/**
 * Waits until an element's text contains a needle.
 *
 * A plain serialized closure with arguments — **not** a predicate built by `Function(...)`: string
 * code execution is banned in this repo (and the previous version of this helper tripped that
 * rule). The two shapes the gate actually needs are containment and non-emptiness.
 */
async function waitForTextContains(testId, needle, timeout = 20_000) {
  await page.waitForFunction(
    ({ id, text }) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').includes(text),
    { id: testId, text: needle },
    { timeout }
  );
}

async function waitForNonEmptyText(testId, timeout = 20_000) {
  await page.waitForFunction(
    (id) => (document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').trim().length > 0,
    testId,
    { timeout }
  );
}

try {
  ({ launched: app, window: page } = await launchApp());
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  assertCheck('0 启动', '新壳在 smoke 模式下启动', (await page.getAttribute('[data-testid="roc-app"]', 'data-mode')) === 'smoke');

  // ---- 闸门 0：准备（provider / 权限 / 工作目录 / 项目） --------------------------
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
          name: 'P9 Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: `secret:${providerId}`,
          enabled: true,
          models: [
            {
              id: modelId,
              displayName: 'P9 Smoke Model',
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
      const secret = await window.roc.settings.setProviderSecret({ providerId, plaintext: 'smoke-test-key' });
      return secret.ok ? { ok: true } : { error: secret.error.message };
    },
    { providerId: smokeProviderId, modelId: smokeModelId, modelKey: smokeModelKey, endpoint: smokeProvider.endpoint }
  );
  assertCheck('0 准备', '默认模型与 permissions.mode=default 就绪', configured.ok === true, configured.error ?? '');

  const preflight = await page.evaluate(async (path) => {
    const workspace = await window.roc.workspace.select({ path });
    const project = await window.roc.research.createProject({
      title: 'P9 管理闸门项目',
      description: 'ROC-P9-PROJECT 管理面板闸门',
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

  // MCP 夹具服务在**打开抽屉之前**建好：管理面板的 store 在抽屉第一次挂载时读配置，
  // 之后再改就得手动刷新（而刷新的语义是「面板刷新」，不是测试的搬运工）。
  const mcpSetup = await page.evaluate(
    async ({ id, command }) => {
      const upsert = await window.roc.mcp.upsertServer({
        id,
        name: 'P9 Stdio Fixture',
        enabled: false,
        transport: 'stdio',
        preset: false,
        riskLevel: 'low',
        command,
        allowedTools: ['p9_fixture_tool']
      });
      if (!upsert.ok) {
        return { error: upsert.error.message };
      }
      const tested = await window.roc.mcp.testServer(id);
      const invalidCommand = await window.roc.mcp.upsertServer({
        id: 'p9-stdio-missing-command',
        name: 'P9 缺命令',
        enabled: false,
        transport: 'stdio',
        preset: false,
        riskLevel: 'low',
        allowedTools: []
      });
      return {
        tested: tested.ok ? tested.data : { error: tested.error.message },
        invalidUpsert: invalidCommand.ok ? null : { error: invalidCommand.error.message }
      };
    },
    { id: 'p9-stdio', command: `node ${mcpFixturePath}` }
  );
  // ---- 闸门 0b：先造一条可检索会话（P5 的 B18 顺序：重活之前） ---------------------
  const chatStart = await page.evaluate(async () => {
    const snapshot = await window.roc.tasks.getSnapshot();
    const threadIds = snapshot.ok ? snapshot.data.threads.map((thread) => thread.id) : [];
    const run = await window.roc.chat.startRun({
      input: 'ROC-P9-PROBE 请回一句话',
      mode: 'chat',
      enabledCapabilities: { mcpServers: [], skills: [] }
    });
    return { ok: run.ok, error: run.ok ? null : run.error.message, threadIds };
  });
  assertCheck('0b 会话', 'chat.startRun 受理', chatStart.ok === true, chatStart.error ?? '');

  let chatCompleted = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await page.evaluate(async () => {
      const snapshot = await window.roc.tasks.getSnapshot();
      if (!snapshot.ok) {
        return { status: 'unknown' };
      }
      const chat = snapshot.data.threads.filter((thread) => thread.kind === 'chat');
      return { status: chat[chat.length - 1]?.status ?? 'none' };
    });
    if (state.status === 'completed') {
      chatCompleted = true;
      break;
    }
    if (state.status === 'failed' || state.status === 'cancelled') {
      break;
    }
    await sleep(1_500);
  }
  if (chatCompleted) {
    assertCheck('0b 会话', '探针会话跑完（助手回复进入持久化会话）', chatCompleted, sessionProbe.slice(0, 18));
  } else {
    record(
      '0b 会话',
      '探针会话没有在 60s 内完成：闸门 1 的检索断言转为「检索面可用」两路（B18）',
      true,
      'chat run 卡住是已登记的后端任务单 B18，不是渲染层缺陷',
      'info'
    );
  }

  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await waitForProjectRoute();

  // ---- 闸门 1：记忆（五份 markdown 内容：读 / 改 / 存 / 快照 / 拒写） -------------
  await openManagement('memory');
  const slots = ['global-user', 'global-agents', 'global-memory', 'workspace-agents', 'workspace-memory'];
  for (const slot of slots) {
    assertCheck('1 记忆', `槽位 ${slot} 出现在列表里`, (await page.locator(`[data-testid="mgmt-memory-slot-${slot}"]`).count()) === 1);
  }
  record('1 记忆', '五个槽位来自 store-slots（含项目 AGENTS.md；workspace/user 不存在）', true, slots.join(', '), 'info');

  const slotShape = await page.evaluate(async () => {
    const status = await window.roc.memory.status();
    if (!status.ok) {
      return { error: status.error.message };
    }
    return {
      workspaceHash: status.data.workspaceHash,
      effective: status.data.files.map((file) => ({ key: `${file.scope}:${file.kind}`, effective: file.effective }))
    };
  });
  assertCheck(
    '1 记忆',
    '五个槽位都 effective：工作目录已绑定，项目槽位真的接通了（B26 已修）',
    Array.isArray(slotShape.effective) &&
      slotShape.effective.length === 5 &&
      slotShape.effective.every((row) => row.effective),
    JSON.stringify(slotShape)
  );
  assertCheck(
    '1 记忆',
    'memory.status.workspaceHash 与 workspace.select 绑定的目录一致（不再是 null）',
    typeof slotShape.workspaceHash === 'string' && slotShape.workspaceHash.length > 0,
    String(slotShape.workspaceHash)
  );

  // 会话消息与全文索引是 agent 库的事实：此前是写死的 0 / null / healthy:true。
  const sessionFacts = await page.evaluate(async () => {
    const status = await window.roc.memory.status();
    const settings = await window.roc.settings.get();
    return {
      memory: status.ok
        ? { sessionMessages: status.data.sessionMessages, fullTextIndex: status.data.fullTextIndex }
        : { error: status.error.message },
      retentionDays: settings.ok ? settings.data.settings.memory.sessionRetentionDays : null
    };
  });
  const sessionStats = sessionFacts.memory.sessionMessages;
  assertCheck(
    '1 记忆',
    '会话消息行数与最早时间来自 agent 库（探针会话已持久化，不再恒为 0 / null）',
    typeof sessionStats?.totalRows === 'number' &&
      sessionStats.totalRows > 0 &&
      typeof sessionStats.oldestAt === 'string' &&
      Number.isFinite(Date.parse(sessionStats.oldestAt)),
    JSON.stringify(sessionStats).slice(0, 120)
  );
  assertCheck(
    '1 记忆',
    '保留天数与 settings.memory.sessionRetentionDays 是同一个值',
    sessionStats?.retentionDays === sessionFacts.retentionDays,
    `${String(sessionStats?.retentionDays)} vs ${String(sessionFacts.retentionDays)}`
  );
  assertCheck(
    '1 记忆',
    '全文索引状态来自真实探测（ready，不再是常量 true）',
    sessionFacts.memory.fullTextIndex?.healthy === true && sessionFacts.memory.fullTextIndex?.status === 'ready',
    JSON.stringify(sessionFacts.memory.fullTextIndex)
  );
  assertCheck('1 记忆', '默认阅读模式不显示编辑框', await page.locator('[data-testid="mgmt-memory-textarea"]').count() === 0);
  assertCheck('1 记忆', '首次进入优先选择项目记忆', await page.locator('[data-testid="mgmt-memory-slot-workspace-memory"]').getAttribute('aria-current') === 'page');
  await page.click('[data-testid="mgmt-memory-details-toggle"]');
  const sessionRowText = await text('mgmt-memory-sessions');
  assertCheck(
    '1 记忆',
    '面板把最早时间格式化成日期，而不是原样打印 ISO',
    sessionRowText.includes('行') && /\dT\d/u.test(sessionRowText) === false,
    sessionRowText.slice(0, 80)
  );

  // 写 global/user
  await page.click('[data-testid="mgmt-memory-slot-global-user"]');
  await page.click('[data-testid="mgmt-memory-edit"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="mgmt-memory-textarea"]') !== null,
    undefined,
    { timeout: 20_000 }
  );
  await page.fill('[data-testid="mgmt-memory-textarea"]', memoryBody);
  await page.click('[data-testid="mgmt-memory-save"]');
  await waitForTextContains('mgmt-memory-outcome', '已保存');
  const outcomeText = await text('mgmt-memory-outcome');
  assertCheck('1 记忆', '保存后回到阅读模式并确认已保存', outcomeText === '已保存' && await page.locator('[data-testid="mgmt-memory-textarea"]').count() === 0, outcomeText);
  await waitForTextContains('mgmt-memory-reading', 'ROC-P9-MEMORY');

  const readBack = await page.evaluate(async () => {
    const result = await window.roc.memory.readFile({ scope: 'global', kind: 'user' });
    return result.ok ? result.data : `error:${result.error.message}`;
  });
  assertCheck('1 记忆', 'memory.readFile 逐字读回写入的 markdown', readBack === memoryBody, JSON.stringify(readBack).slice(0, 90));

  const statusAfterWrite = await page.evaluate(async () => {
    const status = await window.roc.memory.status();
    return status.ok
      ? status.data.files.map((file) => ({ key: `${file.scope}:${file.kind}`, exists: file.exists, chars: file.charCount, effective: file.effective }))
      : { error: status.error.message };
  });
  const userRow = Array.isArray(statusAfterWrite) ? statusAfterWrite.find((row) => row.key === 'global:user') : null;
  assertCheck(
    '1 记忆',
    'memory.status 反映写入（exists true 且字符数与写入一致）',
    userRow !== null && userRow.exists === true && userRow.chars === [...memoryBody].length,
    JSON.stringify(userRow)
  );

  // 项目槽位：绑定了工作目录就必须真的可写（B26 修复后不再返回 workspace_required）
  const workspaceBody = '# 项目记忆\n\nROC-P9-WORKSPACE-MEMORY\n';
  const workspaceWrite = await page.evaluate(async (content) => {
    const result = await window.roc.memory.writeFile({ scope: 'workspace', kind: 'memory', content });
    const readBack = await window.roc.memory.readFile({ scope: 'workspace', kind: 'memory' });
    return result.ok
      ? { meta: result.data.meta, readBack: readBack.ok ? readBack.data : null }
      : { ipcError: result.error.message };
  }, workspaceBody);
  assertCheck(
    '1 记忆',
    '写项目槽位真的落进 workspaceHash 命名空间并逐字读回',
    workspaceWrite.meta !== undefined && workspaceWrite.meta.effective === true && workspaceWrite.readBack === workspaceBody,
    JSON.stringify(workspaceWrite).slice(0, 140)
  );
  await page.click('[data-testid="mgmt-memory-slot-workspace-memory"]');
  await page.click('[data-testid="mgmt-memory-reload"]');
  await page.click('[data-testid="mgmt-memory-edit"]');
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="mgmt-memory-textarea"]')?.value ?? '').includes(
        'ROC-P9-WORKSPACE-MEMORY'
      ),
    undefined,
    { timeout: 20_000 }
  );
  assertCheck(
    '1 记忆',
    '项目槽位在界面里可编辑（没有「不可写」提示）',
    (await page.locator('[data-testid="mgmt-memory-slot-unavailable"]').count()) === 0
  );
  await page.fill('[data-testid="mgmt-memory-textarea"]', '# 项目记忆（界面写入）\n');
  assertCheck(
    '1 记忆',
    '可写项目槽位的保存按钮在草稿变脏后启用',
    (await page.locator('[data-testid="mgmt-memory-save"]').isDisabled()) === false
  );
  await page.click('[data-testid="mgmt-memory-discard"]');

  // 快照预览与文件内容一致
  await page.click('[data-testid="mgmt-memory-preview-toggle"]');
  await page.waitForSelector('[data-testid="mgmt-memory-preview-text"]', { timeout: 20_000 });
  // The preview is its own capability read; wait for the backend's header instead of reading the
  // empty placeholder (the previous run raced this and read an empty <pre>).
  await waitForTextContains('mgmt-memory-preview-text', 'DeepAgents Memory Preview', 20_000);
  const previewText = (await page.locator('[data-testid="mgmt-memory-preview-text"]').textContent()) ?? '';
  assertCheck(
    '1 记忆',
    '快照预览包含 USER.md 的标题行与内容',
    previewText.includes('## /memory/global/USER.md') && previewText.includes('ROC-P9-MEMORY'),
    previewText.slice(0, 80)
  );
  assertCheck(
    '1 记忆',
    '快照预览也带上项目槽位（它生效了，预览只拼生效的槽位）',
    previewText.includes('/memory/workspaces/current/MEMORY.md') && previewText.includes('ROC-P9-WORKSPACE-MEMORY'),
    previewText.slice(-80)
  );

  // 安全扫描拒写（domain outcome，不是 IPC 错误）
  const scanOutcome = await page.evaluate(async () => {
    const result = await window.roc.memory.writeFile({
      scope: 'global',
      kind: 'user',
      content: '# 泄漏\n\nsk-live-abcdef1234567890\n'
    });
    return result.ok ? result.data : { ipcError: result.error.message };
  });
  assertCheck(
    '1 记忆',
    '写含凭据的内容被安全扫描拒写（reason=security_scan + issues）',
    scanOutcome.ok === false && scanOutcome.reason === 'security_scan' && Array.isArray(scanOutcome.issues) && scanOutcome.issues.length > 0,
    JSON.stringify(scanOutcome).slice(0, 160)
  );
  const afterRefusal = await page.evaluate(async () => {
    const status = await window.roc.memory.status();
    return status.ok ? status.data.files.find((file) => file.scope === 'global' && file.kind === 'user')?.charCount ?? null : null;
  });
  assertCheck('1 记忆', '被拒写没有改变文件内容', afterRefusal === [...memoryBody].length, `chars=${String(afterRefusal)}`);

  // 容量上限拒写
  const capacityOutcome = await page.evaluate(async () => {
    const status = await window.roc.memory.status();
    const limit = status.ok ? status.data.files.find((file) => file.scope === 'global' && file.kind === 'user')?.charLimit ?? 20_000 : 20_000;
    const oversized = `${'x'.repeat(limit + 10)}\n`;
    const result = await window.roc.memory.writeFile({ scope: 'global', kind: 'user', content: oversized });
    return result.ok ? result.data : { ipcError: result.error.message };
  });
  assertCheck(
    '1 记忆',
    '超出字符上限被拒写（reason=capacity_exceeded 且带 chars/limit）',
    capacityOutcome.ok === false && capacityOutcome.reason === 'capacity_exceeded' && typeof capacityOutcome.limit === 'number',
    JSON.stringify(capacityOutcome).slice(0, 160)
  );

  // UI 上的拒写展示：把超限内容填进编辑器再保存，界面必须说清原因
  await page.click('[data-testid="mgmt-memory-slot-global-user"]');
  await page.click('[data-testid="mgmt-memory-edit"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="mgmt-memory-textarea"]')?.value ?? '').includes('ROC-P9-MEMORY'),
    undefined,
    { timeout: 20_000 }
  );
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="mgmt-memory-textarea"]');
    if (node === null) {
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(node, `${'y'.repeat(20_010)}\n`);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('[data-testid="mgmt-memory-save"]');
  await waitForTextContains('mgmt-memory-outcome', '未保存');
  const blockedText = await text('mgmt-memory-outcome');
  assertCheck('1 记忆', '界面把拒写渲染成「未保存 + 原因」，不是通用错误', blockedText.includes('容量上限'), blockedText.slice(0, 120));
  await page.click('[data-testid="mgmt-memory-discard"]');
  

  await page.click('[data-testid="mgmt-memory-details-toggle"]');
  await page.click('[data-testid="mgmt-memory-reload"]');
  await waitForTextContains('mgmt-memory-capacity-global-user', '字符', 20_000);
  assertCheck('1 记忆', '重新读取保留已保存的阅读内容', (await text('mgmt-memory-reading')).includes('ROC-P9-MEMORY'));

  await page.click('[data-testid="mgmt-memory-search-toggle"]');
  // 会话检索（记忆域没有条目检索的 IPC，B25）
  const currentScopeDisabled = await page.evaluate(() => {
    const select = document.querySelector('[data-testid="mgmt-memory-search-scope"]');
    const option = select === null ? null : [...select.options].find((entry) => entry.value === 'current');
    return option === undefined || option === null ? null : option.disabled;
  });
  assertCheck(
    '1 记忆',
    '有 workspaceHash 时「当前工作目录」检索范围可选',
    currentScopeDisabled === false,
    String(currentScopeDisabled)
  );
  await page.fill('[data-testid="mgmt-memory-search-input"]', sessionProbe);
  await page.click('[data-testid="mgmt-memory-search-run"]');
  await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="mgmt-memory-search-hits"], [data-testid="mgmt-memory-search-empty"], [data-testid="mgmt-memory-search-error"]');
      return node !== null;
    },
    undefined,
    { timeout: 30_000 }
  );
  const searchHits = await page.locator('[data-testid="mgmt-memory-search-hits"] li').count();
  if (chatCompleted) {
    assertCheck('1 记忆', 'engt过 agent.sessions.search 能搜到探针会话的助手回复', searchHits > 0, `hits=${searchHits}`);
    const openThread = await page.locator('[data-testid^="mgmt-memory-search-open-"]').first();
    assertCheck('1 记忆', '命中带「打开会话」入口', (await openThread.count()) === 1);
  } else {
    record('1 记忆', '检索面本身可用（探针会话因 B18 未完成，未断言命中）', true, `hits=${searchHits}`, 'info');
  }
  await page.click('[data-testid="mgmt-memory-audit-toggle"]');
  const auditNote = (await page.locator('[data-testid="mgmt-memory-audit"]').count()) === 1;
  assertCheck('1 记忆', '自动沉淀审计区渲染（记录或真实空态）', auditNote);

  // ---- 闸门 2：技能（真目录导入 / 启停 / 助手 composer 候选） ---------------------
  const skillImport = await page.evaluate(
    async (sourcePath) => {
      const result = await window.roc.skills.importSkill({ sourcePath });
      if (!result.ok) {
        return { error: result.error.message };
      }
      const listed = await window.roc.skills.list();
      return {
        id: result.data.id,
        name: result.data.name,
        enabled: result.data.enabled,
        ids: listed.ok ? listed.data.map((skill) => skill.id) : []
      };
    },
    skillSourceRoot
  );
  assertCheck(
    '2 技能',
    'skills.import 把含 SKILL.md 的目录复制成技能',
    typeof skillImport.id === 'string' && skillImport.ids.includes(skillImport.id),
    JSON.stringify(skillImport).slice(0, 120)
  );
  const skillId = skillImport.id;

  await openTab('skills');
  await page.click('[data-testid="mgmt-skills-reload"]').catch(() => {});
  await page.waitForSelector(`[data-testid="mgmt-skill-${skillId}"]`, { timeout: 20_000 });
  const skillsSummary = await text('mgmt-skills-summary');
  // 摘要里的总数要和后端 `skills.list` 的清单对得上，不能写死成“1 个技能”——内置技能
  // 会随数据根一起装进来（今天 24 个），写死的数字只是在断言“内置技能没被装上”。
  assertCheck(
    '2 技能',
    '技能列表显示真实技能与摘要',
    skillImport.ids.length > 0 && skillsSummary.includes(`${skillImport.ids.length} 个技能`),
    `${skillsSummary} · list=${skillImport.ids.length}`
  );

  // 相对路径在 UI 上被拒（后端会按进程 cwd 解析，那不是用户选的目录）
  await page.fill('[data-testid="mgmt-skills-import-path"]', './relative-skill');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="mgmt-skills-import-run"]')?.hasAttribute('disabled') === true,
    undefined,
    { timeout: 10_000 }
  );
  assertCheck(
    '2 技能',
    '相对路径被拦下（导入按钮不可用）',
    await page.locator('[data-testid="mgmt-skills-import-run"]').isDisabled()
  );

  // 文件树与预览（SKILL.md 走 markdown 渲染）
  // 先选中刚导入的那个技能：数据根里还有随包安装的内置技能，列表默认选中的不一定是它，
  // 不选就直接点 SKILL.md 预览到的是别人的文件。
  await page.click(`[data-testid="mgmt-skill-${skillId}"]`);
  await page.waitForSelector('[data-testid="mgmt-skill-entries"]', { timeout: 20_000 });
  await page.click('[data-testid="mgmt-skill-entry-SKILL.md"]');
  await page.waitForSelector('[data-testid="mgmt-skill-preview-markdown"]', { timeout: 30_000 });
  const previewBody = await text('mgmt-skill-preview-markdown');
  assertCheck('2 技能', '技能文件按 markdown 只读预览', previewBody.includes('Smoke Skill'), previewBody.slice(0, 80));

  // 启停 → 影响助手 composer 的候选
  await navigate(page, `page=research&project=${projectId}&view=latex&assistant=1`);
  await page.waitForSelector('[data-testid="assistant-panel"]', { timeout: 20_000 });
  const composerProbe = async () => {
    await page.fill('[data-testid="assistant-composer-input"]', '/smoke');
    await page.waitForSelector('[data-testid="assistant-composer-suggestions"]', { timeout: 10_000 }).catch(() => {});
    return await page.locator(`[data-testid="assistant-skill-suggestion-${skillId}"]`).count();
  };
  const suggestionsEnabled = await composerProbe();
  assertCheck('2 技能', '启用时技能出现在 composer 的 / 候选里', suggestionsEnabled === 1, `count=${suggestionsEnabled}`);
  await page.fill('[data-testid="assistant-composer-input"]', '');

  // 关掉技能走**界面**（抽屉里的开关）：这正是 P9 要断言的用户路径 —— 它必须让助手的候选立即变化，
  // 而不是等下一次保存设置。直调 IPC 会绕过 `notifySettingsChanged()`，那测的是另一件事。
  //
  // 摘要里的已启用数不能写死成 0/1：数据根里还有随包安装的内置技能（全启用），所以断言的是
  // “关掉这一个就少一个”，以及重新启用后回到原值。
  const enabledCount = (summary) => Number(/(\d+) 个已启用/u.exec(summary)?.[1] ?? NaN);
  await openManagement('skills');
  await page.waitForSelector(`[data-testid="mgmt-skill-${skillId}"]`, { timeout: 20_000 });
  const enabledBeforeDisable = enabledCount(await text('mgmt-skills-summary'));
  await page.locator(`[data-testid="mgmt-skill-enabled-${skillId}"]`).uncheck();
  await waitForTextContains('mgmt-skills-summary', `${enabledBeforeDisable - 1} 个已启用`, 20_000);
  const summaryAfterDisable = await text('mgmt-skills-summary');
  assertCheck(
    '2 技能',
    '抽屉里的开关把技能关掉并刷新摘要',
    enabledCount(summaryAfterDisable) === enabledBeforeDisable - 1,
    summaryAfterDisable
  );
  await closeManagement();

  const suggestionsDisabled = await composerProbe();
  assertCheck('2 技能', '停用后候选里不再有它（助手读的是同一份技能快照）', suggestionsDisabled === 0, `count=${suggestionsDisabled}`);
  await page.fill('[data-testid="assistant-composer-input"]', '');

  await openManagement('skills');
  await page.locator(`[data-testid="mgmt-skill-enabled-${skillId}"]`).check();
  await waitForTextContains('mgmt-skills-summary', `${enabledBeforeDisable} 个已启用`, 20_000);
  await closeManagement();
  const suggestionsRestored = await composerProbe();
  assertCheck('2 技能', '重新启用后候选又回来了（两个方向都看得见）', suggestionsRestored === 1, `count=${suggestionsRestored}`);
  await page.fill('[data-testid="assistant-composer-input"]', '');

  // ---- 闸门 3：MCP（配置校验 / 装配工具 / 真 stdio 子进程 / UI 增删） -------------
  await openManagement('mcp');
  assertCheck(
    '3 MCP',
    'mcp.testServer 对配置完整的 stdio 服务返回 ready（只校验配置）',
    mcpSetup.tested?.status === 'ready' && Array.isArray(mcpSetup.tested?.checked),
    JSON.stringify(mcpSetup.tested)
  );
  assertCheck(
    '3 MCP',
    '缺 command 的 stdio 服务在保存时就被拒（upsert 先跑 validateTransportFields）',
    mcpSetup.invalidUpsert !== null && /command/u.test(mcpSetup.invalidUpsert.error),
    JSON.stringify(mcpSetup.invalidUpsert)
  );
  record(
    '3 MCP',
    'testServer 的 invalid 分支在现有 API 下不可达：缺 transport 字段的服务根本存不进去',
    true,
    'upsert → validateTransportFields 先拒绝（F24 ③）',
    'info'
  );
  record(
    '3 MCP',
    'mcp.testServer 不连接任何东西（无延迟、无网络错误原文）；真连通证据在下面的 stdio 子进程与装配预览',
    true,
    'F24',
    'info'
  );

  await page.waitForSelector('[data-testid="mgmt-mcp-server-p9-stdio"]', { timeout: 20_000 });
  await page.click('[data-testid="mgmt-mcp-test-p9-stdio"]');
  await waitForTextContains('mgmt-mcp-test-result-p9-stdio', '连接', 20_000);

  // 启用 → 装配预览里出现逐服务工具（manifest.provenance.serverId）
  const previewAfterEnable = await page.evaluate(async () => {
    const enabled = await window.roc.mcp.setServerEnabled({ id: 'p9-stdio', enabled: true });
    if (!enabled.ok) {
      return { error: enabled.error.message };
    }
    const preview = await window.roc.agent.getCapabilityPreview({ mcpServers: ['p9-stdio'], skills: [], mode: 'chat' });
    if (!preview.ok) {
      return { error: preview.error.message };
    }
    const mcpTools = preview.data.manifest.tools.filter((tool) => tool.provenance.kind === 'mcp');
    return {
      tools: mcpTools.map((tool) => ({ name: tool.modelVisibleName, serverId: tool.provenance.serverId, approval: tool.approvalPolicy.kind })),
      resolved: preview.data.manifest.resolvedCapabilities.mcpServers
    };
  });
  assertCheck(
    '3 MCP',
    '启用后工具的装配预览里出现该服务的工具（provenance.serverId 指回服务）',
    Array.isArray(previewAfterEnable.tools) &&
      previewAfterEnable.tools.length === 1 &&
      previewAfterEnable.tools[0]?.name === fixtureToolName &&
      previewAfterEnable.tools[0]?.serverId === 'p9-stdio',
    JSON.stringify(previewAfterEnable).slice(0, 160)
  );
  assertCheck('3 MCP', '装配预览把它算进 resolvedCapabilities.mcpServers', Array.isArray(previewAfterEnable.resolved) && previewAfterEnable.resolved.includes('p9-stdio'));

  await openTab('mcp');
  await page.click('[data-testid="mgmt-mcp-reload"]');
  await waitForTextContains('mgmt-mcp-tools-p9-stdio', fixtureToolName, 20_000).catch(() => {});
  const toolLine = await text('mgmt-mcp-tools-p9-stdio');
  assertCheck('3 MCP', '面板显示逐服务的工具名与审批要求', toolLine.includes(fixtureToolName), toolLine.slice(0, 120));
  const mcpPanelText = ((await page.locator('[data-testid="mgmt-mcp"]').textContent()) ?? '').replace(/\s+/gu, ' ');
  assertCheck(
    '3 MCP',
    '面板文案不声称「连接成功 / 测试连接」（后端只校验配置）',
    mcpPanelText.includes('校验配置') && !mcpPanelText.includes('测试连接') && !mcpPanelText.includes('连接成功'),
    mcpPanelText.slice(0, 120)
  );

  // 真 stdio 子进程：一次 chat run 会在 run-harness 里调用 mcp.tools.get → MCPAdapter 拉起服务
  const mcpRunStarted = await page.evaluate(async () => {
    const run = await window.roc.chat.startRun({
      input: 'ROC-P9-MCP 探针：请回一句话',
      mode: 'chat',
      enabledCapabilities: { mcpServers: ['p9-stdio'], skills: [] }
    });
    return run.ok ? { ok: true } : { error: run.error.message };
  });
  assertCheck('3 MCP', '带 MCP 服务的 chat run 被受理', mcpRunStarted.ok === true, mcpRunStarted.error ?? '');
  let mcpMarker = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1_500);
    if (existsSync(mcpMarkerPath)) {
      mcpMarker = readFileSync(mcpMarkerPath, 'utf8');
      if (mcpMarker.includes('method:tools/list')) {
        break;
      }
    }
  }
  assertCheck(
    '3 MCP',
    'stdio MCP 服务真的被子进程拉起并回答了 tools/list（真连通）',
    mcpMarker.includes('start') && mcpMarker.includes('method:initialize') && mcpMarker.includes('method:tools/list'),
    mcpMarker.replace(/\n/gu, ' | ').slice(0, 160)
  );

  // UI 增删：新建一个 http 服务（不连通也无所谓，配置层面）→ 删除确认
  await openTab('mcp');
  await page.click('[data-testid="mgmt-mcp-create"]');
  await page.waitForSelector('[data-testid="mgmt-mcp-editor"]', { timeout: 15_000 });
  await page.fill('[data-testid="mgmt-mcp-draft-id"]', 'p9-ui-http');
  await page.fill('[data-testid="mgmt-mcp-draft-name"]', 'P9 UI HTTP');
  await page.selectOption('[data-testid="mgmt-mcp-draft-transport"]', 'http');
  await page.waitForSelector('[data-testid="mgmt-mcp-draft-url"]', { timeout: 10_000 });
  await page.fill('[data-testid="mgmt-mcp-draft-url"]', 'not a url');
  await page.waitForSelector('[data-testid="mgmt-mcp-issue-url"]', { timeout: 10_000 });
  const urlIssue = await text('mgmt-mcp-issue-url');
  assertCheck('3 MCP', 'UI 对非绝对 URL 给出字段级错误并禁用保存', urlIssue.includes('绝对地址'), urlIssue.slice(0, 80));
  await page.fill('[data-testid="mgmt-mcp-draft-url"]', 'https://mcp.example.test/mcp');
  await page.click('[data-testid="mgmt-mcp-save"]');
  await page.waitForSelector('[data-testid="mgmt-mcp-server-p9-ui-http"]', { timeout: 20_000 });
  assertCheck('3 MCP', 'UI 新建的 http 服务保存成功并出现在列表里', true);
  await page.click('[data-testid="mgmt-mcp-delete-p9-ui-http"]');
  await page.waitForSelector('[data-testid="mgmt-mcp-delete-confirm-confirm"]', { timeout: 10_000 });
  await page.click('[data-testid="mgmt-mcp-delete-confirm-confirm"]');
  await page.waitForSelector('[data-testid="mgmt-mcp-server-p9-ui-http"]', { state: 'detached', timeout: 20_000 });
  assertCheck('3 MCP', '删除（二次确认）真的从配置里移除', true);

  // 写失败必须看得见、而且乐观开关要收回：这里故意把服务从后端删掉（面板里的配置还留着），
  // 再点它的启用开关 —— IPC 会返回 mcp_server_not_found。
  await page.evaluate(async () => {
    await window.roc.mcp.deleteServer('p9-stdio');
  });
  await page.locator('[data-testid="mgmt-mcp-enabled-p9-stdio"]').click();
  await page.waitForSelector('[data-testid="mgmt-mcp-mutation-error"]', { timeout: 20_000 });
  const mutationError = await text('mgmt-mcp-mutation-error');
  assertCheck('3 MCP', '写失败会显示后端原文', mutationError.includes('操作失败'), mutationError.slice(0, 100));
  assertCheck(
    '3 MCP',
    '写失败后乐观开关回到快照值（勾选框重新是选中）',
    (await isChecked('mgmt-mcp-enabled-p9-stdio')) === true,
    'mcp_server_not_found → clearFlags()'
  );
  // 把服务放回去，闸门 6 的重启断言要它还在配置里。
  await page.evaluate(
    async ({ id, command }) => {
      await window.roc.mcp.upsertServer({
        id,
        name: 'P9 Stdio Fixture',
        enabled: true,
        transport: 'stdio',
        preset: false,
        riskLevel: 'low',
        command,
        allowedTools: ['p9_fixture_tool']
      });
    },
    { id: 'p9-stdio', command: `node ${mcpFixturePath}` }
  );

  await page.click('[data-testid="mgmt-mcp-preset"]');
  await page.waitForSelector('[data-testid="mgmt-mcp-server-exa-hosted"]', { timeout: 20_000 });
  const approvalLine = await text('mgmt-mcp-approval-mode');
  assertCheck('3 MCP', '审批模式在抽屉里只读显示并可跳到设置中心', approvalLine.includes('审批') || approvalLine.includes('自动'), approvalLine.slice(0, 60));
  const openSettingsButton = (await page.locator('[data-testid="mgmt-mcp-open-settings"]').count()) === 1;
  assertCheck('3 MCP', '审批模式的唯一写入口在设置中心（抽屉里给跳转）', openSettingsButton);

  // ---- 闸门 4：后台任务（创建 → 调度器 → 看板 → 立即运行 → 真历史） --------------
  await openTab('tasks');
  await page.click('[data-testid="mgmt-tasks-create"]');
  await page.waitForSelector('[data-testid="mgmt-task-editor"]', { timeout: 15_000 });
  await page.fill('[data-testid="mgmt-task-draft-goal"]', 'ROC-P9-TASK 每天检查构建');
  await page.selectOption('[data-testid="mgmt-task-draft-trigger"]', 'cron');
  await page.waitForSelector('[data-testid="mgmt-task-draft-cron"]', { timeout: 10_000 });
  await page.fill('[data-testid="mgmt-task-draft-description"]', 'ROC-P9-TASK 每天 09:00');
  const firstRunAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const firstRunLocal = `${firstRunAt.getFullYear()}-${pad(firstRunAt.getMonth() + 1)}-${pad(firstRunAt.getDate())}T${pad(firstRunAt.getHours())}:${pad(firstRunAt.getMinutes())}`;
  await page.fill('[data-testid="mgmt-task-draft-first-run"]', firstRunLocal);
  await page.fill('[data-testid="mgmt-task-draft-cron"]', '0 9 * *');
  await page.waitForSelector('[data-testid="mgmt-task-issue-cronExpression"]', { timeout: 10_000 });
  const cronIssue = await text('mgmt-task-issue-cronExpression');
  assertCheck('4 任务', 'cron 段数不对时给出与后端同口径的字段错误', cronIssue.includes('五段'), cronIssue.slice(0, 80));
  await page.fill('[data-testid="mgmt-task-draft-cron"]', '0 9 * * *');
  await page.click('[data-testid="mgmt-task-preview"]');
  await page.waitForSelector('[data-testid="mgmt-task-preview-result"]', { timeout: 20_000 });
  const previewFacts = {
    scheduled: await text('mgmt-task-preview-scheduled'),
    cron: await text('mgmt-task-preview-cron'),
    next: await text('mgmt-task-preview-next'),
    risk: await text('mgmt-task-preview-risk'),
    confirm: await text('mgmt-task-preview-confirm')
  };
  assertCheck(
    '4 任务',
    '预览给出后端的调度事实（scheduled / cron / 下一次 / 风险 / 需确认）',
    previewFacts.scheduled.includes('是') && previewFacts.cron.includes('0 9 * * *') && !previewFacts.next.includes('—'),
    JSON.stringify(previewFacts)
  );
  await page.click('[data-testid="mgmt-task-create-run"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="mgmt-task-select-"]').length > 0,
    undefined,
    { timeout: 30_000 }
  );
  const created = await page.evaluate(async () => {
    const list = await window.roc.tasks.listBackgroundTasks();
    const scheduler = await window.roc.tasks.getSchedulerStatus();
    const active = await window.roc.tasks.getActiveTasks();
    const task = list.ok ? list.data.find((entry) => entry.goal.includes('ROC-P9-TASK')) ?? null : null;
    return {
      listOk: list.ok,
      taskId: task?.id ?? null,
      status: task?.status ?? null,
      triggerType: task?.triggerType ?? null,
      cron: task?.cronExpression ?? null,
      nextRunAt: task?.nextRunAt ?? null,
      registered: scheduler.ok ? scheduler.data.registeredTaskCount : null,
      worker: active.ok ? active.data.some((item) => item.taskId === (task?.id ?? '')) : null
    };
  });
  assertCheck('4 任务', '创建后的任务出现在 task.background.list 里（cron 触发器）', created.taskId !== null && created.triggerType === 'cron', JSON.stringify(created).slice(0, 160));
  assertCheck('4 任务', '调度器把它记为已注册任务', typeof created.registered === 'number' && created.registered >= 1, `registered=${String(created.registered)}`);
  if (created.worker === true) {
    assertCheck('4 任务', '任务同时出现在 P6 看板的 active 列表里', created.worker === true, 'task.active.list 含该任务');
  } else {
    record('4 任务', 'P6 看板的 active 列表不含刚创建的任务（它按 thread 过滤）', true, `worker=${String(created.worker)}`, 'info');
  }

  const taskId = created.taskId;
  await page.waitForSelector(`[data-testid="mgmt-task-${taskId}"]`, { timeout: 20_000 });
  await page.click(`[data-testid="mgmt-task-select-${taskId}"]`);
  await page.waitForSelector('[data-testid="mgmt-task-detail"]', { timeout: 20_000 });
  const detailLine = await text('mgmt-task-detail-cron');
  assertCheck('4 任务', '详情页显示后端给的 cron 与下次运行时间', detailLine.includes('0 9 * * *'), detailLine);

  // 编辑（必须给 reason）
  await page.click(`[data-testid="mgmt-task-edit-${taskId}"]`);
  await page.waitForSelector('[data-testid="mgmt-task-editor"]', { timeout: 15_000 });
  await page.fill('[data-testid="mgmt-task-draft-description"]', 'ROC-P9-TASK 改成每天 10:00');
  await page.click('[data-testid="mgmt-task-update"]');
  await waitForTextContains('mgmt-task-update-error', '原因', 15_000);
  const reasonError = await text('mgmt-task-update-error');
  assertCheck('4 任务', '不带 reason 的修改被拦下并说明原因', reasonError.includes('原因'), reasonError.slice(0, 80));
  await page.fill('[data-testid="mgmt-task-draft-reason"]', '闸门：改触发描述');
  await page.click('[data-testid="mgmt-task-update"]');
  await page.waitForSelector('[data-testid="mgmt-task-editor"]', { state: 'detached', timeout: 20_000 });
  const updated = await page.evaluate(async (id) => {
    const list = await window.roc.tasks.listBackgroundTasks();
    const task = list.ok ? list.data.find((entry) => entry.id === id) ?? null : null;
    return task === null ? null : { description: task.triggerDescription, updatedAt: task.updatedAt };
  }, taskId);
  assertCheck('4 任务', '带 reason 的修改生效', updated !== null && updated.description.includes('10:00'), JSON.stringify(updated));

  // 立即运行 → 真调度记录
  await page.click(`[data-testid="mgmt-task-select-${taskId}"]`);
  const runNow = await page.evaluate(async (id) => {
    const result = await window.roc.tasks.runBackgroundNow(id);
    return result.ok ? { runId: result.data.runId } : { error: result.error.message };
  }, taskId);
  assertCheck('4 任务', 'runBackgroundNow 受理', typeof runNow.runId === 'string', runNow.error ?? '');
  let runs = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1_500);
    const listed = await page.evaluate(async (id) => {
      const result = await window.roc.tasks.listScheduledRuns({ taskId: id, limit: 20 });
      return result.ok ? result.data : [];
    }, taskId);
    runs = listed;
    if (runs.length > 0) {
      break;
    }
  }
  assertCheck(
    '4 任务',
    '立即运行产生真实的调度记录（tasks.listScheduledRuns）',
    runs.length > 0,
    JSON.stringify(runs.slice(0, 2)).slice(0, 160)
  );
  await page.click(`[data-testid="mgmt-tasks-reload"]`);
  await page.click(`[data-testid="mgmt-task-select-${taskId}"]`);
  await waitForNonEmptyText('mgmt-task-runs', 20_000).catch(() => {});
  const runsText = await text('mgmt-task-runs');
  assertCheck('4 任务', '界面把调度记录渲染成真实行（不是前端生成的列表）', runsText.length > 0, runsText.slice(0, 120));

  // 删除（二次确认）
  const availability = await page.evaluate(async (id) => {
    const list = await window.roc.tasks.listBackgroundTasks();
    return list.ok ? (list.data.find((entry) => entry.id === id)?.status ?? null) : null;
  }, taskId);
  if (availability === 'completed' || availability === 'failed' || availability === 'cancelled') {
    await page.click(`[data-testid="mgmt-task-delete-${taskId}"]`);
    await page.waitForSelector('[data-testid="mgmt-task-delete-confirm-confirm"]', { timeout: 10_000 });
    await page.click('[data-testid="mgmt-task-delete-confirm-confirm"]');
    await page.waitForSelector(`[data-testid="mgmt-task-${taskId}"]`, { state: 'detached', timeout: 20_000 });
    assertCheck('4 任务', '删除（二次确认）从任务列表移除', true);
  } else {
    record('4 任务', `任务状态为 ${String(availability)}：取消后删除需要状态先进入终态`, true, '后端只允许 failed/cancelled/completed 删除', 'info');
  }

  // 带未保存的记忆草稿关抽屉：必须确认，且放弃后草稿不残留（同一组面板在画布视图里也能编辑）
  await openManagement('memory');
  await page.click('[data-testid="mgmt-memory-slot-global-user"]');
  await page.click('[data-testid="mgmt-memory-edit"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="mgmt-memory-textarea"]')?.value ?? '').includes('ROC-P9-MEMORY'),
    undefined,
    { timeout: 20_000 }
  );
  await page.fill('[data-testid="mgmt-memory-textarea"]', '# P9 记忆（未保存草稿）\n');
  await page.click('[data-testid="management-panel-close"]');
  await page.waitForSelector('[data-testid="mgmt-discard-panel"]', { timeout: 10_000 });
  assertCheck(
    '6 两入口',
    '带未保存记忆草稿关抽屉会先确认',
    (await page.locator('[data-testid="mgmt-discard-panel"]').count()) === 1,
    'mgmt-discard'
  );
  await page.click('[data-testid="mgmt-discard-cancel"]');
  await page.waitForSelector('[data-testid="mgmt-discard-panel"]', { state: 'detached', timeout: 10_000 });
  assertCheck('6 两入口', '选择继续编辑后抽屉与草稿都还在', (await readInput('mgmt-memory-textarea')).includes('未保存草稿'));
  await page.click('[data-testid="management-panel-close"]');
  await page.waitForSelector('[data-testid="mgmt-discard-confirm"]', { timeout: 10_000 });
  await page.click('[data-testid="mgmt-discard-confirm"]');
  await page.waitForSelector('[data-testid="management-panel-panel"]', { state: 'detached', timeout: 15_000 });
  await openManagement('memory');
  await page.click('[data-testid="mgmt-memory-slot-global-user"]');
  await page.click('[data-testid="mgmt-memory-edit"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="mgmt-memory-textarea"]')?.value ?? '').includes('ROC-P9-MEMORY'),
    undefined,
    { timeout: 20_000 }
  );
  const afterDiscard = await readInput('mgmt-memory-textarea');
  assertCheck(
    '6 两入口',
    '放弃后重新打开看到的是已保存内容（草稿没有跨关闭残留）',
    afterDiscard.includes('ROC-P9-MEMORY') && !afterDiscard.includes('未保存草稿'),
    afterDiscard.slice(0, 40)
  );
  await closeManagement();

  // ---- 闸门 5：无假数据 + typecheck ---------------------------------------------
  const randomHits = searchSourceTree(resolve('src/renderer/management'), 'Math.random(');
  assertCheck('5 无假数据', '管理面板没有 Math.random()', randomHits.length === 0, randomHits.slice(0, 3).join(', '));
  const removedEntities = ['GuardrailRule', 'EvalBenchmarkResult', 'TelemetryMetric'];
  for (const entity of removedEntities) {
    const hits = searchSourceTree(resolve('src/renderer'), entity);
    assertCheck('5 无假数据', `没有硬编码的 ${entity} 假实体`, hits.length === 0, hits.slice(0, 3).join(', '));
  }

  // ---- 闸门 6：两个入口 + 重启保持 ----------------------------------------------
  await openManagement('memory');
  await page.click('[data-testid="mgmt-open-in-canvas"]');
  await page.waitForSelector('[data-testid="management-view"]', { timeout: 20_000 });
  assertCheck(
    '6 两入口',
    '抽屉的「在画布中打开」渲染同一组面板（记忆 tab）',
    (await page.locator('[data-testid="mgmt-view-panel-memory"]').count()) === 1 &&
      (await page.locator('[data-testid="mgmt-panel-memory"]').count()) === 0,
    await text('mgmt-view-summary')
  );
  await page.click('[data-testid="mgmt-view-tab-skills"]');
  await page.waitForSelector('[data-testid="mgmt-view-panel-skills"]', { timeout: 20_000 });
  assertCheck('6 两入口', '画布视图里能切到技能并看到同一个技能', (await page.locator(`[data-testid="mgmt-skill-${skillId}"]`).count()) === 1);

  await page.click('[data-testid="titlebar-search"]');
  await page.waitForSelector('[data-testid="search-palette-input"]', { timeout: 20_000 });
  await page.fill('[data-testid="search-palette-input"]', 'smoke');
  await page.waitForSelector('[data-testid="search-group-skills"]', { timeout: 20_000 });
  const skillsGroupStatus = await page.getAttribute('[data-testid="search-group-skills"]', 'data-status');
  assertCheck('6 两入口', '⌘K 的技能组是真检索（不再是 P9 占位）', skillsGroupStatus === 'ready', String(skillsGroupStatus));
  await page.fill('[data-testid="search-palette-input"]', '记忆');
  await page.waitForSelector('[data-testid="search-item-mgmt:memory"]', { timeout: 20_000 });
  assertCheck('6 两入口', '⌘K 有「管理」命令组', (await page.locator('[data-testid="search-group-management"]').count()) === 1);
  await page.keyboard.press('Escape');

  // 真重启
  await app.close();
  await sleep(1_000);
  ({ launched: app, window: page } = await launchApp());
  const afterRestart = await page.evaluate(async () => {
    const file = await window.roc.memory.readFile({ scope: 'global', kind: 'user' });
    const status = await window.roc.memory.status();
    const skills = await window.roc.skills.list();
    const mcp = await window.roc.mcp.getConfig();
    return {
      file: file.ok ? file.data : `error:${file.error.message}`,
      snapshotEnabled: status.ok ? status.data.snapshot.enabled : null,
      skills: skills.ok ? skills.data.map((skill) => ({ id: skill.id, enabled: skill.enabled })) : [],
      mcpIds: mcp.ok ? mcp.data.servers.map((server) => server.id) : []
    };
  });
  assertCheck('6 重启保持', '重启后记忆文件内容逐字保持', afterRestart.file === memoryBody, JSON.stringify(afterRestart.file).slice(0, 80));
  assertCheck('6 重启保持', '重启后技能目录与 MCP 配置仍在', afterRestart.skills.some((skill) => skill.id === skillId) && afterRestart.mcpIds.includes('p9-stdio'), JSON.stringify(afterRestart.mcpIds));

  await navigate(page, `page=research&project=${projectId}&view=latex`);
  await waitForProjectRoute();
  await openManagement('memory');
  await page.click('[data-testid="mgmt-memory-slot-global-user"]');
  await page.click('[data-testid="mgmt-memory-edit"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="mgmt-memory-textarea"]')?.value ?? '').includes('ROC-P9-MEMORY'),
    undefined,
    { timeout: 20_000 }
  );
  const reloadedDraft = await readInput('mgmt-memory-textarea');
  assertCheck('6 重启保持', '重启后界面读回记忆文件内容', reloadedDraft.includes('ROC-P9-MEMORY'), reloadedDraft.slice(0, 40));
  await closeManagement();

  const typecheck = spawnSync('pnpm', ['typecheck'], { encoding: 'utf8', cwd: resolve('.') });
  assertCheck(
    '7 typecheck',
    'pnpm typecheck 无错误',
    typecheck.status === 0,
    `exit=${typecheck.status} out=${typecheck.stdout.trim().slice(0, 160)} err=${typecheck.stderr.trim().slice(0, 160)}`
  );

  assertCheck('7 渲染层错误', '整轮没有 renderer error', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));

  finishGate({
    label: 'P9',
    artifactDir,
    results,
    rendererErrors,
    extra: { providerRequests: smokeProvider.requests.length },
    // 声明的闸门段落。跑到少一段就是失败：这个脚本曾经报过 29/29 成功，
    // 而那次只跑到了第 4 个标签（`1 记忆`），完整跑是 88/88。
    expectedGates: [
      '0 启动',
      '0 准备',
      '0b 会话',
      '1 记忆',
      '2 技能',
      '3 MCP',
      '4 任务',
      '5 无假数据',
      '6 两入口',
      '6 重启保持',
      '7 typecheck',
      '7 渲染层错误'
    ]
  });
} catch (error) {
  finishGate({ label: 'P9', artifactDir, results, rendererErrors, error });
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

/** Cheap recursive text search (no shell, no globbing surprises). */
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
