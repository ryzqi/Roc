import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let structure, schema, paper;
before(async () => {
  [structure, schema, paper] = await Promise.all(['src/main/plugins/research/paper-structure.ts',
    'src/shared/schemas/research-paper-structure.ts', 'src/main/plugins/research/paper-ir.ts']
    .map(entry => importTypeScriptModule(entry, {platform: 'node'})));
});
const b = (id, text, kind = 'paragraph', extra = {}) => ({id, text, kind, locator: id, ...extra});
const identity = {paperId: 'paper', parseId: 'parse', sourceHash: 'a'.repeat(64)};
const input = () => [b('title', 'Exact Paper Title', 'heading', {label: 'title'}),
  b('abstract', 'Abstract', 'heading'), b('a', 'We propose a method.'),
  b('method', '2 Method', 'heading'), b('m', 'Original method text.'),
  b('dataset', '2.1 Dataset', 'heading'), b('d', 'The dataset has labels.'),
  b('results', '3 Results', 'heading'), b('r', 'The dataset accuracy improves by 4%.'),
  b('ref', 'References', 'heading'), b('citation', 'Dataset accuracy ablation papers.')];

test('exact source section tree retains titles, categories, skipped levels and parent references', () => {
  const blocks = input(), result = structure.buildPaperStructure(blocks);
  schema.assertPaperStructure(result, blocks);
  assert.deepEqual(result.sections.map(s => s.category), ['title', 'abstract', 'method', 'experiments', 'results', 'references']);
  assert.equal(result.sections.find(s => s.blockId === 'dataset').parentId, result.sections.find(s => s.blockId === 'method').id);
  assert.deepEqual(result.blocks.find(s => s.blockId === 'd').sectionIds,
    result.sections.filter(s => ['method', 'dataset'].includes(s.blockId)).map(s => s.id));
  for (const section of result.sections) assert.equal(blocks.find(b => b.id === section.blockId).text.slice(section.start, section.end), section.title);
  const skipped = structure.buildPaperStructure([b('h', '1 Introduction', 'heading'), b('s', '1.2.3 Detail', 'heading')]);
  assert.equal(skipped.sections.length, 2); assert.equal(skipped.sections[1].level, 3);
  assert.equal(skipped.sections[1].parentId, skipped.sections[0].id);
});

test('blocks carry independent dataset, metric and result roles; no entire-results-chapter inference', () => {
  const result = structure.buildPaperStructure(input());
  assert.deepEqual(result.blocks.find(b => b.blockId === 'r').semantic.roles.map(r => r.role), ['dataset', 'metric', 'result']);
  assert.deepEqual(result.blocks.find(b => b.blockId === 'm').semantic.roles.map(r => r.role), ['method']);
  assert.equal(result.blocks.find(b => b.blockId === 'citation').semantic.status, 'not_applicable');
  const unknown = structure.buildPaperStructure([b('h', 'Results', 'heading'), b('b', 'This sentence is uncertain.')]);
  assert.equal(unknown.blocks[1].semantic.status, 'unknown'); assert.deepEqual(unknown.blocks[1].semantic.roles, []);
  assert.ok(result.blocks.every(b => b.semantic.classifierVersion === 'roc-paper-semantic-rules/1'));
});

test('caption, page margins and body references cannot create a new chapter', () => {
  const marked = role => ({reading: {role}});
  const blocks = [b('h', 'Results', 'heading'), b('margin', '2 Method', 'heading', marked('page_header')),
    b('cap', 'Figure 1: Method', 'heading', marked('caption')), b('body', '3 experiments were conducted.'),
    b('body2', 'As shown in Figure 1, the method is effective.')];
  const result = structure.buildPaperStructure(blocks);
  assert.equal(result.sections.length, 1);
  assert.deepEqual(result.blocks[1].sectionIds, []); assert.equal(result.blocks[2].semantic.status, 'not_applicable');
  assert.equal(structure.scientificHeading('3 experiments were conducted.'), null);
});

test('native paragraph embedded headings retain UTF-16 and CRLF offsets without rewriting text', () => {
  const text = '😀 Original.\r\n2 Method\r\nExact original.\r\n2.1 Architecture\r\n尾部';
  const blocks = [b('page1', text), b('page2', 'The architecture continues.')];
  const result = structure.buildPaperStructure(blocks), chunks = paper.paperBlocks(blocks, identity);
  assert.equal(result.sections[0].start, text.indexOf('2 Method'));
  assert.equal(result.sections[1].start, text.indexOf('2.1 Architecture'));
  assert.equal(chunks[0].content, text); assert.equal(chunks[0].locator, 'page1');
  assert.deepEqual(chunks[1].semantic.sectionPath, ['2 Method', '2.1 Architecture']);
  assert.deepEqual(chunks[1].semantic.sectionIds, result.sections.map(s => s.id));
  assert.equal(chunks[1].semantic.scientific.roles[0].role, 'method');
});

test('multilingual unnumbered chapters include conclusion, discussion, appendix and references', () => {
  for (const name of ['Conclusion', 'Discussion', 'Appendix A', 'References', '结论', '讨论', '附录 A', '参考文献']) {
    assert.ok(structure.scientificHeading(name), name);
    const result = structure.buildPaperStructure([b('h', name)]);
    assert.equal(result.sections.length, 1, name);
    assert.notEqual(result.sections[0].category, 'unknown', name);
  }
});

test('publication rejects altered titles, offsets, cycles, missing paths, duplicates and role shape', () => {
  const blocks = input(), result = structure.buildPaperStructure(blocks);
  for (const mutate of [r => r.sections[0].title = 'Invented', r => r.sections[0].start = 1,
    r => r.sections[0].parentId = r.sections.at(-1).id, r => r.sections.push(r.sections[0]),
    r => r.blocks[0].sectionIds = ['absent'], r => r.blocks.pop(),
    r => r.blocks[1].blockId = r.blocks[0].blockId]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => schema.assertPaperStructure(changed, blocks));
  }
  assert.throws(() => schema.paperBlockSemanticSchema.parse({version: 1, classifierVersion: 'v1', status: 'unknown',
    roles: [{role: 'result', source: 'rule', confidence: .9, signals: []}]}));
  assert.throws(() => structure.buildPaperStructure([b('same', 'a'), b('same', 'b')]));
});
