import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture, hash} from './fixtures/scientific-search-fixture.mjs';

let api, toolsApi, snapshots, orchestrator;
before(async () => {
  [api, toolsApi, snapshots, orchestrator] = await Promise.all([
    loadScientificSearchApi(),
    importTypeScriptModule('src/main/plugins/agent/scientific-tools.ts',
      {platform:'node', tempDir:'.runtime/tmp', external:['@langchain/core/tools', 'zod']}),
    importTypeScriptModule('src/main/plugins/research/scientific-search-snapshot.ts',
      {platform:'node', tempDir:'.runtime/tmp', external:['@napi-rs/canvas']}),
    importTypeScriptModule('src/main/plugins/research/scientific-query-orchestrator.ts', {platform:'node', tempDir:'.runtime/tmp'})
  ]);
});
after(() => api?.dispose());
const ids = (search, kind) => search.candidates.filter(c => c.object.kind === kind).map(c => c.id);
const savedContext = async f => {
  const search = await f.router.search(f.request('Dataset C Table 3 Equation (7) Figure 2'));
  search.plan.maxContextTokens = 64_000;
  const context = await f.router.readContext({search,
    candidateIds:[...ids(search, 'table'), ...ids(search, 'equation'), ...ids(search, 'figure')],
    budget:{maxTokens:64_000}});
  return {search, context};
};
const rawStatements = context => {
  const table = context.evidence.find(e => e.object.kind === 'table');
  const cell = table.object.cells.find(c => c.text === '90');
  const equation = context.evidence.find(e => e.object.kind === 'equation');
  const source = table.passages.find(p => p.text.includes('Original method'));
  return [
    {id:'quote', kind:'quote', evidenceId:table.id, sourceLocator:source.sourceLocator,
      start:0, end:source.text.length, text:source.text},
    {id:'cell', kind:'table_value', evidenceId:table.id, objectId:table.objectId, cellId:cell.id, text:cell.text},
    {id:'equation', kind:'equation', evidenceId:equation.id, objectId:equation.objectId,
      text:equation.object.data.rawLatex}
  ];
};
const capability = (f, calls = []) => ({invoke:async (name, request, signal) => {
  calls.push({name, request:structuredClone(request)});
  if (name === 'research.knowledge.scientificQuery') return new orchestrator.ScientificQueryOrchestrator(f.router, f.embeddings).search(request, signal);
  if (name === 'research.knowledge.scientificContext') return f.router.readContext(request, signal);
  if (name === 'research.knowledge.scientificEvidence') return f.router.validateEvidence(request, signal);
  assert.fail(`unexpected capability ${name}`);
}});

