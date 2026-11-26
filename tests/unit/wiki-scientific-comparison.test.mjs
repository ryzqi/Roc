import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi} from './fixtures/scientific-search-fixture.mjs';
import {scientificComparisonFixture} from './fixtures/scientific-comparison-fixture.mjs';
import {wikiModelFactory, wikiExplanationFixture} from './fixtures/scientific-wiki-fixture.mjs';

let api, services, structured, synthesis, comparison;
before(async () => {
  [api, services, structured, synthesis, comparison] = await Promise.all([loadScientificSearchApi(),
    ...['src/main/plugins/research/scientific-extraction-service.ts', 'src/main/plugins/research/wiki-scientific-synthesis.ts',
      'src/main/plugins/research/wiki-synthesis.ts', 'src/main/plugins/research/wiki-scientific-comparison.ts'].map(path =>
      importTypeScriptModule(path, {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))]);
});
after(() => api?.dispose());
const refs = knowledge => knowledge.map(read => ({kind: 'fact',
  source: {documentId: read.documentId, generationId: read.publishedJob.id}, id: read.knowledge.facts[0].id}));
const target = {id: 'scientific:comparison', title: 'Research Comparison · 研究比较'};
const bodyFor = knowledge => structured.scientificWikiSection(target, refs(knowledge), {knowledge});
const columns = knowledge => knowledge.map(read => ({
  source: {documentId: read.documentId, generationId: read.publishedJob.id},
  fact: read.knowledge.facts[0], entities: read.knowledge.entities
}));

test('three actual PDF publications produce an identity-aligned matrix with exact values/conditions and no scientific ranking', async () => {
  const f = await scientificComparisonFixture(api, services);
  try {
    const knowledge = await f.readAll(), original = f.wiki.revision(f.project.id, f.page.page.id, f.page.page.revision);
    assert.ok(knowledge.every(read => read.state === 'current'));
    const section = bodyFor(knowledge), result = comparison.checkScientificComparison(columns(knowledge), f.sources);
    assert.equal(result.status, 'conditions_match');
    for (const read of knowledge) {
      const fact = read.knowledge.facts[0];
      assert.ok(section.body.includes(JSON.stringify(fact.conditions, null, 2)));
      assert.ok(section.body.includes(fact.value.raw));
      assert.ok(section.body.includes(fact.table.cellId));
      assert.equal(fact.scientificApproval, 'unreviewed');
    }
    assert.match(section.body, /Recorded conditions match/);
    assert.match(section.body, /此比较不生成方法排名/);
    let offered;
    f.wiki.configureSynthesis(synthesis.createWikiSynthesizer(wikiModelFactory(async call => {
      const explanation = wikiExplanationFixture(call, 'comparison'); if (explanation) return explanation;
      offered = JSON.parse(call.messages[1].content);
      const facts = offered.entries.filter(entry => entry.kind === 'fact' && entry.value.factType === 'experimental_result');
      assert.equal(new Set(facts.map(entry => entry.ref.source.documentId)).size, 3, 'every complete source group fits');
      for (const paper of f.papers) {
        assert.deepEqual(offered.entries.find(entry =>
          entry.kind === 'object' && entry.ref.id === paper.ir.tables[0].id).value, paper.ir.tables[0]);
        const read = knowledge.find(read => read.documentId === paper.document.id), fact = read.knowledge.facts[0];
        const input = facts.find(entry => entry.ref.id === fact.id && entry.ref.source.documentId === paper.document.id);
        assert.deepEqual(input.value.conditions, fact.conditions, 'all experimental conditions reach the model');
        for (const key of ['raw', 'normalized', 'rawUnit', 'unit']) assert.equal(input.value.value[key], fact.value[key]);
        assert.equal(input.value.scientificApproval, 'unreviewed');
        for (const entity of read.knowledge.entities) {
          const offeredEntity = offered.entries.find(entry => entry.kind === 'entity' &&
            entry.ref.id === entity.id && entry.ref.source.documentId === paper.document.id);
          assert.ok(offeredEntity, 'each result retains all referenced entities');
          for (const key of ['canonicalName', 'aliases']) {
            assert.deepEqual((offeredEntity.value.resolved ?? offeredEntity.value.proposal)[key], entity[key]);
          }
          assert.equal(offeredEntity.value.resolutionStatus, entity.resolutionStatus);
          assert.equal(offered.entityScientificApproval, entity.scientificApproval);
          for (const key of ['canonicalName', 'aliases', 'attributes']) {
            assert.deepEqual(offeredEntity.value.proposal[key], entity.proposal[key], 'original proposed meaning reaches the model');
          }
          assert.deepEqual(offeredEntity.value.proposal.evidence.map(index => offered.sources[index].proposal), entity.proposal.evidence);
        }
        for (const [index, condition] of input.value.conditionEvidence.entries()) {
          assert.deepEqual(condition.evidence.map(index => offered.sources[index].proposal),
            fact.conditionEvidence[index].evidence.map(source => source.proposal));
          assert.ok(condition.evidence.every(index => offered.sources[index].source.documentId === paper.document.id));
        }
      }
      assert.ok(structured.wikiSynthesisInputTokens(call.messages, call.schema, call.options.name) <= 16000);
      return {sections: [{id: target.id, goal: 'Compare complete recorded experimental conditions.', statements: facts.map(entry => entry.ref)}]};
    })));
    const updated = await f.wiki.resynthesize(f.synthesisInput(f.page, [target.id]));
    assert.ok(updated.current.sections.find(item => item.id === target.id).body.includes(section.body));
    assert.equal(updated.current.sections.find(item => item.id === target.id).scientificExplanation.statements[0].kind, 'comparison');
    assert.deepEqual(f.wiki.revision(f.project.id, f.page.page.id, original.revision), original);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_evidence').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_claims').pluck().get(), 0);
  } finally {await f.finish();}
});

