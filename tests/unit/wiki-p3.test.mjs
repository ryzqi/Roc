import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi} from './fixtures/scientific-search-fixture.mjs';
import {scientificWikiFixture, wikiModelFactory} from './fixtures/scientific-wiki-fixture.mjs';
import {scientificComparisonFixture} from './fixtures/scientific-comparison-fixture.mjs';

let api, services, synthesis, explanation, structured, relations;
before(async () => {
  [api, services, synthesis, explanation, structured, relations] = await Promise.all([loadScientificSearchApi(),
    ...['scientific-extraction-service', 'wiki-synthesis', 'wiki-scientific-explanation', 'wiki-scientific-synthesis', 'wiki-relations']
      .map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
        {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))]);
});
after(() => api?.dispose());
const section = page => page.current.sections.find(value => value.id === 'results');
function explanatoryFactory({text = 'Original baseline', kind = 'paraphrase', support = 'supported', mutate = () => {}} = {}) {
  const calls = []; let refs;
  return {calls, factory: wikiModelFactory(async call => {
    calls.push(call.options.name);
    const input = JSON.parse(call.messages[1].content);
    if (call.options.name === 'wiki_scientific_synthesis') {
      refs = [input.entries.find(entry => entry.kind === 'fact' && entry.value.factType === 'experimental_result').ref];
      return {sections: [{id: 'results', goal: 'Explain the recorded baseline and its limits.',
        unresolvedQuestions: ['Do the missing conditions permit generalization?'], statements: refs}]};
    }
    if (call.options.name === 'wiki_scientific_explanation') {
      const proposal = {sections: [{id: 'results', statements: [{text, kind, references: refs}]}]};
      mutate(proposal); return proposal;
    }
    return {reviews: [{sectionId: 'results', statementIndex: 0, support}]};
  })};
}

test('two-step explanation and separate support check retain exact original conditions and host-only validation', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const page = await f.stalePage(), original = f.wiki.revision(f.project.id, page.page.id, page.page.revision);
    const model = explanatoryFactory({text: 'The original baseline reports 90.'});
    f.wiki.configureSynthesis(synthesis.createWikiSynthesizer(model.factory));
    const updated = await f.wiki.resynthesize(f.synthesisInput(page));
    assert.deepEqual(model.calls, ['wiki_scientific_synthesis', 'wiki_scientific_explanation', 'wiki_scientific_support']);
    const output = section(updated), statement = output.scientificExplanation.statements[0];
    assert.equal(statement.validation, 'review_required'); assert.equal(statement.semanticSupport, 'supported');
    assert.equal(statement.scientificApproval, 'unreviewed'); assert.ok(statement.sourceRefs.length);
    const read = await f.readKnowledge();
    assert.ok(statement.sourceRefs.every(ref => ref.paperIrHash === read.paperIR.sha256 &&
      ref.generationId === read.publishedJob.snapshot.source.generationId));
    assert.match(output.body, /综合解释 · 待人工核验/);
    assert.ok(output.body.includes(JSON.stringify(read.knowledge.facts[0].conditions, null, 2)));
    assert.equal(updated.current.sections.find(item => item.id === 'human').body, 'Keep the human note.');
    assert.deepEqual(f.wiki.revision(f.project.id, page.page.id, original.revision), original);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_claims').pluck().get(), 0);
  } finally {await f.finish();}
});