test('exact original quotes, cells and complete equations are supported after source and context reconstruction', async () => {
  const f = await scientificSearchFixture(api, {image:true});
  try {
    const saved = await savedContext(f), statements = rawStatements(saved.context);
    const result = await f.router.validateEvidence({...saved, statements});
    assert.equal(result.sourceStatus, 'valid');
    assert.equal(result.answerStatus, 'supported');
    assert.equal(result.canAnswerAsFacts, true);
    assert.ok(result.statements.every(s => s.sourceStatus === 'valid' && s.supportStatus === 'supported'));
    assert.deepEqual(result.statements.map(s => s.text), statements.map(s => s.text));
    assert.equal(result.contextId, saved.context.id);
    assert.equal(hash(await readFile(f.source)), hash(f.bytes));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('raw value support cannot establish an expanded claim, inference or cross-condition comparison as fact', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const saved = await savedContext(f), originals = rawStatements(saved.context);
    const table = saved.context.evidence.find(e => e.object.kind === 'table');
    const equation = saved.context.evidence.find(e => e.object.kind === 'equation');
    const statements = [
      {...originals[0], id:'bad-quote', text:'Invented quote'},
      {...originals[1], id:'bad-value', text:'100'},
      {...originals[1], id:'bad-object', objectId:equation.objectId},
      {...originals[2], id:'partial-equation', text:'x = y'},
      {id:'expanded', kind:'claim', text:'The method is scientifically superior.', evidenceIds:[table.id]},
      {id:'missing', kind:'claim', text:'A result with missing evidence.', evidenceIds:['absent']},
      {id:'inference', kind:'inference', text:'A possible interpretation.', evidenceIds:[table.id]},
      {id:'comparison', kind:'comparison', text:'90 is better than another experiment.',
        evidenceIds:[table.id, equation.id]}
    ];
    const result = await f.router.validateEvidence({...saved, statements});
    assert.equal(result.answerStatus, 'insufficient_evidence');
    assert.equal(result.canAnswerAsFacts, false);
    assert.ok(result.statements.slice(0,4).every(s => s.sourceStatus === 'mismatch'));
    assert.equal(result.statements[4].supportStatus, 'insufficient_evidence');
    assert.equal(result.statements[5].sourceStatus, 'missing');
    assert.equal(result.statements[6].supportStatus, 'inference');
    assert.match(result.statements[7].reasons.join(' '), /dataset_version_split_metric_unit_conditions_unvalidated/);
    const inferred = await f.router.validateEvidence({...saved, statements:[statements[6]]});
    assert.equal(inferred.answerStatus, 'inference');
    assert.equal(inferred.canAnswerAsFacts, false);
    assert.equal((await f.router.validateEvidence({...saved, statements:[]})).canAnswerAsFacts, false);
    await assert.rejects(f.router.validateEvidence({...saved, statements:[originals[0], originals[0]]}),
      /statement_ids_invalid/);
    await assert.rejects(f.router.validateEvidence({...saved,
      statements:[{...originals[1], supportStatus:'supported'}]}), /unrecognized_keys/);
  } finally {await f.close();}
});

test('every unselected candidate is validated, including self-hashed metadata and persisted citation projections', async () => {
  const f = await scientificSearchFixture(api);
  const transport = new api.LiteratureSearchService(async () => Response.json({message:{DOI:f.metadata.doi,
    reference:[{DOI:'10.1234/original-reference'}]}}));
  const service = new api.ScholarlyRelationsService(f.scholarly, transport, () => '2026-11-17T00:00:00.000Z');
  try {
    const item = f.repository.library.get(f.document.libraryItemId);
    await service.capture({projectId:f.project.id, itemId:item.id, expectedRevision:item.revision,
      requestId:'evidence-citation', sources:['crossref'], offset:0, limit:10});
    const saved = await f.router.search(f.request('Compare Table 3, Equation (7), DOI:10.1234/scientific-search and citations'));
    const candidateIds = ids(saved, 'equation');
    assert.ok(candidateIds.length);
    for (const kind of ['table', 'metadata', 'citation']) {
      const search = structuredClone(saved), candidate = search.candidates.find(c => c.object.kind === kind);
      assert.ok(candidate, kind);
      assert.ok(!candidateIds.includes(candidate.id));
      const originalId = candidate.id;
      if (kind === 'table') candidate.object.cells[0].text = 'forged';
      if (kind === 'metadata') {
        candidate.object.metadata.title = 'Self-consistent forged title';
        candidate.content = JSON.stringify(candidate.object.metadata);
      }
      if (kind === 'citation') {
        candidate.object.relation.object.value = '10.1234/forged-reference';
        candidate.content = JSON.stringify(candidate.object.relation);
        candidate.objectId = `citation:${hash(JSON.stringify([
          candidate.object.snapshotId, candidate.object.source, candidate.object.relation]))}`;
        candidate.id = `scientific-candidate:${hash(JSON.stringify([candidate.generationId, candidate.objectId]))}`;
      }
      candidate.contentHash = hash(candidate.content);
      search.hits = search.hits.map(h => h.id === originalId ? structuredClone(candidate) : h);
      await assert.rejects(f.router.readContext({search, candidateIds}), /candidate_invalid/);
    }
  } finally {await service.shutdown(); await transport.shutdown(); await f.close();}
});

test('duplicate candidates, duplicate or replaced hits and repeated generation receipts are rejected', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const saved = await f.router.search(f.request('Table 3 Equation (7)'));
    for (const change of ['candidate', 'hit', 'missing-hit', 'replaced-hit', 'generation']) {
      const search = structuredClone(saved);
      if (change === 'candidate') search.candidates.push(structuredClone(search.candidates[0]));
      if (change === 'hit') search.hits.push(structuredClone(search.hits[0]));
      if (change === 'missing-hit') search.hits[0].id = 'unknown-hit';
      if (change === 'replaced-hit') {
        search.hits[0].content = 'Self-hashed replacement';
        search.hits[0].contentHash = hash(search.hits[0].content);
      }
      if (change === 'generation') {
        search.snapshot.generations.push(structuredClone(search.snapshot.generations[0]));
        search.snapshot.id = snapshots.scientificSnapshotId(search.snapshot.generations);
      }
      await assert.rejects(f.router.assertCurrent(search), /search_candidate_invalid|search_hit_invalid|search_snapshot_invalid/);
    }
  } finally {await f.close();}
});

