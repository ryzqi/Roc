import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AUDIT_SCRIPT = `(() => {
  const MIN_FONT_PX = 9;
  const MIN_TARGET_PX = 24;
      const SIGNIFICANT_OVERLAP_PX = 3;
  const SIGNIFICANT_RATIO = 0.35;
  const SIGNIFICANT_AREA = 80;

  const isVisible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    if (Number.parseFloat(style.opacity || '1') < 0.05) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  };

  const label = (element) => {
    const testId = element.getAttribute('data-testid');
    const tag = element.tagName.toLowerCase();
    const cls = (element.getAttribute('class') || '')
      .split(/\\s+/)
      .filter((name) => name.length > 0)
      .slice(0, 3)
      .join('.');
    const text = (element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return [tag, testId === null ? '' : '#' + testId, cls, text === '' ? '' : '"' + text + '"']
      .filter((part) => part.length > 0)
      .join(' ');
  };

  const ownerTextElements = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if ((node.textContent || '').trim().length === 0) {
      continue;
    }
    const parent = node.parentElement;
    if (parent !== null) {
      ownerTextElements.add(parent);
    }
  }

  const textRects = [];
  const fontSizeViolations = [];
  const textOverflowViolations = [];
  for (const element of ownerTextElements) {
    if (!isVisible(element)) {
      continue;
    }
    if (element.closest('[data-testid="terminal-xterm"]') !== null) {
      continue;
    }
    if (element.closest('.workband-drag-region, .brand') !== null) {
      continue;
    }
    if (element.closest('.workband-drag-region, .brand') !== null) {
      continue;
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const fontSize = Number.parseFloat(style.fontSize || '0');
    if (fontSize > 0 && fontSize < MIN_FONT_PX) {
      fontSizeViolations.push({ element: label(element), fontSize: Math.round(fontSize * 10) / 10 });
    }
    const overflowsBox =
      element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2;
    const overflowStyle = style.overflow;
    const clipsText =
      overflowStyle === 'hidden' || (style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap');
    if (overflowsBox && !clipsText && element.children.length === 0) {
      textOverflowViolations.push({
        element: label(element),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflow: overflowStyle
      });
    }
    /*
     * 只量第一行。多行文本的 getClientRects 会把行盒按基线外扩，
     * 相邻行盒在行距小于字号时必然相交，那是排版不是重叠。
     * 真正要抓的是同一行内两个不同元素抢同一片区域。
     */
    const range = document.createRange();
    const textNode = Array.from(element.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0
    );
    if (textNode === undefined) {
      continue;
    }
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.textContent.length);
    for (const clientRect of range.getClientRects()) {
      textRects.push({
        element,
        rect: {
          left: clientRect.left,
          top: clientRect.top,
          right: clientRect.right,
          bottom: clientRect.bottom
        }
      });
      break;
    }
    range.detach();
  }

  const intersects = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > SIGNIFICANT_OVERLAP_PX &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SIGNIFICANT_OVERLAP_PX;

  const textOverlaps = [];
  for (let index = 0; index < textRects.length; index += 1) {
    const left = textRects[index];
    for (let other = index + 1; other < textRects.length; other += 1) {
      const right = textRects[other];
      if (left.element === right.element) {
        continue;
      }
      if (left.element.contains(right.element) || right.element.contains(left.element)) {
        continue;
      }
      const sharedModal = left.element.closest('[role="dialog"], .settings-modal, .ui-drawer');
      if (sharedModal !== null && sharedModal === right.element.closest('[role="dialog"], .settings-modal, .ui-drawer')) {
        continue;
      }
      if (!intersects(left.rect, right.rect)) {
        continue;
      }
      const overlapWidth = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
      const overlapHeight = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
      const overlapArea = overlapWidth * overlapHeight;
      const leftArea = (left.rect.right - left.rect.left) * (left.rect.bottom - left.rect.top);
      const rightArea = (right.rect.right - right.rect.left) * (right.rect.bottom - right.rect.top);
      const ratio = overlapArea / Math.min(leftArea, rightArea);
      if (overlapArea < SIGNIFICANT_AREA && ratio < SIGNIFICANT_RATIO) {
        continue;
      }
      const layerSelector = '[role="dialog"], .settings-modal, .workbench, .ui-drawer';
      const leftLayer = left.element.closest(layerSelector);
      const rightLayer = right.element.closest(layerSelector);
      if (leftLayer !== rightLayer) {
        continue;
      }
      textOverlaps.push({
        a: label(left.element),
        b: label(right.element),
        owner: leftLayer === null ? 'page' : label(leftLayer),
        ratio: Math.round(ratio * 100) / 100,
        area: Math.round(overlapArea)
      });
    }
  }

  const smallTargets = [];
  for (const element of document.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select, textarea')) {
    if (!isVisible(element)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width >= MIN_TARGET_PX && rect.height >= MIN_TARGET_PX) {
      continue;
    }
    smallTargets.push({ element: label(element), width: Math.round(rect.width), height: Math.round(rect.height) });
  }

  const composerDebug = (() => {
    const composer = document.querySelector('.composer--chat');
    if (!(composer instanceof HTMLElement)) {
      return null;
    }
    const bottom = composer.querySelector('.composer-bottom');
    const tools = composer.querySelector('.composer-bottom');
    const targets = Array.from(composer.querySelectorAll('*')).filter((child) => {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return rect.width > 0 && (child.scrollWidth > child.clientWidth + 2 || style.overflowX !== 'visible');
    });
    const overflowers = targets.map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        cls: typeof child.className === 'string' ? child.className.slice(0, 60) : '',
        w: Math.round(rect.width),
        scrollW: child.scrollWidth,
        clientW: child.clientWidth,
        right: Math.round(rect.right)
      };
    });
    const bottomRect = tools === null ? null : tools.getBoundingClientRect();
    return {
      width: composer.clientWidth,
      scrollWidth: composer.scrollWidth,
      bottom: bottomRect === null ? null : { left: Math.round(bottomRect.left), right: Math.round(bottomRect.right) },
      overflowers
    };
  })();

  const panelOverflow = [];
  for (const panel of document.querySelectorAll('.card, .research-shell-banner, .research-overview-block, .composer')) {
    if (!isVisible(panel)) {
      continue;
    }
    if (panel.scrollWidth > panel.clientWidth + 2 || panel.scrollHeight > panel.clientHeight + 2) {
      panelOverflow.push({
        element: label(panel),
        scrollWidth: panel.scrollWidth,
        clientWidth: panel.clientWidth,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight
      });
    }
  }

  const viewportOverflow = [];
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  if (scrollWidth > window.innerWidth + 1) {
    viewportOverflow.push({ axis: 'horizontal', scrollWidth, innerWidth: window.innerWidth });
  }
  if (scrollHeight > window.innerHeight + 1) {
    viewportOverflow.push({ axis: 'vertical', scrollHeight, innerHeight: window.innerHeight });
  }

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    textRectCount: textRects.length,
    textOverlaps: textOverlaps.slice(0, 20),
    fontSizeViolations: fontSizeViolations.slice(0, 20),
    textOverflowViolations: textOverflowViolations.slice(0, 20),
    smallTargets: smallTargets.slice(0, 20),
    panelOverflow: panelOverflow.slice(0, 20),
    composerDebug,
    viewportOverflow
  };
})()`;

export async function auditLayout(page, label) {
  const auditScale = await page.evaluate(() => window.devicePixelRatio);
  const audit = await page.evaluate(AUDIT_SCRIPT);
  const outDir = process.env.ROC_UI_AUDIT_DIR;
  if (typeof outDir === 'string' && outDir.length > 0) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outDir, { recursive: true });
    const shot = await page.screenshot({ scale: 'css' });
    writeFileSync(join(outDir, `${label}.png`), shot);
  }
  return { label, ...audit };
}

export function writeLayoutAudit(artifactDir, payload) {
  writeFileSync(join(artifactDir, 'layout-audit.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
