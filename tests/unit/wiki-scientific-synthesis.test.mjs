import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi} from './fixtures/scientific-search-fixture.mjs';
import {scientificWikiFixture, wikiModelFactory} from './fixtures/scientific-wiki-fixture.mjs';

let api, services, synthesis, structured, schemas;
before(async () => {
  [api, services, synthesis, structured, schemas] = await Promise.all([loadScientificSearchApi(),
    ...['src/main/plugins/research/scientific-extraction-service.ts', 'src/main/plugins/research/wiki-synthesis.ts',
      'src/main/plugins/research/wiki-scientific-synthesis.ts', 'src/shared/schemas/research-wiki-pages.ts'].map(path =>
      importTypeScriptModule(path, {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))]);
});
after(() => api?.dispose());
const basisFor = async f => ({knowledge: [await f.readKnowledge()]});
const revisionBytes = (f, page) => f.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
  .pluck().get(page.page.id, page.page.revision);
const bodyFor = (basis, target = {id: 'results', title: 'results'}, kind = 'fact') => {
  const read = basis.knowledge[0], values = kind === 'fact' ? read.knowledge.facts : read.knowledge.relations;
  const value = kind === 'fact' ? values.find(item => item.factType === 'experimental_result') : values[0];
  return structured.scientificWikiSection(target, [{kind, source: {
    documentId: read.documentId, generationId: read.publishedJob.id
  }, id: value.id}], basis);
};

test('actual Wiki synthesis uses current Facts and complete objects, preserves values/conditions/candidates and immutable human history', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const page = await f.stalePage(['results', 'relations', 'equations']), before = revisionBytes(f, page);
    let captured;
    f.wiki.configureSynthesis(synthesis.createWikiSynthesizer(wikiModelFactory(async call => {
      captured = call;
      const input = JSON.parse(call.messages[1].content);
      assert.doesNotMatch(call.messages[1].content, /9999|Old unreviewed interpretation|Keep the human note/);
      assert.ok(input.entries.some(entry => entry.kind === 'fact'));
      const table = input.entries.find(entry => entry.kind === 'object' && entry.ref.objectType === 'Table');
      assert.deepEqual(table.value, f.ir.tables[0], 'the entire original table and every cell are supplied');
      return {sections: input.targets.map(target => {
        const entry = input.entries.find(entry => target.id === 'relations' ? entry.kind === 'relation' :
          target.id === 'equations' ? entry.kind === 'object' && entry.ref.objectType === 'Equation' :
          entry.kind === 'fact' && entry.value.factType === 'experimental_result');
        assert.ok(entry, `${target.id}: offered ${input.entries.map(item => `${item.kind}:${item.ref.objectType ?? item.value.factType ?? item.value.type ?? item.value.entityType}`).join(', ')}`);
        return {id: target.id, statements: [entry.ref]};
      })};
    })));
    const updated = await f.wiki.resynthesize(f.synthesisInput(page, ['results', 'relations', 'equations']));
    const section = id => updated.current.sections.find(item => item.id === id);
    const fact = (await f.readKnowledge()).knowledge.facts.find(item => item.factType === 'experimental_result');
    assert.equal(section('results').status, 'current');
    assert.ok(section('results').body.includes(`原始数值：${fact.value.raw}`));
    assert.ok(section('results').body.includes(`原始单位：${fact.value.rawUnit}`));
    assert.ok(section('results').body.includes(JSON.stringify(fact.conditions, null, 2)));
    assert.match(section('relations').body, /候选关系 · EVALUATES_WITH · 未审核/);
    assert.ok(section('relations').body.includes(JSON.stringify(fact.conditions, null, 2)));
    assert.ok(section('equations').body.includes(f.ir.equations[0].data.rawLatex));
    assert.equal(section('human').body, 'Keep the human note.');
    assert.equal(revisionBytes(f, page), before);
    assert.equal(f.db.prepare('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?')
      .pluck().get(page.page.id, f.oldRevision), f.oldBytes);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_claims').pluck().get(), 0);
    assert.equal(structured.wikiSynthesisInputTokens(captured.messages, captured.schema, captured.options.name) <= 12000, true);
    assert.ok(section('results').scientificStatements[0].source.generationId !==
      JSON.parse(f.oldBytes).sections.find(item => item.id === 'results').paperKnowledgeSources[0].generationId);
  } finally {await f.finish();}
});

