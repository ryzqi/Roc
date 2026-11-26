import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, readFile, rename, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';
let api, contexts;
before(async () => {
  [api, contexts] = await Promise.all([loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-context-assembler.ts', {platform:'node',tempDir:'.runtime/tmp'})]);
});
after(() => api?.dispose());
const select = (search, kind) => search.candidates.filter(c => c.object.kind === kind).map(c => c.id);
test('context reads honor the query plan token ceiling and keep smaller caller budgets', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const request = f.request('Table 3');
    const plan = await f.router.plan(request);
    plan.maxContextTokens = 64;
    const search = await f.router.search(request, undefined, plan);
    for (const [requested, expected] of [[64_000, 64], [32, 32]]) {
      const context = await f.router.readContext({search, candidateIds: select(search, 'table'),
        budget: {maxTokens: requested}});
      assert.equal(context.budget.maxTokens, expected);
      assert.ok(context.usage.tokens <= expected);
      const rebuilt = await f.router.readContext({search, candidateIds: context.selectedCandidateIds,
        budget: context.budget});
      assert.deepEqual(rebuilt, context);
    }
  } finally {await f.close();}
});
test('table contexts merge matching rows and preserve original merged-cell anchors, headers and values', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const search = await f.router.search(f.request('Dataset C F1 Table 3'));
    const ids = select(search, 'table'), result = await f.router.readContext({search,candidateIds:ids});
    assert.ok(ids.length > 1);
    assert.equal(result.evidence.length, 1);
    const table = result.evidence[0];
    assert.deepEqual(table.candidateIds, ids);
    assert.equal(table.hits.length, ids.length);
    for (const candidate of search.candidates.filter(c => ids.includes(c.id))) {
      assert.deepEqual(table.hits.find(h => h.chunkId === candidate.chunkId).sources, candidate.sources);
    }
    assert.deepEqual(table.object.rows, [0,1,2]);
    const originals = f.ir.tables[0].cells;
    for (const cell of table.object.cells) {
      const original = originals.find(c => c.id === cell.id);
      assert.equal(cell.text, original.text);
      assert.deepEqual(cell.sourceLocator, original.sourceLocator);
    }
    assert.ok(table.object.cells.some(c => c.text === 'Original baseline' && c.rowSpan === 2));
    assert.ok(table.object.cells.some(c => c.text === '90'));
    assert.ok(table.object.cells.some(c => c.text === '91'));
    assert.ok(table.passages.some(p => p.role === 'experimental_setup' && p.text.includes('Dataset C')));
    assert.ok(table.passages.some(p => p.role === 'section_heading' && p.text === '2 Method'));
    assert.equal(result.usage.tokens, contexts.scientificContextTokens(result.evidence));
    assert.deepEqual(result.requestedConditions.splits, []);
    assert.equal(result.comparisonStatus, 'requires_validation');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});
