import {before, test} from 'node:test';
import assert from 'node:assert/strict';
import {AIMessage} from '@langchain/core/messages';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let service, structure, schema;
before(async () => {
  [service, structure, schema] = await Promise.all([
    'src/main/plugins/research/paper-semantic-service.ts',
    'src/main/plugins/research/paper-structure.ts',
    'src/shared/schemas/research-paper-semantics.ts'
  ].map(entry => importTypeScriptModule(entry, {
    platform: 'node', external: ['@langchain/core/messages'], tempDir: '.runtime/tmp'
  })));
});
const block = (id, text = `Uncertain original passage ${id}.`, kind = 'paragraph') => ({id, text, kind, locator: `source:${id}`});
const blocks = (n = 40) => Array.from({length: n}, (_, i) => block(`b${i}`));
const signal = () => new AbortController().signal;
const result = (rows, roles = [{role: 'contribution', confidence: .85}]) => ({
  output: {blocks: rows.map(({blockId}) => ({blockId, roles}))},
  providerId: 'test-provider', modelId: 'test-model', inputTokens: 300, outputTokens: 80
});
const enrich = (input, generator, abort = signal()) => service.enrichPaperSemantics(input, undefined, generator, abort);

test('sample is deterministic, evenly spaced, bounded and excludes known headings/references/long blocks', () => {
  const input = [block('heading', '2 Method', 'heading'), block('rule', 'The method learns features.'),
    block('embedded', 'Exact source.\n3 Results\nTail.'), ...blocks(),
    block('long', 'unusual '.repeat(2000)), block('ref', 'References', 'heading'),
    block('citation', 'Unknown original citation.')];
  const selection = service.selectPaperSemanticSample(input);
  assert.deepEqual(selection, service.selectPaperSemanticSample(input));
  assert.equal(selection.eligibleBlocks, 40);
  assert.deepEqual(selection.sample.map(r => r.blockId), ['b0', 'b5', 'b10', 'b15', 'b20', 'b25', 'b30', 'b35']);
  assert.ok(selection.inputBudgetTokens <= 6000);
  const small = service.selectPaperSemanticSample(blocks(5));
  assert.equal(small.sample.length, 2);
  const large = service.selectPaperSemanticSample(Array.from({length: 40}, (_, i) =>
    block(`b${i}`, 'unusual '.repeat(990))));
  assert.ok(large.sample.length < 8 && large.sample.length > 0);
  assert.ok(large.inputBudgetTokens <= 6000);
});

test('one complete proposal adds multiple roles while preserving exact sources and unsampled rule semantics', async () => {
  const input = blocks(), original = structuredClone(input);
  const base = structure.buildPaperStructure(input);
  let calls = 0;
  const enriched = await enrich(input, async rows => {
    calls++;
    return result(rows, [{role: 'contribution', confidence: .9}, {role: 'limitation', confidence: .8},
      {role: 'result', confidence: .74}]);
  });
  assert.equal(calls, 1); assert.deepEqual(input, original);
  assert.equal(enriched.observation.status, 'classified');
  assert.equal(enriched.observation.inputTokens, 300);
  for (const annotation of enriched.structure.blocks) {
    if (enriched.observation.selectedBlockIds.includes(annotation.blockId)) {
      assert.deepEqual(annotation.semantic.roles.map(r => r.role), ['contribution', 'limitation']);
      assert.ok(annotation.semantic.roles.every(r => r.source === 'model'));
    } else assert.deepEqual(annotation, base.blocks.find(b => b.blockId === annotation.blockId));
  }
  service.assertPaperSemanticEnrichment(enriched, input, base);
  for (const change of [
    r => r.structure.blocks.reverse(),
    r => r.structure.blocks[1].semantic = r.structure.blocks[0].semantic,
    r => r.sourceDigest = 'b'.repeat(64),
    r => r.observation.selectedBlockIds.reverse()
  ]) {
    const invalid = structuredClone(enriched); change(invalid);
    assert.throws(() => service.assertPaperSemanticEnrichment(invalid, input, base));
  }
  const altered = structuredClone(input); altered[0].text += ' changed';
  assert.throws(() => service.assertPaperSemanticEnrichment(enriched, altered, base));
});

test('empty/weak model roles preserve unknown and all existing low-strength rule roles', async () => {
  const input = blocks(4);
  const base = structure.buildPaperStructure(input);
  base.blocks[0].semantic = {version: 1, classifierVersion: 'roc-paper-semantic-rules/1', status: 'classified',
    roles: [{role: 'problem', source: 'rule', confidence: .6, signals: ['weak_rule']}]};
  const enriched = await service.enrichPaperSemantics(input, base, async rows => result(rows, []), signal());
  assert.deepEqual(enriched.structure.blocks[0].semantic.roles, base.blocks[0].semantic.roles);
  assert.equal(enriched.structure.blocks[0].semantic.status, 'classified');
  const empty = await enrich(blocks(4), async rows => result(rows, [{role: 'result', confidence: .74}]));
  assert.equal(empty.structure.blocks[0].semantic.status, 'unknown');
  assert.deepEqual(empty.structure.blocks[0].semantic.roles, []);
});

