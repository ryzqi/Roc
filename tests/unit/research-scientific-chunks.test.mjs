import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let chunks, builder, tables, equations, visuals, quality, tokenizer;
before(async () => {
  [chunks, builder, tables, equations, visuals, quality, tokenizer] = await Promise.all([
    'scientific-chunks', 'paper-ir-builder', 'pdf-table-extractor', 'pdf-equation-extractor',
    'pdf-caption-linker', 'pdf-quality-assessor', 'knowledge-chunks'
  ].map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node'})));
});
const identity = {paperId: 'paper', documentId: 'document', parseId: 'parse:one', knowledgeDocumentId: 'knowledge',
  sourceHash: 'a'.repeat(64), parserFingerprint: 'b'.repeat(64)};
const block = (id, kind, text, y) => ({id, kind, text, label: kind, locator: `page 1 ${id}`,
  imagePath: null, locations: [{page: 1, bbox: [10, y, 300, y + 20], coordinateOrigin: 'TOPLEFT'}]});
function source({long = false, missingTable = false} = {}) {
  const formula = long ? `x = ${'y + '.repeat(700)}z` : 'x = y \\tag{2}';
  const blocks = [
    block('body', 'paragraph', '2 Method\nOriginal method 🧪.\n\n'+(long ? '中文实验🧪原始段落。\n\n'.repeat(150) : '')+'3 Results\nOriginal result.', 10),
    block('algorithm', 'paragraph', 'Algorithm 1 Original procedure\n'+(long ? '1: Original long step 🧪\n'.repeat(100) : '1: Read original input\n')+'2: Return original output', 40),
    block('table-caption', 'paragraph', 'Table 1: Original measured results.', 70),
    block('table', 'table', 'Original table OCR text.', 95),
    block('figure', 'figure', '', 130),
    block('figure-caption', 'paragraph', 'Figure 1: Original architecture.', 155),
    block('equation', 'formula', formula, 190),
    block('definition', 'paragraph', 'where $x$ denotes the original input.', 220)
  ];
  const rows = long ? Array.from({length: 60}, (_, i) => `<tr><td>Original method ${i}</td><td>${i}</td></tr>`).join('') :
    '<tr><td rowspan="2">Original baseline</td><td>90</td></tr><tr><td>91</td></tr>';
  blocks[3].table = tables.extractPaperTable(blocks[3], missingTable ? undefined : {id: 'table',
    rawHtml: '<table><tr><th>Method</th><th>F1 (%)</th></tr>'+rows+'</table>'});
  const enriched = visuals.attachPaperVisuals(equations.attachPaperEquations(blocks, [{regions: [{id: 'equation', formula}]}]));
  return {sourceHash: identity.sourceHash, parserFingerprint: identity.parserFingerprint, blocks: enriched,
    quality: quality.assessPdfQuality({pages: [{page: 1, regions: [], coordinateFrame: {
      kind: 'image', page: 1, width: 400, height: 400, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT'}}], blocks: enriched})};
}
function ir(options) {return builder.buildPaperIR({identity, content: source(options)});}
test('seven scientific types preserve original source and table row/header/caption cell identities', () => {
  const paper = ir(), result = chunks.buildScientificChunks(paper, {tableTokens: 100});
  assert.deepEqual([...new Set(result.map(c => c.chunkType))].sort(),
    ['algorithm','caption','equation','figure','paragraph','table','table_row_group'].sort());
  for (const c of result) {
    assert.equal(c.sourceLocator.parseId, identity.parseId);
    assert.equal(c.sourceLocator.parseHash, paper.identity.parseHash);
    assert.equal(c.sourceLocator.objectId, c.objectId);
    assert.ok(c.inputVersion.startsWith('roc-paper-'));
    if (c.parentId) assert.ok(result.some(parent => parent.id === c.parentId && parent.objectId === c.objectId));
    assert.deepEqual(c.relationIds, paper.relations.filter(r => r.fromId === c.objectId || r.toId === c.objectId).map(r => r.id));
  }
  const tableRows = result.filter(c => c.chunkType === 'table_row_group');
  assert.ok(tableRows.length >= 2);
  for (const c of tableRows) {
    assert.match(c.embeddingText, /Method \| F1 \(%\)/);
    assert.match(c.embeddingText, /Table 1: Original measured results/);
    for (const cell of c.sources.filter(s => ['cell','header'].includes(s.field))) {
      const original = paper.tables[0].cells.find(v => v.id === cell.locator.objectId);
      assert.equal(cell.text, original.text);
      assert.equal(cell.locator.locations[0].bbox, null);
    }
  }
  const final = tableRows.find(c => c.selection.rows.includes(2));
  assert.ok(final.sources.some(s => s.text === 'Original baseline'));
  assert.ok(final.sources.some(s => s.text === '91'));
  assert.match(result.find(c => c.chunkType === 'figure').embeddingText, /Original architecture/);
});
test('long UTF16/CJK/emoji spans reconstruct every original character and respect token budgets', () => {
  const text = 'Original 🧪 中文实验。\r\n\r\n'.repeat(250);
  const spans = chunks.scientificTextSpans(text, 48);
  assert.equal(spans.map(s => text.slice(s.start,s.end)).join(''), text);
  for (const [i, span] of spans.entries()) {
    assert.equal(span.start, i ? spans[i-1].end : 0);
    assert.ok(tokenizer.chunkTokenCount(text.slice(span.start,span.end)) <= 48);
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(text.slice(span.start,span.end)));
    assert.ok(!/[\uD800-\uDBFF]$/u.test(text.slice(span.start,span.end)));
  }
  assert.throws(() => chunks.scientificTextSpans(text,0), /budget_invalid/);
});
test('long body respects original section parents; formula body never truncated and algorithm steps complete', () => {
  const paper = ir({long:true}), result = chunks.buildScientificChunks(paper, {paragraphTokens:64, algorithmTokens:64});
  const body = result.filter(c => c.objectId === paper.blocks[0].id);
  const parents = body.filter(c => c.parentId === null);
  assert.equal(parents.length,2);
  assert.deepEqual(parents.map(c => c.sectionPath.at(-1)), ['2 Method','3 Results']);
  assert.equal(parents.map(c => c.content).join(''),paper.blocks[0].text);
  for (const parent of parents) {
    const children = body.filter(c => c.parentId === parent.id);
    if (children.length) assert.equal(children.map(c => c.content).join(''),parent.content);
  }
  const formula = result.filter(c => c.chunkType === 'equation');
  assert.equal(formula.length,1);
  assert.equal(formula[0].content,paper.equations[0].data.rawLatex);
  assert.ok(formula[0].oversized); assert.ok(formula[0].retrieval);
  const algorithm = result.filter(c => c.chunkType === 'algorithm' && c.parentId !== null);
  assert.ok(algorithm.length > 1);
  assert.deepEqual(algorithm.flatMap(c => c.sources.map(s => s.locator.objectId)),paper.algorithms[0].steps.map(s => s.id));
  assert.deepEqual(algorithm.flatMap(c => c.sources.map(s => s.text)),paper.algorithms[0].steps.map(s => s.text));
});
test('missing table structure retains original OCR text and unknown visual content does not invent embedding facts', () => {
  const paper=ir({missingTable:true}), result=chunks.buildScientificChunks(paper);
  const fallback=result.find(c => c.chunkType === 'paragraph' && c.sourceLocator.blockId === 'table');
  assert.equal(fallback.content,'Original table OCR text.'); assert.ok(fallback.retrieval);
  assert.equal(fallback.sourceLocator.objectId,fallback.objectId);
  const copy=structuredClone(paper);
  copy.figures[0].data.captions=[]; copy.figures[0].data.references=[];
  copy.relations=copy.relations.filter(r => r.fromId!==copy.figures[0].id && r.toId!==copy.figures[0].id);
  const figure=chunks.buildScientificChunks(copy).find(c=>c.chunkType==='figure');
  assert.equal(figure.content,''); assert.equal(figure.retrieval,false);
});
test('source corruption rejects, repeats are deterministic and parse/policy versions cannot alias chunks', () => {
  const paper=ir(), result=chunks.buildScientificChunks(paper);
  assert.deepEqual(chunks.buildScientificChunks(paper),result);
  const next=builder.buildPaperIR({identity:{...identity,parseId:'parse:two'},content:source()});
  const ids=new Set(result.map(c=>c.id));
  assert.ok(chunks.buildScientificChunks(next).every(c=>!ids.has(c.id)));
  assert.ok(chunks.buildScientificChunks(paper,{tableTokens:300}).every(c=>!ids.has(c.id)));
  assert.throws(()=>chunks.buildScientificChunks(paper,{paragraphTokens:NaN}),/budget_invalid/);
  const bad=structuredClone(paper); bad.tables[0].cells[0].text='invented';
  assert.throws(()=>chunks.buildScientificChunks(bad));
});
