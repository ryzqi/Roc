import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';
let api, query;
before(async () => {
  [api, query] = await Promise.all([loadScientificSearchApi(), importTypeScriptModule(
    'src/main/plugins/research/scientific-query-orchestrator.ts', {platform: 'node', tempDir: '.runtime/tmp'})]);
});
after(() => api?.dispose());

test('unified retrieval keeps exact reconstructable rounds and stable raw source identities', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const service = new query.ScientificQueryOrchestrator(f.router, f.embeddings);
    const result = await service.search(f.request('Compare Table 3 and Equation (7)'));
    assert.ok(result.rounds.length >= 1 && result.rounds.length <= 3);
    assert.ok(result.sourceRefs.length);
    assert.ok(result.hits.some(hit => hit.object.kind === 'equation'));
    assert.ok(result.rounds.reduce((count, round) => count + round.candidates.length, 0) <= result.rounds[0].plan.maxCandidates);
    for (const round of result.rounds) {
      await f.router.assertCurrent(round);
      await f.router.readContext({search: round, candidateIds: [], budget: {maxTokens: 8000}});
    }
    assert.ok(result.sourceRefs.every(ref => ref.sourceHash === f.ir.identity.sourceHash));
    await f.publish();
    await assert.rejects(f.router.readContext({search: result.rounds[0], candidateIds: [], budget: {maxTokens: 8000}}), /changed/);
  } finally {await f.close();}
});

test('explicit and unresolved paper scopes never leak into broad legacy fallback', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  let calls = 0;
  const service = new query.ScientificQueryOrchestrator(f.router, {search: async () => {calls++; throw new Error('scope leaked');}});
  try {
    const selected = await service.search({...f.request('Table 3'), documentIds: [f.document.id]});
    assert.ok(selected.hits.length);
    const missing = await service.search(f.request('DOI:10.9999/absent'));
    assert.equal(missing.hits.length, 0); assert.equal(calls, 0);
    const aborted = new AbortController(); aborted.abort(new Error('cancelled'));
    await assert.rejects(service.search(f.request('Table 3'), aborted.signal), /cancelled/);
  } finally {await f.close();}
});

test('deadline yields completed receipts, never accepts changed sources during fallback', async () => {
  const f = await scientificSearchFixture(api, {embedded: false});
  try {
    const legacy = {search: async (_request, signal) => new Promise((_, reject) => {
      const fail = () => reject(signal.reason);
      if (signal.aborted) fail(); else signal.addEventListener('abort', fail, {once: true});
    })};
    const result = await new query.ScientificQueryOrchestrator(f.router, legacy, 250).search(f.request('Original method'));
    assert.equal(result.stopReason, 'time_budget'); assert.ok(result.rounds.length);
    const changing = {search: async () => {await f.publish(); return f.embeddings.search({projectId:f.project.id, query:'method',limit:20,embeddingConfigId:null});}};
    await assert.rejects(new query.ScientificQueryOrchestrator(f.router, changing).search(f.request('Original method')), /changed/);
  } finally {await f.close();}
});
