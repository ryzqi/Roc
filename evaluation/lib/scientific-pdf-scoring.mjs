import { parseDocument } from 'htmlparser2';
import { hash } from './common.mjs';
import { scientificAnnotationSchema } from './scientific-rag-corpus.mjs';
import { editDistance, tableSimilarityDetails } from '../adapters/scientific-public/structure.mjs';

export const scientificPdfScoringContract = Object.freeze({
  version: 2, status: 'Draft-agent-reviewed', coordinate: 'rotated-CropBox-TOPLEFT_NORMALIZED',
  layout: 'same-class-IoU>=0.5-maximum-cardinality-deterministic-augmenting-path',
  transcript: 'production-block-text-in-output-order-joined-with-two-LF-per-page',
  cer: 'NFC-codepoints-preserve-whitespace-and-punctuation',
  wer: 'whitespace-v1;not-linguistic-Chinese-segmentation',
  order: 'all-gold-page-pairs-unmatched-endpoints-incorrect',
  cells: 'row-column-rowSpan-columnSpan-NFC-text-preserve-whitespace',
  teds: 'public-ordered-tree-v1;custom-space-collapse-cell-token-cost',
  tedsArtifact: 'normalized-reference/prediction-trees-node-counts-final-distance-denominator-status',
  latex: 'latex-nfc-v1;no-symbolic-equivalence',
  caption: 'unscored-independent-caption-locator-required'
});

const kinds = ['heading', 'text', 'table', 'figure', 'equation', 'caption', 'reference', 'algorithm', 'other'];
function requireValue(condition, code) { if (!condition) throw new Error(`scientific_scoring_${code}`); }
const unique = (values, code) => requireValue(new Set(values).size === values.length, code);
const words = value => value.trim() ? value.trim().split(/\s+/u) : [];
export const scientificNormalizedLatex = value => value.normalize('NFC');

/** The captured viewport already includes CropBox, rotation and UserUnit.
 * Preserve the inverse projection for audit; normalize by the FLOAT viewport,
 * not its rounded raster dimensions. Only raster edge rounding is clipped. */
export function normalizeScientificPdfBox(frame, bbox) {
  requireValue(frame?.kind === 'pdf' && frame.unit === 'raster-pixel'
    && frame.coordinateOrigin === 'TOPLEFT' && Number.isInteger(frame.page) && frame.page > 0,
  'frame_invalid');
  const v = frame.viewport;
  requireValue(v && [v.width, v.height, v.scale, v.userUnit].every(x => Number.isFinite(x) && x > 0)
    && [0, 90, 180, 270].includes(v.rotation)
    && frame.width === Math.round(v.width) && frame.height === Math.round(v.height)
    && Array.isArray(v.viewBox) && v.viewBox.length === 4 && v.viewBox.every(Number.isFinite)
    && v.viewBox[2] > v.viewBox[0] && v.viewBox[3] > v.viewBox[1]
    && Array.isArray(v.transform) && v.transform.length === 6 && v.transform.every(Number.isFinite),
  'viewport_invalid');
  requireValue(Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
    && bbox[0] >= 0 && bbox[1] >= 0 && bbox[2] > bbox[0] && bbox[3] > bbox[1]
    && bbox[2] <= frame.width && bbox[3] <= frame.height, 'bbox_invalid');
  const [a, b, c, d, e, f] = v.transform, det = a * d - b * c;
  requireValue(Number.isFinite(det) && det !== 0, 'transform_invalid');
  const points = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]]
    .map(([x, y]) => [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det]);
  const normalizedUnclipped = [bbox[0] / v.width, bbox[1] / v.height, bbox[2] / v.width, bbox[3] / v.height];
  return { rasterBox: [...bbox], pdfBox: [Math.min(...points.map(p => p[0])),
    Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))],
  normalizedUnclipped, bbox: normalizedUnclipped.map(x => Math.max(0, Math.min(1, x))),
  edgeRoundingClipped: normalizedUnclipped.some(x => x < 0 || x > 1), frameHash: hash(frame) };
}

export function scientificBoxIou(a, b) {
  const area = box => (box[2] - box[0]) * (box[3] - box[1]);
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return intersection / (area(a) + area(b) - intersection || 1);
}

/** Cardinality takes priority over a locally higher IoU. Stable input order
 * and descending-IoU adjacency freeze otherwise equivalent maximum matches. */
