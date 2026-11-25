import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
let schema;
before(async () => {schema = await importTypeScriptModule('src/shared/schemas/research-page-location.ts', {platform: 'node'});});
test('page geometry is explicitly absent or a finite positive-area region with an origin', () => {
  const page = {page: 3, bbox: null, coordinateOrigin: null};
  assert.deepEqual(schema.researchPageLocationSchema.parse(page), page);
  const region = {...page, bbox: [10, 20, 30, 40], coordinateOrigin: 'BOTTOMLEFT'};
  assert.deepEqual(schema.researchPageLocationSchema.parse(region), region);
  for (const value of [{...page, page: 0}, {...page, coordinateOrigin: 'TOPLEFT'}, {...region, coordinateOrigin: null},
    {...region, bbox: [0, 0, 0, 0]}, {...region, bbox: [40, 20, 10, 30]}, {...region, bbox: [0, 0, Infinity, 10]}]) {
    assert.equal(schema.researchPageLocationSchema.safeParse(value).success, false);
  }
  assert.equal(schema.sameResearchPageLocation(page, {...page}), true);
  assert.equal(schema.sameResearchPageLocation(page, {...page, page: 2}), false);
  assert.equal(schema.sameResearchPageLocation(page, region), false);
  assert.equal(schema.sameResearchPageLocation(region, {...region, bbox: [10, 20, 31, 40]}), false);
});
