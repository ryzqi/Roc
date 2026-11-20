import { _electron as electron } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createSmokePaths,
  seedSmokeWorkspace,
  startSmokeProvider
} from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';
import { createGateRecorder, finishGate, navigate, prepareArtifactDir } from './lib/gate-harness.mjs';

// Real Electron, IPC and local scripted provider. No live provider or user data.
const artifactDir = prepareArtifactDir(resolve('.artifacts/pr08-diagnostics'));
const {results, assertCheck} = createGateRecorder();
const paths = await createSmokePaths();
seedSmokeWorkspace(paths.workspaceRoot, paths.remoteRoot);
const provider = await startSmokeProvider();
const target = resolveSmokeTarget({env: {...process.env, ROC_SMOKE_TARGET: 'dist'}});
const rendererErrors = [];
const audits = [];
let runtimeVersions;
let app, page;
let runId, threadId;

async function audit(name) {
  const source = readFileSync('.agents/skills/desktop-agent-ui/scripts/clip-audit.js', 'utf8');
  const result = await page.evaluate(`(${source})({root:'[data-testid="assistant-diagnostics"]',viewport:true})`);
  audits.push({name, ...result});
  assertCheck('layout', `No clipped diagnostics shadows: ${name}`, result.cut === 0, result);
}

async function selectTheme(theme) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await page.evaluate(() => document.documentElement.dataset.theme) === theme) return;
    await page.getByTestId('sidebar-theme-toggle').click();
  }
  throw new Error(`Unable to select ${theme} theme`);
}

async function assertLayout(name) {
  const layout = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="assistant-panel"]');
    const region = document.querySelector('[data-testid="assistant-diagnostics-region"]');
    const input = document.querySelector('[data-testid="assistant-composer-input"]');
    const panelBounds = panel?.getBoundingClientRect();
    const regionBounds = region?.getBoundingClientRect();
    const inputBounds = input?.getBoundingClientRect();
    return {
      panelWidth: panelBounds?.width,
      regionWidth: regionBounds?.width,
      regionHeight: regionBounds?.height,
      scrollHeight: region?.scrollHeight,
      scrollWidth: region?.scrollWidth,
      clientWidth: region?.clientWidth,
      inputTop: inputBounds?.top,
      inputBottom: inputBounds?.bottom,
      regionBottom: regionBounds?.bottom,
      viewportHeight: window.innerHeight
    };
  });
  assertCheck('layout', `Diagnostics preserves composer and horizontal bounds: ${name}`,
    layout.regionWidth > 0 && layout.regionWidth < layout.panelWidth &&
    layout.scrollWidth <= layout.clientWidth + 1 && layout.regionBottom <= layout.inputTop &&
    layout.inputBottom <= layout.viewportHeight, layout);
}

