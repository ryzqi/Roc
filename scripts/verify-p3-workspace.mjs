import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeSkillSource, seedSmokeWorkspace } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';

/**
 * P3 验收闸门的自动化实测（真应用 / 真 IPC / 真 pty / 真 git）。
 *
 * 为什么需要它：P3 的闸门 1/4/5/6 描述的是**运行时行为** —— 外部改文件后文件树是否刷新、
 * stage→commit 是否真的走通、终端是否真的能跑 `pwd`/`ls`/`python --version`、切项目后
 * 文件树/Git/终端是否按新工作目录重建。静态阅读与单测都不能替代这些。旧壳的 smoke 套件
 * 断言的是旧壳的 DOM，P10 才重写它，所以这里用与新壳一致的 `data-testid` 单独立一套。
 *
 * 它**不**替代 P10 的 smoke：这里只覆盖 P3 的四个闸门 + 只读闸门与 R10 的运行时表现，
 * 并且明确以 `ROC_SMOKE_TARGET=dist` 运行（后者很重要：
 * `resolveSmokeTarget` 默认会优先用 `release/mac-arm64/Roc.app`，那可能是旧的打包产物）。
 *
 * 运行：
 *   rm -rf dist/renderer && pnpm build
 *   node scripts/verify-p3-workspace.mjs
 * 结果写入 `.artifacts/p3-gates/`（report.json + 截图）。
 */

const artifactDir = resolve('.artifacts/p3-gates');
mkdirSync(artifactDir, { recursive: true });

const results = [];
function record(gate, name, ok, detail = '') {
  results.push({ gate, name, ok, detail });
  const mark = ok ? '✔' : '✖';
  console.log(`${mark} [${gate}] ${name}${detail.length === 0 ? '' : ` — ${detail}`}`);
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

// 第二个工作目录：闸门 6 需要「切项目后不串数据」，所以两边的文件名必须互斥。
const secondWorkspace = mkdtempSync(join(tmpdir(), 'roc-p3-second-workspace-'));
writeFileSync(join(secondWorkspace, 'second-only.txt'), 'second workspace only\n', 'utf8');
writeFileSync(join(secondWorkspace, '00-overview.txt'), 'SHOULD NOT BE VISIBLE FROM PROJECT 1\n', 'utf8');
const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
};
git(secondWorkspace, ['init']);
git(secondWorkspace, ['config', 'user.email', 'roc-p3@example.test']);
git(secondWorkspace, ['config', 'user.name', 'Roc P3']);
git(secondWorkspace, ['add', '-A']);
git(secondWorkspace, ['commit', '-m', 'second workspace initial']);

// 代码分支预览需要一个真正的“.ts”文件（seedSmokeWorkspace 只有 txt/png/pdf）。
writeFileSync(join(workspaceRoot, 'gate-sample.ts'), 'export const answer: number = 42;\n', 'utf8');

const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`P3 验收闸门实测 · target=${target.kind} · renderer=next\n`);

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

