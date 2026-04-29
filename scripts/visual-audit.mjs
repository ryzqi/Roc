#!/usr/bin/env node

import { _electron as electron, chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const artifactDir = resolve('.artifacts/visual-audit');
const previewDir = join(artifactDir, 'preview');
const appDir = join(artifactDir, 'app');
const diffDir = join(artifactDir, 'diff');
mkdirSync(previewDir, { recursive: true });
mkdirSync(appDir, { recursive: true });
mkdirSync(diffDir, { recursive: true });

const previewSource = resolve('页面预览效果图/roc-system-pages.html');
const previewUrl = `file:///${previewSource.replace(/\\/g, '/')}`;
const packagedExe = resolve('release/win-unpacked/Roc Windows Super Assistant.exe');
const auditTarget = process.env.ROC_VISUAL_AUDIT_TARGET === 'packaged' ? 'packaged' : 'dist';
const previewEngine = process.env.ROC_VISUAL_AUDIT_PREVIEW_ENGINE === 'electron' ? 'electron' : 'browser';
const pixelThreshold = parseIntegerEnv('ROC_VISUAL_AUDIT_PIXEL_THRESHOLD', 16);
const maxDiffRatio = parseFloatEnv('ROC_VISUAL_AUDIT_MAX_DIFF_RATIO', 0);
const perceptualPixelThreshold = parseIntegerEnv('ROC_VISUAL_AUDIT_PERCEPTUAL_PIXEL_THRESHOLD', 24);
const maxPerceptualDiffRatio = parseFloatEnv('ROC_VISUAL_AUDIT_MAX_PERCEPTUAL_DIFF_RATIO', 0.06);
const perceptualScale = normalizePerceptualScale(parseFloatEnv('ROC_VISUAL_AUDIT_PERCEPTUAL_SCALE', 0.125));
const edgeExecutablePathCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const edgeExecutablePath = edgeExecutablePathCandidates.find((candidate) => existsSync(candidate));
const smokeTarget =
  auditTarget === 'packaged' && existsSync(packagedExe)
    ? {
      kind: 'packaged-exe',
      path: packagedExe,
      executablePath: packagedExe,
      launchArgs: []
    }
    : {
      kind: 'dist-main-fallback',
      path: resolve('dist/main/index.js'),
      executablePath: undefined,
      launchArgs: [resolve('dist/main/index.js')]
    };

const pageSpecs = [
  { id: 'chat', mode: 'main', tool: null, previewComposer: true, appComposer: true, workbench: false, floating: false },
  { id: 'tasks', mode: 'main', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: false },
  { id: 'workspace', mode: 'main', tool: 'files', previewComposer: false, appComposer: false, workbench: true, floating: false },
  { id: 'git', mode: 'main', tool: 'git', previewComposer: false, appComposer: false, workbench: true, floating: false },
  { id: 'terminal', mode: 'main', tool: 'terminal', previewComposer: false, appComposer: false, workbench: true, floating: false },
  { id: 'preview', mode: 'main', tool: 'files', previewComposer: false, appComposer: false, workbench: true, floating: false },
  { id: 'mcp', mode: 'main', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: false },
  { id: 'skills', mode: 'main', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: false },
  { id: 'memory', mode: 'main', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: false },
  { id: 'settings', mode: 'main', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: false },
  { id: 'doctor', mode: 'main', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: false },
  { id: 'diagnostics', mode: 'main', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: false },
  { id: 'quick', mode: 'floating', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: true },
  { id: 'tray', mode: 'floating', tool: null, previewComposer: false, appComposer: false, workbench: false, floating: true }
];
const WORKBENCH_PAGE_IDS = new Set(['workspace', 'git', 'terminal', 'preview']);
const rendererReadyTimeoutMs = 45000;

function parseIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseFloatEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizePerceptualScale(value) {
  return value > 0 && value <= 1 ? value : 0.125;
}

function previewPageUrl(spec) {
  const url = new URL(previewUrl);
  url.searchParams.set('page', spec.id);
  if (spec.tool !== null) {
    url.searchParams.set('tool', spec.tool);
  }
  return url.toString();
}

function readVisible(page, selector) {
  return page.locator(selector).isVisible().catch(() => false);
}

function readCount(page, selector) {
  return page.locator(selector).count().catch(() => 0);
}

function previewCaptureSelector(spec) {
  if (spec.mode === 'floating') {
    return spec.id === 'quick' ? '.mini-window' : '.tray-pop';
  }
  return '.shell';
}

function appCaptureSelector(spec) {
  if (spec.mode === 'floating') {
    return spec.id === 'quick' ? '[data-testid="quick-entry-visual"]' : '[data-testid="tray-entry-visual"]';
  }
  return '[data-testid="roc-app"]';
}

async function captureElementScreenshot(page, selector, screenshotPath) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.screenshot({ path: screenshotPath, scale: 'css' });
  const box = await locator.boundingBox();
  return {
    selector,
    bounds:
      box === null
        ? null
        : {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height)
          }
  };
}