test('equation and figure contexts keep complete formula definitions, linked captions and actual PNG bytes', async () => {
  const f = await scientificSearchFixture(api, {image:true});
  try {
    const search = await f.router.search(f.request('Equation (7) and Figure 2'));
    const result = await f.router.readContext({search,candidateIds:[...select(search,'equation'),...select(search,'figure')]});
    const equation = result.evidence.find(e => e.object.kind === 'equation');
    assert.equal(equation.object.data.rawLatex, 'x = y \\tag{7}');
    assert.equal(equation.object.data.equationNumber, '7');
    assert.ok(equation.object.data.variables.some(v => v.definition.includes('original input')));
    const figure = result.evidence.find(e => e.object.kind === 'figure');
    assert.ok(figure.object.data.captions.some(c => c.evidence.text.includes('Original architecture')));
    assert.ok(figure.hits[0].sources.some(s => s.text.includes('Original architecture')) ||
      figure.passages.some(p => p.role === 'caption' && p.text.includes('Original architecture')));
    assert.deepEqual([figure.image.width,figure.image.height], [96,64]);
    assert.equal(figure.image.assetId,'fixture-figure');
    assert.equal(figure.image.sha256,hash(f.imageBytes));
    assert.equal(hash(await readFile(join(f.root,figure.image.path))),figure.image.sha256);
    assert.equal(hash(await readFile(f.source)),hash(f.bytes));
  } finally {await f.close();}
});
test('native PDF text expands exact parent, same-section neighbors and original heading without changing spans', async () => {
  const f = await scientificSearchFixture(api,{objects:false});
  try {
    const search = await f.router.search(f.request('Original method'));
    const ids = search.candidates.filter(c => c.object.kind === 'text' && c.content.includes('Original method')).map(c => c.id);
    const result = await f.router.readContext({search,candidateIds:ids});
    assert.ok(result.evidence.length);
    for (const evidence of result.evidence) for (const passage of evidence.passages) {
      const original = f.ir.blocks.find(b => b.blockId === passage.sourceLocator.blockId);
      const span = passage.sourceLocator.textSpan;
      assert.equal(passage.text,span ? original.text.slice(span.start,span.end) : original.text);
    }
    assert.ok(result.evidence.some(e => e.passages.some(p => p.role === 'section_heading')));
  } finally {await f.close();}
});
test('whole-object, paragraph, per-paper, token, image count and dimension budgets produce explicit omissions', async () => {
  const f = await scientificSearchFixture(api,{image:true});
  try {
    const request = f.request('Table 3 Equation (7) Figure 2 method');
    const plan = await f.router.plan(request);
    plan.maxContextTokens = 64_000;
    const search = await f.router.search(request, undefined, plan);
    const candidateIds = [...select(search,'table'),...select(search,'equation'),...select(search,'figure')];
    for (const [budget,reason] of [
      [{maxObjects:1},'object_budget_exceeded'],[{maxEvidencePerPaper:1},'paper_evidence_budget_exceeded'],
      [{maxParagraphs:0},'paragraph_budget_exceeded'],[{maxTokens:32},'token_budget_exceeded'],
      [{maxImages:0},'image_budget_exceeded'],[{maxImageDimension:64},'image_dimension_budget_exceeded']
    ]) {
      const result = await f.router.readContext({search,candidateIds,budget:{maxTokens:64_000,...budget}});
      assert.ok(result.omissions.some(o => o.reason === reason),reason);
      for (const key of ['objects','paragraphs','tokens','images']) {
        const cap = {objects:'maxObjects',paragraphs:'maxParagraphs',tokens:'maxTokens',images:'maxImages'}[key];
        assert.ok(result.usage[key] <= result.budget[cap]);
      }
      for (const evidence of result.evidence) if (evidence.object.kind === 'equation') {
        assert.equal(evidence.object.data.rawLatex,'x = y \\tag{7}');
      }
    }
    const papers = await f.router.snapshots.capture(f.project.id,[f.generation],new AbortController().signal);
    const oversize = await contexts.assembleScientificContext({search,candidateIds:select(search,'figure')},papers,
      async (...args) => {
        const loaded = await f.router.snapshots.readImage(...args);
        return {...loaded,image:{...loaded.image,width:5000}};
      });
    assert.equal(oversize.usage.images,0);
    assert.ok(oversize.omissions.some(o => o.reason === 'image_dimension_budget_exceeded'));
  } finally {await f.close();}
});
test('caller-modified cell, raw content, locator and formula are rejected against canonical IR and chunks', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const saved = await f.router.search(f.request('Table 3 Equation (7)'));
    for (const field of ['cell','content','locator','equation']) {
      const search = structuredClone(saved);
      const candidate = search.candidates.find(c => c.object.kind === (field === 'equation' ? 'equation' : 'table'));
      if (field === 'cell') candidate.object.cells[0].text = '100';
      if (field === 'content') {candidate.content = 'forged'; candidate.contentHash = hash(candidate.content);}
      if (field === 'locator') candidate.sourceLocator.locations[0].page = 2;
      if (field === 'equation') candidate.object.data.rawLatex = 'invented = 999';
      await assert.rejects(f.router.readContext({search,candidateIds:[candidate.id]}),
        field === 'equation' ? /research_equation_binding_invalid/ : /context_candidate_invalid/);
    }
    await assert.rejects(f.router.readContext({search:saved,candidateIds:['absent']}),/context_selection_invalid/);
  } finally {await f.close();}
});
test('asset mutation and symlink substitution fail closed; cancellation and reparse invalidate an in-flight context', async () => {
  for (const change of ['asset','symlink','cancel','parse','source']) {
    const f = await scientificSearchFixture(api,{image:true});
    let release;
    try {
      const search = await f.router.search(f.request('Figure 2'));
      const request = {search,candidateIds:select(search,'figure')};
      if (change === 'asset') await writeFile(join(f.root,'parser','figure.png'),Buffer.from('changed'));
      if (change === 'symlink') {
        await rename(join(f.root,'parser','figure.png'),join(f.root,'figure-original.png'));
        await symlink(join(f.root,'figure-original.png'),join(f.root,'parser','figure.png'));
      }
      if (['asset','symlink'].includes(change)) {
        await assert.rejects(f.router.readContext(request),/image_changed|path_symlink/);
        continue;
      }
      const reader = f.router.snapshots.readImage;
      let enter; const entered = new Promise(resolve => {enter=resolve;});
      const wait = new Promise(resolve => {release=resolve;});
      f.router.snapshots.readImage = async (...args) => {enter();await wait;return reader(...args);};
      const abort = new AbortController();
      const pending = f.router.readContext(request,abort.signal);
      const rejected = assert.rejects(pending,/context-cancel|source_changed|source_size|source_hash/);
      await entered;
      if (change === 'cancel') abort.abort(new Error('context-cancel'));
      if (change === 'parse') await f.publish();
      if (change === 'source') await writeFile(f.source,Buffer.concat([f.bytes,Buffer.from('\n% changed')]));
      release(); await rejected;
    } finally {release?.();await f.close();}
  }
});

