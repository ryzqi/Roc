import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * The overlay layering table (P10).
 *
 * `src/renderer/shell/overlay-stack.ts` is deliberately React-free so the ordering rules can
 * be asserted without a DOM — they are the part that a screenshot had to catch otherwise.
 *
 * The bug being pinned: at widths below 1100px the sidebar becomes a drawer, and every
 * overlay used the same z-index band (`z-50`). Two overlays in one band are ordered by DOM
 * position, so the drawer — raised by the *layout*, not by the user — painted over the
 * settings panel and clipped the first control under it (「智能体安全」的「工具审批模式」),
 * while also swallowing Escape and the Tab trap.
 *
 * Bundled with esbuild into a temp file, the same way `renderer-settings.test.mjs` loads its
 * pure module (no React, no zod, no renderer entry graph).
 */

let tempDir = '';
let stack;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-overlay-stack-'));
  const outfile = join(tempDir, 'overlay-stack.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer/shell/overlay-stack.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  stack = await import(outfile);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('层级表：环境层永远画在对话层之下', () => {
  assert.ok(
    stack.OVERLAY_Z_INDEX.ambient < stack.OVERLAY_Z_INDEX.dialog,
    `ambient=${stack.OVERLAY_Z_INDEX.ambient} dialog=${stack.OVERLAY_Z_INDEX.dialog}`
  );
});

test('栈：环境层后打开也不会抢走最上层（Esc / Tab 归属）', () => {
  stack.resetOverlayStack();
  try {
    stack.pushOverlay('settings', 'dialog');
    stack.pushOverlay('sidebar', 'ambient');
    assert.equal(stack.topOverlayId(), 'settings', '对话框仍应是最上层');
    assert.equal(stack.hasOpenDialog(), true);
    assert.equal(stack.overlayStackDepth(), 2);

    stack.popOverlay('settings');
    assert.equal(stack.topOverlayId(), 'sidebar', '对话框关掉后才轮到环境层');
    assert.equal(stack.hasOpenDialog(), false, '只剩环境层时页面不应被判为惰性');
  } finally {
    stack.resetOverlayStack();
  }
});

test('栈：同层之内后打开在上，重复登记不会留两份', () => {
  stack.resetOverlayStack();
  try {
    stack.pushOverlay('manage', 'dialog');
    stack.pushOverlay('confirm', 'dialog');
    assert.equal(stack.topOverlayId(), 'confirm');

    stack.pushOverlay('manage', 'dialog');
    assert.equal(stack.topOverlayId(), 'manage', '重新登记应把它提到最上层');
    assert.equal(stack.overlayStackDepth(), 2, '同一个 id 只应占一格');
  } finally {
    stack.resetOverlayStack();
  }
});

test('栈：只有环境层时 topOverlayId 仍是它（抽屉自己也要响应 Esc）', () => {
  stack.resetOverlayStack();
  try {
    stack.pushOverlay('sidebar', 'ambient');
    assert.equal(stack.topOverlayId(), 'sidebar');
    assert.equal(stack.hasOpenDialog(), false);
    stack.popOverlay('sidebar');
    assert.equal(stack.topOverlayId(), null);
    assert.equal(stack.overlayStackDepth(), 0);
  } finally {
    stack.resetOverlayStack();
  }
});