test('public structured saves and repository publication reject rewritten numbers, missing conditions and promoted relations atomically', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const page = await f.stalePage(), basis = await basisFor(f), original = bodyFor(basis), before = revisionBytes(f, page);
    for (const section of [
      {...original, body: original.body.replace('原始数值：90', '原始数值：99')},
      {...original, body: original.body.replace('  "split": "unknown",\n', '')},
      {...bodyFor(basis, {id: 'results', title: 'results'}, 'relation'),
        body: bodyFor(basis, {id: 'results', title: 'results'}, 'relation').body.replace('候选关系', '已确认关系')}
    ]) {
      await assert.rejects(() => f.wiki.saveCurrent(f.saveInput(page, section), 'assistant'), /wiki_scientific_proposal_invalid/);
      f.wiki.configureSynthesis(async () => [section]);
      await assert.rejects(() => f.wiki.resynthesize(f.synthesisInput(page)), /wiki_scientific_proposal_invalid/);
      assert.equal(revisionBytes(f, page), before);
      assert.equal(f.wiki.read(f.project.id, page.page.id).page.revision, page.page.revision);
    }
    assert.throws(() => f.wiki.save(f.saveInput(page, original), 'assistant'), /wiki_scientific_sources_unverified/);
    const saved = await f.wiki.saveCurrent(f.saveInput(page, original), 'assistant');
    assert.equal(saved.current.sections.find(section => section.id === 'results').body, original.body);
    await assert.rejects(() => f.wiki.saveCurrent(f.saveInput(saved, {...original,
      scientificStatements: undefined}), 'assistant'), /wiki_scientific_synthesis_required/);
    await assert.rejects(() => f.wiki.saveCurrent(f.saveInput(saved, {...original, id: 'human'}), 'assistant'),
      /wiki_human_section_protected/);
  } finally {await f.finish();}
});

for (const mutation of ['pdf', 'ir', 'model', 'generation', 'revision']) {
  test(`a ${mutation} change during inference cannot publish a scientific section`, async () => {
    const f = await scientificWikiFixture(api, services);
    try {
      const page = await f.stalePage(), before = revisionBytes(f, page);
      f.wiki.configureSynthesis(async basis => {
        const section = bodyFor(basis.scientific);
        if (mutation === 'pdf') {
          const changed = Buffer.from(f.bytes); changed[20] ^= 1; await writeFile(f.source, changed);
        } else if (mutation === 'ir') await writeFile(join(f.root, f.data.paperIR.path), '{}');
        else if (mutation === 'model') f.switchModel();
        else if (mutation === 'generation') {await f.publishKnowledge(true); await f.wiki.idle();}
        else api.withResearchHumanContext({capability: 'research.wiki.save', projectId: f.project.id, windowId: 42},
          () => f.wiki.save(f.saveInput(page, {id: 'human', title: 'Human note', body: 'A newer human note.',
            evidenceIds: [], claimIds: [], links: []}), 'human'));
        return [section];
      });
      await assert.rejects(() => f.wiki.resynthesize(f.synthesisInput(page)),
        /source|artifact|current_sources|basis_changed|revision_conflict|fingerprint|receipt/i);
      assert.equal(revisionBytes(f, page), before);
      assert.equal(f.wiki.read(f.project.id, page.page.id).current.sections.find(section => section.id === 'results').body,
        'Old unreviewed interpretation 9999 must not be model evidence.');
    } finally {await f.finish();}
  });
}

test('actual model context and complete request overhead bound scientific and legacy calls; omitted/stale references cannot return', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    await f.publishKnowledge();
    const scientific = await basisFor(f), target = {id: 'results', title: 'results'}, basis = {sections: [target], evidence: [], originals: [], scientific};
    const fitted = structured.fitScientificWikiBasis(scientific, [target], 12000);
    assert.ok(fitted.entries.size > 0);
    const emptyTokens = structured.fitScientificWikiBasis({knowledge: []}, [target], 12000).inputTokens;
    const limited = structured.fitScientificWikiBasis(scientific, [target], emptyTokens + 120);
    assert.ok(limited.omittedCount > 0);
    assert.ok(limited.inputTokens <= emptyTokens + 120);
    const resultRef = bodyFor(scientific).scientificStatements[0];
    assert.equal(limited.entries.has(structured.scientificStatementKey(resultRef)), false);
    let invoked = 0;
    const overBudget = synthesis.createWikiSynthesizer(wikiModelFactory(async () => {invoked++; return {};},
      {contextWindowTokens: emptyTokens + 4000 + 512 - 1}));
    await assert.rejects(() => overBudget(basis, new AbortController().signal), /wiki_context_budget/);
    assert.equal(invoked, 0);
    const malicious = synthesis.createWikiSynthesizer(wikiModelFactory(async () => ({sections: [{id: target.id, statements: [resultRef]}]}),
      {contextWindowTokens: emptyTokens + 120 + 4000 + 512}));
    await assert.rejects(() => malicious(basis, new AbortController().signal), /wiki_scientific_reference_invalid/);
    const unavailable = structuredClone(scientific);
    unavailable.knowledge[0].knowledge.facts.forEach(fact => {fact.status = 'stale';});
    const stale = structured.fitScientificWikiBasis(unavailable, [target], 12000);
    assert.ok([...stale.entries.values()].every(entry => entry.kind !== 'fact' && entry.kind !== 'relation'));
    const unknown = structured.scientificWikiSection(target, [{kind: 'unknown'}], unavailable);
    assert.match(unknown.body, /unknown/); assert.deepEqual(unknown.paperKnowledgeSources, structured.scientificWikiSources(scientific));
    const legacy = synthesis.createWikiSynthesizer(wikiModelFactory(async () => {invoked++; return {};},
      {contextWindowTokens: 4000 + 512 + 20}));
    await assert.rejects(() => legacy({sections: [target], evidence: [], originals: []}, new AbortController().signal), /wiki_context_budget/);
    assert.equal(invoked, 0);
  } finally {await f.finish();}
});

