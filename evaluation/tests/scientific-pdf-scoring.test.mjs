import assert from 'node:assert/strict';
import test from 'node:test';
import { hash } from '../lib/common.mjs';
import { matchScientificRegions, normalizeScientificPdfBox, scientificBoxIou, scientificTableCells,
  scoreScientificPdfPaper } from '../lib/scientific-pdf-scoring.mjs';
import { observeScientificPdfStructure } from '../adapters/scientific-pdf.mjs';
import { scientificPdfArguments } from '../../scripts/score-scientific-pdf.mjs';

// Fabricated engineering fixtures, never human gold or scientific measurements.
const sourceHash = hash('synthetic-only');
const html = '<table><tr><td rowspan="2"> A &amp; B </td><td>C</td></tr><tr><td>D</td></tr></table>';
const gold = () => ({
  schemaVersion: 1, annotationVersion: 'scientific-gold-v1', paperId: 'test-paper', sourceHash, parseRef: null,
  coordinateSystem: 'TOPLEFT_NORMALIZED', pages: [{ page: 1, transcript: ' A  😀中\ne\u0301 ' }],
  blocks: ['text', 'table', 'equation', 'figure'].map((kind, i) => ({
    blockId: `g-${i}`, page: 1, kind, text: '', readingOrder: i, bbox: [0, i / 4, 1, (i + 1) / 4] })),
  expectedSections: [{ id: 'section', title: 'Test', blockIds: ['g-0'] }],
  expectedTables: [{ id: 't', blockId: 'g-1', html, cells: scientificTableCells(html) }],
  expectedEquations: [{ id: 'e', blockId: 'g-2', latex: 'x_1=1', normalizedLatex: 'x_1=1',
    normalizationVersion: 'latex-nfc-v1' }],
  expectedFigures: [{ id: 'f', blockId: 'g-3', caption: 'Test caption' }], expectedCitations: [],
  review: { status: 'draft', annotations: [], arbitration: null }
});
const observation = () => ({ sourceHash, parseRef: null, status: 'parsed', failureCode: null,
  pages: [{ page: 1, transcript: gold().pages[0].transcript,
    predictions: gold().blocks.map((b, i) => ({ id: `p-${i}`, kind: b.kind, bbox: b.bbox, text: '', order: i,
      tableHtml: b.kind === 'table' ? html : null, latex: b.kind === 'equation' ? 'x_1=1' : null,
      assetVerified: b.kind === 'figure' })) }] });
const frame = () => ({ kind: 'pdf', page: 1, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT',
  width: 150, height: 90, viewport: { width: 150, height: 90, scale: 1.5, rotation: 90, userUnit: 1,
    viewBox: [10, 20, 70, 120], transform: [0, 1.5, 1.5, 0, -30, -15] } });

test('rotated and cropped coordinates retain inverse PDF projection and float viewport normalization', () => {
  const converted = normalizeScientificPdfBox(frame(), [15, 9, 90, 54]);
  assert.deepEqual(converted.pdfBox, [16, 30, 46, 80]);
  assert.deepEqual(converted.bbox, [.1, .1, .6, .6]);
  assert.equal(converted.edgeRoundingClipped, false);
  const fractional = frame();
  fractional.viewport.width = 150.4; fractional.viewport.height = 90.6; fractional.height = 91;
  const edge = normalizeScientificPdfBox(fractional, [0, 0, 150, 91]);
  assert.equal(edge.bbox[2], 150 / 150.4); assert.equal(edge.bbox[3], 1);
  assert.ok(edge.normalizedUnclipped[3] > 1); assert.equal(edge.edgeRoundingClipped, true);
  const invalid = frame(); invalid.viewport.transform = [0, 0, 0, 0, 0, 0];
  assert.throws(() => normalizeScientificPdfBox(invalid, [0, 0, 10, 10]), /transform_invalid/);
  assert.throws(() => normalizeScientificPdfBox(frame(), [0, 0, 151, 10]), /bbox_invalid/);
});

