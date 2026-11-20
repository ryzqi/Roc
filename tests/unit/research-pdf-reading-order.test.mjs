import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/pdf-reading-order.ts', {platform: 'node'});});
const block = (id, bbox) => ({id, bbox});
test('double columns follow left column before right despite interleaved extraction arrays', () => {
  const blocks = [block('right2', [330, 80, 560, 100]), block('left1', [30, 40, 260, 60]),
    block('right1', [330, 40, 560, 60]), block('left2', [30, 80, 260, 100]), block('title', [30, 10, 560, 25])];
  assert.deepEqual(api.orderPdfBlocks(blocks, 600).blocks.map(b => b.id), ['title', 'left1', 'left2', 'right1', 'right2']);
});
test('mid-page spanning heading divides column bands and unlocated text is flagged', () => {
  const blocks = [block('r1', [330, 40, 560, 60]), block('l1', [30, 40, 260, 60]),
    block('span', [30, 100, 560, 120]), block('l2', [30, 150, 260, 170]), block('r2', [330, 150, 560, 170]),
    block('unknown', null)];
  const result = api.orderPdfBlocks(blocks, 600);
  assert.deepEqual(result.blocks.map(b => b.id), ['l1', 'r1', 'span', 'l2', 'r2', 'unknown']);
  assert.deepEqual(result.warnings, ['native_geometry_unavailable']);
});
