import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {api = await importTypeScriptModule('src/main/plugins/research/pdf-layout-merge.ts', {platform: 'node'});});
const item = (id, text, bbox) => ({id, text, bbox, page: 1, itemIndex: Number(id.at(-1)) || 1, fontSize: 10, direction: 'ltr'});
const region = (id, text, bbox, kind = 'paragraph') => ({score: .82, block: {id, text, kind, label: kind,
  locator: 'page1', imagePath: null, locations: [{page: 1, bbox, coordinateOrigin: 'TOPLEFT'}]}});
test('unknown native and OCR geometry preserves page identity without fusing equal text', () => {
  const ocr = region('ocr1', 'Original text', null);
  ocr.block.locations[0].coordinateOrigin = null;
  const result = api.fusePdfPage({page: 1, width: 600, nativeItems: [item('native1', 'Original text', null)], regions: [ocr]});
  assert.equal(result.blocks.length, 2);
  assert.equal(result.duplicatedRegionCount, 0);
  assert.ok(result.provenance.every(p => p.overlapGroupId === null && p.source !== 'merged'));
  for (const block of result.blocks) assert.deepEqual(block.locations, [{page: 1, bbox: null, coordinateOrigin: null}]);
});
test('one OCR object cannot discard native body text elsewhere on a mixed page', () => {
  const result = api.fusePdfPage({page: 1, width: 600,
    nativeItems: [item('native1', 'Native body must remain searchable', [30, 30, 260, 45])],
    regions: [region('figure1', 'chart labels', [300, 250, 550, 450], 'figure')]});
  assert.equal(result.blocks.length, 2);
  assert.ok(result.blocks.some(b => b.text === 'Native body must remain searchable'));
  assert.ok(result.blocks.some(b => b.kind === 'figure'));
});
test('overlapping matching OCR is deduplicated with original recognitions retained', () => {
  const result = api.fusePdfPage({page: 1, width: 600, nativeItems: [item('native1', 'Precise source text', [30, 30, 240, 45])],
    regions: [region('ocr1', 'precise source text', [28, 28, 245, 47])]});
  assert.equal(result.blocks.length, 1); assert.equal(result.blocks[0].text, 'Precise source text');
  assert.equal(result.provenance[0].source, 'merged'); assert.equal(result.provenance[0].confidence, .82);
  assert.deepEqual(result.provenance[0].alternatives.map(a => a.text), ['Precise source text', 'precise source text']);
});
test('similar text at different coordinates survives; body disagreement preserves both sources', () => {
  const result = api.fusePdfPage({page: 1, width: 600,
    nativeItems: [item('native1', 'Unrelated native paragraph', [30, 30, 240, 45]), item('native2', 'Scan only', [30, 200, 130, 215])],
    regions: [region('ocr1', 'Scan only', [28, 28, 245, 47])]});
  assert.equal(result.blocks.length, 3); assert.equal(result.warnings.length, 1);
  assert.equal(result.provenance[0].status, 'disputed');
  assert.equal(result.blocks.filter(b => b.text === 'Scan only').length, 2);
});
test('visual regions prefer OCR with disputed native alternatives; empty OCR retains native text', () => {
  for (const text of ['chart legend detected by OCR', '']) {
    const result = api.fusePdfPage({page: 1, width: 600, nativeItems: [item('native1', 'Native chart text', [30, 30, 240, 45])],
      regions: [region('figure1', text, [28, 28, 245, 100], 'figure')]});
    assert.equal(result.blocks.length, 1); assert.equal(result.blocks[0].text, text || 'Native chart text');
    assert.ok(result.provenance[0].alternatives.some(a => a.text === 'Native chart text'));
  }
});