test('missing/extra/duplicate IDs, duplicate roles, rewritten text and malformed metadata reject atomically', async () => {
  const input = blocks(8), base = structure.buildPaperStructure(input);
  for (const change of [
    r => r.output.blocks.pop(),
    r => r.output.blocks.push({blockId: 'invented', roles: []}),
    r => r.output.blocks[1].blockId = r.output.blocks[0].blockId,
    r => r.output.blocks[0].roles.push(r.output.blocks[0].roles[0]),
    r => r.output.blocks[0].text = 'rewritten',
    r => r.inputTokens = -1,
    r => r.modelId = 'x'.repeat(301),
    r => r.output.blocks[0].roles[0].confidence = NaN
  ]) {
    const enriched = await enrich(input, async rows => {const proposal = result(rows); change(proposal); return proposal;});
    assert.equal(enriched.observation.status, 'failed');
    assert.equal(enriched.observation.failureCode, 'research_semantic_output_invalid');
    assert.deepEqual(enriched.structure, base);
  }
  const mutation = await enrich(input, async rows => {rows[0].blockId = 'mutated'; return result(rows);});
  assert.equal(mutation.observation.failureCode, 'research_semantic_output_invalid');
});

test('no candidates, unavailable and provider rejection remain distinct and do not leak provider errors', async () => {
  let calls = 0;
  const noCandidates = await enrich([block('h', '2 Method', 'heading')], async rows => {calls++; return result(rows);});
  assert.equal(noCandidates.observation.status, 'no_candidates'); assert.equal(calls, 0);
  const unavailable = await enrich(blocks(), null);
  assert.equal(unavailable.observation.status, 'unavailable'); assert.equal(unavailable.observation.calls, 0);
  const failed = await enrich(blocks(), async () => {throw new Error('secret-provider-payload');});
  assert.equal(failed.observation.status, 'failed'); assert.equal(failed.observation.calls, 1);
  assert.equal(failed.observation.failureCode, 'research_semantic_model_failed');
  assert.ok(!JSON.stringify(failed).includes('secret-provider-payload'));
  for (const change of [r => r.observation.calls = 1, r => r.observation.failureCode = 'research_semantic_timeout']) {
    const invalid = structuredClone(unavailable); change(invalid);
    assert.throws(() => schema.paperSemanticEnrichmentSchema.parse(invalid));
  }
});

test('parent cancellation aborts provider and rejects publication even if provider ignores cancellation', async () => {
  const controller = new AbortController();
  let release, started, providerSignal;
  const ready = new Promise(resolve => {started = resolve;});
  const pending = enrich(blocks(), (rows, abort) => {
    providerSignal = abort; started();
    return new Promise(resolve => {release = () => resolve(result(rows));});
  }, controller.signal);
  await ready;
  controller.abort(new Error('parent_cancelled'));
  await assert.rejects(pending, /parent_cancelled/);
  assert.equal(providerSignal.aborted, true);
  release();
  await assert.rejects(enrich(blocks(), async rows => result(rows), controller.signal), /parent_cancelled/);
});

test('deadline finishes with rule snapshot and rejects a late noncooperative result', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const input = blocks();
  let release, providerSignal;
  const pending = enrich(input, (rows, abort) => {
    providerSignal = abort;
    return new Promise(resolve => {release = () => resolve(result(rows));});
  });
  t.mock.timers.tick(30_000);
  const value = await pending;
  assert.equal(providerSignal.aborted, true);
  assert.equal(value.observation.status, 'timed_out');
  assert.equal(value.observation.failureCode, 'research_semantic_timeout');
  assert.deepEqual(value.structure, structure.buildPaperStructure(input));
  release(); await Promise.resolve();
  assert.deepEqual(value.structure, structure.buildPaperStructure(input));
});

test('actual LangChain structured-output adapter propagates schema, cap, cancellation and usage', async () => {
  const abort = signal(), rows = service.selectPaperSemanticSample(blocks()).sample;
  const generator = service.createPaperSemanticGenerator({
    async createDefaultChatModel(options) {
      assert.deepEqual(options, {streaming: false, maxOutputTokens: 1500});
      return {provider: {id: 'configured-provider'}, modelId: 'configured-model', model: {
        withStructuredOutput(outputSchema, options) {
          assert.deepEqual(options, {name: 'scientific_block_roles', includeRaw: true});
          assert.equal(outputSchema.safeParse({blocks: [{blockId: 'id', roles: [], text: 'rewrite'}]}).success, false);
          return {async invoke(messages, config) {
            assert.equal(config.signal, abort);
            assert.match(messages[0].content, /untrusted data/);
            assert.deepEqual(JSON.parse(messages[1].content), {blocks: rows});
            return {parsed: result(rows).output, raw: new AIMessage({
              content: '', usage_metadata: {input_tokens: 401, output_tokens: 103, total_tokens: 504}
            })};
          }};
        }
      }};
    }
  });
  const actual = await generator(rows, abort);
  assert.equal(actual.providerId, 'configured-provider'); assert.equal(actual.modelId, 'configured-model');
  assert.equal(actual.inputTokens, 401); assert.equal(actual.outputTokens, 103);
});