function readPngAsDataUrl(path) {
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}

function writePngDataUrl(path, dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new Error(`Unsupported diff image payload for ${path}`);
  }
  writeFileSync(path, Buffer.from(dataUrl.slice(prefix.length), 'base64'));
}

async function compareScreenshots(diffPage, previewScreenshotPath, appScreenshotPath, targetDimensions) {
  const comparison = await diffPage.evaluate(
    async ({
      appDataUrl,
      perceptualPixelThreshold: perceptualThreshold,
      perceptualScale: scale,
      pixelThreshold: threshold,
      previewDataUrl,
      targetHeight,
      targetWidth
    }) => {
      function loadImage(src) {
        return new Promise((resolvePromise, rejectPromise) => {
          const image = new Image();
          image.onload = () => resolvePromise(image);
          image.onerror = () => rejectPromise(new Error(`Failed to load image: ${src.slice(0, 64)}`));
          image.src = src;
        });
      }

      function drawImageData(image, width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (context === null) {
          throw new Error('Could not create diff canvas context.');
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, width, height);
        return context.getImageData(0, 0, width, height);
      }

      function compareImageData(previewImageData, appImageData, activeThreshold, emitDiffImage) {
        const width = previewImageData.width;
        const height = previewImageData.height;
        const totalPixels = width * height;
        let differingPixels = 0;
        let diffCanvas = null;
        let diffContext = null;
        let diffImageData = null;

        if (emitDiffImage) {
          diffCanvas = document.createElement('canvas');
          diffCanvas.width = width;
          diffCanvas.height = height;
          diffContext = diffCanvas.getContext('2d');
          if (diffContext === null) {
            throw new Error('Could not create diff output context.');
          }
          diffImageData = diffContext.createImageData(width, height);
        }

        for (let index = 0; index < previewImageData.data.length; index += 4) {
          const previewRed = previewImageData.data[index];
          const previewGreen = previewImageData.data[index + 1];
          const previewBlue = previewImageData.data[index + 2];
          const previewAlpha = previewImageData.data[index + 3];
          const appRed = appImageData.data[index];
          const appGreen = appImageData.data[index + 1];
          const appBlue = appImageData.data[index + 2];
          const appAlpha = appImageData.data[index + 3];
          const maxChannelDelta = Math.max(
            Math.abs(previewRed - appRed),
            Math.abs(previewGreen - appGreen),
            Math.abs(previewBlue - appBlue),
            Math.abs(previewAlpha - appAlpha)
          );
          const isDifferent = maxChannelDelta > activeThreshold;

          if (isDifferent) {
            differingPixels += 1;
          }

          if (diffImageData === null) {
            continue;
          }

          if (isDifferent) {
            diffImageData.data[index] = 217;
            diffImageData.data[index + 1] = 72;
            diffImageData.data[index + 2] = 72;
            diffImageData.data[index + 3] = 255;
            continue;
          }

          diffImageData.data[index] = Math.round((previewRed + appRed) / 2);
          diffImageData.data[index + 1] = Math.round((previewGreen + appGreen) / 2);
          diffImageData.data[index + 2] = Math.round((previewBlue + appBlue) / 2);
          diffImageData.data[index + 3] = 255;
        }

        if (diffContext !== null && diffImageData !== null) {
          diffContext.putImageData(diffImageData, 0, 0);
        }

        return {
          totalPixels,
          differingPixels,
          differenceRatio: totalPixels === 0 ? 0 : differingPixels / totalPixels,
          diffDataUrl: diffCanvas === null ? null : diffCanvas.toDataURL('image/png')
        };
      }

      const [previewImage, appImage] = await Promise.all([loadImage(previewDataUrl), loadImage(appDataUrl)]);
      const width = targetWidth;
      const height = targetHeight;
      const previewImageData = drawImageData(previewImage, width, height);
      const appImageData = drawImageData(appImage, width, height);
      const rawDiff = compareImageData(previewImageData, appImageData, threshold, true);
      const perceptualWidth = Math.max(1, Math.round(width * scale));
      const perceptualHeight = Math.max(1, Math.round(height * scale));
      const perceptualPreviewImageData = drawImageData(previewImage, perceptualWidth, perceptualHeight);
      const perceptualAppImageData = drawImageData(appImage, perceptualWidth, perceptualHeight);
      const perceptualDiff = compareImageData(
        perceptualPreviewImageData,
        perceptualAppImageData,
        perceptualThreshold,
        false
      );
      return {
        previewDimensions: {
          width: previewImage.width,
          height: previewImage.height
        },
        appDimensions: {
          width: appImage.width,
          height: appImage.height
        },
        diffDimensions: {
          width,
          height
        },
        totalPixels: rawDiff.totalPixels,
        differingPixels: rawDiff.differingPixels,
        differenceRatio: rawDiff.differenceRatio,
        perceptualDimensions: {
          width: perceptualWidth,
          height: perceptualHeight
        },
        perceptualTotalPixels: perceptualDiff.totalPixels,
        perceptualDifferingPixels: perceptualDiff.differingPixels,
        perceptualDifferenceRatio: perceptualDiff.differenceRatio,
        diffDataUrl: rawDiff.diffDataUrl
      };
    },
    {
      previewDataUrl: readPngAsDataUrl(previewScreenshotPath),
      appDataUrl: readPngAsDataUrl(appScreenshotPath),
      pixelThreshold,
      perceptualPixelThreshold,
      perceptualScale,
      targetWidth: targetDimensions.width,
      targetHeight: targetDimensions.height
    }
  );

  return comparison;
}