export function matchScientificRegions(gold, predictions) {
  const edges = gold.map(g => predictions.flatMap((p, index) => {
    const overlap = scientificBoxIou(g.bbox, p.bbox);
    return g.kind === p.kind && overlap >= .5 ? [{ index, overlap }] : [];
  }).sort((a, b) => b.overlap - a.overlap || a.index - b.index));
  const owners = new Map();
  const augment = (g, seen) => {
    for (const { index } of edges[g]) {
      if (seen.has(index)) continue;
      seen.add(index);
      if (!owners.has(index) || augment(owners.get(index), seen)) { owners.set(index, g); return true; }
    }
    return false;
  };
  gold.forEach((_, index) => augment(index, new Set()));
  return [...owners].map(([p, g]) => ({ goldId: gold[g].blockId, predictionId: predictions[p].id,
    goldIndex: g, predictionIndex: p, kind: gold[g].kind, iou: scientificBoxIou(gold[g].bbox, predictions[p].bbox) }))
    .sort((a, b) => a.goldIndex - b.goldIndex);
}

/** Strict table/cell interpretation for exact match. Unlike the raster
 * scorer, this never trims or collapses reference/prediction cell text. */
export function scientificTableCells(html) {
  requireValue(typeof html === 'string', 'table_html_invalid');
  const root = parseDocument(html, { decodeEntities: true }), tables = [];
  const collectTables = node => {
    if (node.name === 'table') tables.push(node);
    for (const child of node.children ?? []) collectTables(child);
  };
  collectTables(root);
  requireValue(tables.length === 1, 'table_root_invalid');
  const rows = [], table = tables[0];
  const collectRows = node => {
    if (node.name === 'tr') { rows.push(node); return; }
    for (const child of node.children ?? []) collectRows(child);
  };
  collectRows(table);
  requireValue(rows.length > 0 && rows.length <= 1000, 'table_rows_invalid');
  const nodeText = node => node.type === 'text' ? node.data : (node.children ?? []).map(nodeText).join('');
  const occupied = new Set(), cells = [];
  rows.forEach((rowNode, row) => {
    let column = 0;
    for (const node of rowNode.children.filter(node => ['td', 'th'].includes(node.name))) {
      while (occupied.has(`${row}:${column}`)) column++;
      const rowSpan = Number(node.attribs.rowspan ?? 1), columnSpan = Number(node.attribs.colspan ?? 1);
      requireValue([rowSpan, columnSpan].every(n => Number.isInteger(n) && n > 0 && n <= 1000)
        && rowSpan * columnSpan <= 10000 && row + rowSpan <= rows.length, 'table_span_invalid');
      for (let y = row; y < row + rowSpan; y++) for (let x = column; x < column + columnSpan; x++) {
        const address = `${y}:${x}`;
        requireValue(!occupied.has(address), 'table_overlap'); occupied.add(address);
      }
      cells.push({ row, column, rowSpan, columnSpan, text: nodeText(node).normalize('NFC') });
      requireValue(cells.length <= 5000 && occupied.size <= 100000, 'table_size_limit');
      column += columnSpan;
    }
  });
  requireValue(cells.length > 0, 'table_cells_missing');
  return cells;
}

function checkGold(gold) {
  gold = scientificAnnotationSchema.parse(gold);
  unique(gold.pages.map(p => p.page), 'duplicate_gold_page');
  requireValue(gold.pages.every(p => p.page <= gold.pages.length), 'gold_pages_incomplete');
  unique(gold.blocks.map(b => b.blockId), 'duplicate_gold_block');
  unique(gold.blocks.map(b => `${b.page}:${b.readingOrder}`), 'duplicate_gold_order');
  for (const b of gold.blocks) requireValue(b.page <= gold.pages.length && b.bbox[2] <= 1
    && b.bbox[3] <= 1 && b.bbox[2] > b.bbox[0] && b.bbox[3] > b.bbox[1], 'gold_bbox_invalid');
  const blocks = new Map(gold.blocks.map(b => [b.blockId, b]));
  unique([...gold.expectedTables, ...gold.expectedEquations, ...gold.expectedFigures].map(o => o.id),
    'duplicate_gold_object');
  for (const [key, kind] of [['expectedTables', 'table'], ['expectedEquations', 'equation'], ['expectedFigures', 'figure']]) {
    unique(gold[key].map(o => o.blockId), 'duplicate_gold_object_block');
    requireValue(gold[key].every(o => blocks.get(o.blockId)?.kind === kind), 'gold_object_block_invalid');
    requireValue(gold.blocks.filter(b => b.kind === kind).every(b => gold[key].some(o => o.blockId === b.blockId)),
      'gold_object_annotation_missing');
  }
  const orderedCells = cells => [...cells].sort((a, b) => a.row - b.row || a.column - b.column);
  for (const table of gold.expectedTables) requireValue(hash(orderedCells(scientificTableCells(table.html)))
    === hash(orderedCells(table.cells.map(c => ({ ...c, text: c.text.normalize('NFC') })))), 'gold_html_cells_mismatch');
  for (const equation of gold.expectedEquations) requireValue(equation.normalizationVersion === scientificPdfScoringContract.latex.split(';')[0]
    && equation.normalizedLatex === scientificNormalizedLatex(equation.latex), 'gold_latex_contract_mismatch');
  return gold;
}

