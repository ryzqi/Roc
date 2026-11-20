import { parseDocument } from 'htmlparser2';

export const structureScoringContract = Object.freeze({
  version: 1, track: 'public-raster-component-subset', officialLeaderboardCompatible: false,
  layout: 'category-collapsed-one-to-one-greedy-iou-0.5',
  predictionCategories: 'image-chart-header_image-to-figure;captions-to-text',
  text: 'NFC-space-collapse-region-CER-codepoints-WER-whitespace',
  order: 'all-gold-ordered-pairs-unmatched-pairs-incorrect',
  table: 'row-column-span-text-cell-exact-and-ordered-tree-TEDS',
  formula: 'delimiter-spacing-left-right-normalized-exact-no-symbolic-equivalence'
});

const text = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1,
      previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = current;
  }
  return previous[b.length];
}

export function normalizedLatex(value) {
  return String(value ?? '').normalize('NFC').trim().replace(/^\$\$?|\$\$?$/gu, '')
    .replace(/^\\[\[(]|\\[\])]$/gu, '').replace(/\\(?:left|right|quad|qquad)\b/gu, '')
    .replace(/\\[,;!:]/gu, '').replace(/\s+/gu, '');
}

function nodeText(node) {
  return node.type === 'text' ? node.data : (node.children ?? []).map(nodeText).join('');
}
function firstTable(html) {
  const root = parseDocument(String(html ?? ''), { decodeEntities: true });
  const find = node => node.name === 'table' ? node : (node.children ?? []).map(find).find(Boolean);
  return find(root) ?? null;
}
export function tableCells(html) {
  const table = firstTable(html);
  if (!table) return [];
  const rows = [];
  const collect = node => {
    if (node !== table && node.name === 'table') return;
    if (node.name === 'tr') { rows.push(node); return; }
    for (const child of node.children ?? []) collect(child);
  };
  collect(table);
  const cells = [], occupied = new Set();
  for (const [row, node] of rows.entries()) {
    let column = 0;
    for (const child of (node.children ?? []).filter(child => ['td', 'th'].includes(child.name))) {
      while (occupied.has(`${row}:${column}`)) column++;
      const rowspan = Number(child.attribs?.rowspan ?? 1), colspan = Number(child.attribs?.colspan ?? 1);
      if (![rowspan, colspan].every(n => Number.isInteger(n) && n > 0 && n <= 1000)) {
        throw new Error('scientific_public_table_span_invalid');
      }
      cells.push({ row, column, rowspan, colspan, text: text(nodeText(child)) });
      for (let y = row; y < row + rowspan; y++) for (let x = column; x < column + colspan; x++) {
        if (occupied.has(`${y}:${x}`)) throw new Error('scientific_public_table_overlap');
        occupied.add(`${y}:${x}`);
      }
      column += colspan;
    }
  }
  return cells;
}

function cellTokens(node) {
  if (node.type === 'text') return [...text(node.data)];
  if (!node.name) return (node.children ?? []).flatMap(cellTokens);
  return [`<${node.name}>`, ...(node.children ?? []).flatMap(cellTokens), `</${node.name}>`];
}
function tableTree(html) {
  const table = firstTable(html);
  if (!table) return null;
  const build = node => ({ tag: node.name, rowspan: node.attribs?.rowspan ?? '1',
    colspan: node.attribs?.colspan ?? '1', tokens: ['td', 'th'].includes(node.name)
      ? (node.children ?? []).flatMap(cellTokens) : [],
    children: ['td', 'th'].includes(node.name) ? []
      : (node.children ?? []).filter(child => child.name).map(build) });
  return build(table);
}

export const tableTreeScoringContract = Object.freeze({
  version: 'public-ordered-tree-v1', officialLeaderboardCompatible: false,
  parser: 'htmlparser2@12.0.0;first-table;decodeEntities=true',
  tree: 'tag-rowspan-colspan;cell-descendants-as-tokens;other-tag-children-in-order',
  tokens: 'NFC-space-collapse-trim-per-text-node;Unicode-codepoints;inline-tag-boundaries',
  distance: 'Zhang-Shasha-ordered-tree;delete-promotes-children;insert/delete=1',
  rename: 'different-tag/span=1;otherwise-cell-token-Levenshtein/max-token-length',
  normalization: 'max-reference-prediction-node-count;clamp-similarity-at-zero',
  maxTreeNodes: 4999
});