try {
  app = await electron.launch({
    executablePath: target.executablePath,
    args: target.launchArgs,
    env: {...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: paths.dataRoot, ROC_SMOKE_API_KEY: 'diagnostics-fixture-key'}
  });
  page = await app.firstWindow();
  runtimeVersions = await app.evaluate(() => ({electron: process.versions.electron, chrome: process.versions.chrome}));
  await page.emulateMedia({reducedMotion: 'reduce'});
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') rendererErrors.push(message.text()); });
  await page.getByTestId('roc-app').waitFor({timeout: 30_000});
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  const setup = await page.evaluate(async ({endpoint, workspacePath}) => {
    const snapshot = await window.roc.settings.get();
    if (!snapshot.ok) return {error: snapshot.error.message};
    const providerId = 'pr08-fixture-provider';
    const modelId = 'pr08-fixture-model';
    const saved = await window.roc.settings.save({
      settings: snapshot.data.settings,
      providers: [{
        id: providerId, name: 'PR08 Fixture', type: 'openai_compatible', endpoint,
        credentialRef: `secret:${providerId}`, enabled: true,
        models: [{id: modelId, displayName: 'PR08 Fixture', enabled: true, supportsStreaming: true,
          supportsToolCalls: true, supportsImages: false}]
      }],
      defaultModelId: `${providerId}:${modelId}`,
      permissions: snapshot.data.permissions
    });
    if (!saved.ok) return {error: saved.error.message};
    const secret = await window.roc.settings.setProviderSecret({providerId, plaintext: 'diagnostics-fixture-key'});
    if (!secret.ok) return {error: secret.error.message};
    const project = await window.roc.research.createProject({
      title: 'PR08 diagnostics fixture', description: 'Local run diagnostics UI gate.', workspacePath
    });
    return project.ok ? {projectId: project.data.id} : {error: project.error.message};
  }, {endpoint: provider.endpoint, workspacePath: paths.workspaceRoot});
  assertCheck('runtime', 'Local fixture provider and isolated project configured', !setup.error, setup.error ?? '');
  await navigate(page, `page=research&project=${setup.projectId}&view=latex&assistant=1`);
  await page.getByTestId('assistant-composer-input').waitFor({timeout: 30_000});
  assertCheck('runtime', 'No diagnostics action before a run exists',
    await page.getByTestId('assistant-diagnostics-toggle').count() === 0);
  await page.getByTestId('assistant-composer-input').fill(
    'PR08 diagnostics fixture. ROC-P4-RUN:pr08-diagnostics ROC-P4-MODE:slow ROC-P4-SLOW:80x40 ROC-P4-SLOW-TAG:PR08'
  );
  await page.getByTestId('assistant-composer-send').click();
  await page.locator('[data-testid="assistant-run-status"][data-status="running"]').waitFor({timeout: 30_000});
  const active = await page.evaluate(async () => {
    const threads = await window.roc.tasks.getSnapshot();
    if (!threads.ok) return {error: threads.error.message};
    for (const thread of threads.data.threads.filter(item => item.kind === 'chat')) {
      const result = await window.roc.chat.getActiveRun({threadId: thread.id});
      if (result.ok && result.data !== null) return {runId: result.data.runId, threadId: thread.id};
    }
    return {error: 'No active fixture run'};
  });
  assertCheck('runtime', 'Run identity comes from active-run IPC', !active.error, active.error ?? '');
  ({runId, threadId} = active);
  const toggle = page.getByTestId('assistant-diagnostics-toggle');
  await toggle.waitFor();
  await audit('collapsed');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('assistant-diagnostics-data').waitFor({timeout: 20_000});
  assertCheck('keyboard', 'Enter opens diagnostics disclosure', await toggle.getAttribute('aria-expanded') === 'true');
  await page.locator('[data-testid="assistant-run-status"][data-status="completed"]').waitFor({timeout: 30_000});
  await page.waitForFunction(() => document.querySelector('[data-testid="assistant-diagnostics-region"]')?.getAttribute('aria-busy') === 'false');
  const response = await page.evaluate(async ({runId, threadId}) =>
    await window.roc.agent.getRunDiagnostics({runId, threadId}), {runId, threadId});
  assertCheck('runtime', 'Completed run exposes correlated local model span',
    response.ok && response.data?.terminalStatus === 'completed' &&
    response.data.trace.spans.some(span => span.operation === 'agent_model' && span.status === 'completed'),
    response.ok ? {terminalStatus: response.data?.terminalStatus, spanCount: response.data?.trace.spans.length} : response.error.message);
  const mismatch = await page.evaluate(async ({runId}) =>
    await window.roc.agent.getRunDiagnostics({runId, threadId: 'wrong-thread'}), {runId});
  assertCheck('runtime', 'Diagnostics rejects wrong thread identity', !mismatch.ok);
  const dataText = await page.getByTestId('assistant-diagnostics-data').innerText();
  assertCheck('runtime', 'UI renders known-subtotal model usage and unknown-call count', dataText.includes('已知输入 / 输出 tokens') &&
    dataText.includes('usage 未知调用') &&
    dataText.includes('pr08-fixture-provider'));
  await selectTheme('light');
  await audit('expanded-light');
  await assertLayout('desktop-light');
  await page.screenshot({path: join(artifactDir, 'desktop-light.png')});
  await selectTheme('dark');
  await page.getByTestId('assistant-diagnostics-refresh').hover();
  await audit('expanded-hover-dark');
  await assertLayout('desktop-dark');
  await page.screenshot({path: join(artifactDir, 'desktop-dark.png')});
  await page.getByTestId('assistant-diagnostics-spans').locator('summary').focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="assistant-diagnostics-spans"][open] li').last().waitFor();
  await assertLayout('expanded-trace');
  await page.getByTestId('assistant-diagnostics-region').hover();
  await page.mouse.wheel(0, 1000);
  await page.waitForFunction(() => {
    const region = document.querySelector('[data-testid="assistant-diagnostics-region"]');
    return region !== null && region.scrollTop >= region.scrollHeight - region.clientHeight - 2;
  });
  assertCheck('keyboard', 'Expanded trace scrolls to its final span',
    await page.getByTestId('assistant-diagnostics-spans').locator('li').count() === response.data.trace.spans.length);
  await page.screenshot({path: join(artifactDir, 'desktop-trace.png')});
  await app.evaluate(({BrowserWindow}) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setMinimumSize(800, 600);
    window?.setSize(980, 800);
  });
  await page.waitForFunction(() => window.innerWidth <= 1099);
  await page.getByTestId('assistant-drawer').waitFor();
  assertCheck('layout', 'Narrow window actually enters assistant drawer',
    await page.getByTestId('assistant-column').count() === 0 && await page.evaluate(() => window.innerWidth) <= 1099);
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByTestId('assistant-diagnostics-region').waitFor();
  await page.getByTestId('assistant-diagnostics-data').waitFor();
  await assertLayout('drawer');
  await audit('drawer');
  await page.screenshot({path: join(artifactDir, 'drawer.png')});
  await toggle.focus();
  await page.keyboard.press('Enter');
  assertCheck('keyboard', 'Enter closes diagnostics and preserves focus',
    await page.getByTestId('assistant-diagnostics-region').count() === 0 &&
    await page.evaluate(() => document.activeElement?.dataset.testid) === 'assistant-diagnostics-toggle');
  assertCheck('runtime', 'No renderer errors', rendererErrors.length === 0, rendererErrors);
  finishGate({label: 'PR08 Diagnostics', artifactDir, results, rendererErrors,
    extra: {audits, providerRequests: provider.requests.length, liveProviderCalls: 0,
      environment: {platform: process.platform, arch: process.arch, release: release(), ...runtimeVersions}},
    expectedGates: ['runtime', 'keyboard', 'layout']});
} catch (error) {
  finishGate({label: 'PR08 Diagnostics', artifactDir, results, rendererErrors, error,
    extra: {audits, providerRequests: provider.requests.length, liveProviderCalls: 0,
      environment: {platform: process.platform, arch: process.arch, release: release(), ...runtimeVersions}}});
} finally {
  await app?.close();
  await provider.close();
  for (const path of Object.values(paths)) rmSync(path, {recursive: true, force: true});
}