function previewViewportFor(spec, referenceBounds) {
  if (spec.mode === 'floating') {
    return {
      width: referenceBounds.width + 48,
      height: referenceBounds.height + 48
    };
  }
  return {
    width: referenceBounds.width + 22,
    height: referenceBounds.height + 22
  };
}

function previewWindowSizeForElectron(spec, referenceBounds) {
  if (spec.mode === 'floating') {
    return {
      width: referenceBounds.width + 48,
      height: referenceBounds.height + 48
    };
  }
  return {
    width: referenceBounds.width + 22,
    height: referenceBounds.height + 22
  };
}

async function capturePreview(previewPage, spec, referenceBounds) {
  await previewPage.setViewportSize(previewViewportFor(spec, referenceBounds));
  await previewPage.goto(previewPageUrl(spec));
  await previewPage.waitForLoadState('domcontentloaded');
  await previewPage.waitForTimeout(100);
  const screenshotPath = join(previewDir, `${spec.id}.png`);
  const capture = await captureElementScreenshot(previewPage, previewCaptureSelector(spec), screenshotPath);
  return {
    page: spec.id,
    mode: spec.mode,
    screenshotPath,
    captureSelector: capture.selector,
    captureBounds: capture.bounds,
    rootVisible: await readVisible(previewPage, capture.selector),
    composerVisible: await readVisible(previewPage, '.composer'),
    workbenchVisible: await readCount(previewPage, '.workbench') > 0,
    floatingVisible: await readCount(previewPage, '.floating-stage') > 0
  };
}

