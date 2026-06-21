import { openChatView } from './ui-actions.mjs';

export async function runSmokeWorkbenchFileChecks(ctx) {
  const { page } = ctx;
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
  await page.click('[data-testid="workbench-directory-docs"]');
  await page.waitForSelector('[data-testid="workbench-file-docs-smoke-preview.pdf"]', { timeout: 5000 });
  await page.click('[data-testid="workbench-file-docs-smoke-preview.pdf"]');
  await page.waitForSelector('[data-testid="workbench-file-pdf-preview"]', { timeout: 5000 });
  const pdfPreviewEvidence = await page.evaluate(() => {
    const frame = document.querySelector('[data-testid="workbench-file-pdf-preview"]');
    const previewBody = document.querySelector('.workbench-file-body--pdf');
    const stage = document.querySelector('.workbench-file-pdf-stage');
    const workbenchBar = document.querySelector('.workbench-bar');
    const frameRect = frame?.getBoundingClientRect();
    const previewBodyRect = previewBody?.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    const workbenchBarRect = workbenchBar?.getBoundingClientRect();
    return {
      src: frame?.getAttribute('src') ?? '',
      hintExists: document.querySelector('.workbench-file-pdf-hint') !== null,
      title: frame?.getAttribute('title') ?? '',
      frameHeight: frameRect?.height ?? 0,
      previewBodyHeight: previewBodyRect?.height ?? 0,
      stageHeight: stageRect?.height ?? 0,
      workbenchBarHeight: workbenchBarRect?.height ?? 0
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

  Object.assign(ctx, {
    chatWorkbenchLayoutVisible,
    explorerHideButtonCountBefore,
    explorerRefreshButtonCountBefore,
    filePreviewBeforeClick,
    filePreviewAfterClick,
    filePreviewLayoutEvidence,
    directoryExpandEvidence,
    imagePreviewEvidence,
    pdfPreviewEvidence,
    filePreviewStatsEvidence,
    workbenchPreviewModeButtonCount,
    workbenchCodeModeButtonCount,
    filePaneWidthBefore,
    filePaneWidthAfter,
    workbenchWidthBefore,
    workbenchWidthAfter
  });
}