// Zhang-Shasha ordered tree edit distance, with fractional cell text rename
// cost. Deleting a node promotes its children; this is not subtree deletion.
// Keep the normalized trees and final distance so saved scoring artifacts can
// be independently inspected. Missing/unsupported trees never invent a distance.
export function tableSimilarityDetails(expectedHtml, actualHtml) {
  const expected = tableTree(expectedHtml), actual = tableTree(actualHtml);
  const postorder = root => {
    const nodes = [null], left = [0];
    const visit = node => {
      const children = node.children.map(visit), id = nodes.length;
      nodes.push(node); left.push(children.length ? left[children[0]] : id);
      return id;
    };
    if (root) visit(root);
    const last = new Map();
    left.slice(1).forEach((value, i) => last.set(value, i + 1));
    return { nodes, left, roots: [...last.values()].sort((a, b) => a - b) };
  };
  const a = postorder(expected), b = postorder(actual), n = a.nodes.length, m = b.nodes.length;
  const details = { contract: tableTreeScoringContract, expectedTree: expected, actualTree: actual,
    expectedNodes: n - 1, actualNodes: m - 1, denominator: Math.max(n - 1, m - 1) };
  if (!expected || !actual) return { ...details, status: 'missing-tree',
    reason: !expected ? 'reference-table-missing' : 'prediction-table-missing', distance: null, value: 0 };
  if (n > 5000 || m > 5000) return { ...details, status: 'unsupported',
    reason: 'scientific_public_table_size_limit', distance: null, value: null };
  const tree = Array.from({ length: n }, () => new Float64Array(m));
  const forest = Array.from({ length: n }, () => new Float64Array(m));
  const rename = (x, y) => {
    if (x.tag !== y.tag || x.rowspan !== y.rowspan || x.colspan !== y.colspan) return 1;
    const size = Math.max(x.tokens.length, y.tokens.length);
    return size ? editDistance(x.tokens, y.tokens) / size : 0;
  };
  for (const i of a.roots) for (const j of b.roots) {
    const ai = a.left[i], bj = b.left[j];
    forest[ai - 1][bj - 1] = 0;
    for (let x = ai; x <= i; x++) forest[x][bj - 1] = forest[x - 1][bj - 1] + 1;
    for (let y = bj; y <= j; y++) forest[ai - 1][y] = forest[ai - 1][y - 1] + 1;
    for (let x = ai; x <= i; x++) for (let y = bj; y <= j; y++) {
      const cost = a.left[x] === ai && b.left[y] === bj
        ? forest[x - 1][y - 1] + rename(a.nodes[x], b.nodes[y])
        : forest[a.left[x] - 1][b.left[y] - 1] + tree[x][y];
      forest[x][y] = Math.min(forest[x - 1][y] + 1, forest[x][y - 1] + 1, cost);
      if (a.left[x] === ai && b.left[y] === bj) tree[x][y] = forest[x][y];
    }
  }
  const distance = tree[n - 1][m - 1];
  return { ...details, status: 'scored', reason: null, distance,
    value: Math.max(0, 1 - distance / details.denominator) };
}

// Preserve the public component's existing scalar API and size-limit error.
export function tableSimilarity(expectedHtml, actualHtml) {
  const details = tableSimilarityDetails(expectedHtml, actualHtml);
  if (details.status === 'unsupported') throw new Error(details.reason);
  return details.value;
}

const goldCategory = type => ['figure', 'table'].includes(type) ? type
  : type === 'equation_isolated' ? 'formula'
    : ['text_mask', 'abandon'].includes(type) ? null : 'text';
const predictedCategory = type => type === 'table' ? 'table'
  : ['figure', 'image', 'chart', 'header_image'].includes(type) ? 'figure'
    : ['formula', 'equation'].includes(type) ? 'formula' : 'text';