test('comparison and limitation intents expand exact conditions across sections without inventing text', async () => {
  const setup='We evaluate on Dataset Delta training split with batch size 32.';
  const limitation='Our method cannot handle long sequences.';
  const f=await scientificSearchFixture(api,{embedded:false,extraParagraphs:[
    {heading:'3 Experimental Setup',text:setup},{heading:'4 Limitations',text:limitation}]});
  try {
    const search=await f.router.search(f.request('Compare Equation (7) results and limitations'));
    const context=await f.router.readContext({search,candidateIds:select(search,'equation')});
    assert.equal(context.evidence.length,1);
    const passages=context.evidence[0].passages;
    assert.ok(passages.some(p=>p.role==='experimental_setup' && p.text===setup));
    assert.ok(passages.some(p=>p.role==='explanation' && p.text===limitation));
    for(const passage of passages) {
      const original=f.ir.blocks.find(b=>b.blockId===passage.sourceLocator.blockId),span=passage.sourceLocator.textSpan;
      assert.equal(passage.text,span?original.text.slice(span.start,span.end):original.text);
    }
    assert.equal(context.evidence[0].object.data.rawLatex,'x = y \\tag{7}');
  } finally {await f.close();}
});

test('algorithm context restores whole input output and steps when a selected algorithm chunk is partial', async () => {
  const text='Algorithm 1: Original procedure\nInput: x\n1. Read x\n2. Compute y\nOutput: y';
  const f=await scientificSearchFixture(api,{embedded:false,extraParagraphs:[{heading:'3 Method',text}]});
  try {
    const search=await f.router.search(f.request('Algorithm 1'));
    const selected=search.candidates.find(candidate=>candidate.object.kind==='algorithm');
    assert.ok(selected);
    const context=await f.router.readContext({search,candidateIds:[selected.id]});
    const evidence=context.evidence[0];
    assert.ok(evidence.hits.some(hit=>hit.content===text) || evidence.passages.some(passage=>passage.text===text));
    assert.equal(f.ir.algorithms[0].text,text);
  } finally {await f.close();}
});