test('maximum matching repairs the greedy IoU counterexample and enforces same classes', () => {
  const g = [{ blockId: 'wide', kind: 'text', bbox: [0, 0, .6, 1] },
    { blockId: 'narrow', kind: 'text', bbox: [0, 0, .4, 1] }];
  const p = [{ id: 'shared', kind: 'text', bbox: [0, 0, .5, 1] },
    { id: 'wide-only', kind: 'text', bbox: [.15, 0, .75, 1] }];
  assert.deepEqual(matchScientificRegions(g, p).map(m => [m.goldId, m.predictionId]),
    [['wide', 'wide-only'], ['narrow', 'shared']]);
  p[1].kind = 'caption';
  assert.equal(matchScientificRegions(g, p).length, 1);
});

test('independent exhaustive oracle confirms maximum cardinality for 80 varied small layouts', () => {
  const best = (g, p, index = 0, used = new Set()) => {
    if (index === g.length) return 0;
    let count = best(g, p, index + 1, used);
    p.forEach((row, j) => {
      if (!used.has(j) && g[index].kind === row.kind && scientificBoxIou(g[index].bbox, row.bbox) >= .5) {
        count = Math.max(count, 1 + best(g, p, index + 1, new Set([...used, j])));
      }
    });
    return count;
  };
  for (let seed = 0; seed < 80; seed++) {
    const boxes = (offset, id) => Array.from({ length: 4 }, (_, i) => {
      const left = ((seed * 7 + i * 3 + offset) % 9) / 20;
      return { [id]: `${id}-${i}`, kind: (seed + i + offset) % 5 ? 'text' : 'caption',
        bbox: [left, 0, left + .5, 1] };
    });
    const g = boxes(0, 'blockId'), p = boxes(2, 'id'), matches = matchScientificRegions(g, p);
    assert.equal(matches.length, best(g, p), `seed ${seed}`);
    assert.equal(new Set(matches.map(m => m.predictionId)).size, matches.length);
    assert.deepEqual(matches, matchScientificRegions(g, p));
  }
});

test('exact engineering fixture scores NFC text/order/objects while caption provenance stays null', () => {
  const score = scoreScientificPdfPaper(gold(), observation());
  assert.equal(score.metrics.cer.value, 0); assert.equal(score.metrics.wer.value, 0);
  assert.equal(score.metrics.cer.denominator, [...gold().pages[0].transcript.normalize('NFC')].length);
  for (const metric of ['layoutMicroF1', 'readingOrder', 'cellExactMatch', 'teds',
    'normalizedLatexExactMatch', 'figureAssetLocator']) assert.equal(score.metrics[metric].value, 1);
  assert.equal(score.metrics.captionLocator.value, null);
  assert.equal(score.scientificBaselineReady, false);
  assert.equal(score.scores[0].matches[0].goldId, 'g-0');
  const saved = JSON.parse(JSON.stringify(score)).scores[0].tables[0];
  assert.equal(saved.tedsDetails.status, 'scored'); assert.equal(saved.tedsDetails.distance, 0);
  assert.equal(saved.tedsDetails.expectedNodes, 6); assert.equal(saved.tedsDetails.actualNodes, 6);
  assert.deepEqual(saved.tedsDetails.expectedTree, saved.tedsDetails.actualTree);
});

test('CER preserves extra spaces and punctuation; WER is explicitly whitespace based', () => {
  const o = observation(); o.pages[0].transcript = o.pages[0].transcript.replace('  ', ' ').replace('中', '中!');
  const m = scoreScientificPdfPaper(gold(), o).metrics;
  assert.equal(m.cer.numerator, 2); assert.ok(m.wer.value > 0);
  o.pages[0].transcript += ' extra output';
  assert.ok(scoreScientificPdfPaper(gold(), o).metrics.cer.numerator > 2);
});

test('failures and missing objects retain all gold denominators', () => {
  const o = { sourceHash, parseRef: null, status: 'failed', failureCode: 'test-failure', pages: [] };
  const score = scoreScientificPdfPaper(gold(), o), m = score.metrics;
  assert.equal(m.failedPages, 1);
  assert.equal(m.cer.value, 1); assert.equal(m.wer.value, 1);
  for (const key of ['layoutMicroF1', 'readingOrder', 'cellExactMatch', 'teds',
    'normalizedLatexExactMatch', 'figureAssetLocator']) assert.equal(m[key].value, 0);
  assert.equal(m.readingOrder.denominator, 6); assert.equal(m.cellExactMatch.denominator, 3);
  assert.equal(score.scores[0].tables[0].tedsDetails.status, 'missing-tree');
  assert.equal(score.scores[0].tables[0].tedsDetails.distance, null);
  assert.equal(score.scores[0].tables[0].tedsDetails.expectedNodes, 6);
  o.status = 'parsed'; o.failureCode = null;
  assert.throws(() => scoreScientificPdfPaper(gold(), o), /status_invalid/);
});

