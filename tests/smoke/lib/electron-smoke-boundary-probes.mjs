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
  const sidebarScrollEvidenceBefore = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const controlBlock = document.querySelector('.sidebar-block--control');
    const settingsButton = document.querySelector('[data-testid="settings-gear"]');
    if (!(sidebar instanceof HTMLElement) || !(controlBlock instanceof HTMLElement) || !(settingsButton instanceof HTMLButtonElement)) {
      return {
        sidebarExists: sidebar !== null,
        controlBlockExists: controlBlock !== null,
        settingsExists: settingsButton !== undefined,
        clientHeight: null,
        scrollHeight: null,
        scrollTop: null,
        settingsVisible: false,
        probeApplied: false
      };
    }
    controlBlock.style.marginTop = '520px';
    const sidebarRect = sidebar.getBoundingClientRect();
    const settingsRect = settingsButton.getBoundingClientRect();
    return {
      sidebarExists: true,
      controlBlockExists: true,
      settingsExists: true,
      clientHeight: sidebar.clientHeight,
      scrollHeight: sidebar.scrollHeight,
      scrollTop: sidebar.scrollTop,
      settingsVisible:
        settingsRect.top >= sidebarRect.top &&
        settingsRect.bottom <= sidebarRect.bottom &&
        settingsRect.height > 0 &&
        settingsRect.width > 0,
      probeApplied: true
    };
  });
  await page.hover('.sidebar');
  await page.mouse.wheel(0, 640);
  await page.waitForTimeout(150);
  const sidebarScrollEvidenceAfter = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const controlBlock = document.querySelector('.sidebar-block--control');
    const settingsButton = document.querySelector('[data-testid="settings-gear"]');
    if (!(sidebar instanceof HTMLElement) || !(controlBlock instanceof HTMLElement) || !(settingsButton instanceof HTMLButtonElement)) {
      return {
        sidebarExists: sidebar !== null,
        controlBlockExists: controlBlock !== null,
        settingsExists: settingsButton !== undefined,
        clientHeight: null,
        scrollHeight: null,
        scrollTop: null,
        settingsVisible: false,
        probeApplied: false
      };
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const settingsRect = settingsButton.getBoundingClientRect();
    const result = {
      sidebarExists: true,
      controlBlockExists: true,
      settingsExists: true,
      clientHeight: sidebar.clientHeight,
      scrollHeight: sidebar.scrollHeight,
      scrollTop: sidebar.scrollTop,
      settingsVisible:
        settingsRect.top >= sidebarRect.top &&
        settingsRect.bottom <= sidebarRect.bottom &&
        settingsRect.height > 0 &&
        settingsRect.width > 0,
      probeApplied: true
    };
    controlBlock.style.marginTop = '';
    return result;
  });
  const sidebarSettingsReachable =
    sidebarScrollEvidenceBefore.sidebarExists &&
    sidebarScrollEvidenceBefore.controlBlockExists &&
    sidebarScrollEvidenceBefore.settingsExists &&
    sidebarScrollEvidenceBefore.probeApplied &&
    sidebarScrollEvidenceAfter.probeApplied &&
    (sidebarScrollEvidenceBefore.settingsVisible ||
      (typeof sidebarScrollEvidenceBefore.clientHeight === 'number' &&
        typeof sidebarScrollEvidenceBefore.scrollHeight === 'number' &&
        sidebarScrollEvidenceBefore.scrollHeight > sidebarScrollEvidenceBefore.clientHeight &&
        typeof sidebarScrollEvidenceBefore.scrollTop === 'number' &&
        typeof sidebarScrollEvidenceAfter.scrollTop === 'number' &&
        sidebarScrollEvidenceAfter.scrollTop > sidebarScrollEvidenceBefore.scrollTop &&
        sidebarScrollEvidenceAfter.settingsVisible));

  Object.assign(ctx, {
    materialEvidence,
    boundary,
    workspaceSelectButtonEvidence,
    sidebarScrollEvidenceBefore,
    sidebarScrollEvidenceAfter,
    sidebarSettingsReachable
  });
}
