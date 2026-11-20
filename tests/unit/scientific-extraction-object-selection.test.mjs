import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {z} from 'zod';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, extraction;
before(async () => {
  api = await loadScientificSearchApi();
  extraction = Object.assign({}, ...await Promise.all(
    ['scientific-entity-extractor', 'scientific-extraction-batches'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
        {platform: 'node', external: ['@napi-rs/canvas'], tempDir: '.runtime/tmp'}))));
});
after(() => api?.dispose());
const config = {extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'fixture/1',
  model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: 'fixture'},
  inputTokens: 64000, batchTokens: 8000};
const kinds = ['Equation', 'Figure', 'Table', 'Algorithm'];
const capture = async (ir, batch) => {
  let schema;
  await extraction.extractScientificEntities({config, invoke: async call => {
    schema = call.schema;
    return {entities: []};
  }}, batch, ir, AbortSignal.timeout(5000));
  return schema;
};

test('object-free Entity calls retain all structural branches but cannot select an invented object', async () => {
  const f = await scientificSearchFixture(api, {embedded: false, objects: false});
  try {
    const batch = extraction.buildScientificExtractionBatches(f.ir, config)[0];
    assert.equal(batch.objects.length, 0);
    const before = f.db.serialize(), schema = await capture(f.ir, batch);
    const branches = z.toJSONSchema(schema).properties.entities.items.oneOf;
    assert.deepEqual(branches.map(branch => branch.properties.entityType.const),
      ['Method', 'Model', 'Dataset', 'Metric', 'Experiment', 'Baseline', ...kinds]);
    assert.deepEqual(branches[0].properties.evidence.items.oneOf.map(branch => branch.properties.kind.const),
      ['text_span', 'table_cell', 'object', 'metadata']);
    for (const [index, entityType] of kinds.entries()) {
      assert.deepEqual(branches[index + 6].properties.objectId, {not: {}});
      assert.equal(schema.safeParse({entities: [{id: 'fabricated', entityType, objectId: 'figure-1'}]}).success, false);
    }
    assert.equal(schema.safeParse({entities: []}).success, true);
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});

test('structural Entity wire enums contain every original current-batch object of that type only', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const before = f.db.serialize();
    for (const batch of extraction.buildScientificExtractionBatches(f.ir, config)) {
      const schema = await capture(f.ir, batch);
      const branches = z.toJSONSchema(schema).properties.entities.items.oneOf;
      for (const [index, entityType] of kinds.entries()) {
        const ids = batch.objects.filter(object => object.objectType === entityType).map(object => object.objectId);
        assert.deepEqual(branches[index + 6].properties.objectId,
          ids.length === 0 ? {not: {}} : {type: 'string', enum: ids});
        for (const object of batch.objects) {
          const selection = {entities: [{id: 'selected', entityType, objectId: object.objectId}]};
          assert.equal(schema.safeParse(selection).success, object.objectType === entityType);
        }
        assert.equal(schema.safeParse({entities: [{id: 'unseen', entityType, objectId: 'foreign-object'}]}).success, false);
      }
    }
    assert.deepEqual(f.db.serialize(), before);
  } finally {await f.close();}
});