test('rehashing a changed context, cell, quote locator or image receipt cannot replace reconstructed evidence', async () => {
  const f = await scientificSearchFixture(api, {image:true});
  try {
    const saved = await savedContext(f);
    for (const field of ['content', 'cell', 'locator', 'image', 'query', 'project', 'evidence-id']) {
      const context = structuredClone(saved.context);
      const table = context.evidence.find(e => e.object.kind === 'table');
      if (field === 'content') table.hits[0].content = 'Self-hashed fabricated context';
      if (field === 'cell') table.object.cells.find(c => c.text === '90').text = '100';
      if (field === 'locator') table.passages[0].sourceLocator.locations[0].page = 2;
      if (field === 'image') context.evidence.find(e => e.image).image.sha256 = hash('forged image');
      if (field === 'query') context.query = 'Changed question';
      if (field === 'project') context.projectId = 'foreign-project';
      if (field === 'evidence-id') table.id = 'forged-evidence';
      const {id:_id, ...body} = context;
      context.id = hash(JSON.stringify(body));
      await assert.rejects(f.router.validateEvidence({search:saved.search, context, statements:[]}),
        /evidence_context_changed/);
    }
  } finally {await f.close();}
});

test('saved evidence is invalid after source, membership, parse or PNG changes; in-flight cancellation remains fatal', async () => {
  for (const change of ['source', 'membership', 'parse', 'image', 'cancel']) {
    const f = await scientificSearchFixture(api, {image:true});
    let release;
    try {
      const saved = await savedContext(f), request = {...saved, statements:rawStatements(saved.context)};
      if (change === 'source') await writeFile(f.source, Buffer.concat([f.bytes, Buffer.from('\n% changed source')]));
      if (change === 'membership') f.repository.library.link(f.document.libraryItemId, f.project.id, false, {notify:true});
      if (change === 'parse') await f.publish();
      if (change === 'image') await writeFile(join(f.root, 'parser', 'figure.png'), Buffer.from('changed image'));
      if (change !== 'cancel') {
        await assert.rejects(f.router.validateEvidence(request),
          /source_changed|scope_invalid|source_size|source_hash|image_changed/);
        continue;
      }
      const reader = f.router.snapshots.readImage;
      let enter; const entered = new Promise(resolve => {enter=resolve;});
      const wait = new Promise(resolve => {release=resolve;});
      f.router.snapshots.readImage = async (...args) => {enter(); await wait; return reader(...args);};
      const controller = new AbortController(), pending = f.router.validateEvidence(request, controller.signal);
      const rejected = assert.rejects(pending, /evidence-cancel/);
      await entered;
      controller.abort(new Error('evidence-cancel'));
      release(); await rejected;
    } finally {release?.(); await f.close();}
  }
});