/** Pure scoring is engineering evidence until the caller separately qualifies
 * human provenance, PDF bytes, page geometry and immutable parse receipts. */
export function scoreScientificPdfPaper(annotation, observation) {
  const gold = checkGold(annotation);
  requireValue(observation.sourceHash === gold.sourceHash, 'source_mismatch');
  if (gold.parseRef) requireValue(hash(gold.parseRef) === hash(observation.parseRef), 'parse_ref_mismatch');
  requireValue(['parsed', 'failed'].includes(observation.status)
    && (observation.status === 'failed' ? typeof observation.failureCode === 'string' && observation.failureCode.length > 0
      && observation.pages.length === 0 : observation.failureCode === null
      && observation.pages.length === gold.pages.length), 'observation_status_invalid');
  unique(observation.pages.map(p => p.page), 'duplicate_prediction_page');
  const byPage = new Map(observation.pages.map(p => [p.page, p])), scores = [];
  for (const page of [...gold.pages].sort((a, b) => a.page - b.page)) {
    const actual = byPage.get(page.page);
    requireValue(observation.status === 'failed' || actual, 'prediction_page_missing');
    const predicted = actual?.predictions ?? [], expected = gold.blocks.filter(b => b.page === page.page);
    unique(predicted.map(p => p.id), 'duplicate_prediction_id');
    unique(predicted.filter(p => p.order !== null).map(p => p.order), 'duplicate_prediction_order');
    for (const p of predicted) requireValue(kinds.includes(p.kind) && typeof p.text === 'string'
      && (p.order === null || Number.isInteger(p.order) && p.order >= 0) && p.bbox.length === 4 && p.bbox.every(Number.isFinite)
      && p.bbox[0] >= 0 && p.bbox[1] >= 0 && p.bbox[2] <= 1 && p.bbox[3] <= 1
      && p.bbox[2] > p.bbox[0] && p.bbox[3] > p.bbox[1], 'prediction_invalid');
    const matches = matchScientificRegions(expected, predicted), map = new Map(matches.map(m =>
      [m.goldId, predicted[m.predictionIndex]]));
    const reference = page.transcript.normalize('NFC'), output = (actual?.transcript ?? '').normalize('NFC');
    const referenceWords = words(reference), outputWords = words(output);
    const layout = Object.fromEntries(kinds.map(kind => {
      const tp = matches.filter(m => m.kind === kind).length, goldCount = expected.filter(b => b.kind === kind).length;
      const predictionCount = predicted.filter(p => p.kind === kind).length;
      return [kind, { gold: goldCount, predicted: predictionCount, tp, fp: predictionCount - tp, fn: goldCount - tp }];
    }));
    const ordered = [...expected].sort((a, b) => a.readingOrder - b.readingOrder);
    let correctPairs = 0, totalPairs = 0;
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      totalPairs++;
      const a = map.get(ordered[i].blockId), b = map.get(ordered[j].blockId);
      if (a && b && Number.isInteger(a.order) && Number.isInteger(b.order) && a.order < b.order) correctPairs++;
    }
    const tables = gold.expectedTables.filter(t => expected.some(b => b.blockId === t.blockId)).map(table => {
      const prediction = map.get(table.blockId), html = prediction?.tableHtml ?? null;
      let cells = [], error = null;
      if (html) { try { cells = scientificTableCells(html); } catch (e) { error = e.message; } }
      const expectedCells = table.cells.map(c => ({ ...c, text: c.text.normalize('NFC') }));
      const keys = new Set(expectedCells.map(c => `${c.row}:${c.column}`));
      const actualCells = new Map(cells.map(c => [`${c.row}:${c.column}`, hash(c)]));
      const exactCells = expectedCells.filter(g => actualCells.get(`${g.row}:${g.column}`) === hash(g)).length;
      // Invalid HTML/cell structure is a measured miss. Preserve the reference
      // tree, and do not score the rejected prediction's first-table subset.
      const tedsDetails = tableSimilarityDetails(table.html, error ? '' : html);
      if (error) { tedsDetails.status = 'invalid-prediction'; tedsDetails.reason = error; }
      if (tedsDetails.status === 'unsupported') error = tedsDetails.reason;
      return { id: table.id, predictionId: prediction?.id ?? null, goldCells: expectedCells.length,
        predictedCells: cells.length, exactCells, extraCells: cells.filter(c => !keys.has(`${c.row}:${c.column}`)).length,
        teds: tedsDetails.value, tedsDetails, error,
        referenceHtmlHash: hash(table.html), predictionHtmlHash: html ? hash(html) : null };
    });
    const equations = gold.expectedEquations.filter(e => expected.some(b => b.blockId === e.blockId)).map(equation => {
      const prediction = map.get(equation.blockId), latex = prediction?.latex ?? null;
      return { id: equation.id, predictionId: prediction?.id ?? null, originalLatex: latex,
        normalizedLatex: latex === null ? null : scientificNormalizedLatex(latex),
        exact: latex !== null && scientificNormalizedLatex(latex) === equation.normalizedLatex };
    });
    const figures = gold.expectedFigures.filter(f => expected.some(b => b.blockId === f.blockId)).map(figure => {
      const prediction = map.get(figure.blockId);
      return { id: figure.id, predictionId: prediction?.id ?? null,
        assetLocatorMatched: Boolean(prediction?.assetVerified), captionLocatorMatched: null,
        captionReason: 'independent-caption-locator-gold-missing' };
    });
    scores.push({ paperId: gold.paperId, page: page.page, status: observation.status, failureCode: observation.failureCode,
      text: { characters: [...reference].length, characterEdits: editDistance([...reference], [...output]),
        words: referenceWords.length, wordEdits: editDistance(referenceWords, outputWords),
        referenceHash: hash(reference), predictionHash: hash(output) },
      layout, readingOrder: { correctPairs, totalPairs }, matches, tables, equations, figures });
  }
  return { paperId: gold.paperId, sourceHash: gold.sourceHash, annotationHash: hash(gold),
    observationHash: hash(observation), status: observation.status, failureCode: observation.failureCode,
    scores, metrics: summarizeScientificPdfScores(scores), scientificBaselineReady: false };
}