async function openPreviewWindow(app, spec, referenceBounds) {
  const viewport = previewWindowSizeForElectron(spec, referenceBounds);
  const waiter = app.waitForEvent('window');
  await app.evaluate(
    async ({ BrowserWindow }, args) => {
      const previewWindow = new BrowserWindow({
        show: false,
        width: args.viewport.width,
        height: args.viewport.height,
        useContentSize: true,
        frame: false,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          sandbox: false,
          contextIsolation: true
        }
      });
      previewWindow.setMenuBarVisibility(false);
      await previewWindow.loadURL(args.url);
    },
    {
      url: previewPageUrl(spec),
      viewport
    }
  );
  const previewWindow = await waiter;
  await previewWindow.waitForLoadState('domcontentloaded');
  return previewWindow;
}

async function capturePreviewInElectron(app, spec, referenceBounds) {
  const previewWindow = await openPreviewWindow(app, spec, referenceBounds);
  await previewWindow.waitForTimeout(100);
  const screenshotPath = join(previewDir, `${spec.id}.png`);
  const capture = await captureElementScreenshot(previewWindow, previewCaptureSelector(spec), screenshotPath);
  const result = {
    page: spec.id,
    mode: spec.mode,
    screenshotPath,
    captureSelector: capture.selector,
    captureBounds: capture.bounds,
    rootVisible: await readVisible(previewWindow, capture.selector),
    composerVisible: await readVisible(previewWindow, '.composer'),
    workbenchVisible: await readCount(previewWindow, '.workbench') > 0,
    floatingVisible: await readCount(previewWindow, '.floating-stage') > 0
  };
  await previewWindow.close();
  return result;
}

async function waitForMainPage(page, spec) {
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: rendererReadyTimeoutMs });
  if (spec.id === 'chat') {
    await page.waitForSelector('[data-testid="chat-view"]', { timeout: 10000 });
    return;
  }
  const selectorMap = {
    tasks: '[data-testid="tasks-view"]',
    workspace: '[data-testid="workspace-view"]',
    git: '[data-testid="git-view"]',
    terminal: '[data-testid="terminal-view"]',
    preview: '[data-testid="preview-view"]',
    mcp: '[data-testid="mcp-view"]',
    skills: '[data-testid="skills-view"]',
    memory: '[data-testid="memory-view"]',
    settings: '[data-testid="settings-view"]',
    doctor: '[data-testid="doctor-view"]',
    diagnostics: '[data-testid="diagnostics-view"]'
  };
  await page.waitForSelector(selectorMap[spec.id], { timeout: 10000 });
}

async function seedAppVisualState(page) {
  const selectedWorkspace = await page.evaluate(async (workspacePath) => {
    const result = await window.roc.workspace.select({ path: workspacePath });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.path;
  }, auditWorkspacePath);
  if (selectedWorkspace !== auditWorkspacePath) {
    throw new Error(`visual audit workspace mismatch: ${selectedWorkspace}`);
  }
}

