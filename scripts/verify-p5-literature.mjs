import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';

/**
 * P5 验收闸门的自动化实测（真应用 / 真 IPC / 真文档解析 / 真索引 / 真检索）。
 *
 * 为什么需要它：P5 的闸门描述的全是**运行时事实** —— 一篇真 PDF 是否真的被
 * MinerU（docling）解析出章节 + 公式 + 表格、索引是否真的扫到工作目录里的文件、
 * 检索命中是否真的能跳回原文位置、空项目下 Wiki/图谱是否真的不画示意数据。
 * 静态阅读与单测都不覆盖这些（P3/P4 的实测已经证明：类型正确、单测全绿、
 * 用户看到的仍可能是坏的）。
 *
 * 三条与 P4 不同的口径，都写在这里避免下一轮误判：
 *
 *   1. **前置检查决定闸门 1/2 走哪条路。** `research.models.status` 未就绪时
 *      `research.document.parse` 只会失败（`research_models_unavailable`），所以
 *      harness 先读真实状态，再选「真解析」或「断言真实降级文案 + 用其它路径覆盖
 *      其余断言」；两条路都是断言，不是「跳过」。
 *   2. **文档导入走 IPC，不点文件选择器。** smoke 模式下
 *      `files.selectFromDialog`（src/main/ipc/files-ipc.ts）返回固定的
 *      `<workspace>/assets/smoke-image.png`，因此**无法**用它选中夹具 PDF。
 *      导入这一步用 `research.document.import`；对话框本身按它能做的事断言
 *      （5 个 tab、题名/citationKey 必填、选择器回填、手工录入真写库）。
 *   3. **索引不重复解析 PDF。** 索引的 docling 分支与闸门 1 的 `document.parse`
 *      是**同一个** `ResearchToolchain.parseDocument` 调用，再跑一遍要多花 ~2 分钟
 *      而没有新覆盖。索引闸门改用真实可索引的 markdown 文件（快、确定），并把它
 *      真实报告两个坏文件（种子里那对占位 PDF/PNG）当作失败可见性的证据。
 *
 * 运行（必须 `ROC_SMOKE_TARGET=dist`，且先删产物再 build）：
 *   rm -rf dist/renderer && pnpm build
 *   node scripts/verify-p5-literature.mjs
 *
 * 解析一轮在 CPU 上约 2 分钟，整轮约 5–10 分钟，**必须 detach 跑**（P4 的教训：
 * 前台跑会被工具超时杀掉进程组）。报告与截图写 `.artifacts/p5-gates/`。
 */

const artifactDir = resolve('.artifacts/p5-gates');
mkdirSync(artifactDir, { recursive: true });

const results = [];
/**
 * `kind: 'info'` marks a record that **reports an observation** rather than asserting
 * one (which route was taken, what the parse cost). They are printed and stored like
 * everything else, but the summary below counts them separately — a headline of
 * 「59/59 通过」 must not read as "59 things were asserted" when some of them were
 * merely narrated (评审 P2).
 */
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

/** 闸门 1 的夹具：真 PDF，含一个章节标题、一个独立成行的公式、一个带边框的表格。 */
const fixturePdf = resolve('tests/smoke/lib/assets/p5-paper.pdf');
/** 索引闸门的 markdown 夹具（P5 自己写进工作区，不动 seedSmokeWorkspace）。 */
const indexNoteRelativePath = 'p5-notes.md';
const indexNoteMarker = 'ROC-P5-FILE-HIT';
/** 文案标记：让检索/搜索断言只可能命中本项目自己造的数据。 */
const paperTitleMarker = 'ROC-P5-GATE-PAPER';
const paperCitationKey = 'rocP5GatePaper';
const paperFormulaPhrase = 'Deep learning has transformed scientific discovery';
/**
 * 会话检索的标记。
 *
 * 写在**助手回复**里而不是用户提问里：`agent.sessions.search` 查的是
 * `session_messages`，而 main 只往这张表写两类行 —— run 完成时的助手消息，
 * 以及提问中断被回答时的用户消息（見 session-repository.ts）。普通用户提问只进
 * `agent_events`（转录用），所以拿提问文本去搜是搜不到的。
 *
 * 用 P4 夹具的 slow 模式生成带唯一 tag 的流式文本，助手消息就带上这个标记。
 */
const sessionMarker = 'ROC-P5-SESSION-HIT';
const sessionRunTag = `${sessionMarker}-RUN1`;

const smokeModelId = 'p5-smoke-model';
const smokeProviderId = 'p5-smoke-provider';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;

/** docling CPU 一轮 ≈ 2 分钟；给足余量，但不要无限等。 */
const parseTimeoutMs = 20 * 60_000;

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);

const smokeProvider = await startSmokeProvider({});
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`P5 验收闸门实测 · target=${target.kind} · renderer=next · fixture=${fixturePdf}\n`);

let app;
const rendererErrors = [];
/**
 * B17 绕行的构建入口路径（try 之外声明：finally 要把它恢复回去）。
 *
 * 绕行用**改名**而不是删除：上一轮如果被中途杀掉，改名会留下
 * `*.b17-disabled` 让下一轮自愈，而 `rm` 会让下一轮看到一个不完整的构建。
 */
const jobCliPath = resolve('dist/main/research-job-cli.js');
const jobCliDisabledPath = `${jobCliPath}.b17-disabled`;
if (!existsSync(jobCliPath) && existsSync(jobCliDisabledPath)) {
  renameSync(jobCliDisabledPath, jobCliPath);
  console.log(`（自愈）上一轮 B17 绕行留下的 ${jobCliDisabledPath} 已恢复为 ${jobCliPath}`);
}
let jobCliDisabledByRun = false;

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

async function openLiteratureHub(page, projectId) {
  await navigate(page, `page=research&project=${projectId}&view=literature`);
  await page.waitForSelector('[data-testid="literature-hub"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="literature-list"]', { timeout: 30_000 });
}

/**
 * Selects a library item through the **sidebar** tab.
 *
 * Two `LibraryList` instances render the same `literature-row-<id>` testid (the
 * sidebar tab and the canvas hub both read the shared store), so the row is
 * scoped to the sidebar for clicking — and that is also the stronger assertion:
 * the selection must travel from the sidebar to the canvas through the store.
 */
async function selectLibraryItemViaSidebar(page, itemId) {
  if ((await page.locator('[data-testid="sidebar-panel-literature"]').count()) === 0) {
    await page.click('[data-testid="sidebar-tab-literature"]');
  }
  const selector = `[data-testid="sidebar-panel-literature"] [data-testid="literature-row-${itemId}"]`;
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.click(selector);
}