export function summarizeScientificPdfScores(scores) {
  const total = (select, key) => scores.reduce((n, s) => n + select(s)[key], 0);
  const ratio = (value, denominator, reason) => ({ value: denominator ? value / denominator : null,
    numerator: value, denominator, naReason: denominator ? null : reason });
  const layout = Object.fromEntries(kinds.map(kind => {
    const sums = Object.fromEntries(['gold', 'predicted', 'tp', 'fp', 'fn'].map(k => [k, total(s => s.layout[kind], k)]));
    return [kind, { ...sums, f1: ratio(2 * sums.tp, 2 * sums.tp + sums.fp + sums.fn, 'no-regions') }];
  }));
  const regions = Object.values(layout), tables = scores.flatMap(s => s.tables);
  const equations = scores.flatMap(s => s.equations), figures = scores.flatMap(s => s.figures);
  const pageRatio = (numerator, denominator, reason) => ({
    ...ratio(total(s => s.text, numerator), total(s => s.text, denominator), reason),
    applicablePages: scores.filter(s => s.text[denominator] > 0).length,
    naPages: scores.filter(s => s.text[denominator] === 0).map(s => ({ paperId: s.paperId, page: s.page, reason }))
  });
  return { pages: scores.length, failedPages: scores.filter(s => s.status === 'failed').length,
    cer: pageRatio('characterEdits', 'characters', 'empty-reference-transcript'),
    wer: pageRatio('wordEdits', 'words', 'empty-reference-words'),
    layout, layoutMicroF1: ratio(regions.reduce((n, r) => n + 2 * r.tp, 0),
      regions.reduce((n, r) => n + r.gold + r.predicted, 0), 'no-regions'),
    readingOrder: { ...ratio(total(s => s.readingOrder, 'correctPairs'), total(s => s.readingOrder, 'totalPairs'),
      'fewer-than-two-gold-blocks'), applicablePages: scores.filter(s => s.readingOrder.totalPairs > 0).length,
      naPages: scores.filter(s => s.readingOrder.totalPairs === 0).map(s => ({ paperId: s.paperId, page: s.page,
        reason: 'fewer-than-two-gold-blocks' })) },
    cellExactMatch: ratio(tables.reduce((n, t) => n + t.exactCells, 0), tables.reduce((n, t) => n + t.goldCells, 0),
      'no-gold-tables'), extraTableCells: tables.reduce((n, t) => n + t.extraCells, 0),
    teds: tables.some(t => t.teds === null)
      ? { value: null, numerator: null, denominator: tables.length, naReason: 'teds-scorer-unsupported',
        errors: tables.filter(t => t.teds === null).map(t => ({ id: t.id, error: t.error })) }
      : ratio(tables.reduce((n, t) => n + t.teds, 0), tables.length, 'no-gold-tables'),
    normalizedLatexExactMatch: ratio(equations.filter(e => e.exact).length, equations.length, 'no-gold-equations'),
    figureAssetLocator: ratio(figures.filter(f => f.assetLocatorMatched).length, figures.length, 'no-gold-figures'),
    captionLocator: { value: null, denominator: figures.length, naReason: 'independent-caption-locator-gold-missing' } };
}