function createAuditWorkspace() {
  const workspaceRoot = join(dataRoot, 'Roc');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(workspaceRoot, 'docs'), { recursive: true });
  mkdirSync(join(workspaceRoot, '页面预览效果图'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, '想法.md'),
    '# 想法.md\n## 主界面与入口\n- 主窗口\n- 全局快捷入口\n- 托盘状态入口\n',
    'utf8'
  );
  writeFileSync(
    join(workspaceRoot, '记忆系统.md'),
    '# 记忆系统\nphase three recall keeps searchable notes inside the current workspace.\n',
    'utf8'
  );
  writeFileSync(
    join(workspaceRoot, '技术栈.md'),
    '# 技术栈\n- Electron\n- React\n- TypeScript\n',
    'utf8'
  );
  writeFileSync(
    join(workspaceRoot, 'phase-three-notes.txt'),
    'phase three smoke workspace\nphase three visual audit context\n',
    'utf8'
  );
  writeFileSync(
    join(workspaceRoot, '页面预览效果图', 'roc-system-pages.html'),
    '<!doctype html><html><body>preview placeholder</body></html>\n',
    'utf8'
  );

  const initResult = spawnSync('git', ['init', '-b', 'main'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  if (initResult.status !== 0) {
    spawnSync('git', ['init'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true
    });
  }

  return workspaceRoot;
}

async function captureMainApp(page, spec) {
  await page.evaluate(async ({ pageId, tool }) => {
    const result = await window.roc.app.openMainPage(pageId);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const url = new URL(window.location.href);
    if (tool === null) {
      url.searchParams.delete('tool');
    } else {
      url.searchParams.set('tool', tool);
    }
    window.history.replaceState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, { pageId: spec.id, tool: spec.tool });
  await waitForMainPage(page, spec);
  await page.waitForTimeout(100);
  const screenshotPath = join(appDir, `${spec.id}.png`);
  const capture = await captureElementScreenshot(page, appCaptureSelector(spec), screenshotPath);
  return {
    page: spec.id,
    mode: spec.mode,
    screenshotPath,
    captureSelector: capture.selector,
    captureBounds: capture.bounds,
    rootVisible: await readVisible(page, capture.selector),
    composerVisible: await readCount(page, '.composer') > 0,
    workbenchVisible: await readCount(page, '.workbench') > 0,
    floatingVisible: false
  };
}

async function openFloatingWindow(app, openerWindow, spec) {
  const waiter = app.waitForEvent('window');
  await openerWindow.evaluate(async (pageId) => {
    const result =
      pageId === 'quick' ? await window.roc.app.openQuickEntry() : await window.roc.app.openTrayEntry();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }, spec.id);
  const floatingWindow = await waiter;
  const selector = spec.id === 'quick' ? '[data-testid="quick-entry-view"]' : '[data-testid="tray-entry-view"]';
  await floatingWindow.waitForSelector(selector, { timeout: 10000 });
  return floatingWindow;
}

async function captureFloatingApp(app, openerWindow, spec) {
  const floatingWindow = await openFloatingWindow(app, openerWindow, spec);
  await floatingWindow.waitForTimeout(100);
  const screenshotPath = join(appDir, `${spec.id}.png`);
  const capture = await captureElementScreenshot(floatingWindow, appCaptureSelector(spec), screenshotPath);
  const result = {
    page: spec.id,
    mode: spec.mode,
    screenshotPath,
    captureSelector: capture.selector,
    captureBounds: capture.bounds,
    rootVisible: await readVisible(floatingWindow, capture.selector),
    composerVisible: await readCount(floatingWindow, '.composer') > 0,
    workbenchVisible: await readCount(floatingWindow, '.workbench') > 0,
    floatingVisible: await readVisible(floatingWindow, `[data-testid="floating-${spec.id}"]`)
  };
  await floatingWindow.close();
  return result;
}

const dataRoot = await mkdtemp(join(tmpdir(), 'roc-visual-audit-'));
const auditWorkspacePath = createAuditWorkspace();
let browser;
let app;
let diffPage;
let previewPage;

try {
  browser = await chromium.launch(
    edgeExecutablePath === undefined
      ? undefined
      : {
          executablePath: edgeExecutablePath,
          channel: undefined
        }
  );
  previewPage = await browser.newPage();
  diffPage = await browser.newPage();
  await diffPage.setContent('<!doctype html><html><body></body></html>');

  app = await electron.launch({
    executablePath: smokeTarget.executablePath,
    args: smokeTarget.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot
    }
  });

  const openerWindow = await app.firstWindow();
  await openerWindow.waitForSelector('[data-testid="roc-app"]', { timeout: rendererReadyTimeoutMs });
  await seedAppVisualState(openerWindow);
  await openerWindow.reload();
  await openerWindow.waitForSelector('[data-testid="roc-app"]', { timeout: rendererReadyTimeoutMs });

  const pageResults = [];

  for (const spec of pageSpecs) {
    const appResult =
      spec.mode === 'floating' ? await captureFloatingApp(app, openerWindow, spec) : await captureMainApp(openerWindow, spec);
    if (appResult.captureBounds === null) {
      throw new Error(`Could not resolve capture bounds for ${spec.id}`);
    }
    const previewResult =
      previewEngine === 'electron'
        ? await capturePreviewInElectron(app, spec, appResult.captureBounds)
        : await capturePreview(previewPage, spec, appResult.captureBounds);
    if (previewResult.captureBounds === null) {
      throw new Error(`Could not resolve preview capture bounds for ${spec.id}`);
    }
    const targetDimensions = {
      width: Math.max(previewResult.captureBounds.width, appResult.captureBounds.width),
      height: Math.max(previewResult.captureBounds.height, appResult.captureBounds.height)
    };
    const diffScreenshotPath = join(diffDir, `${spec.id}.png`);
    const comparison = await compareScreenshots(diffPage, previewResult.screenshotPath, appResult.screenshotPath, targetDimensions);
    writePngDataUrl(diffScreenshotPath, comparison.diffDataUrl);
    pageResults.push({
      page: spec.id,
      mode: spec.mode,
      preview: {
        ...previewResult,
        imageDimensions: comparison.previewDimensions
      },
      app: {
        ...appResult,
        imageDimensions: comparison.appDimensions
      },
      diff: {
        screenshotPath: diffScreenshotPath,
        dimensions: comparison.diffDimensions,
        differingPixels: comparison.differingPixels,
        totalPixels: comparison.totalPixels,
        differenceRatio: comparison.differenceRatio,
        pixelThreshold,
        passed: comparison.perceptualDifferenceRatio <= maxPerceptualDiffRatio,
        rawPassed: comparison.differenceRatio <= maxDiffRatio,
        perceptualDimensions: comparison.perceptualDimensions,
        perceptualDifferingPixels: comparison.perceptualDifferingPixels,
        perceptualTotalPixels: comparison.perceptualTotalPixels,
        perceptualDifferenceRatio: comparison.perceptualDifferenceRatio,
        perceptualPixelThreshold
      },
      captureDimensionsMatch:
        previewResult.captureBounds.width === appResult.captureBounds.width &&
        previewResult.captureBounds.height === appResult.captureBounds.height
    });
  }

  const result = {
    checkedAt: new Date().toISOString(),
    smokeTarget,
    previewSource,
    previewEngine,
    thresholds: {
      pixelThreshold,
      maxDiffRatio,
      perceptualPixelThreshold,
      perceptualScale,
      maxPerceptualDiffRatio
    },
    pages: pageResults
  };

  const failedPages = result.pages
    .map((item) => {
      const reasons = [];
      if (!item.preview.rootVisible) {
        reasons.push('preview_root_not_visible');
      }
      if (!item.app.rootVisible) {
        reasons.push('app_root_not_visible');
      }
      if (item.app.page !== 'chat' && item.app.mode === 'main' && item.app.composerVisible) {
        reasons.push('non_chat_composer_visible');
      }
      if (item.app.page === 'chat' && !item.app.composerVisible) {
        reasons.push('chat_composer_missing');
      }
      if (item.app.workbenchVisible !== WORKBENCH_PAGE_IDS.has(item.app.page)) {
        reasons.push('workbench_visibility_mismatch');
      }
      if (item.app.floatingVisible !== (item.app.mode === 'floating')) {
        reasons.push('floating_visibility_mismatch');
      }
      if (!item.diff.passed) {
        reasons.push('perceptual_difference_exceeds_threshold');
      }
      return reasons.length === 0 ? null : { page: item.page, reasons };
    })
    .filter((item) => item !== null);

  result.summary = {
    pageCount: result.pages.length,
    passedPageCount: result.pages.length - failedPages.length,
    failedPageCount: failedPages.length,
    failedPages,
    previewDir,
    appDir,
    diffDir
  };

  writeFileSync(join(artifactDir, 'visual-audit.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (failedPages.length > 0) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
} finally {
  if (app !== undefined) {
    await app.close();
  }
  if (diffPage !== undefined) {
    await diffPage.close();
  }
  if (previewPage !== undefined) {
    await previewPage.close();
  }
  if (browser !== undefined) {
    await browser.close();
  }
  await rm(dataRoot, { recursive: true, force: true });
}
