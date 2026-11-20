import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {verifyScientificPaperStructure} from '../lib/scientific-paper-structure.mjs';

let structure, paper;
before(async () => {
  [structure, paper] = await Promise.all(['src/main/plugins/research/paper-structure.ts',
    'src/main/plugins/research/paper-ir.ts'].map(entry => importTypeScriptModule(entry, {platform: 'node'})));
});
const blocks = [{id: 'h', kind: 'heading', text: '2 Method', locator: 'p1'},
  {id: 'p', kind: 'paragraph', text: 'The dataset has accuracy of 92%.', locator: 'p2'}];
const identity = {paperId: 'paper', parseId: 'parse', sourceHash: 'a'.repeat(64)};
test('independent verifier validates production exact sources and multi-role output', () => {
  const result = verifyScientificPaperStructure(blocks, structure.buildPaperStructure(blocks), paper.paperBlocks(blocks, identity));
  assert.deepEqual(result.roles, {dataset: 1, metric: 1, method: 1});
  assert.equal(result.sections, 1); assert.equal(result.blocks, 2);
});
test('independent verifier rejects changed original intervals, identities, classifications and chunk text', () => {
  const original = structure.buildPaperStructure(blocks), chunks = paper.paperBlocks(blocks, identity);
  for (const mutate of [r => r.sections[0].title = 'Changed', r => r.sections[0].end = 4,
    r => r.sections[0].parentId = r.sections[0].id, r => r.blocks[1].sectionIds = ['missing'],
    r => r.blocks[1].blockId = 'absent', r => r.blocks[1].semantic.roles[0].confidence = 2]) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => verifyScientificPaperStructure(blocks, changed, chunks));
  }
  for (const mutate of [r => r[1].content = 'Rewritten', r => r[1].locator = 'invented',
    r => r[1].semantic.scientific.roles.pop()]) {
    const changed = structuredClone(chunks); mutate(changed);
    assert.throws(() => verifyScientificPaperStructure(blocks, original, changed));
  }
});