test('actual Agent tools bind project scope and full search/context handles through all three capabilities', async () => {
  const f = await scientificSearchFixture(api, {image:true});
  try {
    const calls = [], controller = new AbortController();
    const tools = toolsApi.createScientificTools({capabilities:capability(f, calls),
      projectId:f.project.id, signal:controller.signal});
    const call = (key, args) => tools.find(t => t.name === toolsApi.scientificToolNames[key]).invoke(args);
    await assert.rejects(call('search', {query:'Table 3', projectId:'foreign'}), /schema|unrecognized/i);
    const search = await call('search', {query:'Table 3 Equation (7) Figure 2'});
    assert.equal(search.plan.scope.projectId, f.project.id);
    assert.equal(search.supportStatus, 'requires_validation');
    const candidateIds = search.candidates.filter(c => ['table_row_group', 'equation', 'figure'].includes(c.objectType)).map(c => c.id);
    const context = await call('context', {searchId:search.searchId, candidateIds, budget:{maxTokens:64_000}});
    const validation = await call('validate', {searchId:search.searchId, contextId:context.contextId,
      statements:rawStatements(context)});
    assert.equal(validation.canAnswerAsFacts, true);
    assert.deepEqual(calls.map(c => c.name), ['research.knowledge.scientificQuery',
      'research.knowledge.scientificContext', 'research.knowledge.scientificEvidence']);
    assert.equal(calls[0].request.projectId, f.project.id);
    assert.deepEqual(calls[1].request.search, calls[2].request.search);
    assert.equal(calls[2].request.context.id, context.contextId);
    await assert.rejects(call('context', {searchId:'absent'}), /search_handle_missing/);
    await assert.rejects(call('validate', {searchId:search.searchId, contextId:'absent', statements:[]}), /context_handle_missing/);
    const other = await call('search', {query:'Equation (7)'});
    await assert.rejects(call('validate', {searchId:other.searchId, contextId:context.contextId, statements:[]}),
      /context_handle_missing/);
    await f.publish();
    await assert.rejects(call('validate', {searchId:search.searchId, contextId:context.contextId, statements:[]}), /source_changed/);
    controller.abort(new Error('agent-evidence-cancel'));
    await assert.rejects(call('context', {searchId:'absent'}), /agent-evidence-cancel/);
    await assert.rejects(call('validate', {searchId:'absent', contextId:'absent', statements:[]}), /agent-evidence-cancel/);
  } finally {await f.close();}
});

test('research role tools use the same receipts and check the running worker around asynchronous capabilities', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const controller = new AbortController(), context = f.repository.runs.getContext(f.run.id);
    const tools = f.withWorker(() => api.createResearchRoleTools({run:f.run, context, repository:f.repository,
      capabilities:capability(f), signal:controller.signal}));
    const call = (name, args) => f.withWorker(() => tools.find(t => t.name === name).invoke(args));
    const search = await call('search_scientific_knowledge', {query:'Table 3 Equation (7)'});
    const data = await call('read_scientific_context', {searchId:search.searchId,
      candidateIds:search.candidates.filter(c => ['table_row_group','equation'].includes(c.objectType)).map(c => c.id),
      budget:{maxTokens:64_000}});
    assert.equal((await call('validate_scientific_evidence',
      {searchId:search.searchId, contextId:data.contextId, statements:rawStatements(data)})).canAnswerAsFacts, true);
    context.inputs = [];
    context.recovery = {forged:true};
    await assert.rejects(call('search_scientific_knowledge', {query:'Table 3'}), /role_tool_binding_invalid/);
  } finally {await f.close();}
});

test('Agent quote selection uses the saved source handle and exact excerpt through production validation', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const calls = [], tools = toolsApi.createScientificTools({capabilities:capability(f, calls),
      projectId:f.project.id, signal:new AbortController().signal});
    const call = (key, args) => tools.find(t => t.name === toolsApi.scientificToolNames[key]).invoke(args);
    const search = await call('search', {query:'Table 3'});
    const context = await call('context', {searchId:search.searchId,
      candidateIds:search.candidates.filter(c => c.objectType === 'table_row_group').map(c => c.id)});
    const evidence = context.evidence.find(e => e.object.kind === 'table');
    const source = evidence.passages.find(p => p.text.includes('Original method'));
    assert.match(source.sourceId, /^scientific-source:/);
    const original = structuredClone(source);
    // Mutating the caller's projection cannot change the privately retained source.
    source.text = 'forged';
    source.sourceLocator.documentId = 'foreign';
    const text = 'Dataset C.';
    const validation = await call('validate', {searchId:search.searchId, contextId:context.contextId,
      statements:[{id:'selected', kind:'quote', sourceId:original.sourceId, text}]});
    assert.equal(validation.canAnswerAsFacts, true);
    const resolved = calls.at(-1).request.statements[0];
    assert.equal(resolved.evidenceId, evidence.id);
    assert.deepEqual(resolved.sourceLocator, original.sourceLocator);
    assert.equal(original.text.slice(resolved.start, resolved.end), text);
    assert.equal(resolved.start, original.text.indexOf(text));
    assert.deepEqual(validation.resolvedQuotes, [{statementId:'selected', sourceId:original.sourceId,
      evidenceId:evidence.id, text, sourceLocator:original.sourceLocator, start:resolved.start, end:resolved.end}]);
    await f.publish();
    await assert.rejects(call('validate', {searchId:search.searchId, contextId:context.contextId,
      statements:[{id:'stale', kind:'quote', sourceId:original.sourceId, text}]}), /source_changed/);
  } finally {await f.close();}
});