function goldBox(poly) {
  if (!Array.isArray(poly) || poly.length !== 8 || poly.some(n => !Number.isFinite(n))) {
    throw new Error('scientific_public_polygon_invalid');
  }
  const xs = poly.filter((_, i) => i % 2 === 0), ys = poly.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function iou(a, b) {
  const area = box => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return intersection / (area(a) + area(b) - intersection || 1);
}

/** Independent raster-coordinate scoring. Unmatched gold stays in the
 * denominators; empty or failed predictions never receive success-shaped scores. */
export function scorePublicStructurePage(gold, structured) {
  if (structured.pages?.length !== 1) throw new Error('scientific_public_page_count_invalid');
  const page = structured.pages[0], frame = page.coordinateFrame;
  if (frame?.kind !== 'image' || frame.coordinateOrigin !== 'TOPLEFT'
    || frame.unit !== 'raster-pixel' || frame.width !== gold.page_info.width
    || frame.height !== gold.page_info.height) throw new Error('scientific_public_coordinate_mismatch');
  return scoreRegions(gold, page.regions);
}

export function scoreFailedPublicStructurePage(gold, failureCode) {
  if (typeof failureCode !== 'string' || !failureCode) throw new Error('scientific_public_failure_code_missing');
  return { ...scoreRegions(gold, []), status: 'failed', failureCode, coordinateVerified: false };
}

function scoreRegions(gold, regions) {
  const ignored = gold.layout_dets.filter(item => item.ignore || goldCategory(item.category_type) === null)
    .map(item => goldBox(item.poly));
  const expected = gold.layout_dets.filter(item => !item.ignore && goldCategory(item.category_type) !== null)
    .map(item => ({ ...item, category: goldCategory(item.category_type), bbox: goldBox(item.poly) }));
  const actual = regions.map((region, index) => {
    if (!Array.isArray(region.bbox) || region.bbox.length !== 4
      || region.bbox.some(n => !Number.isFinite(n)) || region.bbox[2] <= region.bbox[0]
      || region.bbox[3] <= region.bbox[1]) throw new Error('scientific_public_prediction_bbox_invalid');
    return { ...region, category: predictedCategory(region.type), index };
  }).filter(region => !ignored.some(box => iou(box, region.bbox) >= .5));
  const candidates = expected.flatMap((item, g) => actual.flatMap((region, p) => {
    const overlap = iou(item.bbox, region.bbox);
    return item.category === region.category && overlap >= .5 ? [{ g, p, overlap }] : [];
  })).sort((a, b) => b.overlap - a.overlap || a.g - b.g || a.p - b.p);
  const matches = new Map(), used = new Set();
  for (const candidate of candidates) if (!matches.has(candidate.g) && !used.has(candidate.p)) {
    matches.set(candidate.g, candidate.p); used.add(candidate.p);
  }
  const layout = Object.fromEntries(['text', 'table', 'figure', 'formula'].map(category => {
    const goldCount = expected.filter(item => item.category === category).length;
    const predicted = actual.filter(item => item.category === category).length;
    const tp = [...matches.keys()].filter(g => expected[g].category === category).length;
    return [category, { gold: goldCount, predicted, tp, fp: predicted - tp, fn: goldCount - tp }];
  }));
  const ocr = { characters: 0, characterEdits: 0, words: 0, wordEdits: 0 };
  const addText = (goldText, prediction) => {
    const a = text(goldText), b = text(prediction);
    ocr.characters += [...a].length; ocr.characterEdits += editDistance([...a], [...b]);
    const words = value => value ? value.split(' ') : [];
    ocr.words += words(a).length; ocr.wordEdits += editDistance(words(a), words(b));
  };
  const tables = [], formulas = [];
  for (const [g, item] of expected.entries()) {
    const prediction = matches.has(g) ? actual[matches.get(g)] : null;
    if (item.category === 'text') addText(item.text, prediction?.text);
    else if (item.category === 'formula') {
      if (!normalizedLatex(item.latex)) throw new Error('scientific_public_formula_gold_missing');
      formulas.push({ annoId: item.anno_id, matched: prediction !== null,
        exact: prediction !== null && normalizedLatex(item.latex) === normalizedLatex(prediction.formula ?? prediction.text) });
    } else if (item.category === 'table') {
      const goldCells = tableCells(item.html);
      if (!goldCells.length) throw new Error('scientific_public_table_gold_missing');
      // Paddle's html is only a thead/tbody fragment. fullHtml contains the
      // table root and, for matched output, the actual OCR cell text.
      const html = prediction?.tableMatches?.fullHtml || prediction?.tableMatches?.html
        || prediction?.table?.fullHtml || prediction?.table?.html || '';
      const cells = tableCells(html);
      const cellKey = cell => `${cell.row}:${cell.column}`;
      const byPosition = new Map(cells.map(cell => [cellKey(cell), cell]));
      const exact = goldCells.filter(cell => JSON.stringify(cell) === JSON.stringify(byPosition.get(cellKey(cell)))).length;
      tables.push({ annoId: item.anno_id, matched: prediction !== null, goldCells: goldCells.length,
        predictedCells: cells.length, exactCells: exact, teds: html ? tableSimilarity(item.html, html) : 0 });
    }
  }
  actual.forEach((region, p) => { if (!used.has(p) && region.category === 'text') addText('', region.text); });
  const ordered = expected.map((item, g) => ({ item, g })).filter(({ item }) => Number.isFinite(item.order))
    .sort((a, b) => a.item.order - b.item.order || a.g - b.g);
  let correctPairs = 0, totalPairs = 0;
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    if (ordered[i].item.order === ordered[j].item.order) continue;
    totalPairs++;
    const left = matches.get(ordered[i].g), right = matches.get(ordered[j].g);
    if (left !== undefined && right !== undefined && actual[left].index < actual[right].index) correctPairs++;
  }
  return { layout, ocr, readingOrder: { correctPairs, totalPairs }, tables, formulas,
    ignoredGold: ignored.length, matches: [...matches].map(([g, p]) => ({
      annoId: expected[g].anno_id, regionId: actual[p].id, category: expected[g].category,
      iou: iou(expected[g].bbox, actual[p].bbox) })) };
}

