import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';

let api, refs, schemas, validator;
before(async () => {
  [api, refs, schemas, validator] = await Promise.all([
    loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/research/scientific-source-ref.ts', {platform:'node'}),
    importTypeScriptModule('src/shared/schemas/research-scientific-source-ref.ts'),
    importTypeScriptModule('src/main/plugins/research/scientific-fact-validator.ts', {platform:'node'})
  ]);
});
after(() => api?.dispose());

test('retrieval and extraction project the same original equation, cell and text identities without changing evidence', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const search = await f.router.search(f.request('Table 3 Equation (7) Figure 2 Dataset C'));
    const receipt = search.snapshot.generations[0], sourceRefs = refs.createScientificSourceRefs(receipt, f.ir);
    const before = structuredClone(search);
    for (const candidate of search.candidates) {
      const ref = sourceRefs.fromCandidate(candidate);
      if (candidate.objectType === 'metadata' || candidate.objectType === 'citation') {
        assert.equal(ref, null);
        continue;
      }
      assert.equal(ref.paperIrHash, receipt.paperIR.sha256);
      assert.equal(ref.generationId, receipt.generationId);
      assert.deepEqual(ref.locator, candidate.sourceLocator);
      sourceRefs.assertBound(ref);
    }
    const equation = search.candidates.find(candidate => candidate.object.kind === 'equation');
    assert.ok(equation);
    const equationSource = validator.validateScientificSource({kind:'object', objectType:'Equation', objectId:equation.objectId}, f.ir);
    assert.deepEqual(sourceRefs.fromSource(equationSource), sourceRefs.fromCandidate(equation));
    const table = f.ir.tables[0], cell = table.cells.find(cell => cell.text === '90');
    const cellSource = validator.validateScientificSource({kind:'table_cell', tableId:table.id, cellId:cell.id, raw:cell.text}, f.ir);
    const cellRef = sourceRefs.fromSource(cellSource);
    assert.equal(cellRef.objectType, 'table_cell');
    assert.equal(cellRef.objectId, cell.id);
    assert.deepEqual(cellRef.locator, cell.sourceLocator);
    const body = f.ir.blocks.find(block => block.blockId === 'body'), start = 9, end = 20;
    const text = validator.validateScientificSource({kind:'text', blockId:body.blockId,
      start, end, quote:body.text.slice(start, end)}, f.ir);
    const textRef = sourceRefs.fromSource(text);
    assert.equal(textRef.objectId, body.id);
    assert.deepEqual(textRef.locator.textSpan, {start, end});
    assert.equal(sourceRefs.fromSource(validator.validateScientificSource({kind:'metadata', field:'title', raw:f.ir.metadata.title}, f.ir)), null);
    assert.deepEqual(search, before);
    assert.equal(equationSource.quote, f.ir.equations[0].data.rawLatex);
    assert.equal(cellSource.quote, '90');
  } finally {await f.close();}
});

test('refs reject mixed identities, stale generation or IR, substituted object types and modified source geometry', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const search = await f.router.search(f.request('Table 3 Equation (7)'));
    const receipt = search.snapshot.generations[0], sourceRefs = refs.createScientificSourceRefs(receipt, f.ir);
    const equation = search.candidates.find(candidate => candidate.object.kind === 'equation');
    const valid = sourceRefs.fromCandidate(equation);
    for (const field of ['generationId', 'paperIrHash', 'documentId', 'parseId', 'sourceHash', 'parseHash', 'parserFingerprint',
      'paperId', 'knowledgeDocumentId', 'objectId', 'objectType', 'bbox', 'block', 'span']) {
      const ref = structuredClone(valid);
      if (field === 'bbox') ref.locator.locations[0].bbox[0]++;
      else if (field === 'block') ref.locator.blockId = 'body';
      else if (field === 'span') ref.locator.textSpan = {start:0, end:1};
      else if (field === 'objectType') ref.objectType = 'table';
      else ref[field] = field.endsWith('Hash') || field === 'parserFingerprint' ? hash('changed') : 'changed';
      assert.throws(() => sourceRefs.assertBound(ref), /research_scientific_source_ref_/, field);
    }
    const mixed = {...valid, locator:{...valid.locator, parseId:'other'}};
    assert.equal(schemas.scientificSourceRefSchema.safeParse(mixed).success, false);
    const changedArtifact = structuredClone(receipt);
    changedArtifact.paperIR.sha256 = hash('forged');
    assert.throws(() => refs.createScientificSourceRefs(changedArtifact, f.ir), /paper_ir_artifact_changed/);
    const cell = f.ir.tables[0].cells.find(cell => cell.text === '90');
    const original = validator.validateScientificSource({kind:'table_cell', tableId:f.ir.tables[0].id, cellId:cell.id, raw:'90'}, f.ir);
    assert.throws(() => sourceRefs.fromSource({...original, quote:'100'}), /fact_source_version_invalid/);
    const body = f.ir.blocks.find(block => block.blockId === 'body');
    const text = validator.validateScientificSource({kind:'text', blockId:body.blockId, start:0, end:5, quote:body.text.slice(0, 5)}, f.ir);
    const textRef = sourceRefs.fromSource(text);
    textRef.locator.textSpan.end = body.text.length + 1;
    assert.throws(() => sourceRefs.assertBound(textRef), /source_ref_locator_invalid/);
  } finally {await f.close();}
});

