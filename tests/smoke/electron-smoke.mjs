import { spawnSync } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
writeFileSync(join(workspaceRoot, '00-overview.txt'), 'workspace overview smoke file\n', 'utf8');
writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\n', 'utf8');
function runWorkspaceGit(args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}
runWorkspaceGit(['init']);
runWorkspaceGit(['config', 'user.email', 'roc-smoke@example.test']);
runWorkspaceGit(['config', 'user.name', 'Roc Smoke']);
runWorkspaceGit(['add', '00-overview.txt', 'phase-three-notes.txt']);
runWorkspaceGit(['commit', '-m', 'initial smoke workspace']);
writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\nchanged in git\n', 'utf8');
writeFileSync(
  join(skillSourceRoot, 'SKILL.md'),
  '---\nname: Smoke Skill\ndescription: Smoke skill validates Phase 5 import.\n---\n\n# Smoke Skill\n',
  'utf8'
);

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', rejectBody);
    request.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function startSmokeProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readRequestBody(request);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: rawBody.length === 0 ? null : JSON.parse(rawBody)
      });
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Smoke Provider 已生成首轮回复。'
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 16,
            completion_tokens: 9
          }
        })
      );
    })().catch((error) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'provider failed' }));
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Smoke provider did not expose a TCP address.');
  }
  const tcpAddress = address;
  return {
    endpoint: `http://127.0.0.1:${tcpAddress.port}/v1`,
    requests,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      })
  };
}

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

async function waitForAppReady(page, label) {
  await page.waitForSelector('[data-testid="roc-app"], .fatal, .boot', { timeout: 15000 });
  if ((await page.locator('.fatal').count()) > 0) {
    const text = await page.textContent('.fatal');
    writeFileSync(join(artifactDir, `electron-smoke-fatal-${label}.txt`), text ?? '', 'utf8');
    throw new Error(`Roc renderer fatal during ${label}: ${text}`);
  }
  if ((await page.locator('[data-testid="roc-app"]').count()) === 0) {
    await page.waitForSelector('[data-testid="roc-app"]', { timeout: 15000 });
  }
}

async function clickSmokeControl(page, selector) {
  const target = page.locator(selector);
  await target.waitFor({ state: 'attached', timeout: 5000 });
  await target.evaluate((element) => {
    element.click();
  });
}

async function waitForCapabilitySelection(page, { mcpCount, skillCount, expectedIds = [] }) {
  await page.waitForFunction(
    ({ expectedIds: ids, mcpCount: expectedMcpCount, skillCount: expectedSkillCount }) => {
      const node = document.querySelector('[data-testid="turn-capabilities"]');
      const text = node?.textContent ?? '';
      return (
        text.includes(`MCP 本轮 ${expectedMcpCount}`) &&
        text.includes(`Skill 本轮 ${expectedSkillCount}`) &&
        ids.every((id) => text.includes(id))
      );
    },
    { expectedIds, mcpCount, skillCount },
    { timeout: 5000 }
  );
  const text = await page.textContent('[data-testid="turn-capabilities"]');
  if (text === null) {
    throw new Error('Smoke could not read chat capability text.');
  }
  return text;
}

async function readMainPageText(page, { pageId, viewSelector, label }) {
  const openedPage = await page.evaluate(async (targetPage) => {
    const result = await window.roc.app.openMainPage(targetPage);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.page;
  }, pageId);
  if (openedPage !== pageId) {
    throw new Error(`Smoke navigated to ${openedPage} instead of ${pageId}.`);
  }
  await page.waitForSelector(viewSelector, { timeout: 5000 });
  const text = await page.textContent(viewSelector);
  if (text === null) {
    throw new Error(`Smoke could not read ${label} view text.`);
  }
  return text;
}

