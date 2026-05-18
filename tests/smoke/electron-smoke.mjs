import { spawnSync } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const artifactDir = resolve('.artifacts/wave1');
mkdirSync(artifactDir, { recursive: true });
const packagedExe = resolve('release/win-unpacked/Roc.exe');
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
function buildSmokeContent(label, lines = 1) {
  return Array.from({ length: lines }, (_, index) => `${label} ${index + 1}`).join('\n') + '\n';
}
mkdirSync(join(workspaceRoot, 'assets'));
writeFileSync(join(workspaceRoot, '00-overview.txt'), 'workspace overview smoke file\n', 'utf8');
writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\n', 'utf8');
writeFileSync(join(workspaceRoot, 'batch-stage.txt'), 'batch stage smoke workspace\n', 'utf8');
writeFileSync(
  join(workspaceRoot, 'assets', 'smoke-image.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=',
    'base64'
  )
);
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
runWorkspaceGit(['add', '00-overview.txt', 'phase-three-notes.txt', 'batch-stage.txt', 'assets/smoke-image.png']);
runWorkspaceGit(['commit', '-m', 'initial smoke workspace']);
writeFileSync(
  join(workspaceRoot, 'phase-three-notes.txt'),
  `phase three smoke workspace\n${buildSmokeContent('changed in git line', 80)}`,
  'utf8'
);
writeFileSync(join(workspaceRoot, 'batch-stage.txt'), buildSmokeContent('changed in batch line', 32), 'utf8');
const remoteRoot = await mkdtemp(join(tmpdir(), 'roc-smoke-remote-'));
runWorkspaceGit(['init', '--bare', remoteRoot]);
runWorkspaceGit(['remote', 'add', 'origin', remoteRoot]);
runWorkspaceGit(['push', '-u', 'origin', 'master']);
writeFileSync(
  join(skillSourceRoot, 'SKILL.md'),
  '---\nname: smoke-skill\ndescription: Smoke skill validates Phase 5 import.\n---\n\n# Smoke Skill\n',
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
      const parsedBody = rawBody.length === 0 ? null : JSON.parse(rawBody);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: parsedBody
      });
      if (parsedBody?.stream === true || request.headers.accept === 'text/event-stream') {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream');
        response.setHeader('cache-control', 'no-cache');
        response.setHeader('connection', 'keep-alive');
        response.write(
          'data: {"choices":[{"index":0,"delta":{"content":"Smoke Provider 已生成首轮回复。\\n\\n短行一。\\n短行二。\\n短行三。\\n短行四。\\n短行五。\\n短行六。\\n短行七。\\n短行八。"},"finish_reason":null}]}\n\n'
        );
        response.write(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":16,"completion_tokens":9,"total_tokens":25}}\n\n'
        );
        response.end('data: [DONE]\n\n');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Smoke Provider 已生成首轮回复。\n\n短行一。\n短行二。\n短行三。\n短行四。\n短行五。\n短行六。\n短行七。\n短行八。'
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

async function openChatView(page) {
  const sidebarEntry = page.locator('[data-testid="nav-chat"]');
  if ((await sidebarEntry.count()) > 0) {
    await clickSmokeControl(page, '[data-testid="nav-chat"]');
  } else {
    await clickSmokeControl(page, '[data-testid="chat-new-conversation"]');
  }
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
}

async function clickComposerPopoverChoice(page, triggerSelector, choiceSelector) {
  await page.hover(triggerSelector);
  await page.waitForSelector(choiceSelector, { timeout: 5000 });
  await clickSmokeControl(page, choiceSelector);
}

async function hoverComposerPopoverContent(page, triggerSelector, popoverSelector) {
  await page.hover(triggerSelector);
  await page.waitForSelector(popoverSelector, { timeout: 5000 });
  const popover = page.locator(popoverSelector);
  const box = await popover.boundingBox();
  if (box === null) {
    throw new Error(`Smoke could not measure popover: ${popoverSelector}`);
  }
  await page.mouse.move(box.x + Math.min(28, box.width / 2), box.y + Math.min(28, box.height / 2), { steps: 12 });
  await popover.waitFor({ state: 'visible', timeout: 5000 });
}

async function waitForTerminalSessionReady(page) {
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-testid="terminal-xterm"]');
      return host !== null;
    },
    undefined,
    { timeout: 10000 }
  );
}

async function waitForCapabilitySelection(page, { mcpCount, skillCount, expectedMcpIds = [], expectedSkillIds = [] }) {
  try {
    await page.waitForFunction(
      ({ mcpCount: expectedMcpCount, skillCount: expectedSkillCount }) => {
        const toolText = document.querySelector('[data-testid="chat-tool-trigger"]')?.textContent ?? '';
        const skillText = document.querySelector('[data-testid="chat-skill-trigger"]')?.textContent ?? '';
        return toolText.includes(String(expectedMcpCount)) && skillText.includes(String(expectedSkillCount));
      },
      { mcpCount, skillCount },
      { timeout: 5000 }
    );
  } catch (error) {
    const triggerEvidence = await page.evaluate(() => ({
      toolTriggerText: document.querySelector('[data-testid="chat-tool-trigger"]')?.textContent ?? '',
      skillTriggerText: document.querySelector('[data-testid="chat-skill-trigger"]')?.textContent ?? ''
    }));
    throw new Error(
      `Capability selection wait failed for mcp=${mcpCount}, skill=${skillCount}: ${JSON.stringify(triggerEvidence)}`,
      { cause: error }
    );
  }

  if (expectedMcpIds.length > 0) {
    await page.hover('[data-testid="chat-tool-trigger"]');
    await page.waitForFunction(
      ({ ids }) =>
        ids.every((id) => {
          const node = document.querySelector(`[data-testid="turn-mcp-${id}"]`);
          return node instanceof HTMLElement && node.classList.contains('active');
        }),
      { ids: expectedMcpIds },
      { timeout: 5000 }
    );
  }

  if (expectedSkillIds.length > 0) {
    await page.hover('[data-testid="chat-skill-trigger"]');
    await page.waitForFunction(
      ({ ids }) =>
        ids.every((id) => {
          const node = document.querySelector(`[data-testid="turn-skill-${id}"]`);
          return node instanceof HTMLElement && node.classList.contains('active');
        }),
      { ids: expectedSkillIds },
      { timeout: 5000 }
    );
  }

  const triggerEvidence = await page.evaluate(() => {
    return {
      toolTriggerText: document.querySelector('[data-testid="chat-tool-trigger"]')?.textContent ?? '',
      skillTriggerText: document.querySelector('[data-testid="chat-skill-trigger"]')?.textContent ?? ''
    };
  });
  return {
    ...triggerEvidence,
    mcpActiveIds: expectedMcpIds,
    skillActiveIds: expectedSkillIds
  };
}

