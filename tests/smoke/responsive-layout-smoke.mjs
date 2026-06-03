import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const styles = [
  'tokens.css',
  'base.css',
  'app-shell.css',
  'chat.css',
  'shared.css',
  'composer.css',
  'workbench.css',
  'responsive.css'
]
  .map((file) => readFileSync(resolve('src/renderer/styles', file), 'utf8'))
  .join('\n');

const taskWorkbenchMarkup = `
  <div class="app-shell" data-testid="roc-app">
    <div class="window-workband"></div>
    <div class="workspace">
      <aside class="sidebar"></aside>
      <main class="canvas">
        <div class="canvas-scroll">
          <div class="page-strip">
            <div class="page-copy">
              <h1 class="page-title">任务</h1>
              <p class="page-meta">1 个任务 · 运行中 1</p>
            </div>
            <div class="page-flags">
              <button class="action-button" type="button">新建任务</button>
            </div>
          </div>
          <section class="canvas-stage stage-grid task-command-center" data-testid="tasks-view">
            <div class="task-workbench-layout">
              <nav class="task-status-rail" data-testid="task-status-rail">
                <button class="task-rail-item task-rail-item--active" type="button"><span>全部</span><strong>1</strong></button>
                <button class="task-rail-item" type="button"><span>运行中</span><strong>1</strong></button>
                <button class="task-rail-item" type="button"><span>计划中</span><strong>1</strong></button>
                <button class="task-rail-item" type="button"><span>待确认</span><strong>0</strong></button>
                <button class="task-rail-item" type="button"><span>已暂停</span><strong>0</strong></button>
              </nav>
              <section class="task-table-panel" data-testid="task-table">
                <div class="task-table-head">
                  <div>
                    <h2 class="section-title">全部任务</h2>
                    <p>按最近更新排序 · 同一任务只出现一次</p>
                  </div>
                  <div class="task-table-status">
                    <span class="status-pill info"><span>1</span></span>
                    <span class="pill ok">调度器运行中</span>
                    <small>注册 1 · 下次 2026-05-22T01:00:00.000Z</small>
                  </div>
                </div>
                <div class="task-table-rows">
                  <button class="task-row task-row--selected" type="button">
                    <span class="task-row-copy">
                      <span class="task-row-title">窄屏任务布局回归检查：确认任务表格和详情抽屉在窗口缩小时不会互相覆盖</span>
                      <span class="task-row-meta">定时 · medium · F:\\Code\\Roc</span>
                    </span>
                    <span class="pill info">计划中</span>
                    <span class="task-row-time"><span class="task-row-time-label">下次运行</span>2026-05-22T01:00:00.000Z</span>
                    <span class="task-row-time"><span class="task-row-time-label">最近运行</span>无</span>
                  </button>
                </div>
              </section>
              <aside class="task-detail-drawer" data-testid="task-detail-drawer">
                <div class="section-head">
                  <h2 class="section-title">任务详情</h2>
                  <span class="status-pill info"><span>running</span></span>
                </div>
                <div class="task-detail-tabs" role="tablist" aria-label="任务详情">
                  <button type="button">概览</button>
                  <button type="button">运行输出</button>
                  <button type="button">运行历史</button>
                  <button type="button">事件流</button>
                  <button type="button">设置</button>
                </div>
                <div class="list-rows">
                  <div class="row">
                    <div class="row-copy">
                      <div class="row-title">工作区</div>
                      <div class="row-sub">F:\\Code\\Roc\\very\\long\\workspace\\path\\that\\should\\not\\move\\other\\controls</div>
                    </div>
                    <span class="pill info">background-task-id-with-a-long-generated-identifier</span>
                  </div>
                </div>
                <div class="action-strip">
                  <button type="button">让 AI 修改</button>
                  <button type="button">立即运行</button>
                  <button type="button">暂停</button>
                  <button type="button">取消</button>
                  <button type="button">打开聊天</button>
                  <button type="button">复制 ID</button>
                </div>
              </aside>
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>
`;