async function seedSmokeRuntimeData(page, { providerEndpoint }) {
  await page.evaluate(
    async ({ providerEndpoint: endpoint, workspacePath }) => {
      async function unwrap(result, label) {
        if (!result.ok) {
          throw new Error(`${label} failed: ${result.error.message}`);
        }
        return result.data;
      }

      await unwrap(
        await window.roc.providers.upsert({
          id: 'smoke-provider',
          name: 'Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: 'env:ROC_SMOKE_API_KEY',
          enabled: true,
          models: [
            {
              id: 'smoke-model',
              displayName: 'Smoke Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }),
        'provider upsert'
      );
      await unwrap(await window.roc.providers.setDefaultModel('smoke-model'), 'default model');
      await unwrap(
        await window.roc.mcp.upsertServer({
          id: 'smoke-mcp',
          name: 'Smoke MCP',
          enabled: true,
          transport: 'http',
          preset: false,
          riskLevel: 'low',
          url: 'http://127.0.0.1:65534/mcp',
          allowedTools: ['smoke_tool']
        }),
        'mcp upsert'
      );
      await unwrap(await window.roc.mcp.ensureExaPreset(), 'exa preset');

      const backgroundPreview = await unwrap(
        await window.roc.tasks.createBackgroundTaskPreview({
          goal: 'Phase 6 smoke background diagnostic task',
          trigger: {
            type: 'schedule',
            description: 'smoke scheduled run',
            nextRunAt: '2026-04-29T01:00:00.000Z'
          },
          workspacePath,
          allowedActions: ['pnpm test'],
          forbiddenActions: ['git push'],
          failurePolicy: 'pause_and_report',
          notificationPolicy: 'failures_and_confirmations'
        }),
        'background task preview'
      );
      await unwrap(await window.roc.tasks.createBackgroundTask(backgroundPreview), 'background task create');

      const existing = await unwrap(
        await window.roc.memory.search({ query: 'phase four smoke active', source: 'all' }),
        'memory search'
      );
      const existingActiveMemory = existing.items.find((item) =>
        item.summary.includes('phase four smoke active memory validates candidate acceptance and recall.')
      );
      if (existingActiveMemory === undefined) {
        const candidate = await unwrap(
          await window.roc.memory.writeCandidate({
            type: 'project_context',
            scope: 'project:roc-smoke',
            content: 'phase four smoke active memory validates candidate acceptance and recall.',
            confidence: 0.9,
            priority: 'medium',
            source: 'user_explicit',
            sourceRef: 'smoke:memory'
          }),
          'memory candidate'
        );
        const accepted = await unwrap(await window.roc.memory.acceptCandidate(candidate.id), 'memory accept');
        const deleted = await unwrap(await window.roc.memory.delete(accepted.id), 'memory delete');
        if (!deleted.recoverable) {
          throw new Error('memory delete did not create a recoverable state.');
        }
        await unwrap(await window.roc.memory.restore(accepted.id), 'memory restore');
        await unwrap(
          await window.roc.memory.writeCandidate({
            type: 'project_context',
            scope: 'project:roc-smoke',
            content: 'phase four smoke active memory does not validate candidate acceptance and recall.',
            confidence: 0.7,
            priority: 'medium',
            source: 'agent_extract:smoke',
            sourceRef: 'smoke:conflict'
          }),
          'memory conflict candidate'
        );
        await unwrap(
          await window.roc.memory.writeSessionRecall({
            sessionId: 'smoke-session-phase4',
            title: 'phase four smoke session',
            summary: 'phase four smoke session recall validates searchable archived conversation.',
            scope: 'project:roc-smoke',
            content: 'phase four smoke session stores raw recall without promoting it into curated memory.',
            sourceRef: 'smoke:session'
          }),
          'memory session recall'
        );
      }
    },
    { providerEndpoint, workspacePath: workspaceRoot }
  );
}

function assertNoRuntimeMockText(sections) {
  const forbidden = [
    { label: '示例数据标签', pattern: /条示例|示例任务|示例数据/u },
    { label: '静态页面预览任务', pattern: /Roc 页面预览生成|页面预览生成|页面预览效果图\/roc-system-pages\.html|页面预览效果图\/\*\.png/u },
    { label: '硬编码预览流程', pattern: /步骤 3\/5|截图工具未找到浏览器入口|生成页面预览并截图/u },
    { label: '演示 Provider 地址', pattern: /api\.example\.local/u },
    { label: '预览工作区故事', pattern: /重构静态页面布局|导出截图|把每个页面都导出为 PNG/u },
    { label: '英文占位语义', pattern: /\bmock\b|\bdemo\b|\bfake\b|\bplaceholder\b|No preview loaded\./iu }
  ];

  const leaks = [];
  for (const section of sections) {
    for (const rule of forbidden) {
      const match = section.text.match(rule.pattern);
      if (match !== null) {
        leaks.push({ section: section.name, rule: rule.label, text: match[0] });
      }
    }
  }

  if (leaks.length > 0) {
    throw new Error(`Runtime mock/demo text leaked: ${JSON.stringify(leaks, null, 2)}`);
  }
}

let app;
let smokeProvider;
try {
  smokeProvider = await startSmokeProvider();
  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: smokeTarget.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });

  const page = await app.firstWindow();
  await waitForAppReady(page, 'initial');
  await page.waitForSelector('[data-testid="window-workband"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="turn-capabilities"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="workspace-select-button"]', { timeout: 5000 });
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
  await waitForAppReady(page, 'after-skill-import');
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
  await seedSmokeRuntimeData(page, { providerEndpoint: smokeProvider.endpoint });
  await page.reload();
  await waitForAppReady(page, 'after-runtime-seed');
  await page.waitForSelector('[data-testid="turn-capabilities"]', { timeout: 5000 });
  await page.click('[data-testid="nav-tasks"]');
  await page.waitForSelector('[data-testid="tasks-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="background-task-summary"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="background-task-controls"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="background-pause"]', { timeout: 5000 });
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
  await page.click('button[aria-label="文件"]');
  await page.waitForSelector('[data-testid="workspace-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="file-tree"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="git-panel"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="terminal-panel"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="rtk-panel"]', { timeout: 5000 });
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
  await page.waitForSelector('[data-testid="memory-candidates"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="memory-conflicts"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="memory-search-results"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="session-recall-results"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="memory-recovery"]', { timeout: 5000 });
  const memoryText = await page.textContent('[data-testid="memory-view"]');
  const memoryRecoveryText = await page.textContent('[data-testid="memory-recovery"]');
  if (memoryText === null) {
    throw new Error('Smoke could not read memory view text.');
  }
  if (memoryRecoveryText === null) {
    throw new Error('Smoke could not read memory recovery text.');
  }
  const memoryRecoveryApiEvidence = await page.evaluate(async () => {
    const search = await window.roc.memory.search({ query: 'phase four smoke active', source: 'all' });
    if (!search.ok) {
      throw new Error(search.error.message);
    }
    const restored = search.data.items.find((item) =>
      item.summary.includes('phase four smoke active memory validates candidate acceptance and recall')
    );
    if (restored === undefined) {
      throw new Error('No restored smoke memory found after delete/restore seed.');
    }
    return { id: restored.id, status: 'active' };
  });
  const gitText = await readMainPageText(page, {
    label: 'git',
    pageId: 'git',
    viewSelector: '[data-testid="git-view"]'
  });
  const workbenchRealToolEvidence = await page.evaluate(async () => {
    const result = await window.roc.app.openMainPage('workspace');
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return true;
  });
  if (!workbenchRealToolEvidence) {
    throw new Error('Smoke could not navigate to workspace for workbench tool checks.');
  }
  await page.waitForSelector('[data-testid="workspace-view"]', { timeout: 5000 });
  const filePreviewBeforeClick = await page.textContent('[data-testid="workbench-file-preview"]');
  await page.click('[data-testid="workbench-file-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-file-preview"]')?.textContent?.includes('changed in git') === true);
  const filePreviewAfterClick = await page.textContent('[data-testid="workbench-file-preview"]');
  const workbenchWidthBefore = await page.locator('[data-testid="workbench-panel"]').boundingBox();
  const resizeHandle = await page.locator('[data-testid="workbench-resize-handle"]').boundingBox();
  if (workbenchWidthBefore === null || resizeHandle === null) {
    throw new Error('Smoke could not measure workbench resize handle.');
  }
  await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeHandle.x - 96, resizeHandle.y + resizeHandle.height / 2, { steps: 8 });
  await page.mouse.up();
  const workbenchWidthAfter = await page.locator('[data-testid="workbench-panel"]').boundingBox();
  if (workbenchWidthAfter === null) {
    throw new Error('Smoke could not measure workbench after resize.');
  }
  await page.click('.workbench-tab[data-tool-button="git"]');
  await page.waitForSelector('[data-testid="workbench-git-changes"]', { timeout: 5000 });
  const workbenchGitText = await page.textContent('[data-testid="workbench-git-changes"]');
  await page.click('[data-testid="git-stage-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('M  phase-three-notes.txt') === true);
  const workbenchGitAfterStage = await page.textContent('[data-testid="workbench-git-changes"]');
  await page.click('[data-testid="git-unstage-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes(' M phase-three-notes.txt') === true);
  const workbenchGitAfterUnstage = await page.textContent('[data-testid="workbench-git-changes"]');
  await page.click('.workbench-tab[data-tool-button="terminal"]');
  await page.waitForSelector('[data-testid="terminal-command-input"]', { timeout: 5000 });
  await page.fill('[data-testid="terminal-command-input"]', 'dir');
  await page.click('[data-testid="terminal-run-command"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="terminal-live-output"]')?.textContent?.includes('phase-three-notes.txt') === true);
  const terminalLiveOutput = await page.textContent('[data-testid="terminal-live-output"]');
  await page.fill('[data-testid="terminal-command-input"]', 'Remove-Item phase-three-notes.txt');
  await page.click('[data-testid="terminal-run-command"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="terminal-live-output"]')?.textContent?.includes('命令需要确认，未执行。') === true
  );
  const terminalBlockedOutput = await page.textContent('[data-testid="terminal-live-output"]');
  const terminalText = await readMainPageText(page, {
    label: 'terminal',
    pageId: 'terminal',
    viewSelector: '[data-testid="terminal-view"]'
  });
  const previewText = await readMainPageText(page, {
    label: 'preview',
    pageId: 'preview',
    viewSelector: '[data-testid="preview-view"]'
  });
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
  await clickSmokeControl(page, '[data-testid="nav-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-settings"]', { timeout: 5000 });
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
  await waitForCapabilitySelection(page, { mcpCount: 0, skillCount: 0 });
  await page.click('[data-testid="turn-mcp-smoke-mcp"]');
  await page.click('[data-testid="turn-skill-smoke-skill"]');
  const chatCapabilityText = await waitForCapabilitySelection(page, {
    expectedIds: ['smoke-mcp', 'smoke-skill'],
    mcpCount: 1,
    skillCount: 1
  });
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
  const typedChatPrompt = `Smoke typed user prompt ${Date.now()}`;
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
  await page.fill('[data-testid="chat-input"]', typedChatPrompt);
  const chatInputEvidence = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="chat-input"]');
    const sendButton = document.querySelector('[data-testid="chat-task-submit"]');
    if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) {
      return {
        exists: input !== null,
        editable: false,
        visuallyFramed: false,
        sendButtonVisibleInViewport: false,
        value: ''
      };
    }
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };
    const visibleInViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= 0 &&
      rect.left >= 0 &&
        rect.bottom <= viewport.height &&
        rect.right <= viewport.width;
    const sendButtonRect = sendButton instanceof HTMLElement ? sendButton.getBoundingClientRect() : null;
    const sendButtonVisibleInViewport =
      sendButton instanceof HTMLButtonElement &&
      !sendButton.disabled &&
      sendButtonRect !== null &&
      sendButtonRect.width > 0 &&
      sendButtonRect.height > 0 &&
      sendButtonRect.top >= 0 &&
      sendButtonRect.left >= 0 &&
      sendButtonRect.bottom <= viewport.height &&
      sendButtonRect.right <= viewport.width;
    const visuallyFramed =
      rect.width > 240 &&
      rect.height > 56 &&
      visibleInViewport &&
      style.visibility === 'visible' &&
      style.opacity !== '0' &&
      style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      !style.borderTop.startsWith('0px none');
    return {
      exists: true,
      editable: !input.disabled && !input.readOnly,
      visuallyFramed,
      rect: {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom
      },
      viewport,
      visibleInViewport,
      sendButtonVisibleInViewport,
      backgroundColor: style.backgroundColor,
      borderTop: style.borderTop,
      value: input.value
    };
  });
  await page.click('[data-testid="chat-task-submit"]');
  await page.waitForSelector('[data-testid="chat-result"]', { timeout: 5000 });
  const chatResultText = await page.textContent('[data-testid="chat-result"]');
  if (chatResultText === null) {
    throw new Error('Smoke could not read chat result text.');
  }
  const taskCapabilityEvidence = await page.evaluate(async (expectedInput) => {
    const snapshot = await window.roc.tasks.getSnapshot();
    if (!snapshot.ok) {
      throw new Error(snapshot.error.message);
    }
    const userMessage = snapshot.data.recentEvents.find(
      (item) =>
        item.type === 'message' &&
        typeof item.payload === 'object' &&
        item.payload !== null &&
        item.payload.role === 'user' &&
        item.payload.content === expectedInput
    );
    if (userMessage === undefined) {
      throw new Error(`No task user message event found for typed prompt: ${expectedInput}`);
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
    const thread = snapshot.data.threads.find((item) => item.id === userMessage.threadId);
    if (thread === undefined) {
      throw new Error(`No task thread found for typed prompt: ${expectedInput}`);
    }
    return {
      expectedInput,
      threadGoal: thread.goal,
      userMessage: userMessage.payload,
      assistantMessage: assistantMessage.payload,
      providerUpdate: providerUpdate.payload,
      manifest: manifest.payload,
      skillLoaded: skillLoaded.payload
    };
  }, typedChatPrompt);
  await page.click('[data-testid="nav-doctor"]');
  await page.waitForSelector('[data-testid="doctor-view"]', { timeout: 5000 });
  const doctorText = await page.textContent('[data-testid="doctor-view"]');
  if (doctorText === null) {
    throw new Error('Smoke could not read doctor view text.');
  }
  await page.click('[data-testid="nav-diagnostics"]');
  await page.waitForSelector('[data-testid="diagnostics-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="diagnostic-package-status"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="performance-sample"]', { timeout: 5000 });
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
  const entryButtonEvidence = {
    quickOpenTasks: false,
    quickOpenChat: false,
    quickSubmitTask: false,
    trayOpenTasks: false,
    trayToggleBackground: false
  };
  await quickWindow.click('[data-testid="quick-open-tasks"]');
  await page.waitForSelector('[data-testid="tasks-view"]', { timeout: 5000 });
  entryButtonEvidence.quickOpenTasks = true;
  await quickWindow.click('[data-testid="quick-open-chat"]');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
  entryButtonEvidence.quickOpenChat = true;
  await quickWindow.click('[data-testid="quick-submit-task"]');
  await quickWindow.waitForSelector('[data-testid="quick-entry-error"], [data-testid="quick-entry-view"]', { timeout: 5000 });
  entryButtonEvidence.quickSubmitTask = true;
  await trayWindow.click('[data-testid="tray-open-tasks"]');
  await page.waitForSelector('[data-testid="tasks-view"]', { timeout: 5000 });
  entryButtonEvidence.trayOpenTasks = true;
  await trayWindow.click('[data-testid="tray-toggle-background"]');
  await trayWindow.waitForFunction(() => document.body.textContent?.includes('恢复后台执行') === true, undefined, {
    timeout: 5000
  });
  entryButtonEvidence.trayToggleBackground = true;
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
  const buttonInteractionEvidence = {
    attachmentControlAbsent: false,
    composerWorkspaceNavigates: false,
    composerMcpNavigates: false,
    composerSkillNavigates: false,
    composerModelNavigates: false,
    composerMemoryNavigates: false,
    workbenchGitClickable: false,
    workbenchTerminalClickable: false,
    workbenchCloseClickable: false,
    memoryEditorHasNoDisabledButtons: false,
    memoryRecordSelectable: false
  };
  await page.click('[data-testid="nav-chat"]');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
  buttonInteractionEvidence.attachmentControlAbsent = (await page.locator('button[aria-label="添加附件"]').count()) === 0;
  await page.click('button[aria-label="工作区文件"]');
  await page.waitForSelector('[data-testid="workspace-view"]', { timeout: 5000 });
  buttonInteractionEvidence.composerWorkspaceNavigates = true;
  await page.click('[data-testid="nav-chat"]');
  await page.click('button[aria-label="已启用 MCP"]');
  await page.waitForSelector('[data-testid="mcp-view"]', { timeout: 5000 });
  buttonInteractionEvidence.composerMcpNavigates = true;
  await page.click('[data-testid="nav-chat"]');
  await page.click('button[aria-label="已启用 Skill"]');
  await page.waitForSelector('[data-testid="skills-view"]', { timeout: 5000 });
  buttonInteractionEvidence.composerSkillNavigates = true;
  await page.click('[data-testid="nav-chat"]');
  await page.click('.model-pill');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 5000 });
  buttonInteractionEvidence.composerModelNavigates = true;
  await page.click('[data-testid="nav-chat"]');
  await page.click('button[aria-label="可见性"]');
  await page.waitForSelector('[data-testid="memory-view"]', { timeout: 5000 });
  buttonInteractionEvidence.composerMemoryNavigates = true;
  buttonInteractionEvidence.memoryEditorHasNoDisabledButtons = (await page.locator('.memory-editor-actions button').count()) === 0;
  const memoryRecordCount = await page.locator('.memory-record').count();
  if (memoryRecordCount === 1) {
    buttonInteractionEvidence.memoryRecordSelectable =
      (await page.locator('.memory-record').first().getAttribute('aria-pressed')) === 'true';
  } else if (memoryRecordCount > 1) {
    await page.locator('.memory-record').nth(1).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.memory-record')[1]?.getAttribute('aria-pressed') === 'true',
      undefined,
      { timeout: 5000 }
    );
    buttonInteractionEvidence.memoryRecordSelectable = true;
  }
  await page.evaluate(async () => {
    const result = await window.roc.app.openMainPage('workspace');
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  });
  await page.waitForSelector('[data-testid="workspace-view"]', { timeout: 5000 });
  await page.click('.workbench-tab[data-tool-button="git"]');
  await page.waitForFunction(() => document.querySelector('.workbench-tab.active')?.textContent?.includes('Git') === true);
  buttonInteractionEvidence.workbenchGitClickable = true;
  await page.click('.workbench-tab[data-tool-button="terminal"]');
  await page.waitForFunction(() => document.querySelector('.workbench-tab.active')?.textContent?.includes('终端') === true);
  buttonInteractionEvidence.workbenchTerminalClickable = true;
  await page.click('button[aria-label="关闭右侧工作台"]');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
  buttonInteractionEvidence.workbenchCloseClickable = true;

  const pageText = await page.textContent('body');
  if (pageText === null) {
    throw new Error('Smoke could not read body text.');
  }
  assertNoRuntimeMockText([
    { name: 'body', text: pageText },
    { name: 'tasks', text: taskText },
    { name: 'workspace', text: workspaceText },
    { name: 'memory', text: memoryText },
    { name: 'memory-recovery', text: memoryRecoveryText },
    { name: 'git', text: gitText },
    { name: 'terminal', text: terminalText },
    { name: 'preview', text: previewText },
    { name: 'mcp', text: mcpText },
    { name: 'settings', text: settingsText },
    { name: 'chat', text: chatResultText },
    { name: 'doctor', text: doctorText },
    { name: 'diagnostics', text: diagnosticsText },
    { name: 'quick-entry', text: quickEntryText },
    { name: 'tray-entry', text: trayEntryText }
  ]);

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
    mockTextAbsent: true,
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
      taskText.includes('托盘摘要') &&
      taskText.includes('后台执行') &&
      backgroundTaskApiEvidence.tray.backgroundTasks.total > 0 &&
      backgroundTaskApiEvidence.hasCreatedEvent,
    phase6DoctorVisible:
      doctorText.includes('健康检查结果') &&
      doctorText.includes('默认模型配置') &&
      doctorText.includes('诊断包') &&
      doctorText.includes('性能采样'),
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
    gitChangesVisible:
      workspaceText.includes('phase-three-notes.txt') &&
      gitText.includes('phase-three-notes.txt') &&
      gitText.includes('变更'),
    terminalOutputVisible:
      workspaceText.includes('phase-three-notes.txt') &&
      terminalLiveOutput?.includes('phase-three-notes.txt') === true,
    previewFileVisible:
      previewText.includes('phase-three-notes.txt') &&
      previewText.includes('phase three smoke workspace') &&
      filePreviewBeforeClick !== filePreviewAfterClick &&
      filePreviewAfterClick?.includes('changed in git') === true,
    workbenchResizable: Math.abs(workbenchWidthAfter.width - workbenchWidthBefore.width) >= 48,
    workbenchFilePreviewClickable:
      filePreviewAfterClick?.includes('phase-three-notes.txt') === true &&
      filePreviewAfterClick.includes('changed in git'),
    workbenchGitActions:
      workbenchGitText?.includes('phase-three-notes.txt') === true &&
      workbenchGitAfterStage?.includes('M  phase-three-notes.txt') === true &&
      workbenchGitAfterUnstage?.includes(' M phase-three-notes.txt') === true,
    terminalCommandRunnable:
      terminalLiveOutput?.includes('> dir') === true &&
      terminalLiveOutput.includes('phase-three-notes.txt'),
    terminalFailureClearsStaleOutput:
      terminalBlockedOutput?.includes('命令需要确认，未执行。') === true &&
      terminalBlockedOutput.includes('phase-three-notes.txt') === false,
    rtkMissingVisible:
      rtkPanelText !== null &&
      rtkPanelText.includes('资源状态') &&
      rtkPanelText.includes(workspaceApiEvidence.rtk.resourceState === 'ready' ? 'ready' : '缺失降级'),
    memoryCandidateVisible: memoryText.includes('conflict_detected'),
    memoryConflictVisible: memoryText.includes('same_type_scope_contradiction_or_duplicate'),
    memoryRecallVisible: memoryText.includes('phase four smoke active memory validates candidate acceptance and recall'),
    sessionRecallVisible: memoryText.includes('phase four smoke session recall validates searchable archived conversation'),
    memoryRecoveryVisible:
      memoryRecoveryText.includes('删除恢复') &&
      memoryRecoveryText.includes('最近操作') &&
      memoryRecoveryText.includes(memoryRecoveryApiEvidence.id) &&
      memoryRecoveryText.includes(memoryRecoveryApiEvidence.status),
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
    quickEntryButtonsClickable:
      quickEntryBoundary.floatingVisible &&
      entryButtonEvidence.quickOpenTasks &&
      entryButtonEvidence.quickOpenChat &&
      entryButtonEvidence.quickSubmitTask &&
      quickEntryText.includes('追加到当前任务') &&
      quickEntryText.includes('创建新任务') &&
      quickEntryText.includes('快速提问'),
    trayEntryVisible:
      entryWindowEvidence.tray &&
      trayEntryText.includes('Roc 常驻状态') &&
      trayEntryText.includes('后台执行') &&
      trayEntryBoundary.floatingVisible &&
      !trayEntryBoundary.composerVisible &&
      !trayEntryBoundary.hasRequire &&
      !trayEntryBoundary.hasProcess,
    trayEntryButtonsClickable:
      trayEntryBoundary.floatingVisible &&
      entryButtonEvidence.trayOpenTasks &&
      entryButtonEvidence.trayToggleBackground &&
      trayEntryText.includes('后台执行') &&
      trayEntryText.includes('恢复后台执行'),
    appEntryApiExpanded:
      boundary.appKeys.includes('openMainPage') &&
      boundary.appKeys.includes('openQuickEntry') &&
      boundary.appKeys.includes('openTrayEntry') &&
      boundary.appKeys.includes('onNavigate'),
    workspaceSelectButtonVisible:
      workspaceSelectButtonEvidence.exists &&
      workspaceSelectButtonEvidence.clickable &&
      workspaceSelectButtonEvidence.visibleInViewport &&
      workspaceSelectButtonEvidence.text.includes('选择'),
    workspaceDialogApiExposed: boundary.workspaceKeys.includes('selectFromDialog'),
    chatCapabilitySelectionVisible:
      chatCapabilityText.includes('MCP 本轮 1') &&
      chatCapabilityText.includes('Skill 本轮 1') &&
      chatCapabilityText.includes('smoke-mcp') &&
      chatCapabilityText.includes('smoke-skill'),
    chatInputEditable:
      chatInputEvidence.exists &&
      chatInputEvidence.editable &&
      chatInputEvidence.visuallyFramed &&
      chatInputEvidence.sendButtonVisibleInViewport &&
      chatInputEvidence.value === typedChatPrompt,
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
      taskCapabilityEvidence.expectedInput === typedChatPrompt &&
      taskCapabilityEvidence.threadGoal === typedChatPrompt &&
      typeof taskCapabilityEvidence.userMessage === 'object' &&
      taskCapabilityEvidence.userMessage !== null &&
      taskCapabilityEvidence.userMessage.content === typedChatPrompt &&
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
      boundary.diagnosticsKeys.includes('createDiagnosticPackage'),
    clickableButtonsHandled: Object.values(buttonInteractionEvidence).every(Boolean)
  };

  const failedChecks = Object.entries({
    hasRequire: !rendererBoundary.hasRequire,
    hasProcess: !rendererBoundary.hasProcess,
    immersiveWorkbandVisible: rendererBoundary.immersiveWorkbandVisible,
    systemMenuHidden: rendererBoundary.systemMenuHidden,
    initialWindowNotMaximized: rendererBoundary.initialWindowNotMaximized,
    mockTextAbsent: rendererBoundary.mockTextAbsent,
    backgroundTaskVisible: rendererBoundary.backgroundTaskVisible,
    traySummaryVisible: rendererBoundary.traySummaryVisible,
    phase6DoctorVisible: rendererBoundary.phase6DoctorVisible,
    diagnosticPackageVisible: rendererBoundary.diagnosticPackageVisible,
    performanceSampleVisible: rendererBoundary.performanceSampleVisible,
    phase6DoctorApi: rendererBoundary.phase6DoctorApi,
    workspaceFileVisible: rendererBoundary.workspaceFileVisible,
    workspaceSearchVisible: rendererBoundary.workspaceSearchVisible,
    gitChangesVisible: rendererBoundary.gitChangesVisible,
    terminalOutputVisible: rendererBoundary.terminalOutputVisible,
    previewFileVisible: rendererBoundary.previewFileVisible,
    workbenchResizable: rendererBoundary.workbenchResizable,
    workbenchFilePreviewClickable: rendererBoundary.workbenchFilePreviewClickable,
    workbenchGitActions: rendererBoundary.workbenchGitActions,
    terminalCommandRunnable: rendererBoundary.terminalCommandRunnable,
    terminalFailureClearsStaleOutput: rendererBoundary.terminalFailureClearsStaleOutput,
    rtkMissingVisible: rendererBoundary.rtkMissingVisible,
    memoryCandidateVisible: rendererBoundary.memoryCandidateVisible,
    memoryConflictVisible: rendererBoundary.memoryConflictVisible,
    memoryRecallVisible: rendererBoundary.memoryRecallVisible,
    sessionRecallVisible: rendererBoundary.sessionRecallVisible,
    memoryRecoveryVisible: rendererBoundary.memoryRecoveryVisible,
    providerConfiguredVisible: rendererBoundary.providerConfiguredVisible,
    mcpManagedVisible: rendererBoundary.mcpManagedVisible,
    skillManagedVisible: rendererBoundary.skillManagedVisible,
    providerActionsVisible: rendererBoundary.providerActionsVisible,
    capabilityActionsVisible: rendererBoundary.capabilityActionsVisible,
    quickEntryVisible: rendererBoundary.quickEntryVisible,
    quickEntryButtonsClickable: rendererBoundary.quickEntryButtonsClickable,
    trayEntryVisible: rendererBoundary.trayEntryVisible,
    trayEntryButtonsClickable: rendererBoundary.trayEntryButtonsClickable,
    appEntryApiExpanded: rendererBoundary.appEntryApiExpanded,
    workspaceSelectButtonVisible: rendererBoundary.workspaceSelectButtonVisible,
    workspaceDialogApiExposed: rendererBoundary.workspaceDialogApiExposed,
    chatCapabilitySelectionVisible: rendererBoundary.chatCapabilitySelectionVisible,
    chatInputEditable: rendererBoundary.chatInputEditable,
    agentCapabilityPreviewVisible: rendererBoundary.agentCapabilityPreviewVisible,
    agentCapabilityPreviewApi: rendererBoundary.agentCapabilityPreviewApi,
    providerChatResultVisible: rendererBoundary.providerChatResultVisible,
    taskRunCapabilityStored: rendererBoundary.taskRunCapabilityStored,
    taskAssistantEventStored: rendererBoundary.taskAssistantEventStored,
    taskProviderUpdateStored: rendererBoundary.taskProviderUpdateStored,
    taskManifestStored: rendererBoundary.taskManifestStored,
    skillLoadedEventStored: rendererBoundary.skillLoadedEventStored,
    memoryApiExpanded: rendererBoundary.memoryApiExpanded,
    providersApiExpanded: rendererBoundary.providersApiExpanded,
    mcpApiExpanded: rendererBoundary.mcpApiExpanded,
    skillsApiExpanded: rendererBoundary.skillsApiExpanded,
    agentApiExpanded: rendererBoundary.agentApiExpanded,
    taskApiExpanded: rendererBoundary.taskApiExpanded,
    lifecycleApiExpanded: rendererBoundary.lifecycleApiExpanded,
    diagnosticsApiExpanded: rendererBoundary.diagnosticsApiExpanded,
    clickableButtonsHandled: rendererBoundary.clickableButtonsHandled
  })
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const passed = failedChecks.length === 0;
  const result = {
    passed,
    dataRoot,
    smokeTarget: {
      kind: smokeTarget.kind,
      path: smokeTarget.path,
      packagedExeExists: existsSync(packagedExe)
    },
    performanceSample: phase6ApiEvidence.sample,
    evidence: {
      chatInputEvidence,
      workspaceSelectButtonEvidence,
      buttonInteractionEvidence,
      entryButtonEvidence,
      memoryRecoveryText,
      memoryRecoveryApiEvidence,
      terminalText,
      terminalLiveOutput,
      terminalBlockedOutput,
      gitText,
      workbenchGitText,
      workbenchGitAfterStage,
      workbenchGitAfterUnstage,
      workbenchWidthBefore,
      workbenchWidthAfter,
      previewText
    },
    failedChecks,
    rendererBoundary,
    checkedAt: new Date().toISOString()
  };

  writeFileSync(join(artifactDir, 'electron-smoke.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (!passed) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
} finally {
  if (app !== undefined) {
    await app.close();
  }
  if (smokeProvider !== undefined) {
    await smokeProvider.close();
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