async function waitForTextContent(page, selector, expectedText, timeout = 5000) {
  await page.waitForFunction(
    ({ selector: targetSelector, expectedText: targetText }) => {
      const text = document.querySelector(targetSelector)?.textContent ?? '';
      return text.includes(targetText);
    },
    { selector, expectedText },
    { timeout }
  );
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

      const currentSettings = await unwrap(await window.roc.settings.get(), 'settings get');
      await unwrap(
        await window.roc.settings.setProviderSecret({
          providerId: 'smoke-provider',
          plaintext: 'sk-smoke-seed-secret'
        }),
        'settings set provider secret'
      );
      await unwrap(
        await window.roc.settings.save({
          settings: currentSettings.settings,
          permissions: currentSettings.permissions,
          providers: [
            ...currentSettings.providers,
            {
              id: 'smoke-provider',
              name: 'Smoke Provider',
              type: 'openai_compatible',
              endpoint,
              credentialRef: 'secret:smoke-provider',
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
            }
          ],
          defaultModelId: 'smoke-model'
        }),
        'settings save'
      );
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
  await page.addInitScript(() => {
    globalThis.__rocConfirmMessages = [];
    window.confirm = (message) => {
      globalThis.__rocConfirmMessages.push(String(message));
      return true;
    };
  });
  await page.waitForSelector('[data-testid="window-workband"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
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
  const appShellFrameEvidence = await page.evaluate(() => {
    const appShell = document.querySelector('[data-testid="roc-app"]');
    if (!(appShell instanceof HTMLElement)) {
      return {
        exists: false,
        gapTop: null,
        gapRight: null,
        gapBottom: null,
        gapLeft: null
      };
    }
    const rect = appShell.getBoundingClientRect();
    return {
      exists: true,
      gapTop: Math.round(rect.top),
      gapRight: Math.round(window.innerWidth - rect.right),
      gapBottom: Math.round(window.innerHeight - rect.bottom),
      gapLeft: Math.round(rect.left)
    };
  });
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
  const boundsBeforeDrag = await browserWindow.evaluate((window) => window.getBounds());
  await page.mouse.move(workbandBox.x + workbandBox.width / 2, workbandBox.y + workbandBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(workbandBox.x + workbandBox.width / 2 + 140, workbandBox.y + workbandBox.height / 2 + 36, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const boundsAfterDrag = await browserWindow.evaluate((window) => window.getBounds());
  const windowDragEvidence = {
    before: boundsBeforeDrag,
    after: boundsAfterDrag,
    moved:
      Math.abs(boundsAfterDrag.x - boundsBeforeDrag.x) >= 24 ||
      Math.abs(boundsAfterDrag.y - boundsBeforeDrag.y) >= 24
  };
  const importedSkillId = await page.evaluate(async (sourcePath) => {
    const result = await window.roc.skills.importSkill({
      sourcePath
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
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
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
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
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
  const workspaceText = await readMainPageText(page, {
    label: 'workspace',
    pageId: 'workspace',
    viewSelector: '[data-testid="workspace-view"]'
  });
  await waitForTextContent(page, '[data-testid="workspace-view"]', '文件操作预览');
  await page.waitForSelector('[data-testid="file-tree"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="rtk-panel"]', { timeout: 5000 });
  const rtkPanelText = await page.textContent('[data-testid="rtk-panel"]');
  if (rtkPanelText === null) {
    throw new Error('Smoke could not read RTK panel text.');
  }
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
  await waitForTextContent(page, '[data-testid="memory-view"]', 'phase four smoke active memory validates candidate acceptance and recall');
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
  await waitForTextContent(page, '[data-testid="git-view"]', 'phase-three-notes.txt');
  await page.waitForSelector('[data-testid="settings-modal"]', { state: 'detached', timeout: 5000 });
  await openChatView(page);
  await page.click('.rail-button[data-tool-button="files"]');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="workbench-panel"]', { timeout: 5000 });
  const chatWorkbenchLayoutVisible =
    (await page.locator('[data-testid="chat-view"]').count()) > 0 &&
    (await page.locator('[data-testid="workbench-panel"]').count()) > 0;
  const explorerHideButtonCountBefore = await page.locator('[aria-label="隐藏临时文件"]').count();
  const explorerRefreshButtonCountBefore = await page.locator('[aria-label="刷新文件树"]').count();
  const filePreviewBeforeClick = await page.textContent('[data-testid="workbench-file-preview"]');
  await page.click('[data-testid="workbench-file-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-file-preview"]')?.textContent?.includes('changed in git') === true);
  const filePreviewAfterClick = await page.textContent('[data-testid="workbench-file-preview"]');
  await page.click('[data-testid="workbench-file-00-overview.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-file-preview"]')?.textContent?.includes('overview') === true);
  const filePreviewLayoutEvidence = await page.evaluate(() => {
    const header = document.querySelector('.workbench-content-pane .pane-header--content');
    const metaStrip = document.querySelector('.workbench-file-meta-strip');
    const body = document.querySelector('.workbench-file-body');
    const preview = document.querySelector('[data-testid="workbench-file-preview"]');
    const footer = document.querySelector('.workbench-content-pane .workbench-footer-bar');
    const footerText = footer instanceof HTMLElement ? footer.textContent?.trim() ?? '' : '';
    if (!(header instanceof HTMLElement) || !(body instanceof HTMLElement)) {
      return {
        headerExists: header instanceof HTMLElement,
        metaStripExists: metaStrip instanceof HTMLElement,
        bodyExists: body instanceof HTMLElement,
        metaStripHeight: null,
        gapAfterHeader: null,
        gapAfterMetaStrip: null,
        previewExists: preview instanceof HTMLElement,
        footerExists: footer instanceof HTMLElement,
        footerText,
        contentGapToBody: null
      };
    }
    let contentBottom = null;
    if (preview instanceof HTMLElement) {
      const range = document.createRange();
      range.selectNodeContents(preview);
      const rangeBox = range.getBoundingClientRect();
      if (rangeBox.height > 0) {
        contentBottom = rangeBox.bottom;
      } else {
        const childBoxes = Array.from(preview.children)
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.height > 0);
        if (childBoxes.length > 0) {
          contentBottom = Math.max(...childBoxes.map((rect) => rect.bottom));
        }
      }
    }
    const headerBox = header.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const visibleBodyBottom = Math.min(bodyBox.bottom, window.innerHeight);
    if (!(metaStrip instanceof HTMLElement)) {
      return {
        headerExists: true,
        metaStripExists: false,
        bodyExists: true,
        metaStripHeight: null,
        gapAfterHeader: Math.round(bodyBox.top - headerBox.bottom),
        gapAfterMetaStrip: null,
        previewExists: preview instanceof HTMLElement,
        footerExists: footer instanceof HTMLElement,
        footerText,
        contentGapToBody: contentBottom === null ? null : Math.round(visibleBodyBottom - contentBottom)
      };
    }
    const metaStripBox = metaStrip.getBoundingClientRect();
    return {
      headerExists: true,
      metaStripExists: true,
      bodyExists: true,
      metaStripHeight: Math.round(metaStripBox.height),
      gapAfterHeader: Math.round(metaStripBox.top - headerBox.bottom),
      gapAfterMetaStrip: Math.round(bodyBox.top - metaStripBox.bottom),
      previewExists: preview instanceof HTMLElement,
      footerExists: footer instanceof HTMLElement,
      footerText,
      contentGapToBody: contentBottom === null ? null : Math.round(visibleBodyBottom - contentBottom)
    };
  });
  await page.click('[data-testid="workbench-directory-assets"]');
  await page.waitForSelector('[data-testid="workbench-file-assets-smoke-image.png"]', { timeout: 5000 });
  const directoryExpandEvidence = (await page.locator('[data-testid="workbench-file-assets-smoke-image.png"]').count()) > 0;
  await page.click('[data-testid="workbench-file-assets-smoke-image.png"]');
  await page.waitForSelector('[data-testid="workbench-file-image-preview"]', { timeout: 5000 });
  const imagePreviewEvidence = await page.evaluate(() => {
    const image = document.querySelector('[data-testid="workbench-file-image-preview"]');
    const board = document.querySelector('.workbench-file-image-board');
    const src = image?.getAttribute('src') ?? '';
    const alt = image?.getAttribute('alt') ?? '';
    const imageStyle = image instanceof HTMLElement ? getComputedStyle(image) : null;
    const boardStyle = board instanceof HTMLElement ? getComputedStyle(board) : null;
    return {
      exists: image !== null,
      src,
      alt,
      boardExists: board !== null,
      imageBorderTopWidth: imageStyle?.borderTopWidth ?? '',
      imageBorderRadius: imageStyle?.borderRadius ?? '',
      imageBoxShadow: imageStyle?.boxShadow ?? '',
      boardBorderTopWidth: boardStyle?.borderTopWidth ?? '',
      boardBackgroundImage: boardStyle?.backgroundImage ?? ''
    };
  });
  const filePreviewStatsEvidence = await page.evaluate(() => {
    const contentHeaderText = document.querySelector('.workbench-content-pane .pane-subtitle--content')?.textContent?.trim() ?? '';
    const metaStripText = document.querySelector('.workbench-file-meta-strip')?.textContent?.trim() ?? '';
    const footerText = document.querySelector('.workbench-content-pane .workbench-footer-bar')?.textContent?.trim() ?? '';
    return {
      contentHeaderText,
      metaStripText,
      footerText
    };
  });
  const workbenchPreviewModeButtonCount = await page.locator('[data-testid="workbench-file-preview-mode-preview"]').count();
  const workbenchCodeModeButtonCount = await page.locator('[data-testid="workbench-file-preview-mode-code"]').count();
  const filePaneWidthBefore = await page.locator('[data-testid="workbench-file-tree"]').boundingBox();
  const fileSplitter = await page.locator('[data-testid="workbench-file-splitter"]').boundingBox();
  if (filePaneWidthBefore === null || fileSplitter === null) {
    throw new Error('Smoke could not measure file splitter.');
  }
  await page.mouse.move(fileSplitter.x + fileSplitter.width / 2, fileSplitter.y + fileSplitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(fileSplitter.x + 72, fileSplitter.y + fileSplitter.height / 2, { steps: 8 });
  await page.mouse.up();
  const filePaneWidthAfter = await page.locator('[data-testid="workbench-file-tree"]').boundingBox();
  if (filePaneWidthAfter === null) {
    throw new Error('Smoke could not measure file tree after resize.');
  }
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
  const gitCommitButtonCount = await page.locator('[data-testid="workbench-git-commit"]').count();
  const gitCommitMessageCount = await page.locator('[data-testid="workbench-git-commit-message"]').count();
  const gitRefreshPrimaryCount = await page.locator('[aria-label="刷新 Git 状态"]').count();
  const gitBatchStageCount = await page.locator('[data-testid="git-stage-selected"]').count();
  const gitSplitCount = await page.locator('.workbench-git--split').count();
  const gitSidebarCount = await page.locator('.git-sidebar').count();
  const gitDetailPaneCount = await page.locator('.git-detail-pane').count();
  const gitChangeActionCount = await page.locator('.git-change-actions button').count();
  const gitCommitInitialState = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    const message = document.querySelector('[data-testid="workbench-git-commit-message"]');
    if (!(button instanceof HTMLButtonElement) || !(message instanceof HTMLTextAreaElement)) {
      return null;
    }
    return {
      className: button.className,
      disabled: button.disabled,
      value: message.value
    };
  });
  const initialGitBranch = await page.textContent('[data-testid="git-current-branch"]');
  const gitHeaderEvidence = await page.evaluate(() => ({
    splitColumns: document.querySelector('.workbench-git--split') instanceof HTMLElement ? getComputedStyle(document.querySelector('.workbench-git--split')).gridTemplateColumns : ''
  }));
  await page.click('[data-testid="git-select-phase-three-notes.txt"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="workbench-git-selection-path"]')?.textContent?.includes('phase-three-notes.txt') === true,
    { timeout: 5000 }
  );
  await page.waitForFunction(() => document.querySelector('[data-testid="git-select-phase-three-notes.txt"]')?.getAttribute('aria-pressed') === 'true');
  const workbenchGitSelectionText = await page.textContent('[data-testid="workbench-git-selection"]');
  const workbenchGitSelectionPath = await page.textContent('[data-testid="workbench-git-selection-path"]');
  const workbenchGitSelectionActionCountBeforeStage = await page.locator('[data-testid="workbench-git-selection"] button').count();
  const gitDiffScrollEvidenceBefore = await page.evaluate(() => {
    const scroll = document.querySelector('.git-diff-scroll');
    const toolbar = document.querySelector('.git-diff-toolbar');
    if (!(scroll instanceof HTMLElement)) {
      return {
        exists: false,
        clientHeight: null,
        scrollHeight: null,
        scrollTop: null,
        overflowX: null,
        overflowY: null,
        toolbarText: toolbar?.textContent ?? ''
      };
    }
    const style = getComputedStyle(scroll);
    return {
      exists: true,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      toolbarText: toolbar?.textContent ?? ''
    };
  });
  await page.evaluate(() => {
    const scroll = document.querySelector('.git-diff-scroll');
    if (scroll instanceof HTMLElement) {
      scroll.scrollTop = Math.min(scroll.scrollHeight - scroll.clientHeight, 160);
    }
  });
  const gitDiffScrollEvidenceAfter = await page.evaluate(() => {
    const scroll = document.querySelector('.git-diff-scroll');
    if (!(scroll instanceof HTMLElement)) {
      return {
        exists: false,
        clientHeight: null,
        scrollHeight: null,
        scrollTop: null
      };
    }
    return {
      exists: true,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop
    };
  });
  await page.click('[data-testid="git-select-toggle-phase-three-notes.txt"]');
  await page.click('[data-testid="git-select-toggle-batch-stage.txt"]');
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return text.includes('2 selected');
  });
  const workbenchGitSelectedCountAfterManual = await page.textContent('[data-testid="git-selected-count"]');
  const workbenchGitSelectionActionCountAfterManual = await page.locator('[data-testid="workbench-git-selection"] button').count();
  await page.click('[data-testid="git-clear-selection"]');
  await page.waitForFunction(() => {
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return selectedCount.includes('0 selected');
  });
  await page.click('[data-testid="git-select-all"]');
  await page.waitForFunction(() => {
    const noteToggle = document.querySelector('[data-testid="git-select-toggle-phase-three-notes.txt"]');
    const batchToggle = document.querySelector('[data-testid="git-select-toggle-batch-stage.txt"]');
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return (
      noteToggle instanceof HTMLInputElement &&
      batchToggle instanceof HTMLInputElement &&
      noteToggle.checked &&
      batchToggle.checked &&
      selectedCount.includes('2 selected')
    );
  });
  const workbenchGitSelectedCountAfterAll = await page.textContent('[data-testid="git-selected-count"]');
  await page.click('[data-testid="git-stage-selected"]');
  try {
    await page.waitForFunction(() => {
      const changes = document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '';
      const detail = document.querySelector('[data-testid="workbench-git-selection"]')?.textContent ?? '';
      const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
      return (
        changes.includes('待提交变更2') &&
        changes.includes('batch-stage.txt已暂存') &&
        changes.includes('phase-three-notes.txt已暂存') &&
        changes.includes('工作区变更0') &&
        detail.includes('已暂存') &&
        selectedCount.includes('2 selected')
      );
    });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      changes: document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '',
      detail: document.querySelector('[data-testid="workbench-git-selection"]')?.textContent ?? '',
      selectedCount: document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? ''
    }));
    throw new Error(`Git batch stage wait failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const workbenchGitAfterBatchStage = await page.textContent('[data-testid="workbench-git-changes"]');
  const workbenchGitSelectionAfterStage = await page.textContent('[data-testid="workbench-git-selection"]');
  const workbenchGitSelectionActionCountAfterStage = await page.locator('[data-testid="workbench-git-selection"] button').count();
  await page.click('[data-testid="git-current-branch"]');
  await page.waitForSelector('[data-testid="git-branch-controls"]', { timeout: 5000 });
  const gitBranchSelectCount = await page.locator('[data-testid="git-branch-select"]').count();
  await page.fill('[data-testid="git-branch-create-input"]', 'feature/smoke-branch');
  await page.click('[data-testid="git-branch-create"]');
  await page.waitForFunction(() => {
    const branch = document.querySelector('[data-testid="git-current-branch"]')?.textContent ?? '';
    return branch.includes('feature/smoke-branch');
  });
  const gitCurrentBranchAfterCreate = await page.textContent('[data-testid="git-current-branch"]');
  await page.fill('[data-testid="git-branch-select"]', initialGitBranch?.trim() ?? 'master');
  await page.locator('.git-branch-option', { hasText: initialGitBranch?.trim() ?? 'master' }).click();
  await page.waitForFunction(
    (expectedBranch) => {
      const branch = document.querySelector('[data-testid="git-current-branch"]')?.textContent ?? '';
      return branch.includes(expectedBranch);
    },
    initialGitBranch?.trim() ?? 'master'
  );
  const gitCurrentBranchAfterCheckout = await page.textContent('[data-testid="git-current-branch"]');
  const confirmMessages = await page.evaluate(() => globalThis.__rocConfirmMessages ?? []);
  writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\nchanged after commit\n', 'utf8');
  await page.click('[aria-label="刷新 Git 状态"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('phase-three-notes.txt') === true);
  await page.click('[data-testid="git-select-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="git-select-phase-three-notes.txt"]')?.getAttribute('aria-pressed') === 'true');
  await page.click('[data-testid="git-stage-selected"]');
  await page.waitForFunction(() => {
    const changes = document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '';
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return changes.includes('phase-three-notes.txt') && selectedCount.includes('2 selected');
  });
  await page.fill('[data-testid="workbench-git-commit-message"]', 'smoke commit');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    if (!(button instanceof HTMLButtonElement)) {
      return false;
    }
    return button.disabled === false && button.classList.contains('git-commit-button--ready');
  });
  const gitCommitReadyState = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    if (!(button instanceof HTMLButtonElement)) {
      return null;
    }
    return {
      className: button.className,
      disabled: button.disabled
    };
  });
  await page.click('[data-testid="workbench-git-commit"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('工作区干净。') === true);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    const message = document.querySelector('[data-testid="workbench-git-commit-message"]');
    if (!(button instanceof HTMLButtonElement) || !(message instanceof HTMLTextAreaElement)) {
      return false;
    }
    return button.disabled === true && !button.classList.contains('git-commit-button--ready') && message.value === '';
  });
  const gitLastCommitText = await page.textContent('.git-last-result');
  const gitCommitResetState = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="workbench-git-commit"]');
    const message = document.querySelector('[data-testid="workbench-git-commit-message"]');
    if (!(button instanceof HTMLButtonElement) || !(message instanceof HTMLTextAreaElement)) {
      return null;
    }
    return {
      className: button.className,
      disabled: button.disabled,
      value: message.value
    };
  });
  writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\nchanged before push\n', 'utf8');
  await page.click('[aria-label="刷新 Git 状态"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('phase-three-notes.txt') === true);
  await page.click('[data-testid="git-select-phase-three-notes.txt"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="git-select-phase-three-notes.txt"]')?.getAttribute('aria-pressed') === 'true');
  await page.click('[data-testid="git-select-toggle-phase-three-notes.txt"]');
  await page.click('[data-testid="git-stage-selected"]');
  await page.waitForFunction(() => {
    const changes = document.querySelector('[data-testid="workbench-git-changes"]')?.textContent ?? '';
    const selectedCount = document.querySelector('[data-testid="git-selected-count"]')?.textContent ?? '';
    return changes.includes('phase-three-notes.txt') && selectedCount.includes('1 selected');
  });
  await page.fill('[data-testid="workbench-git-commit-message"]', 'smoke push commit');
  await page.click('[data-testid="workbench-git-commit"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="workbench-git-changes"]')?.textContent?.includes('工作区干净。') === true);
  const gitLastPushText = await page.textContent('.git-last-result');
  await page.evaluate(() => {
    globalThis.__rocSmokeTerminalEvents = [];
    if (typeof globalThis.__rocSmokeTerminalOutputDispose === 'function') {
      globalThis.__rocSmokeTerminalOutputDispose();
    }
    globalThis.__rocSmokeTerminalOutputDispose = window.roc.terminal.onOutput((event) => {
      globalThis.__rocSmokeTerminalEvents.push(event);
    });
  });
  await page.click('.workbench-tab[data-tool-button="terminal"]');
  await page.waitForSelector('[data-testid="terminal-xterm"]', { timeout: 10000 });
  const terminalWorkbenchStyleEvidence = await page.evaluate(() => {
    const frame = document.querySelector('.workbench-surface--terminal');
    const badges = Array.from(document.querySelectorAll('.terminal-badge')).map((element) => element.textContent ?? '');
    const scope = document.querySelector('[data-testid="terminal-session-scope"]')?.textContent ?? '';
    const terminalSubtitle = document.querySelector('.terminal-subtitle')?.textContent ?? '';
    const footerSegments = Array.from(document.querySelectorAll('.terminal-status-bar span')).map((element) => element.textContent?.trim() ?? '');
    const header = document.querySelector('.terminal-header');
    const xtermShell = document.querySelector('.terminal-xterm-host');
    const workbenchTerminal = document.querySelector('.workbench-terminal');
    if (!(frame instanceof HTMLElement)) {
      return {
        frameVisible: false,
        badgeCount: badges.length,
        scope,
        terminalSubtitle,
        footerSegments,
        headerExists: header !== null,
        xtermShellExists: xtermShell !== null,
        shellFillRatio: null,
        borderRadius: '',
        boxShadow: '',
        backgroundColor: ''
      };
    }
    const frameStyle = getComputedStyle(frame);
    const frameBox = frame.getBoundingClientRect();
    const shellBox = xtermShell instanceof HTMLElement ? xtermShell.getBoundingClientRect() : null;
    const workbenchBox = workbenchTerminal instanceof HTMLElement ? workbenchTerminal.getBoundingClientRect() : null;
    return {
      frameVisible: true,
      badgeCount: badges.length,
      scope,
      terminalSubtitle,
      footerSegments,
      headerExists: header !== null,
      xtermShellExists: xtermShell !== null,
      shellFillRatio:
        shellBox === null || workbenchBox === null || workbenchBox.height === 0
          ? null
          : Number(((frameBox.height / workbenchBox.height) * 100).toFixed(2)),
      borderRadius: frameStyle.borderRadius,
      boxShadow: frameStyle.boxShadow,
      backgroundColor: frameStyle.backgroundColor
    };
  });
  await waitForTerminalSessionReady(page);
  await page.waitForFunction(
    () => Array.isArray(globalThis.__rocSmokeTerminalEvents) && globalThis.__rocSmokeTerminalEvents.length > 0,
    undefined,
    { timeout: 10000 }
  );
  const terminalSessionId = await page.evaluate(() => globalThis.__rocSmokeTerminalEvents[0]?.sessionId ?? null);
  if (typeof terminalSessionId !== 'string' || terminalSessionId.length === 0) {
    throw new Error('Smoke could not capture terminal session id from output events.');
  }
  await page.evaluate(async (sessionId) => {
    const result = await window.roc.terminal.writeInput({ sessionId, data: 'dir\rpwd\r' });
    if (!result.ok) {
      throw new Error(`terminal writeInput failed: ${result.error.message}`);
    }
  }, terminalSessionId);
  await page.waitForFunction(
    (workspacePath) => {
      const text = document.querySelector('[data-testid="terminal-xterm"]')?.textContent?.toLowerCase() ?? '';
      return text.includes('phase-three-notes.txt') && text.includes(workspacePath.toLowerCase());
    },
    workspaceRoot,
    { timeout: 10000 }
  );
  const terminalLiveOutput = await page.textContent('[data-testid="terminal-xterm"]');
  const terminalSecondOutput = await page.textContent('[data-testid="terminal-xterm"]');
  await page.evaluate(() => {
    if (typeof globalThis.__rocSmokeTerminalOutputDispose === 'function') {
      globalThis.__rocSmokeTerminalOutputDispose();
      globalThis.__rocSmokeTerminalOutputDispose = null;
    }
  });
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
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="preview-view"]')?.textContent ?? '';
    return text.includes('bytes') || text.includes('无可预览文件');
  }, undefined, { timeout: 5000 });
  const previewPageImageEvidence = await page.evaluate(() => {
    const image = document.querySelector('[data-testid="preview-view-image"]');
    return {
      exists: image !== null,
      src: image?.getAttribute('src') ?? ''
    };
  });
  await page.click('[data-testid="nav-mcp"]');
  await page.waitForSelector('[data-testid="mcp-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-management"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-test-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-toggle-smoke-mcp"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="mcp-delete-smoke-mcp"]', { timeout: 5000 });
  await page.click('[data-testid="mcp-test-smoke-mcp"]');
  await waitForTextContent(page, '[data-testid="mcp-management"]', 'smoke-mcp:ready');
  const mcpText = await page.textContent('[data-testid="mcp-view"]');
  if (mcpText === null) {
    throw new Error('Smoke could not read MCP view text.');
  }
  await page.click('[data-testid="nav-skills"]');
  await page.waitForSelector('[data-testid="skills-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-management"]', { timeout: 5000 });
  await page.click('[data-testid="skills-filter-enabled"]');
  await page.waitForSelector('[data-testid="skill-row-smoke-skill"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-row-smoke-skill"]', 'Smoke Skill');
  const skillLayoutEvidence = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="skills-view"]');
    const filterStrip = document.querySelector('.skills-filter-strip');
    const firstRow = document.querySelector('[data-testid="skill-row-smoke-skill"]');
    const filterButtons = Array.from(document.querySelectorAll('[data-testid^="skills-filter-"]')).filter(
      (element) => element instanceof HTMLElement
    );
    if (
      !(view instanceof HTMLElement) ||
      !(filterStrip instanceof HTMLElement) ||
      !(firstRow instanceof HTMLElement) ||
      filterButtons.length === 0
    ) {
      return {
        exists: false,
        viewHeight: null,
        filterStripHeight: null,
        chipHeights: [],
        chipMaxHeight: null,
        gapToFirstRow: null,
        stripAlignItems: null,
        stripAlignContent: null
      };
    }
    const viewRect = view.getBoundingClientRect();
    const stripRect = filterStrip.getBoundingClientRect();
    const rowRect = firstRow.getBoundingClientRect();
    const chipHeights = filterButtons.map((element) => Number(element.getBoundingClientRect().height.toFixed(2)));
    return {
      exists: true,
      viewHeight: Number(viewRect.height.toFixed(2)),
      viewDisplay: getComputedStyle(view).display,
      viewJustifyContent: getComputedStyle(view).justifyContent,
      viewAlignItems: getComputedStyle(view).alignItems,
      filterStripHeight: Number(stripRect.height.toFixed(2)),
      filterStripTop: Number(stripRect.top.toFixed(2)),
      chipHeights,
      chipMaxHeight: chipHeights.length === 0 ? null : Math.max(...chipHeights),
      gapToRowList:
        firstRow.parentElement instanceof HTMLElement
          ? Number((firstRow.parentElement.getBoundingClientRect().top - stripRect.bottom).toFixed(2))
          : null,
      gapToFirstRow: Number((rowRect.top - stripRect.bottom).toFixed(2)),
      rowListTop: Number(
        (
          (firstRow.parentElement instanceof HTMLElement
            ? firstRow.parentElement.getBoundingClientRect().top
            : Number.NaN)
        ).toFixed(2)
      ),
      rowListHeight:
        firstRow.parentElement instanceof HTMLElement
          ? Number(firstRow.parentElement.getBoundingClientRect().height.toFixed(2))
          : null,
      rowListDisplay:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).display : null,
      rowListJustifyContent:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).justifyContent : null,
      rowListPaddingTop:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).paddingTop : null,
      rowListMarginTop:
        firstRow.parentElement instanceof HTMLElement ? getComputedStyle(firstRow.parentElement).marginTop : null,
      firstRowTop: Number(rowRect.top.toFixed(2)),
      stripAlignItems: getComputedStyle(filterStrip).alignItems,
      stripAlignContent: getComputedStyle(filterStrip).alignContent
    };
  });
  await page.click('[data-testid="skill-row-smoke-skill"]');
  await page.waitForSelector('[data-testid="skill-drawer"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-drawer-toggle"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="skill-drawer-delete"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-drawer"]', 'Skill · ready');
  await page.click('[data-testid="skill-drawer-toggle"]');
  await page.waitForFunction(async () => {
    const result = await window.roc.skills.list();
    if (!result.ok) {
      return false;
    }
    const skill = result.data.find((entry) => entry.id === 'smoke-skill');
    return skill?.enabled === false;
  }, undefined, { timeout: 5000 });
  await page.click('[data-testid="skills-filter-disabled"]');
  await page.waitForSelector('[data-testid="skill-row-smoke-skill"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-row-smoke-skill"]', 'disabled');
  const disabledSkillText = await page.textContent('[data-testid="skill-row-smoke-skill"]');
  await page.waitForSelector('[data-testid="skill-drawer"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="skill-drawer"]', 'Skill · disabled');
  await page.click('[data-testid="skill-drawer-toggle"]');
  await page.waitForFunction(async () => {
    const result = await window.roc.skills.list();
    if (!result.ok) {
      return false;
    }
    const skill = result.data.find((entry) => entry.id === 'smoke-skill');
    return skill?.enabled === true;
  }, undefined, { timeout: 5000 });
  await page.click('[data-testid="skills-filter-enabled"]');
  await page.waitForSelector('[data-testid="skill-row-smoke-skill"]', { timeout: 5000 });
  const skillText = await page.textContent('[data-testid="skills-view"]');
  if (skillText === null) {
    throw new Error('Smoke could not read Skill view text.');
  }
  const providerSettingsEvidence = {
    nvidiaListed: false,
    nvidiaFixedDetail: false,
    nvidiaDefaultModelChoicesVisible: false,
    llamaCppListed: false,
    llamaCppFixedDetail: false,
    llamaCppDefaultModelChoicesVisible: false,
    smokeProviderListed: false,
    providerActionsVisible: false,
    addProviderEntryVisible: false,
    headerChromeRemoved: false,
    apiKeyHelpRemoved: false,
    createRequiresApiKey: false,
    editWithoutApiKeyAllowed: false,
    detailScrollReachable: false,
    searchMatchesNameAndId: false,
    openaiSlugGenerated: false,
    openaiCreated: false,
    openaiSecretStored: false,
    openaiApiKeyCleared: false,
    openaiSecretUpdated: false,
    openaiRotatedSecretUsed: false,
    anthropicSlugGenerated: false,
    anthropicCreated: false,
    anthropicSecretStored: false,
    anthropicSecretCleared: false,
    openaiReady: false,
    defaultModelSelectable: false,
    providerTestFeedbackVisible: false,
    saveAllDirect: false
  };
  await clickSmokeControl(page, '[data-testid="settings-gear"]');
  await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-settings"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-list-item-nvidia"]', { timeout: 5000 });
  providerSettingsEvidence.nvidiaListed = true;
  providerSettingsEvidence.nvidiaFixedDetail = await page.evaluate(() => {
    const models = document.querySelector('[data-testid="provider-draft-models"]');
    const legacyModelId = document.querySelector('[data-testid="provider-draft-model-id"]');
    const endpoint = document.querySelector('[data-testid="provider-draft-endpoint"]');
    const deleteButton = document.querySelector('[data-testid="provider-delete-nvidia"]');
    const statusPills = Array.from(
      document.querySelectorAll('.provider-detail-title .provider-status-pill'),
      (element) => element.textContent?.trim() ?? ''
    );
    return (
      models instanceof HTMLTextAreaElement &&
      legacyModelId === null &&
      endpoint instanceof HTMLInputElement &&
      endpoint.readOnly === true &&
      endpoint.value === 'https://integrate.api.nvidia.com/v1' &&
      deleteButton === null &&
      !statusPills.includes('Fixed')
    );
  });
  await page.fill(
    '[data-testid="provider-draft-models"]',
    'moonshotai/kimi-k2.6 | Kimi K2.6\nmeta/llama-3.3-70b-instruct | Llama 3.3 70B'
  );
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async () => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.id === 'nvidia');
      const models = document.querySelector('[data-testid="provider-draft-models"]');
      return (
        provider !== undefined &&
        provider.models.length === 2 &&
        provider.models[0]?.id === 'moonshotai/kimi-k2.6' &&
        provider.models[1]?.id === 'meta/llama-3.3-70b-instruct' &&
        models instanceof HTMLTextAreaElement &&
        models.value.includes('moonshotai/kimi-k2.6 | Kimi K2.6') &&
        models.value.includes('meta/llama-3.3-70b-instruct | Llama 3.3 70B')
      );
    },
    undefined,
    { timeout: 5000 }
  );
  await clickSmokeControl(page, '[data-testid="provider-list-item-llama_cpp"]');
  await page.waitForSelector('[data-testid="provider-test-llama_cpp"]', { timeout: 5000 });
  providerSettingsEvidence.llamaCppListed = true;
  providerSettingsEvidence.llamaCppFixedDetail = await page.evaluate(() => {
    const models = document.querySelector('[data-testid="provider-draft-models"]');
    const name = document.querySelector('[data-testid="provider-draft-name"]');
    const endpoint = document.querySelector('[data-testid="provider-draft-endpoint"]');
    const deleteButton = document.querySelector('[data-testid="provider-delete-llama_cpp"]');
    return (
      models instanceof HTMLTextAreaElement &&
      name === null &&
      endpoint instanceof HTMLInputElement &&
      endpoint.readOnly === false &&
      endpoint.value === 'http://127.0.0.1:8081/v1' &&
      deleteButton === null
    );
  });
  await page.fill('[data-testid="provider-draft-models"]', 'qwen3.5-4b | Qwen 3.5 4B');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async () => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.id === 'llama_cpp');
      const endpoint = document.querySelector('[data-testid="provider-draft-endpoint"]');
      const models = document.querySelector('[data-testid="provider-draft-models"]');
      return (
        provider !== undefined &&
        provider.credentialRef === null &&
        provider.endpoint === 'http://127.0.0.1:8081/v1' &&
        provider.models.length === 1 &&
        provider.models[0]?.id === 'qwen3.5-4b' &&
        endpoint instanceof HTMLInputElement &&
        endpoint.value === 'http://127.0.0.1:8081/v1' &&
        models instanceof HTMLTextAreaElement &&
        models.value.includes('qwen3.5-4b | Qwen 3.5 4B')
      );
    },
    undefined,
    { timeout: 5000 }
  );
  providerSettingsEvidence.headerChromeRemoved = await page.evaluate(() => {
    const header = document.querySelector('[data-testid="settings-header"]');
    if (!(header instanceof HTMLElement)) {
      return false;
    }
    return (
      header.querySelector('.page-copy') === null &&
      header.querySelector('.page-kicker') === null &&
      header.querySelector('.page-title') === null &&
      header.querySelector('[data-testid="settings-dirty-count"]') instanceof HTMLElement &&
      header.querySelector('[data-testid="settings-reset-all"]') instanceof HTMLElement &&
      header.querySelector('[data-testid="settings-save-all"]') instanceof HTMLElement
    );
  });
  await clickSmokeControl(page, '[data-testid="provider-list-item-smoke-provider"]');
  await page.waitForSelector('[data-testid="provider-test-smoke-provider"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-delete-smoke-provider"]', { timeout: 5000 });
  providerSettingsEvidence.smokeProviderListed = true;
  providerSettingsEvidence.providerActionsVisible = true;
  for (const sectionId of [
    'providers',
    'default-model',
    'app-basics',
    'auth-security',
    'memory',
    'browser',
    'capabilities'
  ]) {
    await clickSmokeControl(page, `[data-testid="settings-section-${sectionId}"]`);
    await page.waitForSelector(`[data-testid="settings-panel-${sectionId}"], [data-testid="provider-settings"], [data-testid="default-model-settings"]`, {
      timeout: 5000
    });
  }
  await clickSmokeControl(page, '[data-testid="settings-section-default-model"]');
  await page.waitForFunction(
    () => {
      const kimi = document.querySelector('[data-testid="default-model-moonshotai/kimi-k2.6"]');
      const llama = document.querySelector('[data-testid="default-model-meta/llama-3.3-70b-instruct"]');
      const llamaCpp = document.querySelector('[data-testid="default-model-qwen3.5-4b"]');
      return kimi instanceof HTMLButtonElement && llama instanceof HTMLButtonElement && llamaCpp instanceof HTMLButtonElement;
    },
    undefined,
    { timeout: 5000 }
  );
  providerSettingsEvidence.nvidiaDefaultModelChoicesVisible = true;
  providerSettingsEvidence.llamaCppDefaultModelChoicesVisible = true;
  await clickSmokeControl(page, '[data-testid="settings-section-providers"]');
  await page.waitForSelector('[data-testid="provider-add-anthropic"]', { state: 'detached', timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-add-openai"]', { timeout: 5000 });
  providerSettingsEvidence.addProviderEntryVisible = true;
  const renamedSmokeProviderName = 'Smoke Provider Renamed';
  await page.fill('[data-testid="provider-draft-name"]', renamedSmokeProviderName);
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await waitForTextContent(page, '[data-testid="settings-view"]', renamedSmokeProviderName);
  const smokeProviderEditState = await page.evaluate(async ({ providerId, providerName }) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.id === providerId);
    return {
      providerName: provider?.name ?? null,
      secretStored:
        result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true,
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null
    };
  }, { providerId: 'smoke-provider', providerName: renamedSmokeProviderName });
  providerSettingsEvidence.editWithoutApiKeyAllowed =
    smokeProviderEditState.providerName === renamedSmokeProviderName &&
    smokeProviderEditState.secretStored &&
    smokeProviderEditState.statusText === null;
  await clickSmokeControl(page, '[data-testid="provider-add-openai"]');
  const openaiProviderName = 'Smoke UI OpenAI';
  await page.fill('[data-testid="provider-draft-name"]', openaiProviderName);
  await page.fill('[data-testid="provider-draft-endpoint"]', smokeProvider.endpoint);
  await page.fill('[data-testid="provider-draft-models"]', 'smoke-ui-openai-model');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  const openaiMissingKeyState = await page.evaluate(async (providerName) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return {
      providerExists: result.data.providers.some((entry) => entry.name === providerName),
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null
    };
  }, openaiProviderName);
  providerSettingsEvidence.createRequiresApiKey =
    openaiMissingKeyState.providerExists === false &&
    typeof openaiMissingKeyState.statusText === 'string' &&
    openaiMissingKeyState.statusText.includes('API Key');
  await page.fill('[data-testid="provider-draft-api-key"]', 'sk-smoke-ui-openai');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerName) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.name === providerName);
      const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
      return (
        provider !== undefined &&
        result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true &&
        apiKeyInput instanceof HTMLInputElement &&
        apiKeyInput.value === ''
      );
    },
    openaiProviderName,
    { timeout: 5000 }
  );
  providerSettingsEvidence.openaiCreated = true;
  const openaiProviderState = await page.evaluate(async (providerName) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.name === providerName);
    const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
    return {
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null,
      providerIds: result.data.providers.map((entry) => `${entry.id}:${entry.name}`),
      providerId: provider?.id ?? null,
      secretStored:
        provider === undefined
          ? false
          : result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true,
      apiKeyValue: apiKeyInput instanceof HTMLInputElement ? apiKeyInput.value : null
    };
  }, openaiProviderName);
  if (openaiProviderState.providerId === null) {
    throw new Error(
      `missing provider for ${openaiProviderName}; status=${openaiProviderState.statusText}; providers=${openaiProviderState.providerIds.join(',')}`
    );
  }
  const openaiProviderId = openaiProviderState.providerId;
  providerSettingsEvidence.openaiSlugGenerated = openaiProviderId === 'smoke-ui-openai';
  providerSettingsEvidence.openaiSecretStored = openaiProviderState.secretStored;
  providerSettingsEvidence.openaiApiKeyCleared = openaiProviderState.apiKeyValue === '';
  const providerDetailText = await page.textContent('[data-testid="provider-detail"]');
  providerSettingsEvidence.apiKeyHelpRemoved =
    providerDetailText !== null &&
    !providerDetailText.includes('Get your API key from') &&
    !providerDetailText.includes('OpenAI compatible chat completions endpoint') &&
    !providerDetailText.includes('Anthropic compatible /messages endpoint') &&
    !providerDetailText.includes('保存 Provider 后可录入 API Key。');
  await clickSmokeControl(page, `[data-testid="provider-list-item-${openaiProviderId}"]`);
  await page.waitForSelector('[data-testid="provider-draft-api-key"]', { timeout: 5000 });
  const providerDetailScrollEvidence = await page.evaluate(() => {
    const detail = document.querySelector('[data-testid="provider-detail"]');
    const providerSave = document.querySelector('[data-testid="provider-save"]');
    const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
    if (
      !(detail instanceof HTMLElement) ||
      !(providerSave instanceof HTMLElement) ||
      !(apiKeyInput instanceof HTMLElement)
    ) {
      return {
        exists: false,
        overflowY: null,
        hadOverflow: false,
        scrollMoved: false,
        providerSaveVisible: false,
        apiKeyVisible: false
      };
    }
    const before = detail.scrollTop;
    detail.scrollTop = detail.scrollHeight;
    const after = detail.scrollTop;
    const detailRect = detail.getBoundingClientRect();
    const providerSaveRect = providerSave.getBoundingClientRect();
    const apiKeyRect = apiKeyInput.getBoundingClientRect();
    const isVisibleWithinDetail = (rect) =>
      rect.top >= detailRect.top - 1 && rect.bottom <= detailRect.bottom + 1;
    return {
      exists: true,
      overflowY: window.getComputedStyle(detail).overflowY,
      hadOverflow: detail.scrollHeight > detail.clientHeight,
      scrollMoved: after > before,
      providerSaveVisible: isVisibleWithinDetail(providerSaveRect),
      apiKeyVisible: isVisibleWithinDetail(apiKeyRect)
    };
  });
  providerSettingsEvidence.detailScrollReachable =
    providerDetailScrollEvidence.exists &&
    providerDetailScrollEvidence.overflowY === 'auto' &&
    (!providerDetailScrollEvidence.hadOverflow || providerDetailScrollEvidence.scrollMoved) &&
    providerDetailScrollEvidence.providerSaveVisible &&
    providerDetailScrollEvidence.apiKeyVisible;
  await page.waitForSelector(`[data-testid="provider-secret-clear-${openaiProviderId}"]`, { timeout: 5000 });
  await page.fill('[data-testid="provider-draft-api-key"]', 'sk-smoke-ui-openai-rotated');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerId) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
      return (
        result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true &&
        apiKeyInput instanceof HTMLInputElement &&
        apiKeyInput.value === ''
      );
    },
    openaiProviderId,
    { timeout: 5000 }
  );
  const openaiSecretUpdateState = await page.evaluate(async (providerId) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
    return {
      secretStored:
        result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true,
      apiKeyValue: apiKeyInput instanceof HTMLInputElement ? apiKeyInput.value : null
    };
  }, openaiProviderId);
  providerSettingsEvidence.openaiSecretUpdated =
    openaiSecretUpdateState.secretStored && openaiSecretUpdateState.apiKeyValue === '';
  await clickSmokeControl(page, '[data-testid="provider-add-openai"]');
  await clickSmokeControl(page, '[data-testid="provider-draft-type-anthropic_compatible"]');
  const anthropicProviderName = 'Smoke UI Anthropic';
  await page.fill('[data-testid="provider-draft-name"]', anthropicProviderName);
  await page.fill('[data-testid="provider-draft-api-key"]', 'sk-smoke-ui-anthropic');
  await page.fill('[data-testid="provider-draft-endpoint"]', smokeProvider.endpoint);
  await page.fill('[data-testid="provider-draft-models"]', 'smoke-ui-anthropic-model');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerName) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.name === providerName);
      const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
      return (
        provider !== undefined &&
        result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true &&
        apiKeyInput instanceof HTMLInputElement &&
        apiKeyInput.value === ''
      );
    },
    anthropicProviderName,
    { timeout: 5000 }
  );
  providerSettingsEvidence.anthropicCreated = true;
  const anthropicProviderState = await page.evaluate(async (providerName) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.name === providerName);
    return {
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null,
      providerIds: result.data.providers.map((entry) => `${entry.id}:${entry.name}`),
      providerId: provider?.id ?? null,
      secretStored:
        provider === undefined
          ? false
          : result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true
    };
  }, anthropicProviderName);
  if (anthropicProviderState.providerId === null) {
    throw new Error(
      `missing provider for ${anthropicProviderName}; status=${anthropicProviderState.statusText}; providers=${anthropicProviderState.providerIds.join(',')}`
    );
  }
  const anthropicProviderId = anthropicProviderState.providerId;
  providerSettingsEvidence.anthropicSlugGenerated = anthropicProviderId === 'smoke-ui-anthropic';
  providerSettingsEvidence.anthropicSecretStored = anthropicProviderState.secretStored;
  await clickSmokeControl(page, `[data-testid="provider-list-item-${anthropicProviderId}"]`);
  await page.waitForSelector(`[data-testid="provider-secret-clear-${anthropicProviderId}"]`, { timeout: 5000 });
  await clickSmokeControl(page, `[data-testid="provider-secret-clear-${anthropicProviderId}"]`);
  await page.waitForSelector(`[data-testid="provider-secret-clear-${anthropicProviderId}"]`, {
    state: 'detached',
    timeout: 5000
  });
  const anthropicSecretClearState = await page.evaluate(async (providerId) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true;
  }, anthropicProviderId);
  providerSettingsEvidence.anthropicSecretCleared = anthropicSecretClearState === false;
  await page.fill('[data-testid="provider-search"]', openaiProviderName);
  await page.waitForSelector(`[data-testid="provider-list-item-${openaiProviderId}"]`, { timeout: 5000 });
  await page.fill('[data-testid="provider-search"]', openaiProviderId);
  await page.waitForSelector(`[data-testid="provider-list-item-${openaiProviderId}"]`, { timeout: 5000 });
  await page.fill('[data-testid="provider-search"]', '');
  providerSettingsEvidence.searchMatchesNameAndId = true;
  await clickSmokeControl(page, `[data-testid="provider-list-item-${openaiProviderId}"]`);
  await clickSmokeControl(page, `[data-testid="provider-test-${openaiProviderId}"]`);
  await waitForTextContent(page, '[data-testid="provider-detail-status"]', 'Active');
  await waitForTextContent(page, '[data-testid="provider-test-feedback"]', '已测试 smoke-ui-openai-model 可用。');
  providerSettingsEvidence.openaiReady = true;
  providerSettingsEvidence.providerTestFeedbackVisible =
    ((await page.textContent('[data-testid="provider-test-feedback"]')) ?? '').includes(
      '已测试 smoke-ui-openai-model 可用。'
    );
  await clickSmokeControl(page, '[data-testid="settings-section-default-model"]');
  await page.waitForSelector('[data-testid="default-model-smoke-ui-openai-model"]', { timeout: 5000 });
  await clickSmokeControl(page, '[data-testid="default-model-smoke-ui-openai-model"]');
  await waitForTextContent(page, '[data-testid="default-model-settings"]', 'smoke-ui-openai-model');
  providerSettingsEvidence.defaultModelSelectable = true;
  await clickSmokeControl(page, '[data-testid="settings-section-app-basics"]');
  await page.waitForSelector('[data-testid="settings-panel-app-basics"]', { timeout: 5000 });
  const openAtLoginBeforeSaveAll = await page.locator('[data-testid="settings-startup-open-at-login"]').isChecked();
  await clickSmokeControl(page, '[data-testid="settings-startup-open-at-login"]');
  await waitForTextContent(page, '[data-testid="settings-dirty-count"]', '未保存 1 项');
  await clickSmokeControl(page, '[data-testid="settings-save-all"]');
  await page.waitForSelector('[data-testid="impact-preview-modal"]', { state: 'detached', timeout: 5000 });
  await waitForTextContent(page, '[data-testid="settings-dirty-count"]', '无未保存变更');
  const openAtLoginAfterSaveAll = await page.evaluate(async () => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.settings.startup.openAtLogin;
  });
  providerSettingsEvidence.saveAllDirect = openAtLoginAfterSaveAll === !openAtLoginBeforeSaveAll;
  await clickSmokeControl(page, '[data-testid="settings-section-providers"]');
  await waitForTextContent(page, '[data-testid="provider-detail-status"]', 'Active');
  const settingsText = await page.textContent('[data-testid="settings-view"]');
  if (settingsText === null) {
    throw new Error('Smoke could not read settings view text.');
  }
  await page.click('[data-testid="settings-modal-close"]');
  await page.waitForSelector('[data-testid="settings-modal"]', { state: 'detached', timeout: 5000 });
  await openChatView(page);
  await page.hover('[data-testid="chat-tool-trigger"]');
  await page.waitForSelector('[data-testid="turn-mcp-smoke-mcp"]', { timeout: 5000 });
  await page.hover('[data-testid="chat-skill-trigger"]');
  await page.waitForSelector('[data-testid="turn-skill-smoke-skill"]', { timeout: 5000 });
  await page.hover('[data-testid="chat-tool-trigger"]');
  await page.click('[data-testid="chat-tool-clear-all"]');
  await page.hover('[data-testid="chat-skill-trigger"]');
  await page.click('[data-testid="chat-skill-clear-all"]');
  await waitForCapabilitySelection(page, { mcpCount: 0, skillCount: 0 });
  await clickComposerPopoverChoice(page, '[data-testid="chat-tool-trigger"]', '[data-testid="turn-mcp-smoke-mcp"]');
  await clickComposerPopoverChoice(page, '[data-testid="chat-skill-trigger"]', '[data-testid="turn-skill-smoke-skill"]');
  await waitForCapabilitySelection(page, {
    expectedMcpIds: ['smoke-mcp'],
    expectedSkillIds: ['smoke-skill'],
    mcpCount: 1,
    skillCount: 1
  });
  await clickComposerPopoverChoice(page, '[data-testid="chat-tool-trigger"]', '[data-testid="turn-mcp-smoke-mcp"]');
  await clickComposerPopoverChoice(page, '[data-testid="chat-skill-trigger"]', '[data-testid="turn-skill-smoke-skill"]');
  await waitForCapabilitySelection(page, { mcpCount: 0, skillCount: 0 });
  await clickComposerPopoverChoice(page, '[data-testid="chat-tool-trigger"]', '[data-testid="turn-mcp-smoke-mcp"]');
  await clickComposerPopoverChoice(page, '[data-testid="chat-skill-trigger"]', '[data-testid="turn-skill-smoke-skill"]');
  const chatCapabilityEvidence = await waitForCapabilitySelection(page, {
    expectedMcpIds: ['smoke-mcp'],
    expectedSkillIds: ['smoke-skill'],
    mcpCount: 1,
    skillCount: 1
  });
  const agentCapabilityPreviewHidden = await page.evaluate(
    () =>
      document.querySelector('[data-testid="agent-capability-preview"]') === null &&
      document.querySelector('[data-testid="agent-tool-cards"]') === null &&
      document.querySelector('[data-testid="agent-subagents"]') === null
  );
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
  const typedChatPromptSecondLine = 'Smoke Shift+Enter second line';
  const submittedChatPrompt = `${typedChatPrompt}\n${typedChatPromptSecondLine}`;
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
  await page.locator('body').hover({ position: { x: 8, y: 8 } });
  await page.fill('[data-testid="chat-input"]', '');
  await page.focus('[data-testid="chat-input"]');
  await page.keyboard.type(typedChatPrompt);
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await page.keyboard.type(typedChatPromptSecondLine);
  const chatInputEvidence = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="chat-input"]');
    const sendButton = document.querySelector('[data-testid="chat-task-submit"]');
    if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) {
      return {
        exists: input !== null,
        editable: false,
        visuallyFramed: false,
        sendButtonVisibleInViewport: false,
        bottomExplanationsAbsent: false,
        inputSettledAtBottom: false,
        resultAboveInput: false,
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
    const composer = input.closest('.composer');
    const composerRect = composer instanceof HTMLElement ? composer.getBoundingClientRect() : null;
    const chatView = document.querySelector('[data-testid="chat-view"]');
    const chatViewRect = chatView instanceof HTMLElement ? chatView.getBoundingClientRect() : null;
    const bottomStack = document.querySelector('.chat-bottom-stack');
    const bottomStackChildren = bottomStack instanceof HTMLElement ? Array.from(bottomStack.children) : [];
    const bottomExplanationsAbsent =
      document.querySelector('[data-testid="turn-capabilities"]') === null &&
      bottomStackChildren.length === 1 &&
      bottomStackChildren[0] === composer;
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
      rect.width >= 220 &&
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
      bottomExplanationsAbsent,
      composerBottomGapToViewport: composerRect === null ? null : Math.round(viewport.height - composerRect.bottom),
      inputSettledAtBottom:
        composerRect !== null &&
        chatViewRect !== null &&
        composerRect.bottom <= chatViewRect.bottom &&
        chatViewRect.bottom - composerRect.bottom <= 4 &&
        viewport.height - composerRect.bottom <= 10,
      transcriptMountedBeforeSubmit: document.querySelector('[data-testid="chat-transcript"]') !== null,
      resultAboveInput: true,
      value: input.value
    };
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const assistantMessages = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'));
      const latestAssistant = assistantMessages.at(-1);
      return (latestAssistant?.textContent ?? '').includes('Smoke Provider 已生成首轮回复。');
    },
    { timeout: 5000 }
  );
  const chatResultText = await page.textContent('[data-testid="chat-transcript"]');
  if (chatResultText === null) {
    throw new Error('Smoke could not read chat result text.');
  }
  providerSettingsEvidence.openaiRotatedSecretUsed = smokeProvider.requests.some(
    (request) => request.authorization === 'Bearer sk-smoke-ui-openai-rotated'
  );
  const chatResultLayoutEvidence = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="chat-input"]');
    const userMessages = Array.from(document.querySelectorAll('[data-testid="chat-message-user"]'));
    const assistantMessages = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'));
    const latestUser = userMessages.at(-1);
    const latestAssistant = assistantMessages.at(-1);
    if (!(input instanceof HTMLElement) || !(latestUser instanceof HTMLElement) || !(latestAssistant instanceof HTMLElement)) {
      return {
        resultAboveInput: false,
        userAlignedRight: false,
        assistantAlignedLeft: false,
        assistantBubbleUnframed: false,
        assistantContentAnchoredLeft: false,
        assistantBubbleFitsContent: false,
        assistantBubbleNarrowerThanRow: false
      };
    }
    const inputRect = input.getBoundingClientRect();
    const userRect = latestUser.getBoundingClientRect();
    const assistantRect = latestAssistant.getBoundingClientRect();
    const assistantBubble = latestAssistant.querySelector('.chat-bubble--assistant');
    const assistantContent = latestAssistant.querySelector('[data-testid="chat-assistant-content"]');
    const assistantBubbleStyle =
      assistantBubble instanceof HTMLElement ? window.getComputedStyle(assistantBubble) : null;
    const assistantBubbleRect = assistantBubble instanceof HTMLElement ? assistantBubble.getBoundingClientRect() : null;
    const assistantContentRect = assistantContent instanceof HTMLElement ? assistantContent.getBoundingClientRect() : null;
    const composer = input.closest('.composer');
    const composerRect = composer instanceof HTMLElement ? composer.getBoundingClientRect() : null;
    return {
      resultAboveInput: userRect.bottom <= inputRect.top && assistantRect.bottom <= inputRect.top,
      userAlignedRight: window.getComputedStyle(latestUser).justifyContent === 'flex-end',
      assistantAlignedLeft: window.getComputedStyle(latestAssistant).justifyContent === 'flex-start',
      assistantBubbleUnframed:
        assistantBubbleStyle !== null &&
        assistantBubbleStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        assistantBubbleStyle.borderTopWidth === '0px' &&
        assistantBubbleStyle.boxShadow === 'none',
      assistantContentAnchoredLeft:
        assistantContentRect !== null && Math.abs(assistantContentRect.left - assistantRect.left) <= 4,
      assistantBubbleFitsContent:
        assistantBubbleRect !== null &&
        assistantContentRect !== null &&
        Math.abs(assistantBubbleRect.width - assistantContentRect.width) <= 4,
      assistantBubbleNarrowerThanRow:
        assistantBubbleRect !== null && assistantBubbleRect.width <= assistantRect.width - 24,
      assistantGapToComposer:
        composerRect !== null ? Math.round(composerRect.top - assistantRect.bottom) : null
    };
  });
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
    const thread = snapshot.data.threads.find((item) => item.id === userMessage.threadId);
    if (thread === undefined) {
      throw new Error(`No task thread found for typed prompt: ${expectedInput}`);
    }
    return {
      expectedInput,
      threadTitle: thread.title,
      threadGoal: thread.goal,
      userMessage: userMessage.payload,
      assistantMessage: assistantMessage.payload,
      providerUpdate: providerUpdate.payload,
      manifest: manifest.payload,
      skillLoaded: skillLoaded?.payload ?? null
    };
  }, submittedChatPrompt);
  const historySidebarEvidence = await page.evaluate((expectedTitle) => {
    const historyList = document.querySelector('.history-list');
    const text = historyList?.textContent ?? '';
    return {
      exists: historyList !== null,
      text,
      hasExpectedThreadTitle: text.includes(expectedTitle),
      hasCurrentSessionLabel: text.includes('当前主会话'),
      hasQuickEntryLabel: text.includes('快捷入口'),
      hasTrayEntryLabel: text.includes('托盘接管记录'),
      hasMemoryRecordLabel: text.includes('记忆整理裁决'),
      hasTaskRecordLabel: text.includes('任务工作台记录')
    };
  }, taskCapabilityEvidence.threadTitle);
  await page.click('[data-testid="nav-diagnostics"]');
  await page.waitForSelector('[data-testid="diagnostics-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="diagnostic-package-status"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="performance-sample"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="diagnostics-view"]', 'task_snapshot');
  const diagnosticsText = await page.textContent('[data-testid="diagnostics-view"]');
  if (diagnosticsText === null) {
    throw new Error('Smoke could not read diagnostics view text.');
  }
  const phase6ApiEvidence = await page.evaluate(async () => {
    const sample = await window.roc.diagnostics.samplePerformance({
      mode: 'smoke',
      memoryBudgetMb: 300
    });
    const tray = await window.roc.lifecycle.getTraySummary();
    if (!sample.ok) {
      throw new Error(sample.error.message);
    }
    if (!tray.ok) {
      throw new Error(tray.error.message);
    }
    return {
      sample: sample.data,
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
  const buttonInteractionEvidence = {
    chatTopbarActionsGrouped: false,
    chatSidebarToggleVisible: false,
    chatSidebarToggleWorks: false,
    chatHistorySearchToggleVisible: false,
    chatHistorySearchToggleWorks: false,
    chatNewConversationVisible: false,
    chatNewConversationWorks: false,
    attachmentPickerVisible: false,
    attachmentSelectionVisible: false,
    toolPopoverVisible: false,
    toolPopoverHoverSticky: false,
    toolPopoverBatchActionsVisible: false,
    toolSelectAllWorks: false,
    toolClearAllWorks: false,
    skillPopoverVisible: false,
    skillPopoverHoverSticky: false,
    skillPopoverBatchActionsVisible: false,
    skillSelectAllWorks: false,
    skillClearAllWorks: false,
    modelPopoverVisible: false,
    modelPopoverHoverSticky: false,
    composerOnlyHasSendOnRight: false,
    workbenchGitClickable: false,
    workbenchTerminalClickable: false,
    workbenchCloseClickable: false,
    memoryEditorHasNoDisabledButtons: false,
    memoryRecordSelectable: false
  };
  await page.waitForSelector('[data-testid="settings-modal"]', { state: 'detached', timeout: 5000 });
  await openChatView(page);
  buttonInteractionEvidence.chatTopbarActionsGrouped = await page.evaluate(() => {
    const workband = document.querySelector('[data-testid="window-workband"]');
    const brand = workband?.querySelector('.brand');
    const sidebarToggle = document.querySelector('[data-testid="chat-sidebar-toggle"]');
    const historySearchToggle = document.querySelector('[data-testid="chat-history-search-toggle"]');
    const newConversation = document.querySelector('[data-testid="chat-new-conversation"]');
    if (
      !(workband instanceof HTMLElement) ||
      !(brand instanceof HTMLElement) ||
      !(sidebarToggle instanceof HTMLElement) ||
      !(historySearchToggle instanceof HTMLElement) ||
      !(newConversation instanceof HTMLElement)
    ) {
      return false;
    }
    return (
      workband.contains(sidebarToggle) &&
      workband.contains(historySearchToggle) &&
      workband.contains(newConversation) &&
      !document.querySelector('.chat-toolbar-actions')?.contains(sidebarToggle) &&
      sidebarToggle.getBoundingClientRect().left > brand.getBoundingClientRect().right
    );
  });
  buttonInteractionEvidence.chatSidebarToggleVisible = (await page.locator('[data-testid="chat-sidebar-toggle"]').count()) === 1;
  buttonInteractionEvidence.chatHistorySearchToggleVisible =
    (await page.locator('[data-testid="chat-history-search-toggle"]').count()) === 1;
  buttonInteractionEvidence.chatNewConversationVisible =
    (await page.locator('[data-testid="chat-new-conversation"]').count()) === 1;
  await page.click('[data-testid="chat-history-search-toggle"]');
  await page.waitForSelector('[data-testid="chat-history-search-input"]', { timeout: 5000 });
  buttonInteractionEvidence.chatHistorySearchToggleWorks =
    (await page.locator('[data-testid="chat-history-search-input"]').count()) === 1;
  await page.click('[data-testid="chat-sidebar-toggle"]');
  await page.waitForFunction(() => document.querySelector('.sidebar') === null, undefined, { timeout: 5000 });
  buttonInteractionEvidence.chatSidebarToggleWorks = (await page.locator('.sidebar').count()) === 0;
  await page.click('[data-testid="chat-sidebar-toggle"]');
  await page.waitForSelector('.sidebar', { timeout: 5000 });
  await page.hover('[data-testid="chat-attachment-trigger"]');
  buttonInteractionEvidence.attachmentPickerVisible = (await page.locator('[data-testid="chat-attachment-trigger"]').count()) === 1;
  await page.click('[data-testid="chat-attachment-trigger"]');
  await page.waitForSelector('[data-testid="chat-attachment-pill"]', { timeout: 5000 });
  buttonInteractionEvidence.attachmentSelectionVisible =
    ((await page.textContent('[data-testid="chat-attachment-pill"]')) ?? '').includes('phase-three-notes.txt');
  await page.click('[data-testid="chat-new-conversation"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="chat-view"]') !== null &&
      document.querySelector('[data-testid="chat-attachment-pill"]') === null,
    undefined,
    { timeout: 5000 }
  );
  buttonInteractionEvidence.chatNewConversationWorks = (await page.locator('[data-testid="chat-attachment-pill"]').count()) === 0;
  await page.hover('[data-testid="chat-tool-trigger"]');
  await page.waitForSelector('[data-testid="chat-tool-popover"]', { timeout: 5000 });
  buttonInteractionEvidence.toolPopoverVisible =
    ((await page.textContent('[data-testid="chat-tool-popover"]')) ?? '').includes('当前可用工具');
  await hoverComposerPopoverContent(page, '[data-testid="chat-tool-trigger"]', '[data-testid="chat-tool-popover"]');
  buttonInteractionEvidence.toolPopoverHoverSticky =
    (await page.locator('[data-testid="chat-tool-popover"]').count()) === 1;
  buttonInteractionEvidence.toolPopoverBatchActionsVisible =
    ((await page.textContent('[data-testid="chat-tool-popover"]')) ?? '').includes('全选') &&
    ((await page.textContent('[data-testid="chat-tool-popover"]')) ?? '').includes('取消全选');
  await page.click('[data-testid="chat-tool-select-all"]');
  await waitForCapabilitySelection(page, { expectedMcpIds: ['smoke-mcp'], mcpCount: 1, skillCount: 1 });
  buttonInteractionEvidence.toolSelectAllWorks =
    await page.locator('[data-testid="turn-mcp-smoke-mcp"].active').count() === 1;
  await page.hover('[data-testid="chat-tool-trigger"]');
  await page.click('[data-testid="chat-tool-clear-all"]');
  await waitForCapabilitySelection(page, { skillCount: 1, mcpCount: 0 });
  buttonInteractionEvidence.toolClearAllWorks =
    await page.locator('[data-testid="turn-mcp-smoke-mcp"].active').count() === 0;
  await page.hover('[data-testid="chat-skill-trigger"]');
  await page.waitForSelector('[data-testid="chat-skill-popover"]', { timeout: 5000 });
  buttonInteractionEvidence.skillPopoverVisible =
    ((await page.textContent('[data-testid="chat-skill-popover"]')) ?? '').includes('当前可用技能');
  await hoverComposerPopoverContent(page, '[data-testid="chat-skill-trigger"]', '[data-testid="chat-skill-popover"]');
  buttonInteractionEvidence.skillPopoverHoverSticky =
    (await page.locator('[data-testid="chat-skill-popover"]').count()) === 1;
  buttonInteractionEvidence.skillPopoverBatchActionsVisible =
    ((await page.textContent('[data-testid="chat-skill-popover"]')) ?? '').includes('全选') &&
    ((await page.textContent('[data-testid="chat-skill-popover"]')) ?? '').includes('取消全选');
  const selectableSkillIds = await page.evaluate(async () => {
    const result = await window.roc.skills.list();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.filter((skill) => skill.enabled && skill.status === 'ready').map((skill) => skill.id);
  });
  await page.click('[data-testid="chat-skill-select-all"]');
  await waitForCapabilitySelection(page, {
    expectedSkillIds: selectableSkillIds,
    mcpCount: 0,
    skillCount: selectableSkillIds.length
  });
  buttonInteractionEvidence.skillSelectAllWorks =
    selectableSkillIds.length > 0 &&
    (await page.evaluate((ids) => {
      return ids.every((id) => {
        const node = document.querySelector(`[data-testid="turn-skill-${id}"]`);
        return node instanceof HTMLElement && node.classList.contains('active');
      });
    }, selectableSkillIds));
  await page.hover('[data-testid="chat-skill-trigger"]');
  await page.click('[data-testid="chat-skill-clear-all"]');
  await waitForCapabilitySelection(page, { mcpCount: 0, skillCount: 0 });
  buttonInteractionEvidence.skillClearAllWorks =
    await page.locator('[data-testid="turn-skill-smoke-skill"].active').count() === 0;
  await page.hover('[data-testid="chat-model-trigger"]');
  await page.waitForSelector('[data-testid="chat-model-popover"]', { timeout: 5000 });
  buttonInteractionEvidence.modelPopoverVisible =
    ((await page.textContent('[data-testid="chat-model-popover"]')) ?? '').includes('smoke-model');
  await hoverComposerPopoverContent(page, '[data-testid="chat-model-trigger"]', '[data-testid="chat-model-popover"]');
  buttonInteractionEvidence.modelPopoverHoverSticky =
    (await page.locator('[data-testid="chat-model-popover"]').count()) === 1;
  buttonInteractionEvidence.composerOnlyHasSendOnRight = await page.evaluate(() => {
    const composerRight = document.querySelector('.composer-right');
    if (!(composerRight instanceof HTMLElement)) {
      return false;
    }
    const buttons = Array.from(composerRight.querySelectorAll('button'));
    return buttons.length === 1 && buttons[0]?.getAttribute('data-testid') === 'chat-task-submit';
  });
  await page.click('[data-testid="nav-memory"]');
  await page.waitForSelector('[data-testid="memory-view"]', { timeout: 5000 });
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
    const result = await window.roc.app.openMainPage('chat');
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  });
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
  const collapsedChatLayoutBeforeOpen = await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="active-view"]')?.parentElement;
    const rail = document.querySelector('.rail-overlay');
    const composer = document.querySelector('.composer');
    const workbench = document.querySelector('[data-testid="workbench-panel"]');
    if (!(shell instanceof HTMLElement) || !(rail instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
      return {
        shellExists: shell !== null,
        railExists: rail !== null,
        composerExists: composer !== null,
        workbenchVisible: workbench !== null,
        shellClassName: shell instanceof HTMLElement ? shell.className : null,
        railGapToShellRight: null,
        composerWidthRatio: null
      };
    }
    const shellRect = shell.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      shellExists: true,
      railExists: true,
      composerExists: true,
      workbenchVisible: workbench !== null,
      shellClassName: shell.className,
      railGapToShellRight: Math.round(shellRect.right - railRect.right),
      composerWidthRatio: Number((composerRect.width / shellRect.width).toFixed(3))
    };
  });
  await page.click('.rail-button[data-tool-button="files"]');
  await page.waitForSelector('[data-testid="workbench-panel"]', { timeout: 5000 });
  await page.click('.workbench-tab[data-tool-button="git"]');
  await page.waitForFunction(() => document.querySelector('.workbench-tab.active')?.textContent?.includes('Git') === true);
  buttonInteractionEvidence.workbenchGitClickable = true;
  await page.click('.workbench-tab[data-tool-button="terminal"]');
  await page.waitForFunction(() => document.querySelector('.workbench-tab.active')?.textContent?.includes('终端') === true);
  buttonInteractionEvidence.workbenchTerminalClickable = true;
  await page.click('button[aria-label="关闭右侧工作台"]');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 5000 });
  buttonInteractionEvidence.workbenchCloseClickable = true;
  const collapsedChatLayoutAfterClose = await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="active-view"]')?.parentElement;
    const rail = document.querySelector('.rail-overlay');
    const composer = document.querySelector('.composer');
    const workbench = document.querySelector('[data-testid="workbench-panel"]');
    if (!(shell instanceof HTMLElement) || !(rail instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
      return {
        shellExists: shell !== null,
        railExists: rail !== null,
        composerExists: composer !== null,
        workbenchVisible: workbench !== null,
        shellClassName: shell instanceof HTMLElement ? shell.className : null,
        railGapToShellRight: null,
        composerWidthRatio: null
      };
    }
    const shellRect = shell.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      shellExists: true,
      railExists: true,
      composerExists: true,
      workbenchVisible: workbench !== null,
      shellClassName: shell.className,
      railGapToShellRight: Math.round(shellRect.right - railRect.right),
      composerWidthRatio: Number((composerRect.width / shellRect.width).toFixed(3))
    };
  });

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
    { name: 'skills', text: skillText },
    { name: 'settings', text: settingsText },
    { name: 'chat', text: chatResultText },
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
    settingsKeys: boundary.settingsKeys,
    mcpKeys: boundary.mcpKeys,
    skillKeys: boundary.skillKeys,
    taskKeys: boundary.taskKeys,
    lifecycleKeys: boundary.lifecycleKeys,
    diagnosticsKeys: boundary.diagnosticsKeys,
    agentKeys: boundary.agentKeys,
    terminalKeys: boundary.terminalKeys,
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
    diagnosticPackageVisible: diagnosticsText.includes('脱敏') && diagnosticsText.includes('task_snapshot'),
    performanceSampleVisible:
      diagnosticsText.includes('RSS') &&
      phase6ApiEvidence.sample.rssMb > 0 &&
      phase6ApiEvidence.sample.heapUsedMb > 0 &&
      typeof phase6ApiEvidence.sample.exceedsBudget === 'boolean',
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
      ((previewText.includes('phase-three-notes.txt') && previewText.includes('phase three smoke workspace')) ||
        (previewText.includes('assets/smoke-image.png') &&
          previewText.includes('图片预览已加载。') &&
          previewPageImageEvidence.exists &&
          previewPageImageEvidence.src.startsWith('data:image/png;base64,'))) &&
      filePreviewBeforeClick !== filePreviewAfterClick &&
      filePreviewAfterClick?.includes('changed in git') === true,
    workbenchDirectoryExpandable: directoryExpandEvidence,
    workbenchImagePreviewVisible:
      imagePreviewEvidence.exists &&
      imagePreviewEvidence.src.startsWith('data:image/png;base64,') &&
      imagePreviewEvidence.alt.includes('assets/smoke-image.png'),
    workbenchImagePreviewFrameless:
      !imagePreviewEvidence.boardExists &&
      imagePreviewEvidence.imageBorderTopWidth === '0px' &&
      imagePreviewEvidence.imageBorderRadius === '0px' &&
      imagePreviewEvidence.imageBoxShadow === 'none',
    workbenchPreviewModeRemoved: workbenchPreviewModeButtonCount === 0 && workbenchCodeModeButtonCount === 0,
    workbenchFileSplitterResizable: Math.abs(filePaneWidthAfter.width - filePaneWidthBefore.width) >= 40,
    explorerHeaderTrimmed: explorerHideButtonCountBefore === 0 && explorerRefreshButtonCountBefore === 0,
    chatWorkbenchLayoutVisible,
    workbenchResizable: Math.abs(workbenchWidthAfter.width - workbenchWidthBefore.width) >= 48,
    workbenchFilePreviewClickable:
      filePreviewBeforeClick !== filePreviewAfterClick &&
      filePreviewAfterClick.includes('changed in git'),
    workbenchPreviewLayoutCompact:
      filePreviewLayoutEvidence.headerExists &&
      filePreviewLayoutEvidence.bodyExists &&
      ((filePreviewLayoutEvidence.metaStripExists &&
        filePreviewLayoutEvidence.metaStripHeight !== null &&
        filePreviewLayoutEvidence.metaStripHeight <= 48 &&
        filePreviewLayoutEvidence.gapAfterHeader !== null &&
        filePreviewLayoutEvidence.gapAfterMetaStrip !== null &&
        filePreviewLayoutEvidence.gapAfterHeader <= 2 &&
        filePreviewLayoutEvidence.gapAfterMetaStrip <= 2) ||
        (!filePreviewLayoutEvidence.metaStripExists &&
          filePreviewLayoutEvidence.gapAfterHeader !== null &&
          filePreviewLayoutEvidence.gapAfterHeader <= 2)),
    workbenchPreviewNoLargeTrailingGap:
      filePreviewLayoutEvidence.previewExists &&
      !filePreviewLayoutEvidence.footerExists &&
      !filePreviewLayoutEvidence.footerText.includes('F:\\Code\\Roc') &&
      filePreviewLayoutEvidence.contentGapToBody !== null &&
      filePreviewLayoutEvidence.contentGapToBody <= 48,
    workbenchPreviewStatsRemoved:
      filePreviewStatsEvidence.contentHeaderText.length === 0 &&
      filePreviewStatsEvidence.metaStripText.length === 0 &&
      !filePreviewStatsEvidence.footerText.includes('条搜索命中') &&
      !/\d+\s*项/u.test(filePreviewStatsEvidence.footerText),
    workbenchGitControlsVisible:
      gitCommitButtonCount === 1 &&
      gitCommitMessageCount === 1 &&
      gitRefreshPrimaryCount === 1 &&
      gitBatchStageCount === 1 &&
      gitBranchSelectCount === 1 &&
      gitSplitCount === 1 &&
      gitSidebarCount === 1 &&
      gitDetailPaneCount === 1 &&
      gitChangeActionCount === 0,
    workbenchGitVisualHierarchy:
      gitHeaderEvidence.splitColumns.includes('12px') &&
      gitHeaderEvidence.splitColumns.includes('px'),
    workbenchGitDetailControls:
      workbenchGitSelectionActionCountBeforeStage === 0 &&
      workbenchGitSelectionActionCountAfterManual === 0 &&
      workbenchGitSelectionActionCountAfterStage === 0,
    workbenchGitSelection:
      workbenchGitSelectionText?.includes('phase-three-notes.txt') === true &&
      workbenchGitSelectionPath?.includes('phase-three-notes.txt') === true &&
      workbenchGitSelectionText?.includes('changed in git line') === true &&
      workbenchGitSelectionAfterStage?.includes('已暂存') === true &&
      gitDiffScrollEvidenceBefore.exists &&
      gitDiffScrollEvidenceAfter.exists &&
      typeof gitDiffScrollEvidenceBefore.clientHeight === 'number' &&
      typeof gitDiffScrollEvidenceBefore.scrollHeight === 'number' &&
      gitDiffScrollEvidenceBefore.scrollHeight > gitDiffScrollEvidenceBefore.clientHeight &&
      typeof gitDiffScrollEvidenceBefore.scrollTop === 'number' &&
      typeof gitDiffScrollEvidenceAfter.scrollTop === 'number' &&
      gitDiffScrollEvidenceAfter.scrollTop > gitDiffScrollEvidenceBefore.scrollTop &&
      gitDiffScrollEvidenceBefore.overflowX === 'auto' &&
      gitDiffScrollEvidenceBefore.overflowY === 'auto',
    workbenchGitDiffPathDeduped:
      !workbenchGitSelectionText?.includes('phase-three-notes.txt → phase-three-notes.txt') &&
      !gitDiffScrollEvidenceBefore.toolbarText.includes('phase-three-notes.txt → phase-three-notes.txt'),
    workbenchGitActions:
      workbenchGitText?.includes('phase-three-notes.txt') === true &&
      gitCommitInitialState !== null &&
      gitCommitInitialState.disabled === true &&
      gitCommitInitialState.value === '' &&
      !gitCommitInitialState.className.includes('git-commit-button--ready') &&
      workbenchGitAfterBatchStage?.includes('待提交变更2') === true &&
      workbenchGitAfterBatchStage?.includes('phase-three-notes.txt已暂存') === true &&
      workbenchGitAfterBatchStage?.includes('batch-stage.txt已暂存') === true &&
      workbenchGitAfterBatchStage?.includes('工作区变更0') === true &&
      workbenchGitSelectedCountAfterManual?.includes('2 selected') === true &&
      workbenchGitSelectedCountAfterAll?.includes('2 selected') === true &&
      gitCommitReadyState !== null &&
      gitCommitReadyState.disabled === false &&
      gitCommitReadyState.className.includes('git-commit-button--ready') &&
      gitCurrentBranchAfterCreate?.includes('feature/smoke-branch') === true &&
      initialGitBranch !== null &&
      gitCurrentBranchAfterCheckout?.includes(initialGitBranch.trim()) === true &&
      Array.isArray(confirmMessages) &&
      confirmMessages.some((message) => String(message).includes('feature/smoke-branch')) &&
      initialGitBranch !== null &&
      confirmMessages.some((message) => String(message).includes(initialGitBranch.trim())) &&
      gitLastCommitText?.includes('最近提交：smoke commit') === true &&
      gitCommitResetState !== null &&
      gitCommitResetState.disabled === true &&
      gitCommitResetState.value === '' &&
      !gitCommitResetState.className.includes('git-commit-button--ready') &&
      gitLastPushText?.includes('最近提交：smoke push commit') === true,
    terminalCommandRunnable:
      terminalLiveOutput?.includes('phase-three-notes.txt') === true &&
      terminalSecondOutput?.toLowerCase().includes(workspaceRoot.toLowerCase()) === true,
    terminalSessionPersistent:
      terminalLiveOutput?.includes('phase-three-notes.txt') === true &&
      terminalSecondOutput?.includes('phase-three-notes.txt') === true,
    terminalWorkbenchStyled:
      terminalWorkbenchStyleEvidence.frameVisible &&
      terminalWorkbenchStyleEvidence.borderRadius !== '0px' &&
      terminalWorkbenchStyleEvidence.xtermShellExists &&
      terminalWorkbenchStyleEvidence.shellFillRatio !== null &&
      terminalWorkbenchStyleEvidence.shellFillRatio >= 90,
    terminalWorkbenchHierarchy:
      terminalWorkbenchStyleEvidence.headerExists === false &&
      terminalWorkbenchStyleEvidence.badgeCount === 0 &&
      terminalWorkbenchStyleEvidence.scope.length === 0 &&
      terminalWorkbenchStyleEvidence.terminalSubtitle.length === 0 &&
      terminalWorkbenchStyleEvidence.footerSegments.length === 1 &&
      !terminalWorkbenchStyleEvidence.footerSegments.some((item) => item.includes('真实持续会话')) &&
      !terminalWorkbenchStyleEvidence.footerSegments.some((item) => item.includes('×')),
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
      providerSettingsEvidence.nvidiaListed &&
      providerSettingsEvidence.nvidiaFixedDetail &&
      providerSettingsEvidence.nvidiaDefaultModelChoicesVisible &&
      providerSettingsEvidence.llamaCppListed &&
      providerSettingsEvidence.llamaCppFixedDetail &&
      providerSettingsEvidence.llamaCppDefaultModelChoicesVisible &&
      providerSettingsEvidence.smokeProviderListed &&
      providerSettingsEvidence.addProviderEntryVisible &&
      providerSettingsEvidence.headerChromeRemoved &&
      providerSettingsEvidence.apiKeyHelpRemoved &&
      providerSettingsEvidence.createRequiresApiKey &&
      providerSettingsEvidence.editWithoutApiKeyAllowed &&
      providerSettingsEvidence.detailScrollReachable &&
      providerSettingsEvidence.searchMatchesNameAndId &&
      providerSettingsEvidence.openaiSlugGenerated &&
      providerSettingsEvidence.openaiCreated &&
      providerSettingsEvidence.openaiSecretStored &&
      providerSettingsEvidence.openaiApiKeyCleared &&
      providerSettingsEvidence.openaiSecretUpdated &&
      providerSettingsEvidence.openaiRotatedSecretUsed &&
      providerSettingsEvidence.anthropicSlugGenerated &&
      providerSettingsEvidence.anthropicCreated &&
      providerSettingsEvidence.anthropicSecretStored &&
      providerSettingsEvidence.anthropicSecretCleared &&
      providerSettingsEvidence.openaiReady &&
      providerSettingsEvidence.defaultModelSelectable &&
      providerSettingsEvidence.providerTestFeedbackVisible &&
      providerSettingsEvidence.saveAllDirect,
    mcpManagedVisible:
      mcpText.includes('Smoke MCP') &&
      mcpText.includes('smoke-mcp:ready') &&
      mcpText.includes('enabled'),
    skillManagedVisible:
      skillText.includes('Smoke Skill') &&
      skillText.includes('ready') &&
      (disabledSkillText ?? '').includes('disabled'),
    skillLayoutCompact:
      skillLayoutEvidence.exists &&
      skillLayoutEvidence.filterStripHeight !== null &&
      skillLayoutEvidence.filterStripHeight <= 72 &&
      skillLayoutEvidence.chipMaxHeight !== null &&
      skillLayoutEvidence.chipMaxHeight <= 56 &&
      skillLayoutEvidence.gapToRowList !== null &&
      skillLayoutEvidence.gapToRowList <= 64,
    providerActionsVisible: providerSettingsEvidence.providerActionsVisible,
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
    sidebarScrollableToSettings:
      sidebarScrollEvidenceBefore.sidebarExists &&
      sidebarScrollEvidenceBefore.controlBlockExists &&
      sidebarScrollEvidenceBefore.settingsExists &&
      sidebarScrollEvidenceBefore.probeApplied &&
      sidebarScrollEvidenceAfter.probeApplied &&
      typeof sidebarScrollEvidenceBefore.clientHeight === 'number' &&
      typeof sidebarScrollEvidenceBefore.scrollHeight === 'number' &&
      sidebarScrollEvidenceBefore.scrollHeight > sidebarScrollEvidenceBefore.clientHeight &&
      typeof sidebarScrollEvidenceBefore.scrollTop === 'number' &&
      typeof sidebarScrollEvidenceAfter.scrollTop === 'number' &&
      sidebarScrollEvidenceAfter.scrollTop > sidebarScrollEvidenceBefore.scrollTop &&
      sidebarScrollEvidenceAfter.settingsVisible,
    workspaceDialogApiExposed: boundary.workspaceKeys.includes('selectFromDialog'),
    chatCapabilitySelectionVisible:
      chatCapabilityEvidence.toolTriggerText.includes('1') &&
      chatCapabilityEvidence.skillTriggerText.includes('1') &&
      chatCapabilityEvidence.mcpActiveIds.includes('smoke-mcp') &&
      chatCapabilityEvidence.skillActiveIds.includes('smoke-skill'),
    chatCollapsedRailLayoutVisible:
      collapsedChatLayoutBeforeOpen.shellExists &&
      collapsedChatLayoutBeforeOpen.railExists &&
      collapsedChatLayoutBeforeOpen.composerExists &&
      collapsedChatLayoutBeforeOpen.workbenchVisible === false &&
      collapsedChatLayoutBeforeOpen.shellClassName?.includes('workspace-shell--chat-collapsed') === true &&
      typeof collapsedChatLayoutBeforeOpen.railGapToShellRight === 'number' &&
      collapsedChatLayoutBeforeOpen.railGapToShellRight <= 12 &&
      typeof collapsedChatLayoutBeforeOpen.composerWidthRatio === 'number' &&
      collapsedChatLayoutBeforeOpen.composerWidthRatio >= 0.42 &&
      collapsedChatLayoutAfterClose.shellExists &&
      collapsedChatLayoutAfterClose.railExists &&
      collapsedChatLayoutAfterClose.composerExists &&
      collapsedChatLayoutAfterClose.workbenchVisible === false &&
      collapsedChatLayoutAfterClose.shellClassName?.includes('workspace-shell--chat-collapsed') === true &&
      typeof collapsedChatLayoutAfterClose.railGapToShellRight === 'number' &&
      collapsedChatLayoutAfterClose.railGapToShellRight <= 12 &&
      typeof collapsedChatLayoutAfterClose.composerWidthRatio === 'number' &&
      collapsedChatLayoutAfterClose.composerWidthRatio >= 0.42,
    chatInputEditable:
      chatInputEvidence.exists &&
      chatInputEvidence.editable &&
      chatInputEvidence.transcriptMountedBeforeSubmit &&
      chatInputEvidence.visuallyFramed &&
      chatInputEvidence.sendButtonVisibleInViewport &&
      chatInputEvidence.bottomExplanationsAbsent &&
      (chatInputEvidence.inputSettledAtBottom ||
        (typeof chatInputEvidence.composerBottomGapToViewport === 'number' &&
          chatInputEvidence.composerBottomGapToViewport <= 10)) &&
      chatInputEvidence.value === submittedChatPrompt,
    agentCapabilityPreviewHidden: agentCapabilityPreviewHidden,
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
      chatResultText.includes(submittedChatPrompt) &&
      chatResultLayoutEvidence.resultAboveInput &&
      chatResultLayoutEvidence.userAlignedRight &&
      chatResultLayoutEvidence.assistantAlignedLeft &&
      chatResultLayoutEvidence.assistantBubbleUnframed &&
      chatResultLayoutEvidence.assistantContentAnchoredLeft &&
      chatResultLayoutEvidence.assistantBubbleFitsContent &&
      chatResultLayoutEvidence.assistantBubbleNarrowerThanRow &&
      typeof chatResultLayoutEvidence.assistantGapToComposer === 'number' &&
      chatResultLayoutEvidence.assistantGapToComposer >= 24,
    taskRunCapabilityStored:
      taskCapabilityEvidence.expectedInput === submittedChatPrompt &&
      taskCapabilityEvidence.threadGoal === submittedChatPrompt &&
      typeof taskCapabilityEvidence.userMessage === 'object' &&
      taskCapabilityEvidence.userMessage !== null &&
      taskCapabilityEvidence.userMessage.content === submittedChatPrompt &&
      Array.isArray(taskCapabilityEvidence.userMessage.enabledCapabilities?.mcpServers) &&
      Array.isArray(taskCapabilityEvidence.userMessage.enabledCapabilities?.skills) &&
      taskCapabilityEvidence.userMessage.enabledCapabilities.mcpServers.includes('smoke-mcp') &&
      taskCapabilityEvidence.userMessage.enabledCapabilities.skills.includes('smoke-skill'),
    taskAssistantEventStored:
      typeof taskCapabilityEvidence.assistantMessage === 'object' &&
      taskCapabilityEvidence.assistantMessage !== null &&
      typeof taskCapabilityEvidence.assistantMessage.content === 'string' &&
      taskCapabilityEvidence.assistantMessage.content.includes('Smoke Provider 已生成首轮回复。') &&
      taskCapabilityEvidence.assistantMessage.providerId === 'smoke-ui-openai' &&
      taskCapabilityEvidence.assistantMessage.modelId === 'smoke-ui-openai-model',
    taskProviderUpdateStored:
      typeof taskCapabilityEvidence.providerUpdate === 'object' &&
      taskCapabilityEvidence.providerUpdate !== null &&
      taskCapabilityEvidence.providerUpdate.providerId === 'smoke-ui-openai' &&
      taskCapabilityEvidence.providerUpdate.modelId === 'smoke-ui-openai-model' &&
      taskCapabilityEvidence.providerUpdate.finishReason === 'stop',
    taskManifestStored:
      typeof taskCapabilityEvidence.manifest === 'object' &&
      taskCapabilityEvidence.manifest !== null &&
      taskCapabilityEvidence.manifest.resolvedCapabilities.mcpServers.includes('smoke-mcp') &&
      taskCapabilityEvidence.manifest.resolvedCapabilities.skills.includes('smoke-skill') &&
      taskCapabilityEvidence.manifest.toolCards.some((card) => card.id === 'mcp:smoke-mcp:smoke_tool') &&
      taskCapabilityEvidence.manifest.untrustedContextPolicy === 'external_content_reference_only',
    skillLoadedEventStored:
      taskCapabilityEvidence.skillLoaded === null ||
      (typeof taskCapabilityEvidence.skillLoaded === 'object' &&
        taskCapabilityEvidence.skillLoaded !== null &&
        taskCapabilityEvidence.skillLoaded.skillId === 'smoke-skill' &&
        taskCapabilityEvidence.skillLoaded.enabledBy === 'turn_selection'),
    historySidebarShowsRealThreads:
      historySidebarEvidence.exists &&
      historySidebarEvidence.hasExpectedThreadTitle &&
      !historySidebarEvidence.hasCurrentSessionLabel &&
      !historySidebarEvidence.hasQuickEntryLabel &&
      !historySidebarEvidence.hasTrayEntryLabel &&
      !historySidebarEvidence.hasMemoryRecordLabel &&
      !historySidebarEvidence.hasTaskRecordLabel,
    memoryApiExpanded:
      boundary.memoryKeys.includes('listCandidates') &&
      boundary.memoryKeys.includes('listConflicts') &&
      boundary.memoryKeys.includes('sessionSearch') &&
      boundary.memoryKeys.includes('delete') &&
      boundary.memoryKeys.includes('restore'),
    settingsApiExpanded:
      boundary.settingsKeys.includes('get') &&
      boundary.settingsKeys.includes('save') &&
      boundary.settingsKeys.includes('testProvider'),
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
    toolPopoverHoverSticky: buttonInteractionEvidence.toolPopoverHoverSticky,
    skillPopoverHoverSticky: buttonInteractionEvidence.skillPopoverHoverSticky,
    modelPopoverHoverSticky: buttonInteractionEvidence.modelPopoverHoverSticky,
    appShellFlushToWindow:
      appShellFrameEvidence.exists &&
      appShellFrameEvidence.gapTop !== null &&
      appShellFrameEvidence.gapRight !== null &&
      appShellFrameEvidence.gapBottom !== null &&
      appShellFrameEvidence.gapLeft !== null &&
      appShellFrameEvidence.gapTop <= 1 &&
      appShellFrameEvidence.gapRight <= 1 &&
      appShellFrameEvidence.gapBottom <= 1 &&
      appShellFrameEvidence.gapLeft <= 1,
    windowDragWorks: windowDragEvidence.moved,
    clickableButtonsHandled: Object.values(buttonInteractionEvidence).every(Boolean)
  };

  const failedChecks = Object.entries({
    hasRequire: !rendererBoundary.hasRequire,
    hasProcess: !rendererBoundary.hasProcess,
    immersiveWorkbandVisible: rendererBoundary.immersiveWorkbandVisible,
    systemMenuHidden: rendererBoundary.systemMenuHidden,
    initialWindowNotMaximized: rendererBoundary.initialWindowNotMaximized,
    appShellFlushToWindow: rendererBoundary.appShellFlushToWindow,
    windowDragWorks: rendererBoundary.windowDragWorks,
    mockTextAbsent: rendererBoundary.mockTextAbsent,
    historySidebarShowsRealThreads: rendererBoundary.historySidebarShowsRealThreads,
    backgroundTaskVisible: rendererBoundary.backgroundTaskVisible,
    traySummaryVisible: rendererBoundary.traySummaryVisible,
    diagnosticPackageVisible: rendererBoundary.diagnosticPackageVisible,
    performanceSampleVisible: rendererBoundary.performanceSampleVisible,
    workspaceFileVisible: rendererBoundary.workspaceFileVisible,
    workspaceSearchVisible: rendererBoundary.workspaceSearchVisible,
    gitChangesVisible: rendererBoundary.gitChangesVisible,
    terminalOutputVisible: rendererBoundary.terminalOutputVisible,
    previewFileVisible: rendererBoundary.previewFileVisible,
    workbenchDirectoryExpandable: rendererBoundary.workbenchDirectoryExpandable,
    workbenchImagePreviewVisible: rendererBoundary.workbenchImagePreviewVisible,
    workbenchImagePreviewFrameless: rendererBoundary.workbenchImagePreviewFrameless,
    workbenchPreviewModeRemoved: rendererBoundary.workbenchPreviewModeRemoved,
    explorerHeaderTrimmed: rendererBoundary.explorerHeaderTrimmed,
    chatWorkbenchLayoutVisible: rendererBoundary.chatWorkbenchLayoutVisible,
    workbenchResizable: rendererBoundary.workbenchResizable,
    workbenchFilePreviewClickable: rendererBoundary.workbenchFilePreviewClickable,
    workbenchPreviewLayoutCompact: rendererBoundary.workbenchPreviewLayoutCompact,
    workbenchPreviewNoLargeTrailingGap: rendererBoundary.workbenchPreviewNoLargeTrailingGap,
    workbenchPreviewStatsRemoved: rendererBoundary.workbenchPreviewStatsRemoved,
    workbenchFileSplitterResizable: rendererBoundary.workbenchFileSplitterResizable,
    workbenchGitControlsVisible: rendererBoundary.workbenchGitControlsVisible,
    workbenchGitVisualHierarchy: rendererBoundary.workbenchGitVisualHierarchy,
    workbenchGitDiffPathDeduped: rendererBoundary.workbenchGitDiffPathDeduped,
    workbenchGitActions: rendererBoundary.workbenchGitActions,
    terminalCommandRunnable: rendererBoundary.terminalCommandRunnable,
    terminalSessionPersistent: rendererBoundary.terminalSessionPersistent,
    terminalWorkbenchStyled: rendererBoundary.terminalWorkbenchStyled,
    terminalWorkbenchHierarchy: rendererBoundary.terminalWorkbenchHierarchy,
    rtkMissingVisible: rendererBoundary.rtkMissingVisible,
    memoryCandidateVisible: rendererBoundary.memoryCandidateVisible,
    memoryConflictVisible: rendererBoundary.memoryConflictVisible,
    memoryRecallVisible: rendererBoundary.memoryRecallVisible,
    sessionRecallVisible: rendererBoundary.sessionRecallVisible,
    memoryRecoveryVisible: rendererBoundary.memoryRecoveryVisible,
    providerConfiguredVisible: rendererBoundary.providerConfiguredVisible,
    mcpManagedVisible: rendererBoundary.mcpManagedVisible,
    skillManagedVisible: rendererBoundary.skillManagedVisible,
    skillLayoutCompact: rendererBoundary.skillLayoutCompact,
    providerActionsVisible: rendererBoundary.providerActionsVisible,
    capabilityActionsVisible: rendererBoundary.capabilityActionsVisible,
    quickEntryVisible: rendererBoundary.quickEntryVisible,
    quickEntryButtonsClickable: rendererBoundary.quickEntryButtonsClickable,
    trayEntryVisible: rendererBoundary.trayEntryVisible,
    trayEntryButtonsClickable: rendererBoundary.trayEntryButtonsClickable,
    appEntryApiExpanded: rendererBoundary.appEntryApiExpanded,
    workspaceSelectButtonVisible: rendererBoundary.workspaceSelectButtonVisible,
    sidebarScrollableToSettings: rendererBoundary.sidebarScrollableToSettings,
    workspaceDialogApiExposed: rendererBoundary.workspaceDialogApiExposed,
    chatCapabilitySelectionVisible: rendererBoundary.chatCapabilitySelectionVisible,
    chatCollapsedRailLayoutVisible: rendererBoundary.chatCollapsedRailLayoutVisible,
    chatInputEditable: rendererBoundary.chatInputEditable,
    agentCapabilityPreviewHidden: rendererBoundary.agentCapabilityPreviewHidden,
    agentCapabilityPreviewApi: rendererBoundary.agentCapabilityPreviewApi,
    providerChatResultVisible: rendererBoundary.providerChatResultVisible,
    taskRunCapabilityStored: rendererBoundary.taskRunCapabilityStored,
    taskAssistantEventStored: rendererBoundary.taskAssistantEventStored,
    taskProviderUpdateStored: rendererBoundary.taskProviderUpdateStored,
    taskManifestStored: rendererBoundary.taskManifestStored,
    skillLoadedEventStored: rendererBoundary.skillLoadedEventStored,
    memoryApiExpanded: rendererBoundary.memoryApiExpanded,
    settingsApiExpanded: rendererBoundary.settingsApiExpanded,
    mcpApiExpanded: rendererBoundary.mcpApiExpanded,
    skillsApiExpanded: rendererBoundary.skillsApiExpanded,
    agentApiExpanded: rendererBoundary.agentApiExpanded,
    taskApiExpanded: rendererBoundary.taskApiExpanded,
    lifecycleApiExpanded: rendererBoundary.lifecycleApiExpanded,
    diagnosticsApiExpanded: rendererBoundary.diagnosticsApiExpanded,
    toolPopoverHoverSticky: rendererBoundary.toolPopoverHoverSticky,
    skillPopoverHoverSticky: rendererBoundary.skillPopoverHoverSticky,
    modelPopoverHoverSticky: rendererBoundary.modelPopoverHoverSticky,
    terminalApiExpanded:
      rendererBoundary.terminalKeys.includes('createSession') &&
      rendererBoundary.terminalKeys.includes('writeInput') &&
      rendererBoundary.terminalKeys.includes('resize') &&
      rendererBoundary.terminalKeys.includes('closeSession') &&
      rendererBoundary.terminalKeys.includes('onOutput') &&
      rendererBoundary.terminalKeys.includes('onExit'),
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
      historySidebarEvidence,
      memoryRecoveryText,
      memoryRecoveryApiEvidence,
      terminalText,
      terminalLiveOutput,
      terminalWorkbenchStyleEvidence,
      gitText,
      filePreviewLayoutEvidence,
      filePreviewStatsEvidence,
      workbenchGitText,
      workbenchGitAfterBatchStage,
      gitDiffScrollEvidenceBefore,
      gitDiffScrollEvidenceAfter,
      workbenchWidthBefore,
      workbenchWidthAfter,
      collapsedChatLayoutBeforeOpen,
      collapsedChatLayoutAfterClose,
      chatResultLayoutEvidence,
      skillLayoutEvidence,
      providerSettingsEvidence,
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
  await rm(remoteRoot, { recursive: true, force: true });
  await rm(skillSourceRoot, { recursive: true, force: true });
}
