import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let extractor, schema, paper;
before(async () => {
  [extractor, schema, paper] = await Promise.all(['src/main/plugins/research/pdf-equation-extractor.ts',
    'src/shared/schemas/research-paper-equation.ts', 'src/main/plugins/research/paper-ir.ts']
    .map(entry => importTypeScriptModule(entry, {platform: 'node'})));
});
const block = (id, kind, text, page = 1, bbox = [10, 20, 210, 80]) => ({id, kind, text, label: kind, locator: `page ${page}`,
  imagePath: null, locations: [{page, bbox, coordinateOrigin: 'TOPLEFT'}]});
const raw = ' \r\n x + y = z \\tag{2}\r\n \\text{two  words} ';
const input = () => [block('before', 'paragraph', 'As shown in Eq. (2), the result follows.'),
  block('eq', 'formula', 'Original published normalized text.'), block('after', 'paragraph', 'where x denotes temperature; y represents pressure.')];
const pages = [{regions: [{id: 'eq', formula: raw}]}];

test('raw LaTeX, conservative normalization, explicit tag, exact prose definitions and references survive IR', () => {
  const blocks = extractor.attachPaperEquations(input(), pages), e = blocks[1].equation;
  assert.equal(e.rawLatex, raw); assert.equal(e.normalizedLatex, 'x + y = z \\tag{2}\n \\text{two  words}');
  assert.equal(blocks[1].text, input()[1].text); assert.equal(e.equationNumber, '2');
  assert.equal(e.numberEvidence.text, '\\tag{2}'); assert.equal(e.references.length, 1);
  assert.equal(e.references[0].evidence.text, 'Eq. (2)');
  assert.equal(e.variables.length, 2);
  assert.equal(e.variables[0].symbol, 'x'); assert.equal(e.variables[0].definition, 'temperature');
  for (const evidence of [...e.contexts, ...e.variables.map(v => v.evidence), ...e.references.map(r => r.evidence)]) schema.assertEquationEvidence(evidence, blocks);
  const chunks = paper.paperBlocks(blocks, {paperId: 'p', parseId: 'parse', sourceHash: 'a'.repeat(64)});
  assert.deepEqual(chunks[1].semantic.equation, e); assert.equal(chunks[1].content, blocks[1].text);
  assert.ok(e.variables.every(v => v.symbol !== 'z'), 'No definition may be guessed for z');
});

test('only a unique same-line number to the right of an equation supplies spatial numbering', () => {
  const source = [block('eq', 'formula', 'x=y'), block('n', 'paragraph', '(A.3)', 1, [220, 35, 245, 50])];
  assert.equal(extractor.attachPaperEquations(source, [{regions: [{id: 'eq', formula: 'x=y'}]}])[0].equation.equationNumber, 'A.3');
  source[1].text = '(3)';
  const e = extractor.attachPaperEquations(source, [{regions: [{id: 'eq', formula: 'x=y'}]}])[0].equation;
  assert.equal(e.equationNumber, '3'); assert.equal(e.numberEvidence.kind, 'block'); assert.equal(e.contexts.length, 0);
  source[1].locations[0].page = 2;
  assert.equal(extractor.attachPaperEquations(source, [{regions: [{id: 'eq', formula: 'x=y'}]}])[0].equation.equationNumber, null);
});

test('duplicate numbering produces candidate references and does not bind a unique target', () => {
  const blocks = [block('a', 'formula', 'a'), block('b', 'formula', 'b'), block('ref', 'paragraph', 'Equation 1. Eq. 10 is separate. 式 1。')];
  const result = extractor.attachPaperEquations(blocks, [{regions: [{id: 'a', formula: 'a\\tag{1}'}, {id: 'b', formula: 'b\\tag{1}'}]}]);
  for (const block of result.slice(0, 2)) {
    assert.equal(block.equation.references.length, 2);
    assert.ok(block.equation.references.every(r => r.status === 'candidate'));
    assert.ok(block.equation.warnings.includes('research_equation_number_ambiguous'));
  }
});

test('page-only equations never adopt an adjacent spatial number', () => {
  const source = [block('eq', 'formula', 'x=y'), block('n', 'paragraph', '(3)', 1, [220, 35, 245, 50])];
  source[0].locations = [{page: 1, bbox: null, coordinateOrigin: null}];
  const e = extractor.attachPaperEquations(source, [{regions: [{id: 'eq', formula: 'x=y'}]}])[0].equation;
  assert.equal(e.equationNumber, null); assert.equal(e.numberEvidence, null);
  assert.deepEqual(e.source, {page: 1, bbox: null, coordinateOrigin: null, locator: 'page 1'});
});

test('missing/invalid recognition is explicit; LaTeX tokens and escaped braces are retained', () => {
  const source = [block('eq', 'formula', 'not a LaTeX recognition')];
  const missing = extractor.attachPaperEquations(source, [{regions: []}])[0].equation;
  assert.equal(missing.status, 'missing'); assert.equal(missing.rawLatex, null);
  assert.equal(schema.latexHasBalancedBraces('\\{x\\}'), true);
  assert.equal(schema.latexHasBalancedBraces('}x{'), false);
  const invalid = extractor.attachPaperEquations(source, [{regions: [{id: 'eq', formula: '\\frac{x}{y'}]}])[0].equation;
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.rawLatex, '\\frac{x}{y');
  assert.throws(() => extractor.attachPaperEquations(source, [{regions: [{id: 'eq', formula: 'x'.repeat(schema.equationLatexLimit + 1)}]}]), /too_large/);
});

test('schema/source boundaries reject changed normalized tokens, locations, asset and quoted evidence', () => {
  const source = extractor.attachPaperEquations(input(), pages), original = source[1].equation;
  for (const mutate of [e => e.normalizedLatex = 'changed', e => e.id = 'other',
    e => e.source.locator = 'foreign', e => e.source.page = 2, e => e.assetId = 'asset',
    e => e.numberEvidence.text = 'fake', e => e.equationNumber = '999']) {
    const e = structuredClone(original); mutate(e);
    assert.throws(() => schema.assertPaperEquationBlock({...source[1], equation: e}));
  }
  const bad = structuredClone(original.variables[0].evidence); bad.text = 'bad'; bad.textSpan.end = bad.textSpan.start + 3;
  assert.throws(() => schema.assertEquationEvidence(bad, source), /evidence_invalid/);
  assert.throws(() => extractor.attachPaperEquations(input(), [{regions: [{id: 'eq'}, {id: 'eq'}]}]), /binding_invalid/);
});

test('multiple explicit tags retain ambiguity without selecting the first tag', () => {
  const e = extractor.attachPaperEquations([block('eq', 'formula', 'x')],
    [{regions: [{id: 'eq', formula: 'x\\tag{1}\\tag{2}'}]}])[0].equation;
  assert.equal(e.equationNumber, null);
  assert.ok(e.warnings.includes('research_equation_number_ambiguous'));
});