const workbenchMarkup = `
  <aside class="workbench" data-testid="workbench-panel">
    <div class="workbench-bar">
      <div class="workbench-tabs">
        <button class="workbench-tab active" type="button">文件</button>
        <button class="workbench-tab" type="button">Git</button>
        <button class="workbench-tab" type="button">终端</button>
      </div>
      <button class="workbench-close" type="button" aria-label="关闭右侧工作台"></button>
    </div>
    <div class="workbench-panel">
      <div class="workbench-surface">
        <div class="workbench-files">
          <div class="workbench-sidebar-pane">
            <div class="pane-header"><span class="pane-title">文件</span></div>
            <div class="workbench-file-tree">
              <button class="tree-item" type="button"><span class="tree-item-label">very-long-file-name-that-should-clip.ts</span></button>
            </div>
          </div>
          <div class="workbench-file-splitter"></div>
          <div class="workbench-content-pane">
            <div class="pane-header pane-header--content"><span class="pane-path">F:\\Code\\Roc\\very\\long\\file\\path.ts</span></div>
            <div class="workbench-file-body">
              <pre class="workbench-file-preview">content</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </aside>
`;

const chatWorkspaceBaseWidth = 1032;

function resolveChatScale(viewportWidth) {
  const expandedSidebarShellWidth = viewportWidth - 248 - 40;
  return Math.min(1, expandedSidebarShellWidth / chatWorkspaceBaseWidth);
}

function buildChatWorkbenchMarkup({ scale, scaleActive = true, workbenchOpen = false }) {
  const shellClass = workbenchOpen ? 'workspace-shell workspace-shell--chat' : 'workspace-shell workspace-shell--chat-collapsed';
  const workbenchSection = workbenchOpen ? workbenchMarkup : '';
  const chatScaleActive = scaleActive ? 'true' : 'false';

  return `
  <div class="app-shell" data-testid="roc-app">
    <div class="window-workband"></div>
    <div class="workspace workspace--chat">
      <aside class="sidebar"></aside>
      <div class="chat-workspace-scale-host" data-chat-scale-active="${chatScaleActive}" style="--chat-workspace-scale:${scale}; --chat-workspace-base-width:${chatWorkspaceBaseWidth}px;">
        <div class="chat-workspace-scale-frame">
          <div class="${shellClass}">
            <main class="workspace-main workspace-main--chat" data-testid="active-view">
              <section class="canvas canvas--chat">
                <div class="canvas-scroll">
                  <section class="canvas-stage chat-stage" data-testid="chat-view">
                    <div class="chat-empty-plane">
                      <div class="chat-page-shell">
                        <div class="chat-feedback-shell chat-feedback-shell--empty">
                          <div class="chat-feedback-stack">
                            <div class="chat-empty-copy">
                              <h1>Roc 本地工作台</h1>
                              <p>问问 Roc 或交给它一个任务</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="chat-bottom-stack chat-bottom-stack--empty">
                      <div class="composer composer--chat">
                        <textarea class="composer-input" data-testid="chat-input" rows="3">测试输入</textarea>
                        <div class="composer-bottom">
                          <div class="composer-left">
                            <button class="composer-tool" type="button" aria-label="上传文件"></button>
                            <span class="composer-popover-anchor"><button class="composer-tool composer-tool--tools" type="button" aria-label="工具"></button></span>
                            <span class="composer-popover-anchor"><button class="composer-tool composer-tool--skills" type="button" aria-label="技能"></button></span>
                            <span class="composer-popover-anchor">
                              <button class="model-pill model-pill--composer" type="button" aria-label="模型">
                                <span class="model-pill-copy">Smoke Model With Long Label</span>
                              </button>
                            </span>
                          </div>
                          <div class="composer-right">
                            <button class="send-button" data-testid="chat-task-submit" type="button" aria-label="发送"></button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </section>
            </main>
            <aside class="rail-overlay rail-overlay--chat">
              <div class="rail rail--chat">
                <button class="rail-button" type="button" aria-label="文件"></button>
                <button class="rail-button" type="button" aria-label="Git"></button>
                <button class="rail-button" type="button" aria-label="终端"></button>
              </div>
            </aside>
            ${workbenchSection}
          </div>
        </div>
      </div>
    </div>
  </div>
`;
}

function assertCondition(condition, message, evidence) {
  if (!condition) {
    throw new Error(`${message}: ${JSON.stringify(evidence, null, 2)}`);
  }
}