test('source updates reject old refs while historical IR remains readable and project membership still gates reads', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const search = await f.router.search(f.request('Equation (7)'));
    const receipt = search.snapshot.generations[0];
    const oldRefs = refs.createScientificSourceRefs(receipt, f.ir);
    const original = oldRefs.fromCandidate(search.candidates.find(candidate => candidate.object.kind === 'equation'));
    const newer = await f.publish(), next = await f.router.search(f.request('Equation (7)'));
    const currentRefs = refs.createScientificSourceRefs(next.snapshot.generations[0], newer.ir);
    assert.throws(() => currentRefs.assertBound(original), /source_ref_changed/);
    await assert.rejects(f.router.assertCurrent(search), /search_source_changed/);
    oldRefs.assertBound(original);
    assert.deepEqual(await new api.PaperIRRepository(f.root).read(receipt.paperIR), f.ir);
    f.repository.library.link(f.document.libraryItemId, f.project.id, false, {notify:true});
    await assert.rejects(f.router.assertCurrent(next), /scope_invalid|source_changed/);
  } finally {await f.close();}
});

test('identity projections cannot make changed PDF bytes current', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const search = await f.router.search(f.request('Equation (7)'));
    const sourceRefs = refs.createScientificSourceRefs(search.snapshot.generations[0], f.ir);
    const original = sourceRefs.fromCandidate(search.candidates.find(candidate => candidate.object.kind === 'equation'));
    await writeFile(f.source, Buffer.concat([f.bytes, Buffer.from('\n% source changed')]));
    sourceRefs.assertBound(original); // Contract validity never implies current bytes or authorization.
    await assert.rejects(f.router.assertCurrent(search), /source_changed|source_size|source_hash/);
  } finally {await f.close();}
});

test('caller mutations cannot rewrite captured locator, identity or text interval authority', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const search = await f.router.search(f.request('Equation (7) Dataset C'));
    const receipt = structuredClone(search.snapshot.generations[0]), ir = structuredClone(f.ir);
    const sourceRefs = refs.createScientificSourceRefs(receipt, ir);
    const equation = structuredClone(search.candidates.find(candidate => candidate.object.kind === 'equation'));
    const original = sourceRefs.fromCandidate(equation), altered = structuredClone(original);
    ir.equations[0].sourceLocator.rawLocator = 'rewritten after capture';
    altered.locator.rawLocator = ir.equations[0].sourceLocator.rawLocator;
    assert.throws(() => sourceRefs.assertBound(altered), /source_ref_locator_invalid/);
    equation.sourceLocator = altered.locator;
    assert.throws(() => sourceRefs.fromCandidate(equation), /source_ref_locator_invalid/);
    sourceRefs.assertBound(original);

    const paragraph = structuredClone(search.candidates.find(candidate => candidate.objectType === 'paragraph'));
    const block = ir.blocks.find(block => block.blockId === paragraph.sourceLocator.blockId), length = block.text.length;
    block.text += ' forged suffix';
    paragraph.sourceLocator.textSpan = {start:0, end:length + 1};
    assert.throws(() => sourceRefs.fromCandidate(paragraph), /source_ref_locator_invalid/);

    const metadata = structuredClone(search.candidates.find(candidate => candidate.objectType === 'metadata'));
    assert.ok(metadata);
    ir.identity.paperId = 'forged-paper'; receipt.paperIR.identity.paperId = 'forged-paper'; metadata.paperId = 'forged-paper';
    assert.throws(() => sourceRefs.fromCandidate(metadata), /source_ref_changed/);
  } finally {await f.close();}
});

test('extracted sources remain bound before and after lazy source-validator creation', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const search = await f.router.search(f.request('Equation (7)'));
    for (const initialized of [false, true]) {
      const ir = structuredClone(f.ir), sourceRefs = refs.createScientificSourceRefs(search.snapshot.generations[0], ir);
      const original = validator.validateScientificSource({kind:'metadata', field:'title', raw:ir.metadata.title}, ir);
      if (initialized) assert.equal(sourceRefs.fromSource(original), null);
      ir.metadata.title = 'Caller substituted title';
      const altered = validator.validateScientificSource({kind:'metadata', field:'title', raw:ir.metadata.title}, ir);
      assert.throws(() => sourceRefs.fromSource(altered), initialized ? /fact_metadata_invalid/ : /paper_ir_artifact_changed/);
      if (initialized) assert.equal(sourceRefs.fromSource(original), null);
    }
  } finally {await f.close();}
});
