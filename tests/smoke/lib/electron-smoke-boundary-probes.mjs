export async function runSmokeBoundaryProbes(ctx) {
  const { page, mainMaterialEvidence } = ctx;
  const materialEvidence = {
    main: mainMaterialEvidence
  };

  const boundary = await page.evaluate(() => ({
    hasRequire: typeof globalThis.require !== 'undefined',
    hasProcess: typeof globalThis.process !== 'undefined',
    rocKeys: window.roc ? Object.keys(window.roc).sort() : [],
    appKeys: window.roc ? Object.keys(window.roc.app).sort() : [],
    windowKeys: window.roc ? Object.keys(window.roc.window).sort() : [],
    workspaceKeys: window.roc ? Object.keys(window.roc.workspace).sort() : [],
    fileKeys: window.roc ? Object.keys(window.roc.files).sort() : [],
    memoryKeys: window.roc ? Object.keys(window.roc.memory).sort() : [],
    settingsKeys: window.roc ? Object.keys(window.roc.settings).sort() : [],
    mcpKeys: window.roc ? Object.keys(window.roc.mcp).sort() : [],
    skillKeys: window.roc ? Object.keys(window.roc.skills).sort() : [],
    taskKeys: window.roc ? Object.keys(window.roc.tasks).sort() : [],
    lifecycleKeys: window.roc ? Object.keys(window.roc.lifecycle).sort() : [],
    diagnosticsKeys: window.roc ? Object.keys(window.roc.diagnostics).sort() : [],
    agentKeys: window.roc ? Object.keys(window.roc.agent).sort() : [],
    terminalKeys: window.roc ? Object.keys(window.roc.terminal).sort() : [],
    shellKeys: window.roc ? Object.keys(window.roc.shell).sort() : [],
    activeViewText: (() => {
      const activeView = document.querySelector('[data-testid="active-view"]');
      if (activeView === null) {
        return '';
      }
      if (activeView.textContent === null) {
        return '';
      }
      return activeView.textContent;
    })()
  }));
  const workspaceSelectButtonEvidence = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="workspace-select-button"]');
    if (!(button instanceof HTMLButtonElement)) {
      return {
        exists: button !== null,
        clickable: false,
        text: '',
        visibleInViewport: false
      };
    }
    const rect = button.getBoundingClientRect();
    return {
      exists: true,
      clickable: !button.disabled,
      text: button.textContent ?? '',
      visibleInViewport:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth
    };
  });
  // 侧栏底部 dock 常驻：设置入口必须在不滚动的前提下完整落在侧栏内，
  // 并且在侧栏上滚轮后仍然可见（证明它是固定行，而不是被滚出视野的普通内容）。
  const sidebarDockEvidenceBefore = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const dock = document.querySelector('.sidebar-dock');
    const settingsButton = document.querySelector('[data-testid="settings-gear"]');
    if (!(sidebar instanceof HTMLElement) || !(dock instanceof HTMLElement) || !(settingsButton instanceof HTMLButtonElement)) {
      return {
        sidebarExists: sidebar !== null,
        dockExists: dock !== null,
        settingsExists: settingsButton !== null,
        clientHeight: null,
        scrollHeight: null,
        dockInsideSidebar: false,
        settingsVisible: false
      };
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const settingsRect = settingsButton.getBoundingClientRect();
    return {
      sidebarExists: true,
      dockExists: true,
      settingsExists: true,
      clientHeight: sidebar.clientHeight,
      scrollHeight: sidebar.scrollHeight,
      dockInsideSidebar: dockRect.top >= sidebarRect.top - 1 && dockRect.bottom <= sidebarRect.bottom + 1,
      settingsVisible:
        settingsRect.top >= sidebarRect.top &&
        settingsRect.bottom <= sidebarRect.bottom &&
        settingsRect.height > 0 &&
        settingsRect.width > 0
    };
  });
  await page.hover('.sidebar');
  await page.mouse.wheel(0, 640);
  await page.waitForTimeout(150);
  const sidebarDockEvidenceAfter = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const dock = document.querySelector('.sidebar-dock');
    const settingsButton = document.querySelector('[data-testid="settings-gear"]');
    if (!(sidebar instanceof HTMLElement) || !(dock instanceof HTMLElement) || !(settingsButton instanceof HTMLButtonElement)) {
      return {
        sidebarExists: sidebar !== null,
        dockExists: dock !== null,
        settingsExists: settingsButton !== null,
        scrollTop: null,
        dockInsideSidebar: false,
        settingsVisible: false
      };
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const settingsRect = settingsButton.getBoundingClientRect();
    return {
      sidebarExists: true,
      dockExists: true,
      settingsExists: true,
      scrollTop: sidebar.scrollTop,
      dockInsideSidebar: dockRect.top >= sidebarRect.top - 1 && dockRect.bottom <= sidebarRect.bottom + 1,
      settingsVisible:
        settingsRect.top >= sidebarRect.top &&
        settingsRect.bottom <= sidebarRect.bottom &&
        settingsRect.height > 0 &&
        settingsRect.width > 0
    };
  });
  const sidebarSettingsPinned =
    sidebarDockEvidenceBefore.sidebarExists &&
    sidebarDockEvidenceBefore.dockExists &&
    sidebarDockEvidenceBefore.settingsExists &&
    sidebarDockEvidenceBefore.dockInsideSidebar &&
    sidebarDockEvidenceBefore.settingsVisible &&
    sidebarDockEvidenceAfter.dockInsideSidebar &&
    sidebarDockEvidenceAfter.settingsVisible;

  Object.assign(ctx, {
    materialEvidence,
    boundary,
    workspaceSelectButtonEvidence,
    sidebarDockEvidenceBefore,
    sidebarDockEvidenceAfter,
    sidebarSettingsPinned
  });
}