test('forged quotes, values, units, conditions, references and model-granted validation never replace the old revision', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const page = await f.stalePage(), before = f.wiki.revision(f.project.id, page.page.id, page.page.revision);
    f.wiki.configureSynthesis(synthesis.createWikiSynthesizer(wikiModelFactory(async call => {
      const input = JSON.parse(call.messages[1].content);
      return {sections: [{id: 'results', statements: [input.entries.find(entry => entry.kind === 'fact').ref]}]};
    })));
    await assert.rejects(() => f.wiki.resynthesize(f.synthesisInput(page)), /wiki_explanation_plan_incomplete/);
    assert.equal(f.wiki.read(f.project.id, page.page.id).page.revision, before.revision);
    assert.deepEqual(f.wiki.revision(f.project.id, page.page.id, before.revision), before);
    for (const options of [
      {text: 'The result is 99'}, {text: 'The result is 90 seconds'},
      ...['FLOPs', 'flops', 'kg', 'kg/m^2', '秒', '°C', 'kWh'].map(unit => ({text: `The result is 90 ${unit}`})),
      {text: '结果为90 FLOPs'}, {text: '耗时90秒'}, {text: '结果为99'},
      {kind: 'source_statement', text: 'This text is not an original quote.'},
      {kind: 'comparison', text: 'These experiments are directly comparable.'},
      {mutate: value => {value.sections[0].statements[0].references[0].id = 'invented';}},
      {mutate: value => {value.sections[0].statements[0].validation = 'source_validated';}}
    ]) {
      const model = explanatoryFactory(options); f.wiki.configureSynthesis(synthesis.createWikiSynthesizer(model.factory));
      await assert.rejects(() => f.wiki.resynthesize(f.synthesisInput(page)));
      assert.deepEqual(f.wiki.revision(f.project.id, page.page.id, before.revision), before);
      assert.equal(f.wiki.read(f.project.id, page.page.id).page.revision, before.revision);
    }
    const model = explanatoryFactory({kind: 'source_statement'});
    f.wiki.configureSynthesis(synthesis.createWikiSynthesizer(model.factory));
    const updated = await f.wiki.resynthesize(f.synthesisInput(page));
    assert.equal(section(updated).scientificExplanation.statements[0].validation, 'source_validated');
    const tampered = structuredClone(section(updated));
    for (const key of ['owner', 'status', 'dependencies']) delete tampered[key];
    tampered.scientificExplanation.statements[0].sourceRefs[0].objectId = 'invented';
    await assert.rejects(() => f.wiki.saveCurrent(f.saveInput(updated, tampered), 'assistant'));
  } finally {await f.finish();}
});

test('numeric explanations bind arbitrary original units to their own values while ordinary prose remains unreviewed', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const job = await f.publishKnowledge(), read = await f.readKnowledge();
    const references = [{kind: 'fact', source: {documentId: f.document.id, generationId: job.id}, id: read.knowledge.facts[0].id}];
    // Exercise numeric validation against a controlled trusted basis; publication/source validation is covered separately.
    for (const unit of ['秒', 'FLOPs', 'flops', 'kg/m^2', '°C', 'kWh']) {
      const basis = structuredClone({knowledge: [read]}), fact = basis.knowledge[0].knowledge.facts[0];
      fact.value.raw = '10'; fact.value.rawUnit = unit;
      fact.evidence[0].quote = `Measured 10 ${unit}.`;
      fact.evidence[1].quote = 'A second setting was 90.';
      const validate = text => explanation.validateWikiExplanation({text, kind: 'paraphrase', references}, basis, 'supported');
      for (const text of [`The recorded quantity was 10 ${unit}.`, `10 ${unit} was recorded.`, `测得10 ${unit}。`,
        'The value was 10.', '10 was recorded.']) {
        const result = validate(text);
        assert.equal(result.validation, 'review_required'); assert.equal(result.scientificApproval, 'unreviewed');
      }
      for (const replacement of ['seconds', 'ms', 'FLOPs', 'kg', '秒'].filter(value => value !== unit)) {
        assert.throws(() => validate(`The quantity was 10 ${replacement}.`), /wiki_explanation_numeric_invalid/);
      }
      assert.throws(() => validate(`The quantity was 90 ${unit}.`), /wiki_explanation_numeric_invalid/,
        'A unit supported for one value must not attach to another existing number');
    }
  } finally {await f.finish();}
});