test('duplicates, reversed order, malformed tables and changed formula symbols cannot earn credit', () => {
  const o = observation();
  o.pages[0].predictions.reverse().forEach((p, i) => { p.order = i; });
  o.pages[0].predictions.find(p => p.kind === 'table').tableHtml = '<table><tr><td rowspan="-1">A</td></tr></table>';
  o.pages[0].predictions.find(p => p.kind === 'equation').latex = 'x_2=1';
  const report = scoreScientificPdfPaper(gold(), o);
  assert.equal(report.metrics.readingOrder.value, 0);
  assert.equal(report.metrics.cellExactMatch.value, 0);
  assert.equal(report.metrics.normalizedLatexExactMatch.value, 0);
  assert.match(report.scores[0].tables[0].error, /span_invalid/);
  assert.equal(report.scores[0].tables[0].teds, 0);
  assert.equal(report.scores[0].tables[0].tedsDetails.status, 'invalid-prediction');
  assert.equal(report.scores[0].tables[0].tedsDetails.actualTree, null);
  assert.equal(report.scores[0].tables[0].tedsDetails.distance, null);
  const duplicate = structuredClone(o.pages[0].predictions[0]); duplicate.id = 'extra'; duplicate.order = 4;
  o.pages[0].predictions.push(duplicate);
  assert.equal(scoreScientificPdfPaper(gold(), o).metrics.layout.figure.fp, 1);
  duplicate.id = 'p-3';
  assert.throws(() => scoreScientificPdfPaper(gold(), o), /duplicate_prediction_id/);
});

test('table cells preserve whitespace/entities/merged spans and gold HTML must agree with cells', () => {
  const cells = scientificTableCells(html);
  assert.deepEqual(cells.map(c => [c.row, c.column, c.rowSpan, c.text]),
    [[0, 0, 2, ' A & B '], [0, 1, 1, 'C'], [1, 1, 1, 'D']]);
  const o = observation(); o.pages[0].predictions[1].tableHtml = html.replace(' A &amp; B ', 'A &amp; B');
  assert.equal(scoreScientificPdfPaper(gold(), o).metrics.cellExactMatch.value, 2 / 3);
  const g = gold(); g.expectedTables[0].cells[0].text = 'A & B';
  assert.throws(() => scoreScientificPdfPaper(g, observation()), /html_cells_mismatch/);
  const alternative = gold(); alternative.expectedTables[0].cells.reverse();
  assert.equal(scoreScientificPdfPaper(alternative, observation()).metrics.cellExactMatch.value, 1);
  assert.throws(() => scientificTableCells('<table><tr><td>A</td></tr></table><table></table>'), /root_invalid/);
  assert.throws(() => scientificTableCells('<table><tr><td rowspan="2">A</td></tr></table>'), /span_invalid/);
});

test('source/parse identity changes, incomplete gold and unsupported normalization fail closed', () => {
  const g = gold(), o = observation();
  assert.throws(() => scoreScientificPdfPaper(g, { ...o, sourceHash: hash('different') }), /source_mismatch/);
  g.parseRef = { parseId: 'parse-1', parseHash: hash('parse'), parserFingerprint: hash('fp') };
  assert.throws(() => scoreScientificPdfPaper(g, o), /parse_ref_mismatch/);
  assert.equal(scoreScientificPdfPaper(g, { ...o, parseRef: g.parseRef }).metrics.cer.value, 0);
  g.parseRef = null; g.expectedEquations[0].normalizationVersion = 'unreviewed-other';
  assert.throws(() => scoreScientificPdfPaper(g, o), /latex_contract_mismatch/);
  g.expectedEquations = [];
  assert.throws(() => scoreScientificPdfPaper(g, o), /object_annotation_missing/);
});

