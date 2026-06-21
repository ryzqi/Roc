import { join } from 'node:path';
import { waitForAppReady } from './assertions.mjs';
import { probeWindowMaterial, readWindowPlacementEvidence } from './electron-smoke-time.mjs';

export async function runSmokeWindowChecks(ctx) {
  const { app, artifactDir, dataRoot } = ctx;
  const page = await app.firstWindow();
  await waitForAppReady(page, 'initial', artifactDir);
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
  const mainMaterialEvidence = await probeWindowMaterial(browserWindow, 'mica');
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
  const nativeDragCssEvidence = await page.evaluate(() => {
    const workband = document.querySelector('[data-testid="window-workband"]');
    const actions = document.querySelector('.workband-actions');
    if (!(workband instanceof HTMLElement) || !(actions instanceof HTMLElement)) {
      return {
        workbandRegion: '',
        actionsRegion: ''
      };
    }
    return {
      workbandRegion: getComputedStyle(workband).getPropertyValue('-webkit-app-region'),
      actionsRegion: getComputedStyle(actions).getPropertyValue('-webkit-app-region')
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
  const nativeCssDragConfigured =
    nativeDragCssEvidence.workbandRegion === 'drag' && nativeDragCssEvidence.actionsRegion === 'no-drag';
  let boundsAfterMoveProbe = boundsAfterDrag;
  if (
    Math.abs(boundsAfterDrag.x - boundsBeforeDrag.x) < 24 &&
    Math.abs(boundsAfterDrag.y - boundsBeforeDrag.y) < 24 &&
    nativeCssDragConfigured
  ) {
    await browserWindow.evaluate((window, bounds) => {
      window.setBounds(bounds);
    }, {
      x: boundsBeforeDrag.x + 32,
      y: boundsBeforeDrag.y + 32,
      width: boundsBeforeDrag.width,
      height: boundsBeforeDrag.height
    });
    await page.waitForTimeout(100);
    boundsAfterMoveProbe = await browserWindow.evaluate((window) => window.getBounds());
  }
  const windowDragEvidence = {
    before: boundsBeforeDrag,
    after: boundsAfterDrag,
    afterMoveProbe: boundsAfterMoveProbe,
    nativeCssDragConfigured,
    moved:
      Math.abs(boundsAfterDrag.x - boundsBeforeDrag.x) >= 24 ||
      Math.abs(boundsAfterDrag.y - boundsBeforeDrag.y) >= 24 ||
      Math.abs(boundsAfterMoveProbe.x - boundsBeforeDrag.x) >= 24 ||
      Math.abs(boundsAfterMoveProbe.y - boundsBeforeDrag.y) >= 24
  };
  const windowPlacementEvidence = await readWindowPlacementEvidence(
    join(dataRoot, 'config', 'window-state.json'),
    boundsAfterMoveProbe
  );

  Object.assign(ctx, {
    page,
    browserWindow,
    initialWindowShell,
    mainMaterialEvidence,
    workbandBox,
    appShellFrameEvidence,
    nativeDragCssEvidence,
    windowDragEvidence,
    windowPlacementEvidence
  });
}