test('three-layer templates filter listing/search and stale scientific prose cannot be retrieved', async () => {
  const f = await scientificWikiFixture(api, services);
  try {
    const job = await f.publishKnowledge();
    let page = await f.wiki.createCurrent({projectId: f.project.id, title: 'Baseline methods', kind: 'topic', template: 'method',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: [{documentId: f.document.id, generationId: job.id}]});
    await f.wiki.idle(); page = await f.wiki.readCurrent(f.project.id, page.page.id);
    assert.equal(page.page.layer, 'L2'); assert.equal(page.page.template, 'method');
    assert.equal(page.current.sections.some(value => value.id === 'scientific:datasets'), false);
    assert.equal((await f.wiki.search(f.project.id, '', 0, {layers: ['L3']})).pages.some(value => value.id === page.page.id), false);
    assert.equal((await f.wiki.search(f.project.id, '', 0, {templates: ['method']})).pages[0].id, page.page.id);
    const basis = {knowledge: [await f.readKnowledge()]};
    const fact = basis.knowledge[0].knowledge.facts[0];
    page = await f.wiki.saveCurrent(f.saveInput(page, structured.scientificWikiSection({id: 'scientific:methods', title: 'Method'},
      [{kind: 'fact', source: {documentId: f.document.id, generationId: job.id}, id: fact.id}], basis)), 'assistant');
    assert.equal((await f.wiki.search(f.project.id, 'Reported', 0, {layers: ['L2']})).pages[0].id, page.page.id);
    assert.equal((await f.wiki.search(f.project.id, 'Reported', 0, {layers: ['L3']})).pages.length, 0);
    const changed = Buffer.from(f.bytes); changed[20] ^= 1; await writeFile(f.source, changed);
    assert.equal((await f.wiki.search(f.project.id, 'Reported')).pages.length, 0, 'Changed PDF bytes must not remain searchable before reparse');
    await writeFile(f.source, f.bytes);
    await f.publishKnowledge(true); await f.wiki.idle();
    assert.equal((await f.wiki.search(f.project.id, 'Reported')).pages.length, 0);
  } finally {await f.finish();}
});

test('incremental source enrollment updates only selected assistant sections and protects human/history', async () => {
  const f = await scientificComparisonFixture(api, services);
  try {
    const reads = await f.readAll(), first = f.sources.slice(0, 2);
    let page = await f.wiki.createCurrent({projectId: f.project.id, title: 'Evolving method topic', kind: 'topic',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: first});
    await f.wiki.idle(); page = await f.wiki.readCurrent(f.project.id, page.page.id);
    const reference = {kind: 'fact', source: first[0], id: reads[0].knowledge.facts[0].id};
    page = await f.wiki.saveCurrent(f.saveInput(page, structured.scientificWikiSection({id: 'scientific:methods', title: 'Methods'},
      [reference], {knowledge: reads.slice(0, 2)})), 'assistant');
    const stable = structuredClone(page.current.sections.find(value => value.id === 'scientific:methods'));
    const human = {id: 'human', title: 'Human note', body: 'Keep exact human wording.', evidenceIds: [], claimIds: [], links: []};
    page = api.withResearchHumanContext({capability: 'research.wiki.save', projectId: f.project.id, windowId: 42},
      () => f.wiki.save(f.saveInput(page, human), 'human'));
    const before = f.wiki.revision(f.project.id, page.page.id, page.page.revision);
    const input = {projectId: f.project.id, pageId: page.page.id, expectedRevision: page.page.revision,
      expectedBasisDigest: page.basisDigest, sectionIds: ['scientific:comparison'], paperKnowledgeSources: [f.sources[2]]};
    await assert.rejects(() => f.wiki.updateSourcesCurrent({...input, sectionIds: ['human']}), /wiki_human_section_protected/);
    const updated = await f.wiki.updateSourcesCurrent(input);
    assert.deepEqual(updated.current.sections.find(value => value.id === stable.id), stable);
    assert.equal(updated.current.sections.find(value => value.id === 'human').body, human.body);
    assert.equal(updated.current.sections.find(value => value.id === 'scientific:comparison').paperKnowledgeSources.length, 3);
    assert.equal(updated.current.sections.find(value => value.id === 'scientific:comparison').status, 'stale');
    assert.deepEqual(f.wiki.revision(f.project.id, page.page.id, before.revision), before);
    const projected = await f.wiki.readRelationsCurrent(f.project.id, updated.page.id);
    assert.ok(projected.some(value => value.type === 'compares_with'));
    assert.ok(projected.every(value => value.scientificApproval === 'unreviewed'));
    const entities = reads.map(read => read.knowledge.entities.find(value => value.entityType === 'Dataset'));
    const changed = structuredClone(entities[1]); changed.proposal.attributes.version = 'different';
    assert.equal(relations.wikiEntityAlignment(entities[0], changed), 'unresolved');
  } finally {await f.finish();}
});
