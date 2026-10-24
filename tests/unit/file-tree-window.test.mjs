import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('scrolling a large tree keeps DOM bounded while retaining keyboard anchors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roc-tree-window-'));
  try {
    const outfile = join(dir, 'window.mjs');
    await build({ entryPoints: ['src/renderer/canvas/files/file-tree-window.ts'], outfile, bundle: true, format: 'esm', platform: 'node' });
    const { fileTreeWindow } = await import(outfile);
    for (const [count, start, end, active] of [[10000, 9950, 9980, 0], [10000, 20, 50, 9999], [10000, 20, 50, 30], [10, 1000, 1040, 0], [0, 0, 0, -1]]) {
      const result = fileTreeWindow(count, start, end, active);
      assert.ok(result.indices.length <= 31);
      assert.equal(result.indices.reduce((total, row) => total + row.gap + 1, 0) + result.trailingRows, count);
      if (active >= 0 && active < count) assert.ok(result.indices.some(row => row.index === active));
      let previous = -1;
      for (const row of result.indices) {
        assert.equal(row.gap, row.index - previous - 1);
        previous = row.index;
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