test('unsupported TEDS size is incomplete with a reason while valid cell exact match remains measured', () => {
  const large = `<table>${'<tr><td>A</td><td>B</td><td>C</td><td>D</td><td>E</td></tr>'.repeat(1000)}</table>`;
  const g = gold(), o = observation();
  g.expectedTables[0].html = large; g.expectedTables[0].cells = scientificTableCells(large);
  o.pages[0].predictions[1].tableHtml = large;
  const score = scoreScientificPdfPaper(g, o), m = score.metrics;
  assert.equal(m.cellExactMatch.value, 1); assert.equal(m.cellExactMatch.denominator, 5000);
  assert.equal(m.teds.value, null); assert.equal(m.teds.naReason, 'teds-scorer-unsupported');
  assert.match(m.teds.errors[0].error, /size_limit/);
  const detail = score.scores[0].tables[0].tedsDetails;
  assert.equal(detail.status, 'unsupported'); assert.equal(detail.expectedNodes, 6001);
  assert.equal(detail.actualNodes, 6001); assert.equal(detail.distance, null);
  assert.equal(detail.expectedTree.children.length, 1000);
});

test('empty transcripts and singleton order are NA with insertion counts preserved', () => {
  const g = gold(); g.pages[0].transcript = ''; g.blocks = [g.blocks[0]];
  g.expectedTables = []; g.expectedFigures = []; g.expectedEquations = [];
  const o = observation(); o.pages[0].predictions = [o.pages[0].predictions[0]]; o.pages[0].transcript = 'extra';
  const m = scoreScientificPdfPaper(g, o).metrics;
  assert.equal(m.cer.value, null); assert.equal(m.cer.numerator, 5);
  assert.equal(m.readingOrder.value, null); assert.equal(m.cellExactMatch.value, null);
  assert.equal(m.cer.naReason, 'empty-reference-transcript');
  assert.equal(m.cer.applicablePages, 0);
  assert.equal(m.cer.naPages[0].paperId, 'test-paper');
});

test('prediction adapter retains native blocks, rich-only objects and explicit failures', () => {
  const f = frame(), block = { id: 'native', kind: 'paragraph', text: 'Actual output', imagePath: null,
    locations: [{ page: 1, bbox: [0, 0, 150, 90], coordinateOrigin: 'TOPLEFT' }] };
  const row = { sourceHash, status: 'parsed', failure: null, parserFingerprint: hash('parser'), pageCount: 1,
    artifacts: [{ path: 'equation.png', sha256: hash('bytes') }] };
  const structured = { parserFingerprint: row.parserFingerprint, coordinateFrameContractVersion: 1,
    assets: [{ path: 'equation.png', page: 1 }],
    blocks: [block], pages: [{ page: 1, text: 'Native sidecar must not replace output', coordinateFrame: f, regions: [
      { id: 'rich-only', type: 'formula', text: 'x=1', formula: 'x=1', bbox: [15, 9, 90, 54], imagePath: 'equation.png' }
    ] }] };
  const o = observeScientificPdfStructure(row, structured);
  assert.equal(o.pages[0].transcript, 'Actual output');
  assert.deepEqual(o.pages[0].predictions.map(p => p.kind), ['text', 'equation']);
  assert.equal(o.pages[0].predictions[1].assetVerified, true);
  assert.equal(o.pages[0].predictions[1].blockId, null);
  assert.equal(o.pages[0].predictions[1].order, null);
  structured.pages[0].regions.push({ id: block.id, type: 'text', text: ' Actual  output ',
    bbox: block.locations[0].bbox, imagePath: null });
  const normalized = observeScientificPdfStructure(row, structured);
  assert.equal(normalized.pages[0].predictions[0].text, 'Actual output');
  assert.equal(normalized.pages[0].predictions[0].regionText, ' Actual  output ');
  structured.pages[0].regions.pop();
  structured.pages[0].regions[0].id = block.id;
  assert.throws(() => observeScientificPdfStructure(row, structured), /region_block_mismatch/);
  row.status = 'failed'; row.failure = { code: 'test-failure' };
  assert.deepEqual(observeScientificPdfStructure(row, null).pages, []);
});

test('CLI requires explicit observation mode or qualified gold and rejects ambiguous flags', () => {
  const args = ['--run', 'run', '--source-root', 'source', '--output', 'out'];
  assert.equal(scientificPdfArguments([...args, '--observe']).manifestPath, null);
  assert.match(scientificPdfArguments(args).manifestPath, /scientific-rag\/manifest.json$/);
  assert.throws(() => scientificPdfArguments([...args, '--observe', '--manifest', 'gold']), /arguments_invalid/);
  assert.throws(() => scientificPdfArguments([...args, '--output', 'again']), /arguments_invalid/);
});
