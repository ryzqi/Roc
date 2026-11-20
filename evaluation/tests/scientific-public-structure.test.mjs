import assert from 'node:assert/strict';
import test from 'node:test';
import { editDistance, normalizedLatex, scoreFailedPublicStructurePage, scorePublicStructurePage, summarizePublicStructure,
  tableCells, tableSimilarity, tableSimilarityDetails } from '../adapters/scientific-public/structure.mjs';

const object = (category_type, anno_id, box, extra = {}) => ({ category_type, anno_id, ignore: false,
  poly: [box[0], box[1], box[2], box[1], box[2], box[3], box[0], box[3]], ...extra });
const gold = { page_info: { width: 100, height: 100 }, layout_dets: [
  object('text_block', 1, [0, 0, 40, 40], { text: 'alpha beta', order: 1 }),
  object('text_block', 2, [50, 0, 90, 40], { text: 'gamma', order: 2 }),
  object('table', 3, [0, 50, 40, 90], { html: '<table><tr><td>A</td></tr></table>', order: 3 }),
  object('equation_isolated', 4, [50, 50, 90, 90], { latex: '$$x+y$$', order: 4 }) ] };
const parsed = regions => ({ pages: [{ coordinateFrame: {
  kind: 'image', unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT', width: 100, height: 100 }, regions }] });
const exact = [
  { id: 'a', type: 'text', bbox: [0, 0, 40, 40], text: 'alpha beta' },
  { id: 'b', type: 'text', bbox: [50, 0, 90, 40], text: 'gamma' },
  { id: 't', type: 'table', bbox: [0, 50, 40, 90], tableMatches: { html: '<table><tr><td>A</td></tr></table>' } },
  { id: 'f', type: 'formula', bbox: [50, 50, 90, 90], formula: 'x + y' } ];

test('perfect region predictions recover text, order, cells and normalized formulas', () => {
  const report = summarizePublicStructure([scorePublicStructurePage(gold, parsed(exact))]);
  assert.equal(report.layoutMicroF1, 1);
  assert.equal(report.ocr.cer, 0); assert.equal(report.ocr.wer, 0);
  assert.equal(report.readingOrder.pairRecall, 1);
  assert.equal(report.tables.cellExactMatch, 1); assert.equal(report.tables.meanTeds, 1);
  assert.equal(report.formulas.normalizedExactMatch, 1);
});
test('missing objects stay in every gold denominator', () => {
  const report = summarizePublicStructure([scorePublicStructurePage(gold, parsed([]))]);
  assert.equal(report.layoutMicroF1, 0); assert.equal(report.ocr.cer, 1);
  assert.equal(report.ocr.wer, 1); assert.equal(report.readingOrder.pairRecall, 0);
  assert.equal(report.tables.cellExactMatch, 0); assert.equal(report.tables.meanTeds, 0);
  assert.equal(report.formulas.normalizedExactMatch, 0);
});
test('production image and chart labels are figures while captions stay text', () => {
  for (const type of ['image', 'chart', 'header_image', 'figure']) {
    const pageGold = { page_info: gold.page_info, layout_dets: [
      object('figure', 1, [0, 0, 40, 40]),
      object('figure_caption', 2, [50, 0, 90, 40], { text: 'Figure 1' }) ] };
    const score = scorePublicStructurePage(pageGold, parsed([
      { id: 'image', type, bbox: [0, 0, 40, 40] },
      { id: 'caption', type: 'figure_title', bbox: [50, 0, 90, 40], text: 'Figure 1' } ]));
    assert.equal(score.layout.figure.tp, 1);
    assert.equal(score.layout.text.tp, 1);
    assert.equal(score.ocr.characterEdits, 0);
  }
});
test('production table fullHtml is scored with OCR text rather than rootless structure', () => {
  const regions = structuredClone(exact);
  regions[2].tableMatches = { html: '<tr><td>A</td></tr>',
    fullHtml: '<html><body><table><tr><td>A</td></tr></table></body></html>' };
  regions[2].table = { html: '<tr><td></td></tr>',
    fullHtml: '<html><body><table><tr><td></td></tr></table></body></html>' };
  const report = summarizePublicStructure([scorePublicStructurePage(gold, parsed(regions))]);
  assert.equal(report.tables.cellExactMatch, 1);
  assert.equal(report.tables.meanTeds, 1);
  regions[2].tableMatches.fullHtml = regions[2].tableMatches.fullHtml.replace('>A<', '>Z<');
  assert.equal(summarizePublicStructure([scorePublicStructurePage(gold, parsed(regions))])
    .tables.cellExactMatch, 0);
});
test('duplicate predictions cannot increase recall and unmatched text is an insertion', () => {
  const score = scorePublicStructurePage(gold, parsed([...exact, { ...exact[0], id: 'duplicate' }]));
  assert.equal(score.layout.text.tp, 2); assert.equal(score.layout.text.fp, 1);
  assert.equal(score.ocr.characterEdits, 10);
});
test('reading order is assessed on output order, including missing pairs', () => {
  const score = scorePublicStructurePage(gold, parsed([...exact].reverse()));
  assert.equal(score.readingOrder.totalPairs, 6); assert.equal(score.readingOrder.correctPairs, 0);
});
test('wrong coordinate frame and invalid gold/prediction are rejected', () => {
  const value = parsed(exact); value.pages[0].coordinateFrame.width = 200;
  assert.throws(() => scorePublicStructurePage(gold, value), /coordinate_mismatch/);
  assert.throws(() => scorePublicStructurePage(gold, parsed([{ ...exact[0], bbox: [1, 1, 0, 0] }])), /bbox_invalid/);
  const noFormula = structuredClone(gold); delete noFormula.layout_dets[3].latex;
  assert.throws(() => scorePublicStructurePage(noFormula, parsed([])), /formula_gold_missing/);
});
test('table cells preserve row/column spans, decoded content and structural distinctions', () => {
  const html = '<table><tr><td rowspan="2">A &amp; B</td><td>C</td></tr><tr><td>D</td></tr></table>';
  const cells = tableCells(html);
  assert.deepEqual(cells.map(({ row, column, rowspan, text }) => [row, column, rowspan, text]),
    [[0, 0, 2, 'A & B'], [0, 1, 1, 'C'], [1, 1, 1, 'D']]);
  assert.equal(tableSimilarity(html, html), 1);
  assert.ok(tableSimilarity(html, html.replace('rowspan="2"', 'rowspan="1"')) < 1);
  assert.ok(tableSimilarity(html, html.replace('>D<', '>Z<')) < 1);
  assert.equal(tableSimilarity(html, ''), 0);
  assert.throws(() => tableCells('<table><tr><td rowspan="-1">a</td></tr></table>'), /span_invalid/);
});
test('ordered tree edit distance charges node deletion while retaining descendants', () => {
  const wrapped = '<table><tbody><tr><td>A</td></tr></tbody></table>';
  const plain = '<table><tr><td>A</td></tr></table>';
  assert.equal(tableSimilarity(wrapped, plain), .75);
  assert.equal(tableSimilarity(plain, wrapped), .75);
  const a = '<table><tr><td>A</td></tr></table>', b = '<table><tr><td>B</td></tr></table>';
  assert.ok(Math.abs(tableSimilarity(a, b) - 2 / 3) < 1e-12);
});
test('TEDS details retain entity-decoded NFC tokens, spans and independently countable trees', () => {
  const html = '<table><tbody><tr><td rowspan="2" colspan="3"> e\u0301 &amp; <b>X</b> </td></tr></tbody></table>';
  const detail = tableSimilarityDetails(html, html.replace('<tbody>', '').replace('</tbody>', ''));
  assert.equal(detail.contract.version, 'public-ordered-tree-v1');
  assert.equal(detail.contract.officialLeaderboardCompatible, false);
  assert.equal(detail.status, 'scored'); assert.equal(detail.reason, null);
  assert.equal(detail.expectedNodes, 4); assert.equal(detail.actualNodes, 3);
  assert.equal(detail.distance, 1); assert.equal(detail.denominator, 4); assert.equal(detail.value, .75);
  assert.deepEqual(detail.expectedTree.children[0].children[0].children[0], {
    tag: 'td', rowspan: '2', colspan: '3', tokens: ['é', ' ', '&', '<b>', 'X', '</b>'], children: []
  });
  assert.deepEqual(JSON.parse(JSON.stringify(detail)), detail);
  const changed = tableSimilarityDetails('<table><tr><td>AB</td></tr></table>',
    '<table><tr><td>AX</td></tr></table>');
  assert.equal(changed.distance, .5); assert.equal(changed.denominator, 3);
  assert.equal(changed.value, 1 - .5 / 3);
});
test('missing and unsupported TEDS trees retain artifacts without fabricated edit distances', () => {
  const html = '<table><tr><td>A</td></tr></table>';
  const missing = tableSimilarityDetails(html, '');
  assert.equal(missing.status, 'missing-tree'); assert.equal(missing.reason, 'prediction-table-missing');
  assert.equal(missing.expectedNodes, 3); assert.equal(missing.actualNodes, 0);
  assert.equal(missing.actualTree, null); assert.equal(missing.distance, null); assert.equal(missing.value, 0);
  assert.equal(tableSimilarity('', html), 0);
  const large = `<table>${'<tr><td>A</td></tr>'.repeat(2500)}</table>`;
  const unsupported = tableSimilarityDetails(large, html);
  assert.equal(unsupported.status, 'unsupported'); assert.equal(unsupported.expectedNodes, 5001);
  assert.equal(unsupported.distance, null); assert.equal(unsupported.value, null);
  assert.equal(unsupported.expectedTree.children.length, 2500);
  assert.throws(() => tableSimilarity(large, html), /scientific_public_table_size_limit/);
});
test('independent forest-operation oracle confirms distance and scalar behavior for varied small tables', () => {
  // Exhaustive forest recursion, without Zhang-Shasha postorder/leftmost
  // arrays or the production token distance. Deletion promotes descendants.
  const tokenDistance = (a, b) => {
    const matrix = Array.from({ length: a.length + 1 }, () => []);
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    return matrix[a.length][b.length];
  };
  const oracle = (a, b) => {
    const cache = new Map(), count = forest => forest.reduce((n, node) => n + 1 + count(node.children), 0);
    const solve = (left, right) => {
      if (!left.length) return count(right);
      if (!right.length) return count(left);
      const key = JSON.stringify([left, right]);
      if (cache.has(key)) return cache.get(key);
      const [x, ...xs] = left, [y, ...ys] = right;
      const size = Math.max(x.tokens.length, y.tokens.length);
      const rename = x.tag !== y.tag || x.rowspan !== y.rowspan || x.colspan !== y.colspan ? 1
        : size ? tokenDistance(x.tokens, y.tokens) / size : 0;
      const result = Math.min(1 + solve([...x.children, ...xs], right),
        1 + solve(left, [...y.children, ...ys]),
        rename + solve(x.children, y.children) + solve(xs, ys));
      cache.set(key, result); return result;
    };
    return solve([a], [b]);
  };
  const tables = [
    '<table><tr><td>AB</td></tr></table>',
    '<table><tbody><tr><td>AX</td></tr></tbody></table>',
    '<table><tr><th>AB</th><td>C</td></tr></table>',
    '<table><tr><td colspan="2">A</td></tr><tr><td>B</td></tr></table>',
    '<table><tr><td><i>A</i></td></tr></table>'
  ];
  for (const a of tables) for (const b of tables) {
    const detail = tableSimilarityDetails(a, b), expected = oracle(detail.expectedTree, detail.actualTree);
    assert.ok(Math.abs(detail.distance - expected) < 1e-12, `${a} vs ${b}`);
    assert.equal(tableSimilarity(a, b), detail.value);
    assert.ok(Math.abs(detail.value - Math.max(0, 1 - expected / detail.denominator)) < 1e-12);
  }
});
test('parser failures retain every denominator without claiming a parsed coordinate frame', () => {
  const score = scoreFailedPublicStructurePage(gold, 'research_image_too_large');
  assert.equal(score.status, 'failed'); assert.equal(score.coordinateVerified, false);
  const report = summarizePublicStructure([score]);
  assert.equal(report.ocr.cer, 1); assert.equal(report.tables.cellExactMatch, 0);
  assert.equal(report.formulas.normalizedExactMatch, 0);
});
test('normalization preserves scientific content and Unicode edit denominators', () => {
  assert.equal(normalizedLatex('$$ \\left(x\\; + y\\right) $$'), '(x+y)');
  assert.notEqual(normalizedLatex('x_1'), normalizedLatex('x_2'));
  assert.equal(editDistance([...'\u{1f600}中文'], [...'\u{1f600}中']), 1);
});