async function waitForTerminalText(page, needle, timeoutMs = 15_000) {
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

/**
 * Measures the app's own end-to-end refresh latency for one file.
 *
 * Installs a `MutationObserver` in the renderer *before* the file is written, so the
 * clock starts at the write and stops when the row exists in the DOM. Node and the
 * renderer share one wall clock, so this is a real measurement rather than
 * "how long did Playwright take to notice" — the earlier version asserted only
 * `<= 700 ms`, which is not the gate the phase claims (200 ms).
 */
async function measureRefreshLatency(page, relativePath, writeFile) {
  await page.evaluate(({ name }) => {
    window.__p3RefreshLatency = new Promise((resolve) => {
      const startedAt = Date.now();
      // Fail fast with -1 instead of leaving a promise that never settles: a hung
      // `page.evaluate` has no timeout and would consume the whole run.
      const giveUp = setTimeout(() => {
        observer.disconnect();
        resolve(-1);
      }, 5000);
      const observer = new MutationObserver(() => {
        if (document.querySelector(`[data-testid="file-tree-row-${name}"]`) !== null) {
          clearTimeout(giveUp);
          observer.disconnect();
          resolve(Date.now() - startedAt);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }, { name: relativePath });
  writeFile();
  return await page.evaluate(() => window.__p3RefreshLatency);
}

/**
 * Expands a directory only when it is not already expanded.
 *
 * Clicking an expanded directory *collapses* it (that is the product behaviour),
 * so a fixed sequence of clicks is not repeatable — the harness must ask the row
 * what state it is in rather than assume.
 */
async function ensureExpanded(page, relativePath, childPath) {
  const row = page.locator(`[data-testid="file-tree-row-${relativePath}"]`);
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click();
  }
  await page.waitForSelector(`[data-testid="file-tree-row-${childPath}"]`, { timeout: 15_000 });
}

async function typeInTerminal(page, command) {
  await page.click('[data-testid="terminal-xterm"]');
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

try {
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
    console.error('[renderer:pageerror]', error.message.slice(0, 300));
  });

  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  assertCheck('0 启动', '新壳在 smoke 模式下启动', (await page.getAttribute('[data-testid="roc-app"]', 'data-mode')) === 'smoke');
  assertCheck('0 启动', '门户可见（无项目时不进入工作台）', (await page.locator('[data-testid="portal-column"]').count()) === 1);

  // ---- 准备：两个项目，各自绑定一个真实工作目录 --------------------------------
  const first = await page.evaluate(
    async ({ workspacePath }) =>
      await window.roc.research.createProject({
        title: 'P3 gate project',
        description: 'P3 acceptance gate harness project.',
        workspacePath
      }),
    { workspacePath: workspaceRoot }
  );
  if (!first.ok) {
    fail('0 准备', '创建项目 1', first.error.message);
  }
  const second = await page.evaluate(
    async ({ workspacePath }) =>
      await window.roc.research.createProject({
        title: 'P3 gate project two',
        description: 'Second project for the project-switch gate.',
        workspacePath
      }),
    { workspacePath: secondWorkspace }
  );
  if (!second.ok) {
    fail('0 准备', '创建项目 2', second.error.message);
  }
  record('0 准备', '两个项目各自绑定一个真实工作目录', true, `${first.data.id} / ${second.data.id}`);

  // ---- 闸门 6（前半）：项目 1 的文件树 = 项目 1 的工作目录 ----------------------
  await navigate(page, `page=research&project=${first.data.id}&tool=files`);
  await page.waitForSelector('[data-testid="file-tree"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="file-tree-row-00-overview.txt"]', { timeout: 20_000 });
  assertCheck('6 项目隔离', '项目 1 的文件树来自它自己的工作目录', true, '00-overview.txt 可见');
  assertCheck(
    '6 项目隔离',
    '项目 1 看不到项目 2 的专属文件',
    (await page.locator('[data-testid="file-tree-row-second-only.txt"]').count()) === 0
  );

  // ---- 闸门 1：外部编辑 → 文件树刷新（含突发合并与尾刷） ------------------------
  const singleLatency = await measureRefreshLatency(page, 'external-one.txt', () => {
    writeFileSync(join(workspaceRoot, 'external-one.txt'), 'external one\n', 'utf8');
  });
  assertCheck(
    '1 外部编辑刷新',
    '外部新增文件后文件树自动刷新（应用内实测 ≤200ms）',
    singleLatency >= 0 && singleLatency <= 200,
    `${singleLatency} ms`
  );

  // 突发：后两次写入落在 200ms 窗口内，按设计要等尾刷；断言的是「都落地」，不是延迟。
  for (const name of ['external-two.txt', 'external-three.txt']) {
    writeFileSync(join(workspaceRoot, name), `${name}\n`, 'utf8');
  }
  await page.waitForSelector('[data-testid="file-tree-row-external-two.txt"]', { timeout: 5_000 });
  await page.waitForSelector('[data-testid="file-tree-row-external-three.txt"]', { timeout: 5_000 });
  assertCheck('1 外部编辑刷新', '同一窗口内的突发写入全部落地', true, '2 个文件');

  // 尾刷：第一次刷新完成后窗口仍在计时，此时再写一次 —— 若尾刷被丢掉，第二个文件
  // 永远不会出现（旧断言「3 个文件最终都出现」抓不到这种情况，整目录重列就能满足它）。
  const trailingLatency = await measureRefreshLatency(page, 'external-window.txt', () => {
    writeFileSync(join(workspaceRoot, 'external-window.txt'), 'window\n', 'utf8');
  });
  assertCheck('1 外部编辑刷新', '窗口内尾刷没有丢更新', trailingLatency >= 0 && trailingLatency <= 450, `${trailingLatency} ms`);

  // 已展开目录内的外部新增（同时实测延迟）。先展开：行只有在父目录被列出之后才可能存在，
  // 否则探针等的是一个永远不会出现的 DOM 节点（本 harness 第一版就这样挂住过）。
  await ensureExpanded(page, 'docs', 'docs/smoke-preview.pdf');
  const docsLatency = await measureRefreshLatency(page, 'docs/external-doc.txt', () => {
    writeFileSync(join(workspaceRoot, 'docs', 'external-doc.txt'), 'doc\n', 'utf8');
  });
  assertCheck('1 外部编辑刷新', '外部新增文件出现在已展开目录里（应用内实测 ≤200ms）', docsLatency >= 0 && docsLatency <= 200, `${docsLatency} ms`);

  // 评审 major-2 回归：刷新会清空缓存，但「已展开」是用户意图，不是缓存条目 ——
  // 刷新后子项必须重新拉回来，而不是留一个空的展开目录。
  await page.click('[data-testid="file-tree-refresh"]');
  await page.waitForSelector('[data-testid="file-tree-row-docs/external-doc.txt"]', { timeout: 10_000 });
  assertCheck(
    '1 外部编辑刷新',
    '刷新后已展开目录仍列出子项（展开 = 意图，不是缓存）',
    (await page.getAttribute('[data-testid="file-tree-row-docs"]', 'aria-expanded')) === 'true',
    ''
  );

  await page.screenshot({ path: join(artifactDir, '01-files-tree.png') });

  // ---- 闸门 2：预览分发（文本 / 代码 / 图片 / PDF）+ R10 ------------------------
  //
  // 点文件行会**弹出预览模态**（对齐 research-studio 的 `FilePreviewModal`），所以每个文件前要把上
  // 一个关掉：模态没关就去点树里的下一行，指针会被遮罩拦住（Playwright 会直接报 intercepts pointer
  // events）。`关闭文件预览` 是模态标题栏的关闭按钮。
  const openPreview = async (rowTestId) => {
    await page.click(rowTestId);
  };
  // 用预览自带的关闭按钮关（参考的 FilePreviewModal 也有一个）：PDF 分支是 `<iframe>`，一旦
  // iframe 拿到焦点，Escape 就到不了我们的窗口监听器，所以关闭不能只依赖键盘。
  const closePreview = async () => {
    if ((await page.locator('[data-testid="file-preview-modal-panel"]').count()) > 0) {
      await page.click('[data-testid="file-preview-close"]');
      await page.waitForSelector('[data-testid="file-preview-modal-panel"]', { state: 'detached', timeout: 10_000 });
    }
  };

  await openPreview('[data-testid="file-tree-row-00-overview.txt"]');
  await page.waitForSelector('[data-testid="file-preview-text"]', { timeout: 15_000 });
  const textPreview = (await page.locator('[data-testid="file-preview-text"]').textContent()) ?? '';
  assertCheck('2 预览', '文本预览读取真实内容', textPreview.includes('workspace overview smoke file'), textPreview.trim().slice(0, 40));
  await closePreview();

  await openPreview('[data-testid="file-tree-row-gate-sample.ts"]');
  await page.waitForSelector('[data-testid="file-preview"][data-kind="code"]', { timeout: 15_000 });
  assertCheck('2 预览', '代码文件按 code 分支渲染', true, 'data-kind=code');
  await closePreview();
  // 预览必须关得掉（参考的 FilePreviewModal 用 Escape/遮罩关；面板本身没有共享 ModalShell 的
  // 头部关闭按钮）。这一条是在文本/代码分支上断言的 —— PDF 分支是 `<iframe src=roc-preview://…>`，
  // iframe 会吃按键，所以那一步的关闭交给下一次导航。
  assertCheck('2 预览', '预览可以关掉（自带关闭按钮，不依赖焦点在哪）', (await page.locator('[data-testid="file-preview-modal-panel"]').count()) === 0, '');

  await ensureExpanded(page, 'assets', 'assets/smoke-image.png');
  await openPreview('[data-testid="file-tree-row-assets/smoke-image.png"]');
  await page.waitForSelector('[data-testid="file-preview-image"]', { timeout: 15_000 });
  const imageSrc = await page.getAttribute('[data-testid="file-preview-image"]', 'src');
  assertCheck('2 预览', '图片按 data URL 渲染', imageSrc !== null && imageSrc.startsWith('data:image/'), (imageSrc ?? '').slice(0, 24));
  await closePreview();

  await ensureExpanded(page, 'docs', 'docs/smoke-preview.pdf');
  await openPreview('[data-testid="file-tree-row-docs/smoke-preview.pdf"]');
  await page.waitForSelector('[data-testid="file-preview-pdf"]', { timeout: 15_000 });
  const pdfSrc = await page.getAttribute('[data-testid="file-preview-pdf"]', 'src');
  assertCheck('2 预览', 'PDF 走主进程自定义协议（roc-preview://）', (pdfSrc ?? '').startsWith('roc-preview://'), (pdfSrc ?? '').slice(0, 40));
  assertCheck('2 预览', 'PDF 不使用 Blob URL', !(pdfSrc ?? '').startsWith('blob:'), '');
  await closePreview();

  // R10：越界路径必须在渲染前被拒绝，并给出专属文案。
  //
  // 这一步以前走画布 `view=files`（它的 `data-state=rejected` 就是这条闸门的判据）。画布文件视图
  // 已删（对齐 research-studio：文件在左栏树 + 预览浮层），越界拒绝的真身移到左栏树自己：
  // 同一段 `checkRelativePath` + `pathRejectionMessage`，所以文案没变，只是显示在树里。
  await navigate(page, `page=research&project=${first.data.id}&view=literature&file=${encodeURIComponent('../../etc/passwd')}`);
  await page.waitForSelector('[data-testid="file-tree-rejected"]', { timeout: 10_000 });
  const rejectionText = (await page.locator('[data-testid="file-tree-rejected"]').textContent()) ?? '';
  assertCheck('3 路径越界（R10）', '深链越界路径在渲染前被拒绝', rejectionText.includes('不能越出工作目录'), rejectionText.trim().slice(0, 80));
  assertCheck('3 路径越界（R10）', '拒绝时不产生预览请求', (await page.locator('[data-testid="file-preview"]').count()) === 0);

  // ---- 闸门 4：Git 全流程（改动列表 → stage → commit + discard 二次确认） -------
  await navigate(page, `page=research&project=${first.data.id}&view=literature&tool=git`);
  await page.waitForSelector('[data-testid="git-drawer-panel"] [data-testid="git-panel"][data-state="ready"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="git-change-phase-three-notes.txt"]', { timeout: 15_000 });
  assertCheck('4 Git', '改动列表显示真实未暂存改动', true, 'phase-three-notes.txt');
  const branchLabel = (await page.locator('[data-testid="git-current-branch"]').textContent()) ?? '';
  assertCheck('4 Git', '当前分支来自 git.status', branchLabel.trim().length > 0, branchLabel.trim());

  // 评审 R-2 回归：面板已打开时外部新增文件必须自己出现在列表里（旧实现只有文件树
  // 订阅了 watcher，Git 列表会一直陈旧到手动刷新）。
  writeFileSync(join(workspaceRoot, 'git-watcher-new.txt'), 'appeared while the panel is open\n', 'utf8');
  await page.waitForSelector('[data-testid="git-change-git-watcher-new.txt"]', { timeout: 10_000 });
  assertCheck('4 Git', 'Git 面板随外部改动自动刷新（无需手动刷新）', true, 'git-watcher-new.txt');

  await page.click('[data-testid="git-select-phase-three-notes.txt"]');
  await page.waitForSelector('[data-testid="git-diff"]', { timeout: 15_000 });
  assertCheck('4 Git', 'git.fileDiff 渲染出补丁', (await page.locator('[data-testid="git-diff"]').count()) === 1);
  assertCheck('4 Git', 'git.diffStat 显示在列表上方', (await page.locator('[data-testid="git-diff-stat"]').count()) === 1);

  await page.click('[data-testid="git-stage-phase-three-notes.txt"]');
  await page.waitForSelector('[data-testid="git-change-phase-three-notes.txt"][data-staged="true"]', { timeout: 15_000 });
  assertCheck('4 Git', 'stage 后该文件进入已暂存组', true, 'data-staged=true');

  await page.fill('[data-testid="git-commit-message"]', 'P3 gate: stage and commit from the new shell');
  await page.click('[data-testid="git-commit"]');
  await page.waitForSelector('[data-testid="git-last-commit"]', { timeout: 20_000 });
  // 不能再断言「工作区干净」：本 harness 自己往工作目录里写过未跟踪文件（闸门 1 的
  // 外部编辑），它们本来就不该被这次提交带走。要断言的是**被暂存的那个文件离开了列表**。
  await page.waitForSelector('[data-testid="git-change-phase-three-notes.txt"]', {
    state: 'detached',
    timeout: 20_000
  });
  assertCheck('4 Git', 'commit 后该文件离开改动列表（列表来自返回的 git.status）', true, '');
  assertCheck(
    '4 Git',
    '该文件也不再出现在已暂存组',
    (await page.locator('[data-testid="git-change-phase-three-notes.txt"][data-staged="true"]').count()) === 0,
    ''
  );
  const headSubject = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: workspaceRoot, encoding: 'utf8' }).stdout.trim();
  assertCheck('4 Git', '提交真的落进了仓库', headSubject.includes('P3 gate'), headSubject);

  // discard：二次确认 → 取消不改变任何东西 → 确认后改动消失
  writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'discard me\n', 'utf8');
  await page.waitForSelector('[data-testid="git-change-phase-three-notes.txt"]', { timeout: 15_000 });
  await page.click('[data-testid="git-discard-phase-three-notes.txt"]');
  await page.waitForSelector('[data-testid="git-discard-confirm"]', { timeout: 10_000 });
  assertCheck('4 Git', 'discard 需要二次确认', true, 'ConfirmDialog 已出现');
  await page.click('[data-testid="git-discard-confirm-cancel"]');
  await page.waitForSelector('[data-testid="git-discard-confirm"]', { state: 'detached', timeout: 10_000 });
  assertCheck('4 Git', '取消后改动仍在（确认是必须的）', (await page.locator('[data-testid="git-change-phase-three-notes.txt"]').count()) === 1);
  await page.click('[data-testid="git-discard-phase-three-notes.txt"]');
  await page.waitForSelector('[data-testid="git-discard-confirm-confirm"]', { timeout: 10_000 });
  await page.click('[data-testid="git-discard-confirm-confirm"]');
  await page.waitForSelector('[data-testid="git-change-phase-three-notes.txt"]', { state: 'detached', timeout: 15_000 });
  assertCheck('4 Git', '确认后改动被丢弃', true, '');
  await page.screenshot({ path: join(artifactDir, '04-git-panel.png') });

  // 关掉 Git 抽屉再走：它的遮罩盖着画布，后面点终端会被拦住（同样的事在 gate 6/只读闸门里靠
  // 「换 view 自动收抽屉」解决，这里是同一个 view 内换步骤，所以要显式关）。
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="git-drawer"]', { state: 'detached', timeout: 15_000 });

  // ---- 闸门 5：终端能跑 ls / pwd / python --version，且 resize 同步给 PTY ------
  await navigate(page, `page=research&project=${first.data.id}&view=terminal`);
  await page.waitForSelector('[data-testid="terminal-view"][data-phase="ready"]', { timeout: 30_000 });
  assertCheck('5 终端', 'pty 会话进入 ready', true, '');

  await typeInTerminal(page, 'pwd');
  const pwdOutput = await waitForTerminalText(page, workspaceRoot);
  assertCheck('5 终端', 'pwd 输出工作目录', pwdOutput.includes(workspaceRoot), workspaceRoot);

  await typeInTerminal(page, 'ls');
  const lsOutput = await waitForTerminalText(page, '00-overview.txt');
  assertCheck('5 终端', 'ls 列出真实文件', lsOutput.includes('00-overview.txt'), '');

  await typeInTerminal(page, 'python3 --version');
  const pythonOutput = await waitForTerminalText(page, 'Python 3');
  assertCheck('5 终端', 'python3 --version 有输出', /Python 3\.\d/u.test(pythonOutput), (pythonOutput.match(/Python 3\.\d+\.\d+/u) ?? [''])[0]);

  const geometryBefore = (await page.locator('[data-testid="terminal-geometry"]').textContent()) ?? '';
  const browserWindow = await app.browserWindow(page);
  await browserWindow.evaluate((win) => {
    const bounds = win.getBounds();
    win.setBounds({ ...bounds, width: bounds.width + 240 });
  });
  await page.waitForTimeout(1_200);
  const geometryAfter = (await page.locator('[data-testid="terminal-geometry"]').textContent()) ?? '';
  const cols = (value) => Number.parseInt(value.split('x')[0] ?? '0', 10);
  assertCheck(
    '5 终端',
    '窗口变宽后 PTY 列宽同步',
    cols(geometryAfter) > cols(geometryBefore),
    `${geometryBefore} → ${geometryAfter}`
  );
  // 可访问性（AGENTS.md「保留 focus-visible」）：`outline-none` 在 utilities 层会盖掉
  // base 层的焦点环，所以这里用 computed style 验证聚焦后真的有 2px 可见环。
  await navigate(page, `page=research&project=${first.data.id}&tool=git`);
  await page.waitForSelector('[data-testid="git-commit-message"]', { timeout: 20_000 });
  const focusRing = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="git-commit-message"]');
    if (element === null) {
      return null;
    }
    element.focus();
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
  });
  assertCheck(
    '可访问性',
    '聚焦输入框有可见焦点环（未被 outline-none 覆盖）',
    focusRing !== null && focusRing.outlineStyle !== 'none' && Number.parseFloat(focusRing.outlineWidth) >= 2,
    JSON.stringify(focusRing)
  );
  await navigate(page, `page=research&project=${first.data.id}&view=terminal`);
  await page.waitForSelector('[data-testid="terminal-view"][data-phase="ready"]', { timeout: 30_000 });
  assertCheck('7 RTK', '终端底部显示 rtk.status 一行', (await page.locator('[data-testid="terminal-rtk-status"]').count()) === 1, (await page.locator('[data-testid="terminal-rtk-status"]').textContent()) ?? '');
  await page.screenshot({ path: join(artifactDir, '05-terminal.png') });

  // 终端现在是画布 tab（不再有 `tool=terminal` 这个粘性标记），离开它不会自动清掉别的工具；
  // 这里没有别的工具开着，所以直接切项目。

  // ---- 闸门 6（后半）：切到项目 2 → 文件树/Git/终端全部按新工作目录重建 ---------
  await navigate(page, `page=research&project=${second.data.id}&tool=files`);
  await page.waitForSelector('[data-testid="file-tree-row-second-only.txt"]', { timeout: 20_000 });
  assertCheck('6 项目隔离', '切到项目 2 后文件树来自项目 2', true, 'second-only.txt 可见');
  assertCheck(
    '6 项目隔离',
    '项目 2 看不到项目 1 的 Git 改动残留',
    (await page.locator('[data-testid="file-tree-row-external-one.txt"]').count()) === 0
  );

  await navigate(page, `page=research&project=${second.data.id}&tool=git`);
  await page.waitForSelector('[data-testid="git-panel"][data-state="ready"]', { timeout: 20_000 });
  assertCheck(
    '6 项目隔离',
    '项目 2 的 Git 状态是它自己的（工作区干净）',
    (await page.locator('[data-testid="git-changes-clean"]').count()) === 1
  );

  await navigate(page, `page=research&project=${second.data.id}&view=terminal`);
  await page.waitForSelector('[data-testid="terminal-view"][data-phase="ready"]', { timeout: 30_000 });
  const secondCwd = (await page.locator('[data-testid="terminal-cwd"]').textContent()) ?? '';
  assertCheck('6 项目隔离', '切项目后终端在新工作目录重建', secondCwd.includes(secondWorkspace), secondCwd);
  await typeInTerminal(page, 'pwd');
  const secondPwd = await waitForTerminalText(page, secondWorkspace);
  assertCheck('6 项目隔离', '共享终端已在新目录可用', secondPwd.includes(secondWorkspace), '');

  // ---- 只读闸门（归档项目）：文件写入 / Git 写操作 / 终端全部关闭 ---------------
  const archive = await page.evaluate(
    async ({ id }) => await window.roc.research.updateProject({ id, status: 'archived' }),
    { id: first.data.id }
  );
  if (!archive.ok) {
    fail('只读闸门', '归档项目', archive.error.message);
  }
  await navigate(page, `page=research&project=${first.data.id}&view=terminal`);
  await page.waitForSelector('[data-testid="terminal-readonly"]', { timeout: 20_000 });
  assertCheck('只读闸门', '归档项目不提供交互式终端', true, 'terminal-readonly');
  await navigate(page, `page=research&project=${first.data.id}&tool=git`);
  await page.waitForSelector('[data-testid="git-panel"][data-state="ready"]', { timeout: 20_000 });
  assertCheck(
    '只读闸门',
    '归档项目不能切换/创建分支',
    await page.locator('[data-testid="git-current-branch"]').isDisabled(),
    ''
  );
  // 只读时提交信息框本身就是 disabled 的（写不进去），所以这里断言「不可编辑」而不是
  // 试着填一个值再断言按钮禁用 —— 后者会被 Playwright 的 actionable 等待挡住。
  assertCheck(
    '只读闸门',
    '归档项目的提交信息不可编辑',
    await page.locator('[data-testid="git-commit-message"]').isDisabled(),
    ''
  );
  assertCheck('只读闸门', '归档项目的提交按钮被禁用', await page.locator('[data-testid="git-commit"]').isDisabled(), '');
  const readonlyNote = (await page.locator('[data-testid="git-readonly-note"]').textContent()) ?? '';
  assertCheck('只读闸门', '归档项目在面板内明示只读', readonlyNote.includes('已归档'), readonlyNote.trim());
  await navigate(page, `page=research&project=${first.data.id}&tool=files`);
  await page.waitForSelector('[data-testid="file-sidebar-panel"]', { timeout: 20_000 });
  assertCheck(
    '只读闸门',
    '归档项目没有新建文件入口',
    (await page.locator('[data-testid="file-create-open"]').count()) === 0,
    ''
  );
  await page.evaluate(
    async ({ id }) => await window.roc.research.updateProject({ id, status: 'active' }),
    { id: first.data.id }
  );

  assertCheck('0 健康', '整轮流程没有 renderer 错误', rendererErrors.length === 0, rendererErrors.slice(0, 2).join(' | '));

  const failed = results.filter((entry) => !entry.ok);
  writeFileSync(
    join(artifactDir, 'report.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), passed: failed.length === 0, results, rendererErrors }, null, 2),
    'utf8'
  );
  console.log(`\nP3 验收闸门：${results.length - failed.length}/${results.length} 通过。报告写入 ${artifactDir}/report.json`);
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
  console.error(`\nP3 验收闸门失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (app !== undefined) {
    await app.close();
  }
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(skillSourceRoot, { recursive: true, force: true });
  rmSync(remoteRoot, { recursive: true, force: true });
  rmSync(secondWorkspace, { recursive: true, force: true });
}
