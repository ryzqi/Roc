import { spawnSync } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const artifactDir = resolve('.artifacts/wave1');
mkdirSync(artifactDir, { recursive: true });
const packagedExe = resolve('release/win-unpacked/Roc Windows Super Assistant.exe');
const preferredSmokeTarget = process.env.ROC_SMOKE_TARGET === 'packaged' ? 'packaged' : 'dist';
const distMainPath = resolve('dist/main/index.js');
const smokeTarget =
  preferredSmokeTarget === 'packaged'
    ? existsSync(packagedExe)
      ? {
          kind: 'packaged-exe',
          path: packagedExe,
          executablePath: packagedExe,
          launchArgs: []
        }
      : (() => {
          throw new Error(`Packaged smoke target is unavailable: ${packagedExe}`);
        })()
    : {
        kind: 'dist-main-fallback',
        path: distMainPath,
        executablePath: undefined,
        launchArgs: [distMainPath]
      };

const dataRoot = await mkdtemp(join(tmpdir(), 'roc-smoke-'));
const workspaceRoot = await mkdtemp(join(tmpdir(), 'roc-smoke-workspace-'));
const skillSourceRoot = await mkdtemp(join(tmpdir(), 'roc-smoke-skill-'));
writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\n', 'utf8');
writeFileSync(
  join(skillSourceRoot, 'SKILL.md'),
  '---\nname: Smoke Skill\ndescription: Smoke skill validates Phase 5 import.\n---\n\n# Smoke Skill\n',
  'utf8'
);

