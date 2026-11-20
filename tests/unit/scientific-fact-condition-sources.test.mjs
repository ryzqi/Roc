import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {z} from 'zod';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {
  const modules = await Promise.all(['scientific-fact-wire', 'scientific-fact-extractor', 'paper-ir-builder',
    'scientific-fact-validator'].map(name => importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
    {platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'})));
  api = Object.assign({}, ...modules);
});
const text = (index = 0) => ({kind: 'text_span', textId: `text-${index}`});
const blocks = ['GE-FL uses Dataset-A and accuracy on the train split.', 'L = sum p(y|x)'];
const entities = [
  {id: 'baseline', entityType: 'Baseline', canonicalName: 'GE-FL'},
  {id: 'dataset', entityType: 'Dataset', canonicalName: 'Dataset-A'},
  {id: 'metric', entityType: 'Metric', canonicalName: 'accuracy'},
  {id: 'method', entityType: 'Method', canonicalName: 'GE-FL'},
  {id: 'baseline2', entityType: 'Baseline', canonicalName: 'missing-baseline'}
];
const sources = blocks.map((quote, index) => ({quote,
  proposal: {kind: 'text', blockId: `block-${index}`, start: 0, end: quote.length, quote}}));
const schema = () => api.scientificFactWireSchema({tables: []}, {id: 'batch',
  blocks: blocks.map((text, index) => ({blockId: `block-${index}`, start: 0, end: text.length, text})),
  objects: []}, [], {cellHandle: (_table, cell) => cell}, entities.map(e => e.id), {entities, sources});
const base = () => ({
  id: 'fact', factType: 'method_component', subjectEntityId: null, objectEntityId: null,
  predicate: 'Original method configuration', value: null, table: null,
  conditions: {datasetId: null, datasetVersion: 'unknown', split: 'unknown',
    metricId: null, baselineId: null, budget: 'unknown', other: {}},
  conditionEvidence: [], evidence: [text()], confidence: .5
});
const item = (field, index = 0, key = null) => ({field, key, evidence: [text(index)]});

test('original failure pattern: generated string and baseline name need selected source support', () => {
  for (const [field, value, evidence] of [
    ['other', {task: 'baseball-hockey classification'}, item('other', 0, 'task')],
    ['baselineId', 'baseline', item('baselineId', 1)]
  ]) {
    const fact = base(); fact.conditions[field] = value; fact.conditionEvidence = [evidence];
    const before = structuredClone(fact);
    assert.equal(schema().safeParse({facts: [fact]}).success, false, field);
    assert.deepEqual(fact, before, 'Source failure must never repair a candidate');
  }
});

test('provider JSON Schema narrows typed IDs and excludes nonmentioning baseline text', () => {
  const json = z.toJSONSchema(schema());
  const proposal = json.properties.facts.items;
  assert.deepEqual(proposal.properties.conditions.properties.baselineId.anyOf[0].enum, ['baseline']);
  const choices = proposal.properties.conditionEvidence.items.anyOf;
  const baseline = choices.find(c => c.properties.field.const === 'baselineId');
  assert.ok(baseline);
  const evidence = baseline.properties.evidence.items;
  assert.deepEqual(evidence.properties.textId.const, 'text-0');
  assert.ok(!JSON.stringify(baseline).includes('text-1'));
});

test('supported choices remain exact; the selected entity must match its own evidence', () => {
  for (const [field, value] of [['datasetId', 'dataset'], ['metricId', 'metric'], ['baselineId', 'baseline'],
    ['split', 'train'], ['other', {optimizer: 'GE-FL'}]]) {
    const fact = base(); fact.conditions[field] = value;
    fact.conditionEvidence = [item(field, 0, field === 'other' ? 'optimizer' : null)];
    assert.deepEqual(schema().parse({facts: [fact]}), {facts: [fact]});
  }
  for (const id of ['method', 'baseline2', 'dataset']) {
    const fact = base(); fact.conditions.baselineId = id; fact.conditionEvidence = [item('baselineId')];
    assert.equal(schema().safeParse({facts: [fact]}).success, false);
  }
  const partial = base(); partial.conditions.split = 'rain'; partial.conditionEvidence = [item('split')];
  assert.equal(schema().safeParse({facts: [partial]}).success, false, 'Printed-token boundaries remain authoritative');
});

test('an unselectable complete title does not prevent Fact extraction from valid sources', async () => {
  const identity = {paperId: 'paper', documentId: 'document', parseId: 'parse', knowledgeDocumentId: 'knowledge',
    sourceHash: 'a'.repeat(64), parserFingerprint: 'b'.repeat(64)};
  const quote = 'Original method uses the train split.';
  for (const length of [16000, 16001]) {
    const ir = api.buildPaperIR({identity, content: {sourceHash: identity.sourceHash,
      parserFingerprint: identity.parserFingerprint,
      blocks: [{id: 'prose', kind: 'paragraph', text: quote, label: 'paragraph', locator: 'page 1',
        imagePath: null, locations: [{page: 1, bbox: [10, 10, 300, 30], coordinateOrigin: 'TOPLEFT'}]}],
      quality: {version: 'roc-paper-quality/1', coverageDefinition: 'clipped-rectangle-union/measured-page-area',
        pages: [], status: 'good', failure: null}},
      metadata: {title: 'X'.repeat(length), authors: [], doi: null, year: null, origin: 'library'}});
    const batch = {id: 'batch', blocks: ir.blocks.map(block => ({blockId: block.blockId, kind: block.kind,
      start: 0, end: block.text.length, text: block.text, sections: []})), objects: []};
    const before = structuredClone({ir, batch});
    const inventory = api.scientificFactConditionSources(ir, batch);
    assert.equal(inventory.some(source => source.proposal.kind === 'metadata' &&
      source.proposal.field === 'title'), length === 16000);
    assert.ok(inventory.some(source => source.quote === quote));
    const proposal = {kind: 'metadata', field: 'title', raw: ir.metadata.title};
    if (length === 16000) assert.equal(api.validateScientificSource(proposal, ir).quote, ir.metadata.title);
    else assert.throws(() => api.validateScientificSource(proposal, ir), /too_big/,
      'The original selected-source limit must still reject an oversized title');
    let invoked = 0;
    const facts = await api.extractScientificFacts({config: {inputTokens: 64000}, invoke: async call => {
      invoked++;
      const input = JSON.parse(call.messages[1].content);
      assert.equal(input.metadata.title, ir.metadata.title, 'Complete input must not be cropped');
      const fact = base();
      const choice = input.conditionTokenChoices.sources.find(choice => choice.evidence.textId === 'text-0');
      const token = choice.tokens.find(([_, text]) => text === 'train')[0];
      fact.conditions.split = {sourceId: choice.sourceId, firstToken: token, lastToken: token};
      fact.conditionEvidence = [item('split')];
      return call.schema.parse({facts: [fact]});
    }}, batch, ir, [], new AbortController().signal);
    assert.equal(invoked, 1);
    assert.equal(facts.length, 1);
    assert.deepEqual({ir, batch}, before, 'Inventory must preserve the original IR and batch');
  }
});