function buildDocument(markup) {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>${styles}</style>
      </head>
      <body>${markup}</body>
    </html>`;
}

async function readBoxes(page, selectors) {
  return await page.evaluate((targetSelectors) => {
    function box(selector) {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing selector: ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        flexDirection: style.flexDirection,
        flexWrap: style.flexWrap,
        gridTemplateColumns: style.gridTemplateColumns
      };
    }

    return Object.fromEntries([
      ['windowWidth', window.innerWidth],
      ['windowHeight', window.innerHeight],
      ...targetSelectors.map((entry) => [entry.key, box(entry.selector)])
    ]);
  }, selectors);
}

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
  await page.setContent(buildDocument(taskWorkbenchMarkup));

  const evidence = await readBoxes(page, [
    { key: 'workspace', selector: '.workspace' },
    { key: 'sidebar', selector: '.sidebar' },
    { key: 'canvas', selector: '.canvas' },
    { key: 'tasksView', selector: '[data-testid="tasks-view"]' },
    { key: 'rail', selector: '[data-testid="task-status-rail"]' },
    { key: 'table', selector: '[data-testid="task-table"]' },
    { key: 'drawer', selector: '[data-testid="task-detail-drawer"]' },
    { key: 'drawerRow', selector: '[data-testid="task-detail-drawer"] .row' },
    { key: 'drawerSub', selector: '[data-testid="task-detail-drawer"] .row-sub' },
    { key: 'drawerPill', selector: '[data-testid="task-detail-drawer"] .pill' }
  ]);

  assertCondition(evidence.tasksView.left <= 16, 'Narrow task view must not stay offset by a fixed sidebar', evidence);
  assertCondition(evidence.tasksView.width >= 600, 'Narrow task view must keep enough width for stacked content', evidence);
  assertCondition(evidence.rail.bottom <= evidence.table.top, 'Status rail and table must stack without overlap', evidence);
  assertCondition(evidence.table.bottom <= evidence.drawer.top, 'Task table and detail drawer must stack without overlap', evidence);
  assertCondition(evidence.drawer.right <= evidence.windowWidth, 'Task detail drawer must stay inside the viewport', evidence);
  assertCondition(evidence.drawerRow.scrollWidth <= evidence.drawerRow.clientWidth + 1, 'Detail row must not be widened by long tags', evidence);
  assertCondition(evidence.drawerSub.scrollWidth <= evidence.drawerSub.clientWidth + 1, 'Detail row subtext must wrap instead of overflowing', evidence);
  assertCondition(evidence.drawerPill.scrollWidth <= evidence.drawerPill.clientWidth + 1, 'Detail row pill must wrap or shrink inside the drawer', evidence);

  const narrowChatViewportWidth = 1160;
  await page.setViewportSize({ width: narrowChatViewportWidth, height: 720 });
  await page.setContent(buildDocument(buildChatWorkbenchMarkup({ scale: resolveChatScale(narrowChatViewportWidth) })));
  const chatEvidence = await readBoxes(page, [
    { key: 'workspace', selector: '.workspace' },
    { key: 'shell', selector: '.workspace-shell' },
    { key: 'main', selector: '.workspace-main' },
    { key: 'chatView', selector: '[data-testid="chat-view"]' },
    { key: 'composer', selector: '.composer' },
    { key: 'input', selector: '[data-testid="chat-input"]' },
    { key: 'composerBottom', selector: '.composer-bottom' },
    { key: 'composerLeft', selector: '.composer-left' },
    { key: 'composerRight', selector: '.composer-right' },
    { key: 'railOverlay', selector: '.rail-overlay' },
    { key: 'rail', selector: '.rail' }
  ]);

  assertCondition(chatEvidence.shell.bottom <= chatEvidence.windowHeight, 'Narrow chat shell must stay inside the viewport', chatEvidence);
  assertCondition(chatEvidence.composer.bottom <= chatEvidence.windowHeight, 'Narrow chat composer must stay inside the viewport', chatEvidence);
  assertCondition(chatEvidence.input.width >= 560, 'Narrow chat input must stay usable after proportional scaling', chatEvidence);
  assertCondition(chatEvidence.composerLeft.flexWrap === 'nowrap', 'Narrow chat composer controls must keep their desktop row positions while scaled', chatEvidence);
  assertCondition(chatEvidence.rail.flexDirection === 'column', 'Narrow chat rail must remain a vertical right toolbar', chatEvidence);
  assertCondition(chatEvidence.rail.height > chatEvidence.rail.width, 'Narrow chat rail must stay taller than it is wide', chatEvidence);
  assertCondition(chatEvidence.railOverlay.left >= chatEvidence.main.right - 2, 'Narrow chat rail must stay to the right of the main chat column', chatEvidence);
  assertCondition(chatEvidence.shell.gridTemplateColumns.trim().split(/\s+/).length === 2, 'Collapsed narrow chat shell must keep two columns instead of stacking', chatEvidence);
  assertCondition(chatEvidence.railOverlay.bottom <= chatEvidence.windowHeight, 'Narrow chat rail must stay inside the viewport', chatEvidence);

  await page.setViewportSize({ width: narrowChatViewportWidth, height: 720 });
  await page.setContent(buildDocument(buildChatWorkbenchMarkup({ scale: 1, scaleActive: false })));
  const unscaledBreakpointEvidence = await readBoxes(page, [
    { key: 'shell', selector: '.workspace-shell' },
    { key: 'main', selector: '.workspace-main' },
    { key: 'composerBottom', selector: '.composer-bottom' },
    { key: 'composerLeft', selector: '.composer-left' },
    { key: 'composerRight', selector: '.composer-right' },
    { key: 'railOverlay', selector: '.rail-overlay' },
    { key: 'rail', selector: '.rail' }
  ]);

  assertCondition(
    unscaledBreakpointEvidence.shell.gridTemplateColumns.trim().split(/\s+/).length === 2,
    'Legacy breakpoint must not stack collapsed chat shell when scale is inactive',
    unscaledBreakpointEvidence
  );
  assertCondition(
    unscaledBreakpointEvidence.rail.flexDirection === 'column',
    'Legacy breakpoint must not turn the chat rail into a horizontal toolbar',
    unscaledBreakpointEvidence
  );
  assertCondition(
    unscaledBreakpointEvidence.railOverlay.left >= unscaledBreakpointEvidence.main.right - 2,
    'Legacy breakpoint must keep the chat rail to the right of the main column',
    unscaledBreakpointEvidence
  );
  assertCondition(
    unscaledBreakpointEvidence.composerLeft.flexWrap === 'nowrap',
    'Legacy breakpoint must not let composer controls wrap away from their desktop positions',
    unscaledBreakpointEvidence
  );
  assertCondition(
    unscaledBreakpointEvidence.composerBottom.scrollWidth <= unscaledBreakpointEvidence.composerBottom.clientWidth + 1,
    'Legacy breakpoint composer controls must stay inside the input footer row',
    unscaledBreakpointEvidence
  );

  const openWorkbenchResults = [];
  for (const width of [1160]) {
    await page.setViewportSize({ width, height: 720 });
    await page.setContent(buildDocument(buildChatWorkbenchMarkup({ scale: resolveChatScale(width), workbenchOpen: true })));
    const openWorkbenchEvidence = await readBoxes(page, [
      { key: 'shell', selector: '.workspace-shell' },
      { key: 'main', selector: '.workspace-main' },
      { key: 'composer', selector: '.composer' },
      { key: 'input', selector: '[data-testid="chat-input"]' },
      { key: 'composerLeft', selector: '.composer-left' },
      { key: 'railOverlay', selector: '.rail-overlay' },
      { key: 'rail', selector: '.rail' },
      { key: 'workbench', selector: '[data-testid="workbench-panel"]' },
      { key: 'workbenchPanel', selector: '.workbench-panel' },
      { key: 'workbenchContent', selector: '.workbench-content-pane' }
    ]);
    openWorkbenchResults.push({ width, evidence: openWorkbenchEvidence });

    assertCondition(openWorkbenchEvidence.shell.bottom <= openWorkbenchEvidence.windowHeight, 'Open workbench shell must stay inside the viewport', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.composer.bottom <= openWorkbenchEvidence.main.bottom, 'Open workbench composer must stay inside the chat main area', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.input.width >= 300, 'Open workbench input must keep usable width after scaling', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.composerLeft.flexWrap === 'nowrap', 'Open workbench composer controls must keep their desktop row positions while scaled', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.rail.flexDirection === 'column', 'Open workbench rail must remain vertical after shrink', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.rail.height > openWorkbenchEvidence.rail.width, 'Open workbench rail must stay taller than it is wide', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.railOverlay.left >= openWorkbenchEvidence.main.right - 2, 'Open workbench rail must stay to the right of the main chat column', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.workbench.left >= openWorkbenchEvidence.railOverlay.right - 2, 'Open workbench panel must stay to the right of the rail', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.shell.gridTemplateColumns.trim().split(/\s+/).length === 3, 'Open workbench shell must keep three columns instead of stacking', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.workbench.bottom <= openWorkbenchEvidence.windowHeight, 'Open workbench panel must stay inside the viewport', openWorkbenchEvidence);
    assertCondition(openWorkbenchEvidence.workbenchContent.height >= 100, 'Open workbench content pane must keep usable height', openWorkbenchEvidence);
  }

  console.log(JSON.stringify({ task: evidence, chat: chatEvidence, unscaledBreakpointChat: unscaledBreakpointEvidence, openWorkbench: openWorkbenchResults }, null, 2));
} finally {
  await browser.close();
}