test('equal printed Dataset/Metric/Baseline names without explicit cross-source identity alignment cannot be compared directly', async () => {
  const f = await scientificComparisonFixture(api, services, {aligned: false});
  try {
    const knowledge = await f.readAll(), result = comparison.checkScientificComparison(columns(knowledge), f.sources);
    assert.equal(result.status, 'not_directly_comparable');
    for (const field of ['dataset', 'metric', 'baseline']) assert.equal(result.checks.find(check => check.field === field).status, 'unknown');
    const saved = await f.wiki.saveCurrent(f.saveInput(f.page, bodyFor(knowledge)), 'assistant');
    assert.match(saved.current.sections.find(item => item.id === target.id).body, /不可直接比较 · Not directly comparable/);
  } finally {await f.finish();}
});

test('every missing or different experimental dimension and incomplete paper selection fails direct comparability', async () => {
  const f = await scientificComparisonFixture(api, services);
  try {
    const knowledge = await f.readAll(), original = columns(knowledge);
    for (const [field, mutate] of [
      ['dataset', column => {column.fact.conditions.datasetId = null;}],
      ['dataset', column => {column.entities.find(entity => entity.entityType === 'Dataset').proposal.attributes.version = 'v2';}],
      ['dataset_version', column => {column.fact.conditions.datasetVersion = 'v2';}],
      ['split', column => {column.fact.conditions.split = 'validation';}],
      ['metric', column => {column.fact.conditions.metricId = null;}],
      ['metric_definition', column => {column.entities.find(entity => entity.entityType === 'Metric').proposal.attributes.definition = null;}],
      ['unit', column => {column.fact.value.unit = 'seconds';}],
      ['baseline', column => {column.fact.conditions.baselineId = null;}],
      ['baseline_version', column => {column.entities.find(entity => entity.entityType === 'Baseline').proposal.attributes.version = 'v2';}],
      ['budget', column => {column.fact.conditions.budget = 'unknown';}],
      ['hardware', column => {delete column.fact.conditions.hardware;}],
      ['trainingBudget', column => {column.fact.conditions.trainingBudget = 'unknown';}],
      ['inferenceBudget', column => {column.fact.conditions.inferenceBudget = '3 ms';}],
      ['randomSeeds', column => {column.fact.conditions.randomSeeds = '2';}],
      ['repeats', column => {column.fact.conditions.repeats = '1';}],
      ['uncertainty', column => {column.fact.conditions.uncertainty = 'unknown';}],
      ['other_conditions', column => {column.fact.conditions.other.seed = '2';}],
      ['other_conditions', column => {column.fact.conditions.other = {};}],
      ['numeric_value', column => {column.fact.value.normalized = null;}]
    ]) {
      const changed = structuredClone(original); mutate(changed[1]);
      const result = comparison.checkScientificComparison(changed, f.sources);
      assert.equal(result.status, 'not_directly_comparable', field);
      assert.notEqual(result.checks.find(check => check.field === field).status, 'match', field);
    }
    for (const selected of [original.slice(0, 2), [original[0]], [original[0], original[0]]]) {
      assert.equal(comparison.checkScientificComparison(selected, f.sources).status, 'not_directly_comparable');
    }
    const reordered = structuredClone(original);
    reordered.forEach(column => {column.fact.conditions.other = {second: '2', first: '1'};});
    reordered[1].fact.conditions.other = {first: '1', second: '2'};
    assert.equal(comparison.checkScientificComparison(reordered, f.sources).status, 'conditions_match');
  } finally {await f.finish();}
});

test('public comparison saves reject forged verdicts and values; a PDF change during comparison inference leaves history untouched', async () => {
  const f = await scientificComparisonFixture(api, services);
  try {
    const knowledge = await f.readAll(), section = bodyFor(knowledge), revision = f.page.page.revision;
    for (const body of [section.body.replace('Recorded conditions match', 'Method C is scientifically best'),
      section.body.replace('"89"', '"99"'), section.body.replace('"split": "test"', '"split": "unknown"')]) {
      await assert.rejects(() => f.wiki.saveCurrent(f.saveInput(f.page, {...section, body}), 'assistant'), /wiki_scientific_proposal_invalid/);
      assert.equal(f.wiki.read(f.project.id, f.page.page.id).page.revision, revision);
    }
    f.wiki.configureSynthesis(async () => {
      const bytes = Buffer.from(f.papers[1].bytes); bytes[20] ^= 1; await writeFile(f.papers[1].sourcePath, bytes);
      return [section];
    });
    await assert.rejects(() => f.wiki.resynthesize(f.synthesisInput(f.page, [target.id])), /source|current_sources|receipt|fingerprint/);
    assert.equal(f.wiki.read(f.project.id, f.page.page.id).page.revision, revision);
    assert.equal(f.wiki.history(f.project.id, f.page.page.id).length, 1);
  } finally {await f.finish();}
});