async function waitForWindowWithSelector(app, selector) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (await candidate.locator(selector).isVisible().catch(() => false)) {
        return candidate;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Smoke timed out waiting for window selector: ${selector}`);
}

async function clickSmokeControl(page, selector) {
  const target = page.locator(selector);
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.evaluate((element) => {
    element.click();
  });
}

async function waitForSmokeContract(page, selector) {
  await page.locator(selector).waitFor({ state: 'attached', timeout: 5000 });
}

let app;
try {
  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: smokeTarget.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot
    }
  });

  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="window-workband"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="turn-capabilities"]', { timeout: 5000 });
  const browserWindow = await app.browserWindow(page);
  const initialWindowShell = {
    menuBarVisible: await browserWindow.evaluate((window) => window.isMenuBarVisible()),
    maximized: await browserWindow.evaluate((window) => window.isMaximized())
  };
  const workbandBox = await page.locator('[data-testid="window-workband"]').boundingBox();
  if (workbandBox === null) {
    throw new Error('Smoke could not measure immersive workband.');
  }
  if (workbandBox.y > 2) {
    throw new Error(`Immersive workband is not aligned to window top: y=${workbandBox.y}`);
  }
  await page.click('[data-testid="window-toggle-maximize"]');
  const maximizedAfterClick = await browserWindow.evaluate((window) => window.isMaximized());
  if (!maximizedAfterClick) {
    throw new Error('Smoke could not maximize frameless window.');
  }
  await page.click('[data-testid="window-toggle-maximize"]');
  const restoredAfterClick = await browserWindow.evaluate((window) => window.isMaximized());
  if (restoredAfterClick) {
    throw new Error('Smoke could not restore frameless window.');
  }
  const importedSkillId = await page.evaluate(async (sourcePath) => {
    const result = await window.roc.skills.importSkill({
      sourcePath,
      id: 'smoke-skill'
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.id;
  }, skillSourceRoot);
  if (importedSkillId !== 'smoke-skill') {
    throw new Error(`Skill import mismatch: ${importedSkillId}`);
  }
  await page.reload();
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="turn-capabilities"]', { timeout: 5000 });
  const selectedWorkspace = await page.evaluate(async (workspacePath) => {
    const result = await window.roc.workspace.select({ path: workspacePath });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.path;
  }, workspaceRoot);
  if (selectedWorkspace !== workspaceRoot) {
    throw new Error(`Workspace selection mismatch: ${selectedWorkspace}`);
  }
  await page.reload();
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="turn-capabilities"]', { timeout: 5000 });
  await page.click('[data-testid="nav-tasks"]');
  await page.waitForSelector('[data-testid="tasks-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="background-task-summary"]', { timeout: 5000 });
  await waitForSmokeContract(page, '[data-testid="background-task-controls"]');
  await waitForSmokeContract(page, '[data-testid="background-pause"]');
  const backgroundTaskControlsText = await page.textContent('[data-testid="background-task-controls"]');
  const taskText = await page.textContent('[data-testid="tasks-view"]');
  if (taskText === null) {
    throw new Error('Smoke could not read tasks view text.');
  }
  const backgroundTaskApiEvidence = await page.evaluate(async () => {
    const tray = await window.roc.lifecycle.getTraySummary();
    const snapshot = await window.roc.tasks.getSnapshot();
    if (!tray.ok) {
      throw new Error(tray.error.message);
    }
    if (!snapshot.ok) {
      throw new Error(snapshot.error.message);
    }
    return {
      tray: tray.data,
      hasCreatedEvent: snapshot.data.recentEvents.some((item) => item.type === 'background_task_created')
    };
  });
  await clickSmokeControl(page, '[data-testid="nav-workspace"]');
  await page.waitForSelector('[data-testid="workspace-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="file-tree"]', { timeout: 5000 });
  await waitForSmokeContract(page, '[data-testid="git-panel"]');
  await waitForSmokeContract(page, '[data-testid="terminal-panel"]');
  await waitForSmokeContract(page, '[data-testid="rtk-panel"]');
  const workspaceText = await page.textContent('[data-testid="workspace-view"]');
  if (workspaceText === null) {
    throw new Error('Smoke could not read workspace view text.');
  }
  const rtkPanelText = await page.textContent('[data-testid="rtk-panel"]');
  const workspaceApiEvidence = await page.evaluate(async () => {
    const search = await window.roc.files.search({ query: 'phase three', maxResults: 8 });
    const rtk = await window.roc.rtk.status();
    if (!search.ok) {
      throw new Error(search.error.message);
    }
    if (!rtk.ok) {
      throw new Error(rtk.error.message);
    }
    return {
      search: search.data,
      rtk: rtk.data
    };
  });
  await page.click('[data-testid="nav-memory"]');
  await page.waitForSelector('[data-testid="memory-view"]', { timeout: 5000 });
  await waitForSmokeContract(page, '[data-testid="memory-candidates"]');
  await waitForSmokeContract(page, '[data-testid="memory-conflicts"]');
  await waitForSmokeContract(page, '[data-testid="memory-search-results"]');
  await waitForSmokeContract(page, '[data-testid="session-recall-results"]');
  await waitForSmokeContract(page, '[data-testid="memory-recovery"]');
  const memoryText = await page.textContent('[data-testid="memory-view"]');
  if (memoryText === null) {
    throw new Error('Smoke could not read memory view text.');
  }
  await page.click('[data-testid="nav-mcp"]');
  await page.waitForSelector('[data-testid="mcp-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-management"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-management"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-test-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-toggle-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-delete-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-toggle-smoke-skill"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-delete-smoke-skill"]', { timeout: 5000 });
  const mcpText = await page.textContent('[data-testid="mcp-view"]');
  if (mcpText === null) {
    throw new Error('Smoke could not read MCP view text.');
  }
  await clickSmokeControl(page, '[data-testid="settings-button"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 5000 });
  await waitForSmokeContract(page, '[data-testid="provider-settings"]');
  await page.waitForSelector('[data-testid="provider-test-smoke-provider"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-default-smoke-provider"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-delete-smoke-provider"]', { timeout: 5000 });
  const settingsText = await page.textContent('[data-testid="settings-view"]');
  if (settingsText === null) {
    throw new Error('Smoke could not read settings view text.');
  }
  await page.click('[data-testid="nav-chat"]');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="turn-capability-ids"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="turn-mcp-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="turn-skill-smoke-skill"]', { timeout: 5000 });
  await page.click('[data-testid="turn-mcp-smoke-mcp"]');
  await page.click('[data-testid="turn-skill-smoke-skill"]');
  const deselectedCapabilityText = await page.textContent('[data-testid="turn-capabilities"]');
  if (
    deselectedCapabilityText === null ||
    !deselectedCapabilityText.includes('MCP 本轮 0') ||
    !deselectedCapabilityText.includes('Skill 本轮 0')
  ) {
    throw new Error('Smoke could not deselect per-turn capabilities.');
  }
  await page.click('[data-testid="turn-mcp-smoke-mcp"]');
  await page.click('[data-testid="turn-skill-smoke-skill"]');
  const chatCapabilityText = await page.textContent('[data-testid="turn-capabilities"]');
  if (chatCapabilityText === null) {
    throw new Error('Smoke could not read chat capability text.');
  }
  await page.waitForSelector('[data-testid="agent-capability-preview"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="agent-tool-cards"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="agent-subagents"]', { timeout: 5000 });
  const agentPreviewText = await page.textContent('[data-testid="agent-capability-preview"]');
  if (agentPreviewText === null) {
    throw new Error('Smoke could not read Agent capability preview text.');
  }
  const agentPreviewApiEvidence = await page.evaluate(async () => {
    const preview = await window.roc.agent.getCapabilityPreview({
      mcpServers: ['smoke-mcp', 'missing-mcp'],
      skills: ['smoke-skill']
    });
    if (!preview.ok) {
      throw new Error(preview.error.message);
    }
    return {
      selected: preview.data.selectedCapabilities,
      skipped: preview.data.skippedCapabilities,
      cards: preview.data.toolCards.map((card) => card.id),
      skills: preview.data.skillCards.map((card) => card.id),
      subagents: preview.data.subagents.map((subagent) => ({
        id: subagent.id,
        inheritsSkills: subagent.inheritsSkills
      })),
      policy: preview.data.untrustedContextPolicy
    };
  });
  await page.click('[data-testid="chat-task-submit"]');
  await page.waitForSelector('[data-testid="chat-result"]', { timeout: 5000 });
  const chatResultText = await page.textContent('[data-testid="chat-result"]');
  if (chatResultText === null) {
    throw new Error('Smoke could not read chat result text.');
  }
  const taskCapabilityEvidence = await page.evaluate(async () => {
    const snapshot = await window.roc.tasks.getSnapshot();
    if (!snapshot.ok) {
      throw new Error(snapshot.error.message);
    }
    const userMessage = snapshot.data.recentEvents.find(
      (item) =>
        item.type === 'message' &&
        typeof item.payload === 'object' &&
        item.payload !== null &&
        item.payload.role === 'user'
    );
    if (userMessage === undefined) {
      throw new Error('No task user message event found after chat submit.');
    }
    const assistantMessage = snapshot.data.recentEvents.find(
      (item) =>
        item.type === 'message' &&
        typeof item.payload === 'object' &&
        item.payload !== null &&
        item.payload.role === 'assistant'
    );
    if (assistantMessage === undefined) {
      throw new Error('No task assistant message event found after chat submit.');
    }
    const manifest = snapshot.data.recentEvents.find((item) => item.type === 'context_manifest');
    if (manifest === undefined) {
      throw new Error('No context_manifest event found after chat submit.');
    }
    const providerUpdate = snapshot.data.recentEvents.find((item) => item.type === 'agent_update');
    if (providerUpdate === undefined) {
      throw new Error('No provider agent_update event found after chat submit.');
    }
    const skillLoaded = snapshot.data.recentEvents.find((item) => item.type === 'skill_loaded');
    if (skillLoaded === undefined) {
      throw new Error('No skill_loaded event found after chat submit.');
    }
    return {
      userMessage: userMessage.payload,
      assistantMessage: assistantMessage.payload,
      providerUpdate: providerUpdate.payload,
      manifest: manifest.payload,
      skillLoaded: skillLoaded.payload
    };
  });
  await page.click('[data-testid="nav-doctor"]');
  await page.waitForSelector('[data-testid="doctor-view"]', { timeout: 5000 });
  const doctorText = await page.textContent('[data-testid="doctor-view"]');
  if (doctorText === null) {
    throw new Error('Smoke could not read doctor view text.');
  }
  await page.click('[data-testid="nav-diagnostics"]');
  await page.waitForSelector('[data-testid="diagnostics-view"]', { timeout: 5000 });
  await waitForSmokeContract(page, '[data-testid="diagnostic-package-status"]');
  await waitForSmokeContract(page, '[data-testid="performance-sample"]');
  const diagnosticsText = await page.textContent('[data-testid="diagnostics-view"]');
  if (diagnosticsText === null) {
    throw new Error('Smoke could not read diagnostics view text.');
  }
  const phase6ApiEvidence = await page.evaluate(async () => {
    const sample = await window.roc.diagnostics.samplePerformance({
      mode: 'smoke',
      memoryBudgetMb: 300
    });
    const doctor = await window.roc.doctor.run();
    const tray = await window.roc.lifecycle.getTraySummary();
    if (!sample.ok) {
      throw new Error(sample.error.message);
    }
    if (!doctor.ok) {
      throw new Error(doctor.error.message);
    }
    if (!tray.ok) {
      throw new Error(tray.error.message);
    }
    return {
      sample: sample.data,
      doctorCheckIds: doctor.data.findings.map((finding) => finding.checkId),
      tray: tray.data
    };
  });

  const entryWindowEvidence = await page.evaluate(async () => {
    const quick = await window.roc.app.openQuickEntry();
    const tray = await window.roc.app.openTrayEntry();
    if (!quick.ok) {
      throw new Error(quick.error.message);
    }
    if (!tray.ok) {
      throw new Error(tray.error.message);
    }
    return { quick: quick.data.opened, tray: tray.data.opened };
  });
  const quickWindow = await waitForWindowWithSelector(app, '[data-testid="quick-entry-view"]');
  const trayWindow = await waitForWindowWithSelector(app, '[data-testid="tray-entry-view"]');
  await quickWindow.waitForSelector('[data-testid="floating-quick"]', { timeout: 5000 });
  await trayWindow.waitForSelector('[data-testid="floating-tray"]', { timeout: 5000 });
  await quickWindow.click('[data-testid="quick-open-tasks"]');
  await page.waitForSelector('[data-testid="tasks-view"]', { timeout: 5000 });
  await trayWindow.click('[data-testid="tray-open-tasks"]');
  await page.waitForSelector('[data-testid="tasks-view"]', { timeout: 5000 });
  const quickEntryText = await quickWindow.textContent('[data-testid="quick-entry-view"]');
  const trayEntryText = await trayWindow.textContent('[data-testid="tray-entry-view"]');
  if (quickEntryText === null || trayEntryText === null) {
    throw new Error('Smoke could not read quick/tray entry text.');
  }
  const quickEntryBoundary = await quickWindow.evaluate(() => ({
    hasRequire: typeof globalThis.require !== 'undefined',
    hasProcess: typeof globalThis.process !== 'undefined',
    floatingVisible: document.querySelector('[data-testid="floating-quick"]') !== null,
    composerVisible: document.querySelector('.composer') !== null
  }));
  const trayEntryBoundary = await trayWindow.evaluate(() => ({
    hasRequire: typeof globalThis.require !== 'undefined',
    hasProcess: typeof globalThis.process !== 'undefined',
    floatingVisible: document.querySelector('[data-testid="floating-tray"]') !== null,
    composerVisible: document.querySelector('.composer') !== null
  }));

  const boundary = await page.evaluate(() => ({
    hasRequire: typeof globalThis.require !== 'undefined',
    hasProcess: typeof globalThis.process !== 'undefined',
    rocKeys: window.roc ? Object.keys(window.roc).sort() : [],
    appKeys: window.roc ? Object.keys(window.roc.app).sort() : [],
    workspaceKeys: window.roc ? Object.keys(window.roc.workspace).sort() : [],
    fileKeys: window.roc ? Object.keys(window.roc.files).sort() : [],
    memoryKeys: window.roc ? Object.keys(window.roc.memory).sort() : [],
    providerKeys: window.roc ? Object.keys(window.roc.providers).sort() : [],
    mcpKeys: window.roc ? Object.keys(window.roc.mcp).sort() : [],
    skillKeys: window.roc ? Object.keys(window.roc.skills).sort() : [],
    taskKeys: window.roc ? Object.keys(window.roc.tasks).sort() : [],
    lifecycleKeys: window.roc ? Object.keys(window.roc.lifecycle).sort() : [],
    diagnosticsKeys: window.roc ? Object.keys(window.roc.diagnostics).sort() : [],
    agentKeys: window.roc ? Object.keys(window.roc.agent).sort() : [],
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

  const pageText = await page.textContent('body');
  if (pageText === null) {
    throw new Error('Smoke could not read body text.');
  }

  const rendererBoundary = {
    hasRequire: boundary.hasRequire,
    hasProcess: boundary.hasProcess,
    rocKeys: boundary.rocKeys,
    appKeys: boundary.appKeys,
    workspaceKeys: boundary.workspaceKeys,
    fileKeys: boundary.fileKeys,
    memoryKeys: boundary.memoryKeys,
    providerKeys: boundary.providerKeys,
    mcpKeys: boundary.mcpKeys,
    skillKeys: boundary.skillKeys,
    taskKeys: boundary.taskKeys,
    lifecycleKeys: boundary.lifecycleKeys,
    diagnosticsKeys: boundary.diagnosticsKeys,
    agentKeys: boundary.agentKeys,
    shellKeys: boundary.shellKeys,
    activeViewText: boundary.activeViewText,
    immersiveWorkbandVisible: workbandBox.height > 0 && workbandBox.y <= 2,
    systemMenuHidden: initialWindowShell.menuBarVisible === false,
    initialWindowNotMaximized: initialWindowShell.maximized === false,
    mockTextAbsent: !pageText.includes('示例任务'),
    smokeTargetKind: smokeTarget.kind,
    smokeTargetPath: smokeTarget.path,
    packagedExeExists: existsSync(packagedExe),
    backgroundTaskVisible:
      backgroundTaskControlsText !== null &&
      backgroundTaskControlsText.includes('Phase 6 smoke background diagnostic task') &&
      backgroundTaskApiEvidence.tray.backgroundTasks.total > 0 &&
      backgroundTaskApiEvidence.tray.nextRunAt === '2026-04-29T01:00:00.000Z' &&
      backgroundTaskApiEvidence.hasCreatedEvent,
    traySummaryVisible:
      pageText.includes('托盘摘要') &&
      pageText.includes('后台执行') &&
      backgroundTaskApiEvidence.tray.backgroundTasks.total > 0 &&
      backgroundTaskApiEvidence.hasCreatedEvent,
    phase6DoctorVisible:
      doctorText.includes('健康检查结果') &&
      doctorText.includes('模型配置') &&
      doctorText.includes('修复动作'),
    diagnosticPackageVisible: diagnosticsText.includes('脱敏') && diagnosticsText.includes('task_snapshot'),
    performanceSampleVisible:
      diagnosticsText.includes('RSS') &&
      phase6ApiEvidence.sample.rssMb > 0 &&
      phase6ApiEvidence.sample.heapUsedMb > 0 &&
      typeof phase6ApiEvidence.sample.exceedsBudget === 'boolean',
    phase6DoctorApi:
      phase6ApiEvidence.doctorCheckIds.includes('background.tasks') &&
      phase6ApiEvidence.doctorCheckIds.includes('diagnostics.directory') &&
      phase6ApiEvidence.doctorCheckIds.includes('performance.sample') &&
      phase6ApiEvidence.tray.backgroundTasks.total > 0,
    workspaceFileVisible: workspaceText.includes('phase-three-notes.txt'),
    workspaceSearchVisible:
      workspaceApiEvidence.search.matches.some(
        (match) => match.relativePath === 'phase-three-notes.txt' && match.preview.includes('phase three smoke workspace')
      ),
    gitMissingVisible: workspaceText.includes('当前工作区不是 Git 仓库。'),
    terminalOutputVisible: workspaceText.includes('phase-three-notes.txt'),
    rtkMissingVisible:
      rtkPanelText !== null &&
      rtkPanelText.includes('资源状态') &&
      rtkPanelText.includes(workspaceApiEvidence.rtk.resourceState === 'ready' ? 'ready' : '缺失降级'),
    memoryCandidateVisible: memoryText.includes('conflict_detected'),
    memoryConflictVisible: memoryText.includes('same_type_scope_contradiction_or_duplicate'),
    memoryRecallVisible: memoryText.includes('phase four smoke active memory validates candidate acceptance and recall'),
    sessionRecallVisible: memoryText.includes('phase four smoke session recall validates searchable archived conversation'),
    memoryRecoveryVisible: memoryText.includes('smoke 已验证可恢复链'),
    providerConfiguredVisible:
      settingsText.includes('Smoke Provider') &&
      settingsText.includes('smoke-model') &&
      settingsText.includes('smoke-provider:ready'),
    mcpManagedVisible:
      mcpText.includes('Smoke MCP') &&
      mcpText.includes('smoke-mcp:ready') &&
      mcpText.includes('enabled'),
    skillManagedVisible: mcpText.includes('Smoke Skill') && mcpText.includes('ready'),
    providerActionsVisible:
      settingsText.includes('测试') &&
      settingsText.includes('设默认') &&
      settingsText.includes('删除'),
    capabilityActionsVisible:
      mcpText.includes('测试') &&
      mcpText.includes('禁用') &&
      mcpText.includes('删除'),
    quickEntryVisible:
      entryWindowEvidence.quick &&
      quickEntryText.includes('Roc 快捷入口') &&
      quickEntryText.includes('同步主窗口') &&
      quickEntryBoundary.floatingVisible &&
      !quickEntryBoundary.composerVisible &&
      !quickEntryBoundary.hasRequire &&
      !quickEntryBoundary.hasProcess,
    trayEntryVisible:
      entryWindowEvidence.tray &&
      trayEntryText.includes('Roc 常驻状态') &&
      trayEntryText.includes('后台执行') &&
      trayEntryBoundary.floatingVisible &&
      !trayEntryBoundary.composerVisible &&
      !trayEntryBoundary.hasRequire &&
      !trayEntryBoundary.hasProcess,
    appEntryApiExpanded:
      boundary.appKeys.includes('openMainPage') &&
      boundary.appKeys.includes('openQuickEntry') &&
      boundary.appKeys.includes('openTrayEntry') &&
      boundary.appKeys.includes('onNavigate'),
    chatCapabilitySelectionVisible:
      chatCapabilityText.includes('MCP 本轮 1') &&
      chatCapabilityText.includes('Skill 本轮 1') &&
      chatCapabilityText.includes('smoke-mcp') &&
      chatCapabilityText.includes('smoke-skill'),
    agentCapabilityPreviewVisible:
      agentPreviewText.includes('Agent 能力预览') &&
      agentPreviewText.includes('web_read') &&
      agentPreviewText.includes('smoke_tool') &&
      agentPreviewText.includes('Smoke Skill') &&
      agentPreviewText.includes('does not inherit skills'),
    agentCapabilityPreviewApi:
      agentPreviewApiEvidence.selected.mcpServers.includes('smoke-mcp') &&
      agentPreviewApiEvidence.selected.skills.includes('smoke-skill') &&
      agentPreviewApiEvidence.skipped.some(
        (item) => item.id === 'missing-mcp' && item.type === 'mcp_server' && item.reason === 'not_found'
      ) &&
      agentPreviewApiEvidence.cards.includes('web:web_read') &&
      agentPreviewApiEvidence.cards.includes('mcp:smoke-mcp:smoke_tool') &&
      agentPreviewApiEvidence.skills.includes('skill:smoke-skill') &&
      agentPreviewApiEvidence.subagents.some((subagent) => subagent.id === 'code-review' && subagent.inheritsSkills === false) &&
      agentPreviewApiEvidence.policy === 'external_content_reference_only',
    providerChatResultVisible:
      chatResultText.includes('Smoke Provider 已生成首轮回复。') &&
      chatResultText.includes('task_answered') &&
      chatResultText.includes('smoke-provider / smoke-model'),
    taskRunCapabilityStored:
      typeof taskCapabilityEvidence.userMessage === 'object' &&
      taskCapabilityEvidence.userMessage !== null &&
      Array.isArray(taskCapabilityEvidence.userMessage.enabledCapabilities?.mcpServers) &&
      Array.isArray(taskCapabilityEvidence.userMessage.enabledCapabilities?.skills) &&
      taskCapabilityEvidence.userMessage.enabledCapabilities.mcpServers.includes('smoke-mcp') &&
      taskCapabilityEvidence.userMessage.enabledCapabilities.skills.includes('smoke-skill'),
    taskAssistantEventStored:
      typeof taskCapabilityEvidence.assistantMessage === 'object' &&
      taskCapabilityEvidence.assistantMessage !== null &&
      taskCapabilityEvidence.assistantMessage.content === 'Smoke Provider 已生成首轮回复。' &&
      taskCapabilityEvidence.assistantMessage.providerId === 'smoke-provider' &&
      taskCapabilityEvidence.assistantMessage.modelId === 'smoke-model',
    taskProviderUpdateStored:
      typeof taskCapabilityEvidence.providerUpdate === 'object' &&
      taskCapabilityEvidence.providerUpdate !== null &&
      taskCapabilityEvidence.providerUpdate.providerId === 'smoke-provider' &&
      taskCapabilityEvidence.providerUpdate.modelId === 'smoke-model' &&
      taskCapabilityEvidence.providerUpdate.finishReason === 'stop',
    taskManifestStored:
      typeof taskCapabilityEvidence.manifest === 'object' &&
      taskCapabilityEvidence.manifest !== null &&
      taskCapabilityEvidence.manifest.resolvedCapabilities.mcpServers.includes('smoke-mcp') &&
      taskCapabilityEvidence.manifest.resolvedCapabilities.skills.includes('smoke-skill') &&
      taskCapabilityEvidence.manifest.toolCards.some((card) => card.id === 'mcp:smoke-mcp:smoke_tool') &&
      taskCapabilityEvidence.manifest.untrustedContextPolicy === 'external_content_reference_only',
    skillLoadedEventStored:
      typeof taskCapabilityEvidence.skillLoaded === 'object' &&
      taskCapabilityEvidence.skillLoaded !== null &&
      taskCapabilityEvidence.skillLoaded.skillId === 'smoke-skill' &&
      taskCapabilityEvidence.skillLoaded.enabledBy === 'turn_selection',
    memoryApiExpanded:
      boundary.memoryKeys.includes('listCandidates') &&
      boundary.memoryKeys.includes('listConflicts') &&
      boundary.memoryKeys.includes('sessionSearch') &&
      boundary.memoryKeys.includes('delete') &&
      boundary.memoryKeys.includes('restore'),
    providersApiExpanded:
      boundary.providerKeys.includes('list') &&
      boundary.providerKeys.includes('upsert') &&
      boundary.providerKeys.includes('setDefaultModel') &&
      boundary.providerKeys.includes('test'),
    mcpApiExpanded:
      boundary.mcpKeys.includes('ensureExaPreset') &&
      boundary.mcpKeys.includes('upsertServer') &&
      boundary.mcpKeys.includes('setServerEnabled') &&
      boundary.mcpKeys.includes('deleteServer') &&
      boundary.mcpKeys.includes('testServer'),
    skillsApiExpanded:
      boundary.skillKeys.includes('importSkill') &&
      boundary.skillKeys.includes('setEnabled') &&
      boundary.skillKeys.includes('deleteSkill'),
    agentApiExpanded:
      boundary.agentKeys.includes('getStatus') &&
      boundary.agentKeys.includes('getConfigPreview') &&
      boundary.agentKeys.includes('getCapabilityPreview'),
    taskApiExpanded:
      boundary.taskKeys.includes('createBackgroundTaskPreview') &&
      boundary.taskKeys.includes('createBackgroundTask') &&
      boundary.taskKeys.includes('pauseBackgroundTask') &&
      boundary.taskKeys.includes('resumeBackgroundTask') &&
      boundary.taskKeys.includes('cancelBackgroundTask'),
    lifecycleApiExpanded:
      boundary.lifecycleKeys.includes('getTraySummary') &&
      boundary.lifecycleKeys.includes('pauseBackgroundExecution') &&
      boundary.lifecycleKeys.includes('resumeBackgroundExecution'),
    diagnosticsApiExpanded:
      boundary.diagnosticsKeys.includes('samplePerformance') &&
      boundary.diagnosticsKeys.includes('createDiagnosticPackage')
  };

  const result = {
    passed: true,
    dataRoot,
    smokeTarget: {
      kind: smokeTarget.kind,
      path: smokeTarget.path,
      packagedExeExists: existsSync(packagedExe)
    },
    performanceSample: phase6ApiEvidence.sample,
    rendererBoundary,
    checkedAt: new Date().toISOString()
  };

  writeFileSync(join(artifactDir, 'electron-smoke.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (
    rendererBoundary.hasRequire ||
    rendererBoundary.hasProcess ||
    !rendererBoundary.immersiveWorkbandVisible ||
    !rendererBoundary.systemMenuHidden ||
    !rendererBoundary.initialWindowNotMaximized ||
    !rendererBoundary.mockTextAbsent ||
    !rendererBoundary.backgroundTaskVisible ||
    !rendererBoundary.traySummaryVisible ||
    !rendererBoundary.phase6DoctorVisible ||
    !rendererBoundary.diagnosticPackageVisible ||
    !rendererBoundary.performanceSampleVisible ||
    !rendererBoundary.phase6DoctorApi ||
    !rendererBoundary.workspaceFileVisible ||
    !rendererBoundary.workspaceSearchVisible ||
    !rendererBoundary.gitMissingVisible ||
    !rendererBoundary.terminalOutputVisible ||
    !rendererBoundary.rtkMissingVisible ||
    !rendererBoundary.memoryCandidateVisible ||
    !rendererBoundary.memoryConflictVisible ||
    !rendererBoundary.memoryRecallVisible ||
    !rendererBoundary.sessionRecallVisible ||
    !rendererBoundary.memoryRecoveryVisible ||
    !rendererBoundary.providerConfiguredVisible ||
    !rendererBoundary.mcpManagedVisible ||
    !rendererBoundary.skillManagedVisible ||
    !rendererBoundary.providerActionsVisible ||
    !rendererBoundary.capabilityActionsVisible ||
    !rendererBoundary.quickEntryVisible ||
    !rendererBoundary.trayEntryVisible ||
    !rendererBoundary.appEntryApiExpanded ||
    !rendererBoundary.chatCapabilitySelectionVisible ||
    !rendererBoundary.agentCapabilityPreviewVisible ||
    !rendererBoundary.agentCapabilityPreviewApi ||
    !rendererBoundary.providerChatResultVisible ||
    !rendererBoundary.taskRunCapabilityStored ||
    !rendererBoundary.taskAssistantEventStored ||
    !rendererBoundary.taskProviderUpdateStored ||
    !rendererBoundary.taskManifestStored ||
    !rendererBoundary.skillLoadedEventStored ||
    !rendererBoundary.memoryApiExpanded ||
    !rendererBoundary.providersApiExpanded ||
    !rendererBoundary.mcpApiExpanded ||
    !rendererBoundary.skillsApiExpanded ||
    !rendererBoundary.agentApiExpanded ||
    !rendererBoundary.taskApiExpanded ||
    !rendererBoundary.lifecycleApiExpanded ||
    !rendererBoundary.diagnosticsApiExpanded
  ) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
} finally {
  if (app !== undefined) {
    await app.close();
  }
  spawnSync('pnpm', ['rebuild', 'better-sqlite3', '--pending=false'], {
    cwd: resolve('.'),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  await rm(dataRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(skillSourceRoot, { recursive: true, force: true });
}
