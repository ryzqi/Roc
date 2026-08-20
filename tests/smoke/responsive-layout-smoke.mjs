import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const styles = [
  'tokens.css',
  'base.css',
  'app-shell.css',
  'app-sidebar.css',
  'chat.css',
  'chat-rich-content.css',
  'shared.css',
  'settings.css',
  'composer.css',
  'tool-call.css',
  'subagent.css',
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
          <section class="canvas-stage stage-grid task-board-page" data-testid="tasks-board-view">
            <div class="task-board-grid" data-testid="task-board-grid">
              <section class="task-board-column" data-testid="task-board-column-todo">
                <header class="task-board-column-head">
                  <h2 class="section-title">待处理</h2>
                  <span class="status-pill info"><span>1</span></span>
                </header>
                <div class="task-board-column-list">
                  <button class="task-board-card" data-testid="task-board-card-long" type="button">
                    <span class="task-board-card-title">窄屏任务布局回归检查：确认看板卡片和详情页在窗口缩小时不会互相覆盖</span>
                    <span class="task-board-card-meta">pending_confirmation</span>
                    <span class="task-board-card-meta">F:\\Code\\Roc\\very\\long\\workspace\\path\\that\\should\\wrap</span>
                  </button>
                </div>
              </section>
              <section class="task-board-column" data-testid="task-board-column-running">
                <header class="task-board-column-head">
                  <h2 class="section-title">进行中</h2>
                  <span class="status-pill info"><span>0</span></span>
                </header>
                <div class="task-board-column-list"></div>
              </section>
              <section class="task-board-column" data-testid="task-board-column-paused">
                <header class="task-board-column-head">
                  <h2 class="section-title">已暂停</h2>
                  <span class="status-pill info"><span>0</span></span>
                </header>
                <div class="task-board-column-list"></div>
              </section>
              <section class="task-board-column" data-testid="task-board-column-done">
                <header class="task-board-column-head">
                  <h2 class="section-title">已结束</h2>
                  <span class="status-pill info"><span>0</span></span>
                </header>
                <div class="task-board-column-list"></div>
              </section>
            </div>
          </section>
          <section class="canvas-stage task-detail-page" data-testid="task-detail-view">
            <div class="task-detail-page-head">
              <button class="action-button" type="button">返回任务工作台</button>
              <div class="page-copy">
                <h1 class="page-title mini">窄屏任务布局回归检查</h1>
              </div>
            </div>
            <div class="task-detail-content-shell">
              <div class="task-detail-page-body" data-testid="task-detail-page-body">
                <div class="task-detail-main-column">
                  <section class="task-detail-panel task-detail-summary-panel" data-testid="task-detail-summary-panel">
                    <div class="task-detail-panel-head">
                      <div>
                        <span class="task-detail-kicker">Task Console</span>
                        <h2>任务概览</h2>
                      </div>
                    </div>
                    <p class="task-detail-goal">窄屏任务布局回归检查：确认详情页控制台在窗口缩小时不会互相覆盖。</p>
                    <div class="task-detail-metric-grid">
                      <div class="task-detail-metric"><span>当前状态</span><strong>waiting_user</strong></div>
                      <div class="task-detail-metric"><span>运行次数</span><strong>运行 7 次</strong></div>
                      <div class="task-detail-metric"><span>最近运行</span><strong>2026-05-16 01:00</strong></div>
                      <div class="task-detail-metric"><span>下次运行</span><strong>2026-05-17 01:00</strong></div>
                    </div>
                  </section>
                  <section class="task-detail-panel task-detail-transcript-shell">
                    <div class="chat-transcript" data-testid="chat-transcript">
                      <div class="chat-message-row chat-message-row--assistant" data-testid="chat-message-assistant">
                        <article class="chat-bubble chat-bubble--assistant">
                          <div class="chat-assistant-content" data-testid="chat-assistant-content">
                            <p>任务详情页转录内容保持在任务域内。</p>
                          </div>
                        </article>
                      </div>
                    </div>
                  </section>
                  <form class="task-detail-followup" data-testid="task-detail-followup">
                    <textarea data-testid="task-detail-followup-input">F:\\Code\\Roc\\very\\long\\workspace\\path\\that\\should\\wrap\\inside\\followup</textarea>
                    <button class="action-button" type="submit">继续任务</button>
                  </form>
                </div>
                <aside class="task-detail-side-column">
                  <section class="task-detail-panel task-detail-meta-panel" data-testid="task-detail-meta-panel">
                    <dl class="task-detail-meta-list">
                      <div class="task-detail-meta-row"><dt>工作区</dt><dd>F:\\Code\\Roc\\very\\long\\workspace\\path\\that\\should\\wrap</dd></div>
                      <div class="task-detail-meta-row"><dt>触发器</dt><dd>每天 09:00 · cron</dd></div>
                    </dl>
                  </section>
                </aside>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>
`;

const observabilitySettingsMarkup = `
  <div class="app-shell" data-testid="roc-app">
    <div class="window-workband"></div>
    <div class="workspace">
      <aside class="sidebar"></aside>
      <main class="canvas">
        <div class="canvas-scroll">
          <div class="page-strip settings-page-strip">
            <span class="pill warn" data-testid="settings-dirty-count">未保存 1 项</span>
            <div class="settings-page-actions" data-testid="settings-page-actions">
              <button class="secondary" type="button">放弃修改</button>
              <button class="primary" type="button">保存设置</button>
            </div>
          </div>
          <section class="canvas-stage stage-grid settings-view-stage" data-testid="settings-view">
            <div class="split settings-layout" data-testid="settings-layout">
              <nav class="settings-list settings-sidebar-card" data-testid="settings-sidebar">
                <button class="settings-item" type="button">模型提供商</button>
                <button class="settings-item" type="button">默认模型</button>
                <button class="settings-item" type="button">应用基础</button>
                <button class="settings-item" type="button">任务与调度</button>
                <button class="settings-item" type="button">授权与安全</button>
                <button class="settings-item" type="button">Hooks</button>
                <button class="settings-item active" type="button">可观测性</button>
                <button class="settings-item" type="button">记忆策略</button>
              </nav>
              <div class="settings-panel-stack settings-panel-stack--compact">
                <section class="single-panel settings-section-panel" data-testid="settings-panel-observability">
                  <div class="section-head">
                    <div>
                      <h2 class="section-title">可观测性</h2>
                      <p class="card-hint">LangSmith tracing 默认关闭，仅在明确启用后发送数据。</p>
                    </div>
                  </div>
                  <div class="settings-observability-disclosure" data-testid="settings-observability-disclosure">
                    <strong>数据边界</strong>
                    <p>启用后，Roc 会将经脱敏的 trace 数据发送到 LangSmith。项目名称用于选择 LangSmith project；数据保留期限由 LangSmith workspace 的 retention policy 控制。</p>
                  </div>
                  <div class="settings-form settings-observability-form" data-testid="settings-observability-form">
                    <div class="settings-section-group settings-observability-group">
                      <div class="settings-observability-group-header">
                        <h3 class="settings-group-title">Tracing 配置</h3>
                        <span class="status-pill ok"><span>配置</span><strong>已同步</strong></span>
                      </div>
                      <label class="field checkbox-field settings-toggle-row settings-observability-toggle">
                        <span>启用 LangSmith tracing</span>
                        <input type="checkbox">
                        <small class="field-hint">关闭时不会向 LangSmith 发送新的 trace。</small>
                      </label>
                      <label class="field">
                        <span>项目名称</span>
                        <input data-testid="settings-observability-project-name" type="text" value="roc-production-observability-project">
                        <small class="field-hint">用于在 LangSmith workspace 中归集 Roc trace。</small>
                      </label>
                      <div class="settings-actions settings-observability-actions" data-testid="settings-observability-config-actions">
                        <button class="primary" type="button">保存配置</button>
                      </div>
                    </div>
                    <div class="settings-section-group settings-observability-group">
                      <div class="settings-observability-group-header">
                        <h3 class="settings-group-title">API Key</h3>
                        <span class="status-pill ok"><span>密钥</span><strong>已安全存储</strong></span>
                      </div>
                      <label class="field">
                        <span>LangSmith API Key</span>
                        <input data-testid="settings-observability-api-key" type="password" value="">
                        <small class="field-hint">仅在本机加密存储；读取设置时只返回是否已存储。</small>
                      </label>
                      <div class="settings-actions settings-observability-actions" data-testid="settings-observability-key-actions">
                        <button class="primary" type="button">保存 API Key</button>
                        <button class="secondary" type="button">清除 API Key</button>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
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

function buildHistoryMenuMarkup({ left, top }) {
  return `
    <div class="history-row">
      <button class="history-row-main" type="button">
        <span aria-hidden="true"></span>
        <span class="nav-copy">
          <span class="nav-label">History title with an intentionally very long unbroken suffix-abcdefghijklmnopqrstuvwxyz0123456789</span>
          <span class="nav-meta">2026-08-20 15:20</span>
        </span>
      </button>
      <button class="history-row-more" type="button" aria-label="更多历史会话操作"></button>
      <div class="history-context-menu" role="menu" style="left:${left}px;top:${top}px">
        <button role="menuitem" type="button">删除</button>
      </div>
    </div>
  `;
}

function buildSidebarHistoryMarkup() {
  const rows = Array.from({ length: 12 }, (_value, index) => `
    <div class="history-row">
      <button class="history-row-main" type="button">
        <span aria-hidden="true"></span>
        <span class="nav-copy">
          <span class="nav-label">历史会话 ${index + 1} with-a-very-long-title-that-must-not-overlap-actions</span>
          <span class="nav-meta">2026-08-20 15:${String(index).padStart(2, '0')}</span>
        </span>
      </button>
      <button class="history-row-more" type="button" aria-label="更多历史会话操作"></button>
    </div>
  `).join('');
  return `
    <div class="workspace workspace--chat" style="width:320px;height:360px;padding:0;grid-template-columns:248px minmax(0,1fr)">
      <aside class="sidebar">
        <div class="sidebar-head"><button class="workspace-pill" type="button"><span>F:\\Code\\Roc</span><strong>选择</strong></button></div>
        <div class="sidebar-block sidebar-block--history sidebar-block--history-search">
          <div class="side-title">历史会话</div>
          <label class="history-search-field"><input type="search" value=""></label>
          <div class="sidebar-block-scroll history-list">${rows}</div>
        </div>
        <div class="sidebar-block sidebar-block--tasks"><div class="side-title">任务工作台</div><div class="sidebar-block-scroll nav-list"></div></div>
      </aside>
      <main></main>
    </div>
  `;
}

function buildChatRichContentMarkup() {
  const longToken = 'chat-content-abcdefghijklmnopqrstuvwxyz0123456789'.repeat(5);
  return `
    <main style="width:320px;padding:12px">
      <div class="chat-transcript">
        <div class="chat-transcript-header"></div>
        <div class="chat-transcript-item">
          <div class="chat-message-row chat-message-row--assistant">
            <article class="chat-bubble chat-bubble--assistant">
              <div class="chat-assistant-content">
                <p>${longToken}</p>
                <div class="chat-approval-card">
                  <div class="chat-approval-head">等待审批</div>
                  <ul class="chat-approval-actions">
                    <li class="chat-approval-item">
                      <span class="chat-approval-tool">${longToken}</span>
                      <pre class="chat-approval-args">{"path":"${longToken}"}</pre>
                    </li>
                  </ul>
                </div>
                <div class="code-card">
                  <div class="code-card-head"><span class="code-card-lang">typescript</span></div>
                  <pre><code>${longToken}</code></pre>
                </div>
                <details class="tool-call-modern">
                  <summary class="tool-call-modern__header">
                    <span class="tool-call-modern__name">${longToken}</span>
                    <span class="tool-call-modern__badge">running</span>
                  </summary>
                </details>
              </div>
            </article>
          </div>
        </div>
        <div class="chat-transcript-item">
          <div class="chat-message-row chat-message-row--user">
            <article class="chat-bubble chat-bubble--user">
              <p>${longToken}</p>
              <div class="chat-message-attachments">
                <span class="chat-message-attachment"><span>${longToken}.png</span><small>1 KB</small></span>
              </div>
            </article>
          </div>
        </div>
      </div>
      <div class="chat-bottom-stack">
        <form class="composer composer--chat">
          <div class="chat-attachment-strip">
            <span class="chat-attachment-pill"><span>${longToken}.png</span><small>1 KB</small></span>
          </div>
          <textarea class="composer-input">${longToken}</textarea>
          <div class="composer-bottom"><div class="composer-left"></div><div class="composer-right"></div></div>
        </form>
      </div>
    </main>
  `;
}

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
        gridTemplateColumns: style.gridTemplateColumns,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace
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
  for (const viewport of [{ width: 320, height: 480 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    const left = viewport.width - 112 - 8;
    const top = viewport.height - 48 - 8;
    await page.setContent(buildDocument(buildHistoryMenuMarkup({ left, top })));
    const menuEvidence = await readBoxes(page, [
      { key: 'row', selector: '.history-row' },
      { key: 'main', selector: '.history-row-main' },
      { key: 'title', selector: '.nav-label' },
      { key: 'more', selector: '.history-row-more' },
      { key: 'menu', selector: '.history-context-menu' }
    ]);
    assertCondition(menuEvidence.menu.left >= 8, 'History menu must keep the left viewport margin', menuEvidence);
    assertCondition(menuEvidence.menu.top >= 8, 'History menu must keep the top viewport margin', menuEvidence);
    assertCondition(menuEvidence.menu.right <= viewport.width - 8, 'History menu must keep the right viewport margin', menuEvidence);
    assertCondition(menuEvidence.menu.bottom <= viewport.height - 8, 'History menu must keep the bottom viewport margin', menuEvidence);
    assertCondition(menuEvidence.main.right <= menuEvidence.more.left, 'History title column must not overlap the More button', menuEvidence);
    assertCondition(menuEvidence.more.width === 32, 'History More button must keep its fixed width', menuEvidence);
    assertCondition(menuEvidence.title.overflowX === 'hidden', 'History title must clip inside its text column', menuEvidence);
    assertCondition(menuEvidence.title.textOverflow === 'ellipsis', 'History title must expose truncation with ellipsis', menuEvidence);
    assertCondition(menuEvidence.title.whiteSpace === 'nowrap', 'History title must keep a stable single-line height', menuEvidence);
  }

  await page.setViewportSize({ width: 320, height: 480 });
  await page.setContent(buildDocument(buildSidebarHistoryMarkup()));
  const historyScrollEvidence = await readBoxes(page, [
    { key: 'sidebar', selector: '.sidebar' },
    { key: 'historyBlock', selector: '.sidebar-block--history' },
    { key: 'historyList', selector: '.history-list' },
    { key: 'firstRow', selector: '.history-row' }
  ]);
  assertCondition(historyScrollEvidence.sidebar.overflowY === 'hidden', 'Chat sidebar must not compete with history scrolling', historyScrollEvidence);
  assertCondition(historyScrollEvidence.historyList.overflowY === 'auto', 'History list must own vertical scrolling', historyScrollEvidence);
  assertCondition(historyScrollEvidence.historyList.scrollWidth <= historyScrollEvidence.historyList.clientWidth + 1, 'History list must not overflow horizontally', historyScrollEvidence);
  assertCondition(historyScrollEvidence.firstRow.right <= historyScrollEvidence.historyList.right, 'History rows must stay inside the history list', historyScrollEvidence);

  await page.setViewportSize({ width: 320, height: 720 });
  await page.setContent(buildDocument(buildChatRichContentMarkup()));
  const richContentEvidence = await readBoxes(page, [
    { key: 'transcript', selector: '.chat-transcript' },
    { key: 'assistantRow', selector: '.chat-message-row--assistant' },
    { key: 'assistantBubble', selector: '.chat-bubble--assistant' },
    { key: 'assistantContent', selector: '.chat-assistant-content' },
    { key: 'approval', selector: '.chat-approval-card' },
    { key: 'approvalItem', selector: '.chat-approval-item' },
    { key: 'approvalArgs', selector: '.chat-approval-args' },
    { key: 'codeCard', selector: '.code-card' },
    { key: 'codePre', selector: '.code-card pre' },
    { key: 'toolCall', selector: '.tool-call-modern' },
    { key: 'userBubble', selector: '.chat-bubble--user' },
    { key: 'messageAttachment', selector: '.chat-message-attachment' },
    { key: 'composer', selector: '.composer--chat' },
    { key: 'composerAttachment', selector: '.chat-attachment-pill' }
  ]);
  const richDocumentWidth = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth
  }));
  for (const key of ['transcript', 'assistantRow', 'assistantBubble', 'assistantContent', 'approval', 'approvalItem', 'codeCard', 'toolCall', 'userBubble', 'messageAttachment', 'composer', 'composerAttachment']) {
    assertCondition(richContentEvidence[key].right <= 320, `Narrow chat ${key} must stay inside the viewport`, richContentEvidence);
  }
  assertCondition(richContentEvidence.approvalArgs.overflowX === 'auto', 'Approval JSON must own its horizontal scrolling', richContentEvidence);
  assertCondition(richContentEvidence.codePre.overflowX === 'auto', 'Code blocks must own their horizontal scrolling', richContentEvidence);
  assertCondition(richDocumentWidth.document <= 320, 'Narrow chat document must not overflow horizontally', { richContentEvidence, richDocumentWidth });
  assertCondition(richDocumentWidth.body <= 320, 'Narrow chat body must not overflow horizontally', { richContentEvidence, richDocumentWidth });

  const settingsResults = [];
  for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.setContent(buildDocument(observabilitySettingsMarkup));
    const settingsEvidence = await readBoxes(page, [
      { key: 'pageActions', selector: '[data-testid="settings-page-actions"]' },
      { key: 'layout', selector: '[data-testid="settings-layout"]' },
      { key: 'sidebar', selector: '[data-testid="settings-sidebar"]' },
      { key: 'panel', selector: '[data-testid="settings-panel-observability"]' },
      { key: 'disclosure', selector: '[data-testid="settings-observability-disclosure"]' },
      { key: 'form', selector: '[data-testid="settings-observability-form"]' },
      { key: 'projectInput', selector: '[data-testid="settings-observability-project-name"]' },
      { key: 'apiKeyInput', selector: '[data-testid="settings-observability-api-key"]' },
      { key: 'configActions', selector: '[data-testid="settings-observability-config-actions"]' },
      { key: 'keyActions', selector: '[data-testid="settings-observability-key-actions"]' }
    ]);
    const documentWidth = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth
    }));
    const keyButtonBoxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="settings-observability-key-actions"] button')).map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })
    );
    settingsResults.push({ viewport, evidence: settingsEvidence, documentWidth, keyButtonBoxes });

    const expectedColumnCount = viewport.width <= 1180 ? 1 : 2;
    assertCondition(
      settingsEvidence.layout.gridTemplateColumns.trim().split(/\s+/).length === expectedColumnCount,
      'Observability settings layout must use the expected responsive column count',
      settingsEvidence
    );
    assertCondition(settingsEvidence.sidebar.right <= viewport.width, 'Settings navigation must stay inside the viewport', settingsEvidence);
    assertCondition(settingsEvidence.panel.right <= viewport.width, 'Observability settings panel must stay inside the viewport', settingsEvidence);
    assertCondition(documentWidth.document <= viewport.width, 'Observability settings document must not overflow horizontally', { settingsEvidence, documentWidth });
    assertCondition(documentWidth.body <= viewport.width, 'Observability settings body must not overflow horizontally', { settingsEvidence, documentWidth });
    for (const key of ['pageActions', 'disclosure', 'form', 'projectInput', 'apiKeyInput', 'configActions', 'keyActions']) {
      assertCondition(
        settingsEvidence[key].scrollWidth <= settingsEvidence[key].clientWidth + 1,
        `Observability settings ${key} must not overflow horizontally`,
        settingsEvidence
      );
    }
    assertCondition(keyButtonBoxes.length === 2, 'Observability key actions must render both commands', keyButtonBoxes);
    const [firstKeyButton, secondKeyButton] = keyButtonBoxes;
    assertCondition(
      [
        firstKeyButton.right <= secondKeyButton.left,
        firstKeyButton.bottom <= secondKeyButton.top
      ].some((separated) => separated),
      'Observability key action buttons must not overlap',
      keyButtonBoxes
    );
  }

  await page.setViewportSize({ width: 640, height: 640 });
  await page.setContent(buildDocument(taskWorkbenchMarkup));

  const evidence = await readBoxes(page, [
    { key: 'workspace', selector: '.workspace' },
    { key: 'sidebar', selector: '.sidebar' },
    { key: 'canvas', selector: '.canvas' },
    { key: 'taskBoard', selector: '[data-testid="tasks-board-view"]' },
    { key: 'boardGrid', selector: '[data-testid="task-board-grid"]' },
    { key: 'todoColumn', selector: '[data-testid="task-board-column-todo"]' },
    { key: 'runningColumn', selector: '[data-testid="task-board-column-running"]' },
    { key: 'taskCard', selector: '[data-testid="task-board-card-long"]' },
    { key: 'taskCardTitle', selector: '[data-testid="task-board-card-long"] .task-board-card-title' },
    { key: 'taskDetail', selector: '[data-testid="task-detail-view"]' },
    { key: 'taskDetailBody', selector: '[data-testid="task-detail-page-body"]' },
    { key: 'taskFollowup', selector: '[data-testid="task-detail-followup"]' },
    { key: 'taskFollowupInput', selector: '[data-testid="task-detail-followup-input"]' }
  ]);

  assertCondition(evidence.taskBoard.left <= 16, 'Narrow task board must not stay offset by a fixed sidebar', evidence);
  assertCondition(evidence.taskBoard.width >= 600, 'Narrow task board must keep enough width for stacked content', evidence);
  assertCondition(evidence.boardGrid.gridTemplateColumns.trim().split(/\s+/).length === 1, 'Narrow task board columns must collapse to one column', evidence);
  assertCondition(evidence.todoColumn.bottom <= evidence.runningColumn.top, 'Task board columns must stack without overlap', evidence);
  assertCondition(evidence.taskCardTitle.scrollWidth <= evidence.taskCardTitle.clientWidth + 1, 'Task board card title must wrap instead of overflowing', evidence);
  assertCondition(evidence.taskCard.right <= evidence.windowWidth, 'Task board card must stay inside the viewport', evidence);
  assertCondition(evidence.taskBoard.bottom <= evidence.taskDetail.top, 'Task board and detail page fixtures must stack without overlap', evidence);
  assertCondition(evidence.taskDetail.right <= evidence.windowWidth, 'Task detail page must stay inside the viewport', evidence);
  assertCondition(evidence.taskDetailBody.gridTemplateColumns.trim().split(/\s+/).length === 1, 'Narrow task detail body must stay one column', evidence);
  assertCondition(evidence.taskFollowupInput.scrollWidth <= evidence.taskFollowupInput.clientWidth + 1, 'Task detail follow-up input must stay inside the detail page', evidence);

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

  console.log(JSON.stringify({ settings: settingsResults, task: evidence, chat: chatEvidence, unscaledBreakpointChat: unscaledBreakpointEvidence, openWorkbench: openWorkbenchResults }, null, 2));
} finally {
  await browser.close();
}