/** 等待某个 testid 出现并返回它是否出现过（用于可观察状态的断言，而不是静默等待）。 */
async function appears(page, selector, timeoutMs) {
  return await page
    .waitForSelector(selector, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/** 等待一个元素属性变成期望值，超时后把实际值写进 detail。 */
async function waitForAttribute(page, selector, attribute, expected, timeoutMs, gate, name) {
  const deadline = Date.now() + timeoutMs;
  let actual = null;
  while (Date.now() < deadline) {
    const node = page.locator(selector);
    if ((await node.count()) > 0) {
      actual = await node.first().getAttribute(attribute);
      if (actual === expected) {
        return actual;
      }
    }
    await page.waitForTimeout(200);
  }
  fail(gate, name, `${selector} 的 ${attribute} 期望 ${expected}，实际 ${actual}`);
  return actual;
}

/**
 * 等一个元素的**文本**满足条件，返回最后一次读到的文本。
 *
 * 存在的理由不是“多等一会”，而是这些界面里的文本都是**异步动作的结果**：选文件要过
 * 一次 IPC（`files.selectFromDialog`），索引计数要过一次轮询。`click` 之后立刻读会
 * 读到点击前的值，把真实功能误报成坏的（P4 的教训：等待必须等在一个可观察状态上）。
 */
async function waitForText(page, selector, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    const node = page.locator(selector);
    if ((await node.count()) > 0) {
      text = (await node.first().textContent()) ?? '';
      if (predicate(text)) {
        return text;
      }
    }
    await page.waitForTimeout(250);
  }
  return text;
}

/** 同上，但读的是输入框的 value（受控输入的写入也不是同步的）。 */
async function waitForInputValue(page, selector, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = '';
  while (Date.now() < deadline) {
    const node = page.locator(selector);
    if ((await node.count()) > 0) {
      value = await node.first().inputValue();
      if (predicate(value)) {
        return value;
      }
    }
    await page.waitForTimeout(200);
  }
  return value;
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
  // Electron 的 Local Storage 跨轮复用（P4 的教训）：先清干净再 reload，避免上一轮
  // 留下的 `roc.ui.*` 决定这一轮的初始状态。
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  assertCheck('0 启动', '新壳在 smoke 模式下启动', (await page.getAttribute('[data-testid="roc-app"]', 'data-mode')) === 'smoke');

  // ---- 闸门 0：前置检查（决定闸门 1/2 的路线） --------------------------------
  const preflight = await page.evaluate(async () => {
    const models = await window.roc.research.getModelsStatus();
    const toolchain = await window.roc.research.getToolchainStatus();
    return {
      models: models.ok ? models.data : { error: models.error.message },
      toolchain: toolchain.ok ? toolchain.data : { error: toolchain.error.message }
    };
  });
  const modelsReady = preflight.models.ready === true;
  const modelsStatus = preflight.models;
  record(
    '0 前置检查',
    `research.models.status（${modelsReady ? '就绪' : '未就绪'}）`,
    true,
    modelsReady
      ? `models=${modelsStatus.models.map((entry) => `${entry.directory}=${entry.ready}`).join(',')}`
      : `error=${modelsStatus.error ?? 'unknown'} models=${modelsStatus.models.length}`,
    'info'
  );
  assertCheck(
    '0 前置检查',
    'research.toolchain.status 可用（解析走 Python 工具链）',
    preflight.toolchain.available === true,
    `available=${preflight.toolchain.available} versions=${JSON.stringify(preflight.toolchain.versions ?? null)} error=${preflight.toolchain.error ?? 'null'}`
  );
  record(
    '0 前置检查',
    modelsReady ? '闸门 1 路线：真解析（MinerU/docling）' : '闸门 1 路线：断言真实降级文案 + 其余断言走索引/派生路径',
    true,
    modelsReady ? '真 PDF → 真解析 → 阅读器章节/公式/表格' : '解析模型未装：document.parse 只会失败，断言失败态与模型提示',
    'info'
  );

  // ---- 闸门 0：文献导入前置（dev/dist 构建的 JS 作业 CLI 沙箱缺口） -------------
  //
  // `research.library.importRecord` / `importFile` / `document.import(target:'new-item')`
  // 都经过 `ResearchToolchain.normalizeBibliography`，它在 `dist/main/research-job-cli.js`
  // **存在**时走独立子进程（`job()`），否则回退到 main 内的 `jobInProcess()`。
  //
  // 实测（P5，2026-10-15）：dev/dist 构建下子进程走不通 —— 沙箱 profile 只放行了
  // `dist/main`、pdfjs-dist、canvas、Electron 目录，于是：
  //   ① node 的模块加载器要读最近的 package.json 判断模块类型 → `<repo>/package.json` 被拒；
  //   ② 外部化的 `zod` 等依赖也在 node_modules 里 → 同样被拒。
  // 结果是子进程 stdout 为空 → `research_json_invalid` → 界面只看到“Roc 内部错误”。
  // 打包构建不受影响：asar 在 `Roc.app/Contents` 下，整个 bundle 都在放行范围内。
  // 已登记后端任务单 B17（不在本迁移内改 `src/main`）。
  //
  // harness 的处理：先拿**真实调用**测一次；失败则删掉这个构建入口，让 main 走它
  // 自己的 in-process 回退（同一批操作的另一个实现，main 显式支持），跑完再恢复。
  // 两条路都要断言，不得默认可用。
  const bibliographyProbe = async () =>
    await page.evaluate(async () => {
      const now = new Date().toISOString();
      const result = await window.roc.research.importLibraryRecord({
        record: {
          id: 'local:manual:rocP5PreflightProbe',
          source: 'local',
          externalId: 'rocP5PreflightProbe',
          doi: null,
          title: 'ROC-P5-PREFLIGHT-PROBE',
          authors: [],
          abstract: null,
          publishedYear: null,
          citationCount: null,
          url: null,
          openAccessUrl: null,
          importedAt: now,
          updatedAt: now
        },
        citationKey: 'rocP5PreflightProbe',
        projectId: null
      });
      return result.ok ? { ok: true } : { ok: false, code: result.error.code, message: result.error.message };
    });

  let probe = await bibliographyProbe();
  // 报告里必须留下**第一次探测**的真实结果：只看绕行后的 probe 会把 B17 记成
  // 「available」，等于把后端缺陷从证据里抹掉（本 harness 第一版就是这么错的）。
  let bibliographyImport = probe.ok ? 'available-via-cli' : null;
  let bibliographyProbeError = probe.ok ? null : `${probe.code}: ${probe.message}`;
  if (!probe.ok) {
    record(
      '0 前置检查',
      `文献导入前置不可用（${probe.code}）—— 命中 B17（dev/dist 的 JS 作业 CLI 沙箱缺口）`,
      true,
      probe.message,
      'info'
    );
    if (!existsSync(jobCliPath)) {
      // 构建产物不在时不许“凑合跑”：那时 in-process 回退是唯一实现，这一轮就测不到
      // 真正会被打包发布的那条路径（P3 的教训：拿过期的/不完整的目标跑出来的绿不算绿）。
      fail(
        '0 前置检查',
        '文献导入前置',
        `${jobCliPath} 不存在：构建不完整（重新 build 后再跑）。`
      );
    }
    renameSync(jobCliPath, jobCliDisabledPath);
    jobCliDisabledByRun = true;
    probe = await bibliographyProbe();
    bibliographyImport = probe.ok ? 'blocked(B17) -> in-process fallback' : null;
    assertCheck(
      '0 前置检查',
      '移除 JS 作业 CLI 后 main 的 in-process 回退能完成 bibliography 作业（B17 绕行）',
      probe.ok,
      probe.ok ? `cli 已改名为 ${jobCliDisabledPath}` : `${probe.code}: ${probe.message}`
    );
  } else {
    assertCheck(
      '0 前置检查',
      'build 产出了 JS 作业 CLI 入口（否则这一轮测的是回退路径，不是发布形态）',
      existsSync(jobCliPath),
      jobCliPath
    );
    record('0 前置检查', '文献导入前置可用（JS 作业 CLI 子进程路径正常）', true, '', 'info');
  }

  // ---- 闸门 0：provider / 默认模型（闸门 6 需要真会话） -------------------------
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
          name: 'P5 Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: `secret:${providerId}`,
          enabled: true,
          models: [
            {
              id: modelId,
              displayName: 'P5 Smoke Model',
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
        permissions: current.data.permissions
      });
      if (!saved.ok) {
        return { error: saved.error.message };
      }
      const secret = await window.roc.settings.setProviderSecret({ providerId, plaintext: 'smoke-test-key' });
      if (!secret.ok) {
        return { error: secret.error.message };
      }
      const afterSecret = await window.roc.settings.get();
      if (!afterSecret.ok) {
        return { error: afterSecret.error.message };
      }
      return { defaultModelId: afterSecret.data.defaultModelId };
    },
    { providerId: smokeProviderId, modelId: smokeModelId, modelKey: smokeModelKey, endpoint: smokeProvider.endpoint }
  );
  if (configured.error !== undefined) {
    fail('0 准备', '配置 provider 与默认模型', configured.error);
  }
  assertCheck('0 准备', '默认模型指向 smoke provider', configured.defaultModelId === smokeModelKey, configured.defaultModelId);

  const projectResult = await page.evaluate(
    async ({ workspacePath }) =>
      await window.roc.research.createProject({
        title: 'ROC-P5-GATE-PROJECT',
        description: 'P5 literature acceptance gate harness project.',
        workspacePath
      }),
    { workspacePath: workspaceRoot }
  );
  if (!projectResult.ok) {
    fail('0 准备', '创建项目', projectResult.error.message);
  }
  const projectId = projectResult.data.id;

  // 索引闸门的真实内容：一份可索引的 markdown（`.txt` 不在默认 kinds 里）。
  mkdirSync(join(workspaceRoot, 'notes'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, indexNoteRelativePath),
    `# P5 索引夹具\n\n${indexNoteMarker} 这一行用来验证真实索引、真实命中与跳回来源文件。\n\n第二段：图检索与向量检索都由后端完成。\n`,
    'utf8'
  );

  /**
   * 确认后端真的被限定在项目工作目录上。
   *
   * 这不是多余的：smoke 模式下 `files.selectFromDialog` 会回填
   * `<当前工作目录>/assets/smoke-image.png`，而“当前工作目录”来自
   * `workspace.getCurrent()`。未绑定时它会回落到真的原生对话框 —— 那会让整轮
   * 卡在一个打不开的对话框上（而不是报错）。渲染层自己会绑（`useBoundWorkspace`），
   * 这里只是把依赖变成一个断言。
   */
  const binding = await page.evaluate(
    async ({ workspacePath }) => {
      const before = await window.roc.workspace.getCurrent();
      if (before.ok && before.data?.path === workspacePath) {
        return { path: before.data.path, retried: false };
      }
      await window.roc.workspace.select({ path: workspacePath });
      const after = await window.roc.workspace.getCurrent();
      return { path: after.ok ? (after.data?.path ?? null) : `error:${after.error.message}`, retried: true };
    },
    { workspacePath: workspaceRoot }
  );
  assertCheck(
    '0 准备',
    '后端工作目录绑定到项目目录（files.selectFromDialog 的 smoke 回填依赖它）',
    binding.path === workspaceRoot,
    `path=${binding.path} retried=${binding.retried}`
  );

  // ---- 闸门 0（收尾）：造一条真会话（闸门 6 的 ⌘K 会话分组要用它） --------------
  //
  // 放在这里有两个理由：① 会话检索断言与 palette 断言因此可以分开报告；
  // ② **此时 app 还没做解析/索引** —— 实测发现在重活之后 `chat.startRun` 会偶发卡在
  // context maintenance 的 persist 阶段（provider 一个请求都收不到，且随后每轮都卡），
  // 见后端任务单 B18。这一条放在早期是**有意的顺序选择**，不是绕过断言：
  // B18 本身由闸门 2 之后的探针盯着，卡住时会把权威事件流留在报告里。
  await installRunEventTap(page);
  const sessionRun = await runScriptedSession(page, {
    projectId,
    tag: sessionRunTag,
    prompt: '闸门 6：慢流制造一条可检索的会话消息。'
  });
  if (!sessionRun.ok) {
    await recordStalledRun(page, sessionRun, '6 ⌘K');
  }
  const sessionSearchable = await page.evaluate(async ({ marker }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await window.roc.sessions.search({ query: marker, workspaceScope: 'all', limit: 10 });
      if (!result.ok) {
        return { total: 0, role: null, error: result.error.message };
      }
      if (result.data.total > 0) {
        return { total: result.data.total, role: result.data.items[0]?.role ?? null, error: null };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { total: 0, role: null, error: null };
  }, { marker: sessionMarker });

  if (sessionRun.ok) {
    assertCheck(
      '6 ⌘K',
      '真会话跑完（run_completed），助手消息带检索标记',
      true,
      `threadId=${sessionRun.threadId} providerRequests=${sessionRun.providerRequests}`
    );
    assertCheck(
      '6 ⌘K',
      '闸门 6：agent.sessions.search 能检索到这条真会话（持久化的助手消息，不是提问）',
      sessionSearchable.total > 0,
      `total=${sessionSearchable.total} role=${sessionSearchable.role}`
    );
  } else {
    /**
     * 降级路线（照闸门 1 的模型前置写法：两条路都要断言，不是跳过）。
     *
     * B18：本 app 会话里 chat run 卡住 → 不可能造出可检索的会话消息。此时**不放宽**
     * 能测的那部分：`agent.sessions.search` 必须仍然可用（无错误地返回结果），
     * ⌘K 的会话分组必须在闸门 6 里仍然是 `ready`（不是 unavailable/loading）。
     * 「内容能搜到」这一条只能在 B18 修好后回到上面那条断言 —— 它没有被删掉，
     * 只是当前环境走不到。
     */
    record(
      '6 ⌘K',
      'B18：chat run 卡住，本轮 app 会话里没有可检索的会话消息 —— 会话闸门降级为「接线可用」断言',
      true,
      `events=[${sessionRun.events.join(', ')}] providerRequests=${sessionRun.providerRequests}`,
      'info'
    );
    assertCheck(
      '6 ⌘K',
      'agent.sessions.search 仍可用（B18 降级路线：无错误地返回结果）',
      sessionSearchable.error === null,
      sessionSearchable.error ?? `total=${sessionSearchable.total}`
    );
  }

  // ---- 闸门 1：导入对话框（真实 UI 断言） ------------------------------------
  await openLiteratureHub(page, projectId);
  await page.click('[data-testid="literature-hub-import"]');
  await page.waitForSelector('[data-testid="literature-import-dialog"]', { timeout: 20_000 });
  const tabs = await page.locator('[data-testid^="literature-import-tab-"]').count();
  assertCheck('1 导入 UI', '导入弹窗提供 5 条真实路径（文档 / DOI / 参考文献文件 / 手工录入 / 检索）', tabs === 5, `tabs=${tabs}`);
  assertCheck(
    '1 导入 UI',
    '新条目导入要求先给题名 + citationKey（契约如此）',
    await page.locator('[data-testid="literature-import-document-submit"]').isDisabled(),
    ''
  );
  await page.fill('[data-testid="literature-import-document-title"]', `${paperTitleMarker} 手工派生的题名`);
  const derivedKey = await waitForInputValue(page, '[data-testid="literature-import-document-key"]', (value) => value.length > 0, 10_000);
  assertCheck('1 导入 UI', '题名推导出符合 schema 的 citationKey', derivedKey.length > 0, derivedKey);
  await page.click('[data-testid="literature-import-pick-document"]');
  const pickedPath = await waitForText(
    page,
    '[data-testid="literature-import-document-path"]',
    (text) => text.includes('smoke-image.png'),
    20_000
  );
  assertCheck(
    '1 导入 UI',
    '选择文件走 files.selectFromDialog（smoke 下回填固定的 assets/smoke-image.png）',
    pickedPath.includes('smoke-image.png'),
    pickedPath.trim()
  );
  assertCheck(
    '1 导入 UI',
    '本地按白名单标出文档类型（PNG → 图片）',
    pickedPath.includes('图片'),
    pickedPath.trim()
  );
  // 手工录入：真写库，且必须出现在**共享 store** 的两个界面里（侧栏 tab + 画布列表）。
  await page.click('[data-testid="literature-import-tab-manual"]');
  await page.fill('[data-testid="literature-import-manual-title"]', 'ROC-P5-MANUAL-RECORD 手工录入');
  await page.fill('[data-testid="literature-import-manual-year"]', '2024');
  await page.fill('[data-testid="literature-import-manual-key"]', 'rocP5ManualRecord');
  await page.click('[data-testid="literature-import-manual-submit"]');
  const importMessage = await page
    .waitForSelector('[data-testid="literature-import-message"]', { timeout: 30_000 })
    .then(async (node) => (await node.textContent()) ?? '')
    .catch(() => '');
  assertCheck('1 导入 UI', '手工录入真的写入文献库（importRecord）', importMessage.includes('已导入'), importMessage.trim());
  await page.click('[data-testid="literature-import-dialog-close"]');
  await page.waitForTimeout(500);
  const manualId = await page.evaluate(async () => {
    const listed = await window.roc.research.listLibrary({
      projectId: null,
      query: 'ROC-P5-MANUAL-RECORD',
      includeArchived: false,
      limit: 20
    });
    return listed.ok ? (listed.data[0]?.id ?? null) : `error:${listed.error.message}`;
  });
  assertCheck('1 导入 UI', '新条目在服务端检索里可查到', typeof manualId === 'string' && !manualId.startsWith('error:'), String(manualId));
  const hubRowCount = await page.locator(`[data-testid="literature-hub"] [data-testid="literature-row-${manualId}"]`).count();
  assertCheck('1 导入 UI', '画布 hub 的列表渲染了这条（共享 store）', hubRowCount >= 1, `rows=${hubRowCount}`);
  // 侧栏的文献列表只在文献 tab 挂载；两侧同时存在即“一个 store、两处渲染”的结构性证据。
  await page.click('[data-testid="sidebar-tab-literature"]');
  const sidebarRowCount = await waitForText(
    page,
    '[data-testid="literature-count"]',
    (text) => text.includes('1 条'),
    20_000
  );
  const bothSurfacesCount = await page.locator(`[data-testid="literature-row-${manualId}"]`).count();
  assertCheck(
    '1 导入 UI',
    '同一条文献在侧栏 tab 与画布 hub 两个界面都渲染（共享 store，不是第二份状态）',
    bothSurfacesCount >= 2,
    `rows=${bothSurfacesCount} sidebarCount="${sidebarRowCount.trim()}"`
  );

  // ---- 闸门 1：真 PDF 导入 → 真解析 → 阅读器（章节 / 公式 / 表格） --------------
  const imported = await page.evaluate(
    async ({ sourcePath, title, citationKey, project }) =>
      await window.roc.research.importDocument({ target: 'new-item', sourcePath, title, citationKey, projectId: project }),
    { sourcePath: fixturePdf, title: `${paperTitleMarker} 验收论文`, citationKey: paperCitationKey, project: projectId }
  );
  if (!imported.ok) {
    fail('1 真解析', '导入夹具 PDF', imported.error.message);
  }
  const documentId = imported.data.id;
  record('1 真解析', '真实 PDF 导入（research.document.import）', true, `documentId=${documentId} size=${imported.data.size} mediaType=${imported.data.mediaType}`);
  assertCheck('1 真解析', '导入后状态为 imported（尚未解析）', imported.data.status === 'imported', imported.data.status);

  const libraryItemId = imported.data.libraryItemId;
  if (libraryItemId === null) {
    fail('1 真解析', '导入创建了文献库条目', 'libraryItemId=null');
  }
  await navigate(page, `page=research&project=${projectId}&view=literature`);
  await page.waitForSelector('[data-testid="literature-hub"]', { timeout: 30_000 });
  // 这次导入是 harness 直接调的 IPC（不是列表的导入按钮），所以 store 里的列表还是旧的：
  // 点一次真实的「重新读取文献库」，而不是假设它会自己刷新。
  await page.click('[data-testid="literature-refresh"]');
  await selectLibraryItemViaSidebar(page, libraryItemId);
  await page.waitForSelector('[data-testid="paper-reader"]', { timeout: 20_000 });
  const readerTitle = (await page.textContent('[data-testid="reader-title"]')) ?? '';
  assertCheck('1 真解析', '阅读器显示真实题名', readerTitle.includes(paperTitleMarker), readerTitle.trim());
  const readerKey = (await page.textContent('[data-testid="reader-citation-key"]')) ?? '';
  assertCheck('1 真解析', '阅读器显示真实 citationKey', readerKey.trim() === paperCitationKey, readerKey.trim());
  await waitForAttribute(page, '[data-testid="reader-document-status"]', 'data-status', 'imported', 20_000, '1 真解析', '解析前状态可读');
  if (modelsReady) {
    await page.click('[data-testid="reader-start-parse"]');
    await waitForAttribute(page, '[data-testid="reader-document-status"]', 'data-status', 'parsing', 60_000, '1 真解析', '解析中状态由后端 run 驱动');
    record('1 真解析', '解析中状态来自后端 run 且由轮询驱动（不是假进度）', true, 'status=parsing');
    await page.screenshot({ path: join(artifactDir, '01-parsing.png') });

    // 真的点一次取消。只观察到 `parsing` 只能证明「取消按钮被渲染出来了」，
    // 证明不了取消这条路通 —— 而取消是 T5.3 明列的交付项（评审 P1）。
    await page.click('[data-testid="reader-cancel-parse"]');
    await waitForAttribute(page, '[data-testid="reader-document-status"]', 'data-status', 'cancelled', 60_000, '1 真解析', '取消后的状态来自后端');
    assertCheck(
      '1 真解析',
      '取消后不再显示取消按钮、回到可再次解析（说明后端 run 真的被中止）',
      (await page.locator('[data-testid="reader-cancel-parse"]').count()) === 0 &&
        (await appears(page, '[data-testid="reader-start-parse"]', 10_000)),
      ''
    );
    await page.screenshot({ path: join(artifactDir, '01-cancelled.png') });

    // 再解析一次：闸门 1 要的是 `ready` 的解析结果，取消只覆盖了取消路径。
    await page.click('[data-testid="reader-start-parse"]');
    await waitForAttribute(page, '[data-testid="reader-document-status"]', 'data-status', 'parsing', 60_000, '1 真解析', '取消后能再次进入 parsing');
  } else {
    await page.click('[data-testid="reader-start-parse"]');
  }

  const parseStartedAt = Date.now();

  // ---- 闸门 3：静态断言（前端没有旧壳的假检索/假流水线） -----------------------
  const forbidden = ['executeTriPathRRFRetrieval', 'deduplicateAndMergePapers', 'executeMinerUPipeline', 'MINERU_PIPELINE_STAGES'];
  const forbiddenHits = [];
  for (const file of listSourceFiles('src/renderer')) {
    // 先剔注释：这几个名字现在只出现在“已删除 / 契约里没有”的说明里，注释不可能
    // 实现假检索；不剔注释的话，解释“这些假实现已经没了”的注释反而会让闸门变红。
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const needle of forbidden) {
      if (code.includes(needle)) {
        forbiddenHits.push(`${file}:${needle}`);
      }
    }
  }
  assertCheck(
    '3 无假实现',
    `src/renderer 的**代码**里没有 ${forbidden.join(' / ')}（注释不算）`,
    forbiddenHits.length === 0,
    forbiddenHits.join(', ')
  );
  const legacyFiles = ['src/renderer/literature/ragEngine.ts', 'src/renderer/literature/mineruParser.ts']
    .filter((path) => existsSync(path));
  assertCheck('3 无假实现', 'ragEngine.ts / mineruParser.ts 不存在', legacyFiles.length === 0, legacyFiles.join(', '));
  const objectUrlHits = listSourceFiles('src/renderer').filter((file) => /URL\.createObjectURL\s*\(/u.test(stripComments(readFileSync(file, 'utf8'))));
  assertCheck('3 无假实现', 'renderer 里没有 Blob URL（PDF 走 files.preview* 协议）', objectUrlHits.length === 0, objectUrlHits.join(', '));

  // ---- 闸门 5：派生函数单测（纯函数 + 稳定输出） -------------------------------
  // node --test 的摘要行是 `ℹ pass N` / `ℹ fail N`（不是 TAP 的 `# pass N`）；
  // 计数只用于 detail，判定以退出码为准。
  const unitSummary = (output) => ({
    pass: /\bpass (\d+)/u.exec(output)?.[1] ?? '?',
    fail: /\bfail (\d+)/u.exec(output)?.[1] ?? '?'
  });
  const deriveTests = spawnSync('node', ['--test', 'tests/unit/renderer-derive.test.mjs'], {
    cwd: resolve('.'),
    encoding: 'utf8'
  });
  const deriveOutput = `${deriveTests.stdout ?? ''}${deriveTests.stderr ?? ''}`;
  const deriveSummary = unitSummary(deriveOutput);
  assertCheck(
    '5 派生单测',
    'derive-wiki / derive-graph 单测通过（含空输入=空投影、同输入输出稳定）',
    deriveTests.status === 0 && deriveSummary.fail === '0' && deriveSummary.pass !== '0',
    `pass=${deriveSummary.pass} fail=${deriveSummary.fail}`
  );
  const literatureTests = spawnSync('node', ['--test', 'tests/unit/renderer-literature.test.mjs', 'tests/unit/renderer-parse-blocks.test.mjs'], {
    cwd: resolve('.'),
    encoding: 'utf8'
  });
  const literatureSummary = unitSummary(`${literatureTests.stdout ?? ''}${literatureTests.stderr ?? ''}`);
  assertCheck(
    '5 派生单测',
    'literature / parse-blocks 单测通过',
    literatureTests.status === 0 && literatureSummary.fail === '0' && literatureSummary.pass !== '0',
    `pass=${literatureSummary.pass} fail=${literatureSummary.fail}`
  );

  // ---- 闸门 4：空项目下 Wiki / 图谱是空态，不画示意数据 ------------------------
  const emptyProject = await page.evaluate(
    async ({ workspacePath }) =>
      await window.roc.research.createProject({
        title: 'ROC-P5-EMPTY-PROJECT',
        description: 'P5 empty-data gate project.',
        workspacePath
      }),
    { workspacePath: remoteRoot }
  );
  if (!emptyProject.ok) {
    fail('4 空数据', '创建第二个（空）项目', emptyProject.error.message);
  }
  const emptyProjectId = emptyProject.data.id;
  await openLiteratureHub(page, emptyProjectId);
  await page.click('[data-testid="literature-subview-wiki"]');
  const wikiEmpty = await appears(page, '[data-testid="wiki-empty"]', 30_000);
  const wikiViewCount = await page.locator('[data-testid="wiki-view"]').count();
  assertCheck('4 空数据', '空项目的知识库显示空态（没有示意概念页）', wikiEmpty && wikiViewCount === 0, `empty=${wikiEmpty} view=${wikiViewCount}`);
  const wikiText = (await page.textContent('[data-testid="wiki-empty"]')) ?? '';
  assertCheck('4 空数据', '空态文案说明先导入文献/捕获证据', wikiText.includes('先导入文献'), wikiText.trim().slice(0, 60));
  await page.click('[data-testid="literature-subview-graph"]');
  const graphEmpty = await appears(page, '[data-testid="graph-empty"]', 30_000);
  const graphCount = await page.locator('[data-testid="knowledge-graph"]').count();
  assertCheck('4 空数据', '空项目的图谱显示空态（不画力导向示意图）', graphEmpty && graphCount === 0, `empty=${graphEmpty} graph=${graphCount}`);
  await page.click('[data-testid="literature-subview-rag"]');
  const ragEmptyFiles = await appears(page, '[data-testid="rag-no-files"]', 30_000);
  const ragCounts = (await page.textContent('[data-testid="rag-counts"]')) ?? '';
  assertCheck('4 空数据', '空项目的 RAG 显示真实的 0 文件，而不是假分块', ragEmptyFiles && /\u6587\u4ef6 0/u.test(ragCounts), ragCounts.trim());
  await page.screenshot({ path: join(artifactDir, '04-empty-state.png') });

  // ---- 回到闸门 1：等真解析完成 -------------------------------------------------
  await navigate(page, `page=research&project=${projectId}&view=literature`);
  await page.waitForSelector('[data-testid="literature-hub"]', { timeout: 30_000 });
  // 切项目不会重置子视图选择（它是组件状态），刚才停在 RAG：显式回到阅读器。
  await page.click('[data-testid="literature-subview-reader"]');
  await selectLibraryItemViaSidebar(page, libraryItemId);
  await page.waitForSelector('[data-testid="paper-reader"]', { timeout: 20_000 });

  const documentStatus = await waitForAttribute(
    page,
    '[data-testid="reader-document-status"]',
    'data-status',
    modelsReady ? 'ready' : 'failed',
    parseTimeoutMs,
    '1 真解析',
    modelsReady ? '解析完成（后端 run=ready）' : '解析按真实降级失败'
  );
  const parseSeconds = Math.round((Date.now() - parseStartedAt) / 1000);
  record('1 真解析', `解析结束状态 = ${documentStatus}（用时 ${parseSeconds}s）`, true, '');

  if (modelsReady) {
    await page.waitForSelector('[data-testid="reader-blocks"]', { timeout: 60_000 });
    const countsText = (await page.textContent('[data-testid="reader-block-counts"]')) ?? '';
    assertCheck('1 真解析', '阅读器显示解析块统计（真实计数）', /\u5757/u.test(countsText) && /\u516c\u5f0f/u.test(countsText), countsText.trim());
    const headings = await page.locator('[data-testid="reader-block-heading"]').allTextContents();
    assertCheck(
      '1 真解析',
      '闸门 1：阅读器显示章节标题（heading）',
      headings.some((text) => text.includes('1  Introduction') || text.includes('Introduction')),
      headings.map((text) => text.split('·')[0]?.trim()).join(' | ').slice(0, 120)
    );
    const formulas = await page.locator('[data-testid="reader-block-formula"]').allTextContents();
    assertCheck(
      '1 真解析',
      '闸门 1：阅读器显示至少一个公式（CodeFormulaV2 抽出的 LaTeX）',
      formulas.length >= 1 && formulas.some((text) => text.includes('\\frac') || text.includes('\\sum')),
      `count=${formulas.length} sample=${formulas[0]?.replace(/\s+/gu, ' ').slice(0, 90) ?? ''}`
    );
    const tables = await page.locator('[data-testid="reader-block-table"]').allTextContents();
    assertCheck(
      '1 真解析',
      '闸门 1：阅读器显示至少一个表格（表格块文本，契约没有 rows — F16）',
      tables.length >= 1 && tables.some((text) => text.includes('Method') && text.includes('Accuracy')),
      `count=${tables.length} sample=${tables[0]?.replace(/\s+/gu, ' ').slice(0, 90) ?? ''}`
    );
    const locators = await page.locator('[data-testid="reader-blocks"] [data-locator]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-locator'))
    );
    assertCheck(
      '1 真解析',
      '每个块都带真实 locator（跳回原文位置的锚点）',
      locators.length >= 5 && locators.every((value) => typeof value === 'string' && value.length > 0),
      `blocks=${locators.length} first=${locators[0]}`
    );
    await page.screenshot({ path: join(artifactDir, '01-reader-blocks.png') });
  } else {
    const errorText = (await page.textContent('[data-testid="reader-document-error"]')) ?? '';
    assertCheck(
      '1 真解析',
      '模型未就绪时解析失败并显示真实错误码（research_models_unavailable）',
      errorText.includes('research_models_unavailable'),
      errorText.trim()
    );
    const modelsState = (await page.textContent('[data-testid="reader-models-state"]')) ?? '';
    const modelsReadyAttr = await page.getAttribute('[data-testid="reader-models-state"]', 'data-ready');
    assertCheck(
      '1 真解析',
      '阅读器把解析模型状态说清楚（未安装 + 可下载入口）',
      modelsReadyAttr === 'false' && modelsState.includes('\u6a21\u578b'),
      modelsState.trim()
    );
  }

  // ---- 闸门 2：真索引 → 真实文件数与命中 → 跳回原文位置 ------------------------
  await page.click('[data-testid="literature-subview-rag"]');
  await page.waitForSelector('[data-testid="rag-studio"]', { timeout: 20_000 });
  await page.click('[data-testid="rag-scan"]');
  const indexedReady = await page
    .waitForSelector(`[data-testid="rag-files"] [data-file-status="ready"]`, { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  assertCheck('2 真索引', '增量扫描后后端报告真实索引文件', indexedReady, '');
  const countsAfterScan = await waitForText(page, '[data-testid="rag-counts"]', (text) => /\u6587\u4ef6 [1-9]/u.test(text), 60_000);
  const totalMatch = /\u6587\u4ef6 (\d+)/u.exec(countsAfterScan);
  const totalFiles = totalMatch === null ? 0 : Number.parseInt(totalMatch[1], 10);
  assertCheck('2 真索引', 'RAG 显示真实文件数（不是假分块数 — B14）', totalFiles > 0, countsAfterScan.trim());
  const noteRow = page.locator('[data-testid="rag-files"] tr', { hasText: indexNoteRelativePath });
  assertCheck('2 真索引', `索引文件表里出现 ${indexNoteRelativePath}`, (await noteRow.count()) > 0, '');
  const noteStatus = (await noteRow.first().locator('td').nth(2).textContent()) ?? '';
  assertCheck('2 真索引', `markdown 夹具真的被索引（状态=${noteStatus.trim()}）`, noteStatus.includes('\u5df2\u7d22\u5f15'), noteStatus.trim());
  // 坏文件不是被忽略，而是被报出来：种子里那对占位 PDF/PNG 解析必然失败。
  const failedRows = await page.locator('[data-testid="rag-files"] [data-file-status="failed"]').count();
  assertCheck('2 真索引', '不可解析的文件被真实报为失败（不是静默跳过）', failedRows > 0, `failed=${failedRows}`);

  await page.fill('[data-testid="rag-query"]', indexNoteMarker);
  await page.click('[data-testid="rag-search"]');
  await page.waitForSelector('[data-testid="rag-hits"]', { timeout: 60_000 });
  const searchMeta = (await page.textContent('[data-testid="rag-search-meta"]')) ?? '';
  assertCheck('2 真索引', '检索由后端返回真实关键词/向量计数', /关键词 [1-9]/u.test(searchMeta), searchMeta.trim());
  const hitRows = page.locator('[data-testid="rag-hits"] li');
  const hitCount = await hitRows.count();
  assertCheck('2 真索引', '命中列表非空', hitCount > 0, `hits=${hitCount}`);
  const firstHitText = (await hitRows.first().textContent()) ?? '';
  assertCheck('2 真索引', '命中内容包含夹具标记（说明命中的是真内容）', firstHitText.includes(indexNoteMarker), '');
  const hitOpenId = await hitRows.first().locator('button').first().getAttribute('data-testid');
  await hitRows.first().locator('button').first().click();
  await page.waitForSelector('[data-testid="files-view"][data-state="preview"]', { timeout: 30_000 });
  const previewPath = (await page.textContent('[data-testid="file-preview-path"]')) ?? '';
  assertCheck(
    '2 真索引',
    '工作区文件来源的命中跳回真实来源文件（契约无行号，只能到文件）',
    previewPath.includes(indexNoteRelativePath),
    `${hitOpenId} → ${previewPath.trim()}`
  );
  await page.screenshot({ path: join(artifactDir, '02-index-hit.png') });

  // ---- B18 探针（info）：重活之后的 run 还能不能起来 ---------------------------
  //
  // 实测（2026-10-15，本 harness）：app 做过文档解析 + 索引扫描之后，`chat.startRun`
  // 会**偶发并且随后持续**卡在 context maintenance 的 persist 阶段 ——
  //   - 后端自己持久化的 run 事件流只有 `run_started` + `context_compaction_started`
  //   - 冒烟 provider 收到的请求数 = 0（模型从未被调用）
  //   - 对卡住的那一轮 `chat.cancelRun` 返回内部错误
  // 裸探针（无解析/无索引）连跑 3 轮全部正常，所以它与本项目改动无关，属后端任务单 B18。
  // 这里只**记录**，不参与判定：它让每次跑 harness 都能看到 B18 是否仍在。
  const postWorkRun = await runScriptedSession(page, {
    projectId,
    tag: `${sessionRunTag}-POSTWORK`,
    prompt: 'B18 探针：重活之后再起一轮。'
  });
  if (postWorkRun.ok) {
    record('B18 探针', '重活（解析 + 索引）之后的 run 正常完成', true, `events=[${postWorkRun.events.join(', ')}]`, 'info');
  } else {
    await recordStalledRun(page, postWorkRun, 'B18 探针');
  }

  if (modelsReady) {
    // 文献来源的命中：documentId 前缀说清了它是解析文档，reader 用 locator 对齐块。
    await openLiteratureHub(page, projectId);
    await page.click('[data-testid="literature-subview-rag"]');
    await page.waitForSelector('[data-testid="rag-studio"]', { timeout: 20_000 });
    await page.fill('[data-testid="rag-query"]', 'stochastic gradient descent');
    await page.click('[data-testid="rag-search"]');
    await page.waitForSelector('[data-testid="rag-hits"]', { timeout: 60_000 });
    /**
     * 用 IPC 把**这一条**命中的 `chunkId`/`locator` 取出来，再点它对应的按钮。
     *
     * 不能靠 `hasText: '在阅读器里定位'` 选中：`library:`（记录级）命中也是那个按钮文案，
     * 于是「解析文档的命中带 documentId」这条断言就只是说「有某种文献命中」（评审 P2）。
     * `rag-hit-open-<chunkId>` 这个 testid 是逐命中的，可以精确点到。
     */
    const parsedHit = await page.evaluate(
      async ({ projectId: project, query }) => {
        const status = await window.roc.research.getIndexStatus({ projectId: project });
        const embeddingConfigId = status.ok ? status.data.settings.embeddingConfigId : null;
        const result = await window.roc.research.searchKnowledge({ query, projectId: project, limit: 20, embeddingConfigId });
        if (!result.ok) {
          return { error: result.error.message };
        }
        const hit = result.data.hits.find((entry) => entry.documentId.startsWith('document:'));
        return hit === undefined
          ? { error: `no document: hit among ${result.data.hits.length}` }
          : { chunkId: hit.chunkId, locator: hit.locator ?? '', documentId: hit.documentId };
      },
      { projectId, query: 'stochastic gradient descent' }
    );
    assertCheck(
      '2 真索引',
      '解析文档的命中带 documentId=document:<parseId>（可以定位到块）',
      parsedHit.error === undefined && parsedHit.documentId.startsWith('document:'),
      parsedHit.error === undefined ? `${parsedHit.documentId} → ${parsedHit.locator}` : parsedHit.error
    );
    if (parsedHit.error === undefined) {
      const expectedLocator = parsedHit.locator;
      await page.click(`[data-testid="rag-hit-open-${parsedHit.chunkId}"]`);
      await page.waitForSelector('[data-testid="paper-reader"]', { timeout: 20_000 });
      const focused = await page
        .waitForSelector('[data-testid="reader-blocks"] [data-focused="true"]', { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      const focusedLocator = focused
        ? await page.getAttribute('[data-testid="reader-blocks"] [data-focused="true"]', 'data-locator')
        : null;
      assertCheck(
        '2 真索引',
        '闸门 2：命中能跳回原文位置（命中 locator 与解析块 locator 完全一致且高亮）',
        focused && focusedLocator !== null && expectedLocator === focusedLocator,
        `expected="${expectedLocator}" focused="${focusedLocator}"`
      );
      const jumpMissed = await page.locator('[data-testid="reader-jump-missed"]').count();
      assertCheck('2 真索引', '跳转没有落到“找不到位置”的降级提示上', jumpMissed === 0, '');
      await page.screenshot({ path: join(artifactDir, '02-reader-jump.png') });
      console.log('   … 闸门 2 跳转断言与截图完成');
    }
  } else {
    record('2 真索引', '文献来源命中跳转（需要解析文档，模型未就绪本轮不适用）', true, 'degraded path');
  }

  // ---- 闸门 6：⌘K 能搜到真文献 / 真文件 / 真会话 -------------------------------
  //
  // 这一轮**不新开对话**：可检索的那条会话在闸门 0 末尾就造好了（那时 app 还没做过
  // 解析/索引这类重活 —— 见 B18），palette 分组只需要那条已持久化的消息。
  // 这样闸门 6 的判定与 B18 的偶发性解耦，B18 本身由后面那条 info 探针单独盯着。
  await navigate(page, `page=research&project=${projectId}&view=literature`);
  await page.waitForSelector('[data-testid="literature-hub"]', { timeout: 30_000 });
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('[data-testid="search-palette-input"]', { timeout: 20_000 });

  await page.fill('[data-testid="search-palette-input"]', paperTitleMarker);
  const literatureGroupReady = await appears(page, '[data-testid="search-group-literature"] [data-testid^="search-item-library:"]', 30_000);
  const literatureGroupStatus = await page.getAttribute('[data-testid="search-group-literature"]', 'data-status');
  assertCheck(
    '6 ⌘K',
    '闸门 6：⌘K 能搜到真文献（分组 ready + 命中行）',
    literatureGroupReady && literatureGroupStatus === 'ready',
    `status=${literatureGroupStatus}`
  );
  const literatureItemTestId = await page.getAttribute(
    '[data-testid="search-group-literature"] [data-testid^="search-item-library:"]',
    'data-testid'
  );
  const expectedLibraryItemId = (literatureItemTestId ?? '').replace('search-item-library:', '');
  await page.click('[data-testid="search-group-literature"] [data-testid^="search-item-library:"]');
  await page.waitForSelector('[data-testid="paper-reader"]', { timeout: 20_000 });
  // 等阅读器出现只证明「选中了某一条」；断言它就是点在 ⌘K 上的那一条（评审 P2）。
  assertCheck(
    '6 ⌘K',
    '点文献命中会切到文献视图并选中**该**条（reader 的 data-library-item 一致）',
    (await page.getAttribute('[data-testid="paper-reader"]', 'data-library-item')) === expectedLibraryItemId,
    `${expectedLibraryItemId}`
  );

  await page.keyboard.press('Meta+k');
  await page.waitForSelector('[data-testid="search-palette-input"]', { timeout: 20_000 });
  await page.fill('[data-testid="search-palette-input"]', 'p5-notes');
  const fileNameItem = await appears(page, `[data-testid="search-item-name:${indexNoteRelativePath}"]`, 30_000);
  assertCheck('6 ⌘K', '闸门 6：⌘K 能搜到真文件（文件名分组）', fileNameItem, '');
  await page.fill('[data-testid="search-palette-input"]', indexNoteMarker);
  const fileContentItem = await appears(page, '[data-testid="search-group-file-contents"] [data-testid^="search-item-content:"]', 30_000);
  assertCheck('6 ⌘K', '⌘K 的内容分组也能搜到（files.search，服务端扫描）', fileContentItem, '');

  await page.fill('[data-testid="search-palette-input"]', sessionMarker);
  const sessionItem = await appears(page, '[data-testid="search-group-sessions"] [data-testid^="search-item-session:"]', 30_000);
  const sessionGroupStatus = await page.getAttribute('[data-testid="search-group-sessions"]', 'data-status');
  const sessionGroupText = (await page.textContent('[data-testid="search-group-sessions"]')) ?? '';
  if (sessionRun.ok) {
    assertCheck(
      '6 ⌘K',
      '闸门 6：⌘K 能搜到真会话（agent.sessions.search）',
      sessionItem && sessionGroupStatus === 'ready',
      `status=${sessionGroupStatus}`
    );
  } else {
    // B18 降级路线：分组必须仍然接线可用并如实说「没有匹配」（不是 unavailable）。
    assertCheck(
      '6 ⌘K',
      '⌘K 会话分组接线可用（ready + 空态文案，而不是不可用）—— B18 降级路线',
      sessionGroupStatus === 'ready' && sessionGroupText.includes('没有匹配'),
      `status=${sessionGroupStatus} text=${sessionGroupText.replace(/\s+/gu, ' ').trim().slice(0, 60)}`
    );
  }

  await page.fill('[data-testid="search-palette-input"]', 'ROC-P5-GATE-PROJECT');
  const projectItem = await appears(page, '[data-testid="search-group-projects"] [data-testid^="search-item-project:"]', 30_000);
  assertCheck('6 ⌘K', '⌘K 的项目分组可用（research.projects.list）', projectItem, '');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(artifactDir, '06-search-palette.png') });

  // ---- 闸门 7：typecheck -------------------------------------------------------
  const typecheck = spawnSync('pnpm', ['typecheck'], { cwd: resolve('.'), encoding: 'utf8' });
  assertCheck('7 typecheck', 'pnpm typecheck 通过', typecheck.status === 0, (typecheck.stdout ?? '').trim().slice(0, 200));

  assertCheck('0 健康', '整轮流程没有 renderer 错误', rendererErrors.length === 0, rendererErrors.slice(0, 2).join(' | '));

  const failed = results.filter((entry) => !entry.ok);
  writeFileSync(
    join(artifactDir, 'report.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: failed.length === 0,
        preflight: {
          modelsReady,
          modelsStatus,
          toolchain: preflight.toolchain,
          bibliographyImport,
          bibliographyProbeError
        },
        results,
        providerRequests: smokeProvider.requests.length,
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
    `\nP5 验收闸门：${results.length - failed.length}/${results.length} 记录通过 · 断言 ${results.length - infoCount - assertionFailures}/${results.length - infoCount} · 说明性记录 ${infoCount} · modelsReady=${modelsReady}。报告写入 ${artifactDir}/report.json`
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  writeFileSync(
    join(artifactDir, 'report.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        results,
        rendererErrors
      },
      null,
      2
    ),
    'utf8'
  );
  console.error(`\nP5 验收闸门失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // 恢复 B17 绕行改名的构建产物，让 harness 不给下一轮（或下一次构建）埋陷阱。
  if (jobCliDisabledByRun && existsSync(jobCliDisabledPath)) {
    renameSync(jobCliDisabledPath, jobCliPath);
  }
  if (app !== undefined) {
    /**
     * 收尾有超时：B18 卡住的那轮会让 app 的 shutdown 等在一个永不 resolve 的 promise 上
     * （实测 `app.close()` 就此挂住，留下 4 个 Electron 进程与一个不结束的 node 进程）。
     * harness 不能因为被测程序的缺陷而永远不退出 —— 到点就硬退出。
     */
    await Promise.race([app.close(), new Promise((resolveDone) => setTimeout(resolveDone, 20_000))]);
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
  await smokeProvider.close();
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(skillSourceRoot, { recursive: true, force: true });
  rmSync(remoteRoot, { recursive: true, force: true });
}

/** Recursively lists the renderer sources, for the static (gate 3) assertions. */
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

/** Comments must not be able to satisfy (or fail) a source-level assertion. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

/**
 * 在页面里装一次 run 事件订阅（闸门 0 的会话 + B18 探针共用）。
 *
 * 等待方式刻意不是「在 `page.evaluate` 里 await 一个事件 Promise」：事件不来时那就是
 * **无限等**（harness 第一版就这么卡死过一次）。订阅把状态写进 `window`，等待交给
 * `waitForFunction` —— 超时必须是 harness 自己的时间边界。
 */
async function installRunEventTap(page) {
  await page.evaluate(() => {
    if (window.__p5Tapped === true) {
      return;
    }
    window.__p5Tapped = true;
    window.__p5RunEvents = [];
    window.__p5FinishedRuns = [];
    window.roc.chat.onRunEvent((raw) => {
      const event = raw !== null && typeof raw === 'object' && !('type' in raw) && 'event' in raw ? raw.event : raw;
      if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
        return;
      }
      // 内层事件名/阶段一起记：B18 的卡点恰恰只能用内层事件定位（外层都叫
      // `context_maintenance`）。
      window.__p5RunEvents.push(
        event.type === 'context_maintenance' ? `context_maintenance:${event.event}/${event.stage}` : event.type
      );
      if (['run_completed', 'run_failed', 'run_cancelled'].includes(event.type)) {
        window.__p5FinishedRuns.push(event.runId);
      }
    });
  });
}

/**
 * 跑一轮脚本化对话，返回事件轨迹与 provider 请求数。
 *
 * 用 P4 夹具的 slow 模式 + 唯一 tag：助手回复会被持久化成 `session_messages` 行，
 * 于是 tag 成为可检索的会话内容（普通用户提问只进 `agent_events`，搜不到 — F17②）。
 */
async function runScriptedSession(page, { projectId, tag, prompt }) {
  const requestsBefore = smokeProvider.requests.length;
  await page.evaluate(() => {
    window.__p5RunEvents = [];
    window.__p5FinishedRuns = [];
  });
  const started = await page.evaluate(
    async ({ project, workspacePath, tag: runTag, prefix }) => {
      const result = await window.roc.chat.startRun({
        input: `${prefix} ROC-P4-RUN:${runTag} ROC-P4-MODE:slow ROC-P4-SLOW:4x50 ROC-P4-SLOW-TAG:${runTag}`,
        mode: 'chat',
        threadId: null,
        researchProjectId: project,
        workspacePath,
        enabledCapabilities: { mcpServers: [], skills: [] }
      });
      return result.ok
        ? { runId: result.data.runId, threadId: result.data.threadId }
        : { error: result.error.message };
    },
    { project: projectId, workspacePath: workspaceRoot, tag, prefix: prompt }
  );
  if (started.error !== undefined) {
    return { ok: false, events: [`startRun failed: ${started.error}`], providerRequests: 0 };
  }
  const finished = await page
    .waitForFunction((runId) => window.__p5FinishedRuns.includes(runId), started.runId, { timeout: 120_000, polling: 100 })
    .then(() => true)
    .catch(() => false);
  const events = await page.evaluate(() => window.__p5RunEvents);
  return {
    ok: finished && events.includes('run_completed'),
    events,
    runId: started.runId,
    threadId: started.threadId,
    providerRequests: smokeProvider.requests.length - requestsBefore
  };
}

/**
 * 卡住的 run：把**后端权威事件流**、取消结果与 provider 请求数记成 info 记录。
 *
 * 三分数据缺一不可：后端事件流说明「app 自己走到哪一步」（而不是界面漏了事件）；
 * `cancelRun` 的结果说明「卡住的那一轮能不能收掉」（实测不能，是内部错误）；
 * provider 请求数说明「模型到底有没有被调用」（实测 0）。
 */
async function recordStalledRun(page, run, gate) {
  record(
    gate,
    'run 未在 120 s 内完成（B18 特征：卡在 context maintenance 的 persist 阶段）',
    true,
    `events=[${run.events.join(', ')}] providerRequests=${run.providerRequests}`,
    'info'
  );
  if (run.runId === undefined) {
    return;
  }
  const replay = await page.evaluate(
    async ({ runId }) => {
      const result = await window.roc.chat.getRunEvents({ runId, afterSequence: 0 });
      return result.ok
        ? result.data.events
            .map((entry) =>
              `${entry.sequence}:${entry.event.type}${
                entry.event.type === 'context_maintenance' ? `(${entry.event.event}/${entry.event.stage})` : ''
              }`
            )
            .join(' ')
        : `error:${result.error.message}`;
    },
    { runId: run.runId }
  );
  record(gate, '后端持久化的 run 事件流（卡住那一轮，权威）', true, replay.slice(0, 400), 'info');
  const cancelled = await page.evaluate(
    async ({ runId }) => {
      const result = await window.roc.chat.cancelRun({ runId });
      return result.ok ? String(result.data.cancelled) : `error:${result.error.message}`;
    },
    { runId: run.runId }
  );
  record(gate, '卡住的那一轮尝试取消（实测是内部错误）', true, `cancelled=${cancelled}`, 'info');
}