export function summarizePublicStructure(scores) {
  const sum = (select, key) => scores.reduce((value, score) => value + select(score)[key], 0);
  const layout = Object.fromEntries(['text', 'table', 'figure', 'formula'].map(category => {
    const totals = Object.fromEntries(['gold', 'predicted', 'tp', 'fp', 'fn']
      .map(key => [key, sum(score => score.layout[category], key)]));
    const denominator = 2 * totals.tp + totals.fp + totals.fn;
    return [category, { ...totals, f1: denominator ? 2 * totals.tp / denominator : null }];
  }));
  const tp = Object.values(layout).reduce((sum, row) => sum + row.tp, 0);
  const size = Object.values(layout).reduce((sum, row) => sum + row.gold + row.predicted, 0);
  const ocr = Object.fromEntries(['characters', 'characterEdits', 'words', 'wordEdits'].map(key => [key, sum(s => s.ocr, key)]));
  const order = Object.fromEntries(['correctPairs', 'totalPairs'].map(key => [key, sum(s => s.readingOrder, key)]));
  const tables = scores.flatMap(score => score.tables), formulas = scores.flatMap(score => score.formulas);
  const goldCells = tables.reduce((sum, table) => sum + table.goldCells, 0);
  return { pages: scores.length, layout, layoutMicroF1: size ? 2 * tp / size : null,
    ocr: { ...ocr, cer: ocr.characters ? ocr.characterEdits / ocr.characters : null,
      wer: ocr.words ? ocr.wordEdits / ocr.words : null },
    readingOrder: { ...order, pairRecall: order.totalPairs ? order.correctPairs / order.totalPairs : null },
    tables: { count: tables.length, matched: tables.filter(row => row.matched).length, goldCells,
      cellExactMatch: goldCells ? tables.reduce((sum, row) => sum + row.exactCells, 0) / goldCells : null,
      meanTeds: tables.length ? tables.reduce((sum, row) => sum + row.teds, 0) / tables.length : null },
    formulas: { count: formulas.length, matched: formulas.filter(row => row.matched).length,
      normalizedExactMatch: formulas.length ? formulas.filter(row => row.exact).length / formulas.length : null } };
}
