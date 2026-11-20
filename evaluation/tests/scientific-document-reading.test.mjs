import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyScientificDocumentReading} from '../lib/scientific-document-reading.mjs';

const a = {version: 1, source: 'rule', role: 'body', ruleScore: null, signals: [], continuesFrom: null, continuesTo: null};
const blocks = [{id: 'a', text: 'The source continues', kind: 'paragraph', locator: 'p1', locations: [{page: 1, bbox: [10, 690, 280, 710], coordinateOrigin: 'TOPLEFT'}]},
  {id: 'b', text: 'on the next page.', kind: 'paragraph', locator: 'p2', locations: [{page: 2, bbox: [10, 90, 280, 110], coordinateOrigin: 'TOPLEFT'}]}];
const pages = [1, 2].map(page => ({page, coordinateFrame: {kind: 'pdf', width: 600, height: 800}}));
const annotation = () => blocks.map((b, i) => ({...structuredClone(b), reading: {...a, continuesFrom: i ? 'a' : null, continuesTo: i ? null : 'b'}}));
test('independent reading verifier preserves exact original source and reciprocal page links', () => {
  const result = verifyScientificDocumentReading(blocks, pages, annotation());
  assert.equal(result.blocks, 2); assert.deepEqual(result.links, [{from: 'a', to: 'b', pages: [1, 2]}]);
});
test('changed sources, coherent wrong geometry, missing annotations and forged margins reject', () => {
  for (const mutate of [b => b[0].text += 'invented', b => b[1].locations[0].page = 3, b => delete b[0].reading,
    b => b[0].reading.continuesTo = 'missing', b => b[1].reading.continuesFrom = null, b => b[0].reading.ruleScore = 2,
    b => {b[0].reading.role = 'page_header'; b[0].reading.continuesTo = null; b[1].reading.continuesFrom = null;}]) {
    const annotated = annotation(); mutate(annotated);
    assert.throws(() => verifyScientificDocumentReading(blocks, pages, annotated));
  }
});