test('source selections reject changed text, ambiguous excerpts and foreign handles before validation', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const calls = [], controller = new AbortController();
    const tools = toolsApi.createScientificTools({capabilities:capability(f, calls),
      projectId:f.project.id, signal:controller.signal});
    const call = (key, args) => tools.find(t => t.name === toolsApi.scientificToolNames[key]).invoke(args);
    const search = await call('search', {query:'Table 3'});
    const context = await call('context', {searchId:search.searchId});
    const source = context.evidence.flatMap(e => e.passages).find(p => p.text.includes('Original method'));
    const validate = statement => call('validate', {searchId:search.searchId, contextId:context.contextId,
      statements:[{id:'selected', kind:'quote', sourceId:source.sourceId, text:'Dataset C.', ...statement}]});
    for (const [statement, reason] of [
      [{text:'Dataset\nC.'}, /quote_text_missing/],
      [{text:'Dataset c.'}, /quote_text_missing/],
      [{text:'s'}, /quote_text_ambiguous/],
      [{sourceId:'foreign'}, /quote_source_handle_missing/],
      [{evidenceId:'forged'}, /schema|unrecognized/i],
      [{start:0, end:10}, /schema|unrecognized/i]
    ]) await assert.rejects(validate(statement), reason);
    assert.equal(calls.filter(c => c.name === 'research.knowledge.scientificEvidence').length, 0);
    const other = toolsApi.createScientificTools({capabilities:capability(f), projectId:f.project.id,
      signal:new AbortController().signal});
    await assert.rejects(other.find(t => t.name === toolsApi.scientificToolNames.validate).invoke({
      searchId:search.searchId, contextId:context.contextId,
      statements:[{id:'foreign', kind:'quote', sourceId:source.sourceId, text:'Dataset C.'}]}), /context_handle_missing/);
    controller.abort(new Error('selection-cancel'));
    await assert.rejects(validate({}), /selection-cancel/);
  } finally {await f.close();}
});

test('Agent selects a complete immutable source without copying PDF text or guessing offsets', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const calls = [], controller = new AbortController();
    const tools = toolsApi.createScientificTools({capabilities:capability(f, calls),
      projectId:f.project.id, signal:controller.signal});
    const call = (key, args) => tools.find(t => t.name === toolsApi.scientificToolNames[key]).invoke(args);
    const search = await call('search', {query:'Table 3'});
    const context = await call('context', {searchId:search.searchId});
    const evidence = context.evidence.find(e => e.passages.some(p => p.text.includes('Original method')));
    const source = structuredClone(evidence.passages.find(p => p.text.includes('Original method')));
    const statement = {id:'whole-source', kind:'quote', sourceId:source.sourceId, selection:'source'};
    evidence.passages.find(p => p.sourceId === source.sourceId).text = 'changed projection';
    const validate = statements => call('validate', {searchId:search.searchId,
      contextId:context.contextId, statements});
    const result = await validate([statement]);
    assert.equal(result.canAnswerAsFacts, true);
    assert.deepEqual(result.resolvedQuotes, [{statementId:statement.id, sourceId:source.sourceId,
      evidenceId:evidence.id, text:source.text, sourceLocator:source.sourceLocator,
      start:0, end:source.text.length}]);
    assert.deepEqual(calls.at(-1).request.statements, [{id:statement.id, kind:'quote', evidenceId:evidence.id,
      text:source.text, sourceLocator:source.sourceLocator, start:0, end:source.text.length}]);
    await assert.rejects(validate([{...statement, text:'replacement'}]), /schema|unrecognized/i);
    await assert.rejects(validate([{...statement, sourceId:'foreign'}]), /quote_source_handle_missing/);
    await assert.rejects(validate([{...statement, selection:'invented'}]), /schema|invalid/i);
    await assert.rejects(validate([statement, statement]), /statement_ids_invalid/);
    await f.publish();
    await assert.rejects(validate([statement]), /source_changed/);
    controller.abort(new Error('whole-source-cancel'));
    await assert.rejects(validate([statement]), /whole-source-cancel/);
  } finally {await f.close();}
});