test('an oversized table closure is omitted whole; canonical oversized scientific prose fails without truncation', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    await f.publishKnowledge();
    const scientific = await basisFor(f), altered = structuredClone(scientific), table = altered.knowledge[0].objects.tables[0];
    // Valid raw data may exceed the model window; the source object must never be shortened to make it fit.
    table.data.rawHtml += ' complete-source-token'.repeat(50000);
    const fitted = structured.fitScientificWikiBasis(altered, [{id: 'results', title: 'results'}], 12000);
    assert.ok(fitted.omittedCount > 0);
    assert.ok([...fitted.entries.values()].every(entry =>
      entry.kind !== 'fact' && !(entry.kind === 'object' && entry.ref.objectType === 'Table')));
    const long = structuredClone(scientific), fact = long.knowledge[0].knowledge.facts.find(item => item.factType === 'experimental_result');
    fact.predicate = 'raw original sentence '.repeat(400);
    assert.throws(() => bodyFor(long), /wiki_scientific_section_budget/);
    assert.equal(fact.predicate.length, 'raw original sentence '.repeat(400).length);
  } finally {await f.finish();}
});

test('request cancellation prevents publication and shutdown waits for an in-flight provider to release', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const page = await f.stalePage(), before = revisionBytes(f, page);
    for (const shutdown of [false, true]) {
      let entered, release;
      const ready = new Promise(resolve => {entered = resolve;}), held = new Promise(resolve => {release = resolve;});
      f.wiki.configureSynthesis(async basis => {entered(); await held; return [bodyFor(basis.scientific)];});
      const controller = new AbortController(), task = f.wiki.resynthesize(f.synthesisInput(page), controller.signal);
      const rejected = assert.rejects(task, /abort/i);
      await ready;
      let settled = false, closing;
      if (shutdown) closing = f.wiki.shutdown().then(() => {settled = true;});
      else controller.abort();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      release(); await rejected; if (closing) {await closing; assert.equal(settled, true);}
      assert.equal(revisionBytes(f, page), before);
      assert.equal(f.wiki.read(f.project.id, page.page.id).page.revision, page.page.revision);
    }
  } finally {await f.finish();}
});

test('section count, duplicate/changed IDs, fabricated references and model changes are rejected before publication', async () => {
  assert.equal(schemas.wikiResynthesizeSchema.safeParse({projectId: 'p', pageId: 'w', sectionIds: ['a', 'a'],
    expectedRevision: 1, expectedBasisDigest: 'a'.repeat(64)}).success, false);
  const f = await scientificWikiFixture(api, services);
  try {
    const page = await f.stalePage(), scientific = await basisFor(f), target = {id: 'results', title: 'results'};
    const valid = bodyFor(scientific).scientificStatements[0], signal = new AbortController().signal;
    for (const sections of [[{id: 'invented-section', statements: [valid]}],
      [{id: target.id, statements: [{...valid, id: 'fabricated-fact'}]}]]) {
      const run = synthesis.createWikiSynthesizer(wikiModelFactory(async () => ({sections})));
      await assert.rejects(() => run({sections: [target], evidence: [], originals: [], scientific}, signal),
        /wiki_section_selection_changed|wiki_scientific_reference_invalid/);
    }
    let stamp = 'model/1';
    const switched = synthesis.createWikiSynthesizer(wikiModelFactory(async () => {
      stamp = 'model/2'; return {sections: [{id: target.id, statements: [valid]}]};
    }, {stamp: () => stamp}));
    f.wiki.configureSynthesis(switched);
    await assert.rejects(() => f.wiki.resynthesize(f.synthesisInput(page)), /wiki_basis_changed/);
    assert.equal(f.wiki.read(f.project.id, page.page.id).page.revision, page.page.revision);
  } finally {await f.finish();}
});
