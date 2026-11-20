import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api;
before(async () => {
  api = Object.assign({}, ...await Promise.all(['scientific-fact-extractor', 'scientific-extraction-input',
    'scientific-fact-wire', 'scientific-fact-condition-tokens', 'paper-ir-builder', 'pdf-table-extractor',
    'scientific-extraction-batches'].map(name =>
    importTypeScriptModule(`src/main/plugins/research/${name}.ts`,
      {platform: 'node', external: ['zod'], tempDir: '.runtime/tmp'}))));
});
const source = index => ({kind: 'text_span', textId: `text-${index}`});
const base = () => ({
  id: 'fact', factType: 'method_component', subjectEntityId: null, objectEntityId: null,
  predicate: 'Original configuration', value: null, table: null,
  conditions: {datasetId: null, datasetVersion: 'unknown', split: 'unknown',
    metricId: null, baselineId: null, budget: 'unknown', other: {}},
  conditionEvidence: [], evidence: [source(0)], confidence: .5
});
function fixture(quotes = ['Method uses train\t\r\n𝛼-fold e\u0301 split.', 'Method uses train\t\r\n𝛼-fold e\u0301 split.'],
  tableHtml = null) {
  const identity = {paperId: 'paper', documentId: 'document', parseId: 'parse', knowledgeDocumentId: 'knowledge',
    sourceHash: 'a'.repeat(64), parserFingerprint: 'b'.repeat(64)};
  const ir = api.buildPaperIR({identity, content: {sourceHash: identity.sourceHash,
    parserFingerprint: identity.parserFingerprint, blocks: quotes.map((text, index) => {
      const block = {id: `prose-${index}`, kind: tableHtml ? 'table' : 'paragraph', text,
        label: tableHtml ? 'table' : 'paragraph', locator: `page ${index + 1}`, imagePath: null,
        locations: [{page: index + 1, bbox: [10, 10, 300, 30], coordinateOrigin: 'TOPLEFT'}]};
      return tableHtml ? {...block, table: api.extractPaperTable(block, {id: block.id, rawHtml: tableHtml})} : block;
    }), quality: {version: 'roc-paper-quality/1', coverageDefinition: 'clipped-rectangle-union/measured-page-area',
      pages: [], status: 'good', failure: null}},
    metadata: {title: 'Original paper', authors: [], doi: null, year: null, origin: 'library'}});
  const batch = tableHtml ? api.buildScientificExtractionBatches(ir, {
    extractorVersion: 'roc-scientific-knowledge/1', promptVersion: 'fixture/1',
    model: {provider: 'fixture', modelId: 'fixture', model: 'fixture', revision: 'fixture/1'},
    inputTokens: 64000, batchTokens: 8000})
    .find(batch => batch.objects.some(object => object.objectType === 'Table')) :
    {id: 'batch', blocks: ir.blocks.map(block => ({blockId: block.blockId, kind: block.kind,
    start: 0, end: block.text.length, text: block.text, sections: []})),
    objects: []};
  return {ir, batch};
}
function select(input, evidence, firstToken, lastToken = firstToken) {
  const choice = input.conditionTokenChoices.sources.find(choice =>
    JSON.stringify(choice.evidence) === JSON.stringify(evidence));
  assert.ok(choice, 'The complete original source must have one selectable identity');
  return {sourceId: choice.sourceId, firstToken, lastToken};
}
const extract = (f, invoke, inputTokens = 64000) => api.extractScientificFacts(
  {config: {inputTokens}, invoke}, f.batch, f.ir, [], new AbortController().signal);

test('actual Fact extraction decodes exact UTF16 ranges once and preserves the complete original payload', async () => {
  const f = fixture(), before = structuredClone(f);
  let calls = 0, originalOutput;
  const facts = await extract(f, async call => {
    calls++;
    const input = JSON.parse(call.messages[1].content);
    assert.equal(input.conditionTokenChoices.version, 'roc-scientific-fact-condition-tokens/1');
    const {conditionTokenChoices, ...original} = input;
    assert.equal(JSON.stringify(original), JSON.stringify(api.scientificExtractionInput(f.batch,
      {textSelections: true}).encode({metadata: f.ir.metadata, batch: f.batch, entities: [],
      resultSubjectEntityIds: [], resultEvidenceScopes: []})));
    assert.equal(conditionTokenChoices.sources.filter(choice => choice.evidence.kind === 'text_span').length, 2);
    const fact = base();
    fact.conditions.split = select(input, source(0), 2, 4);
    fact.conditions.other = {configuration: select(input, source(1), 2, 4)};
    fact.conditionEvidence = [
      {field: 'split', key: null, evidence: [source(0)]},
      {field: 'other', key: 'configuration', evidence: [source(1)]}
    ];
    originalOutput = structuredClone(fact);
    const once = call.schema.parse({facts: [fact]});
    assert.deepEqual(call.schema.parse(once), once, 'Provider/session/invoke parsing must be idempotent');
    assert.deepEqual(once, {facts: [fact]}, 'Validation retains range objects and evidence');
    return {facts: [fact]};
  });
  assert.equal(calls, 1);
  assert.equal(facts[0].conditions.split, 'train\t\r\n𝛼-fold e\u0301');
  assert.equal(facts[0].conditions.other.configuration, facts[0].conditions.split);
  assert.equal(facts[0].conditionEvidence[1].evidence[0].blockId, f.batch.blocks[1].blockId);
  assert.deepEqual(f, before);
  assert.equal(typeof originalOutput.conditions.split, 'object');
});

test('actual numeric Fact guidance separates permitted ranges from unsupported header methods', async () => {
  const f = fixture(['Task Algorithm A\nreview 0.625'],
    '<table><tr><td>Task</td><td>Algorithm A</td></tr><tr><td>review</td><td>0.625</td></tr></table>');
  const before = structuredClone(f);
  const facts = await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content), prompt = call.messages[0].content;
    assert.match(prompt, /Check condition permissions before choosing a condition value/u);
    assert.match(prompt, /Omit both that other key and its matching conditionEvidence/u);
    const table = input.batch.objects[0], value = table.content.cells.find(cell => cell.text === '0.625');
    const choice = raw => input.conditionTokenChoices.sources.find(choice =>
      choice.evidence.kind === 'table_cell' && choice.evidence.raw === raw);
    const own = choice('review'), header = choice('Algorithm A');
    assert.ok(own && header);
    const allowed = input.conditionTokenChoices.numericScopes.find(scope =>
      scope.tableId === table.objectId && scope.row === value.row).allowedSourceIds;
    assert.ok(allowed.includes(own.sourceId));
    assert.ok(!allowed.includes(header.sourceId), 'Visible method text does not grant row permission');
    const fact = {...base(), factType: 'experimental_result', predicate: 'Reported result',
      value: {raw: '0.625', unit: null, unitEvidence: []},
      table: {tableId: table.objectId, cellId: value.id, row: value.row},
      evidence: [{kind: 'table_cell', tableId: table.objectId, cellId: value.id, raw: '0.625'}]};
    const unsupported = structuredClone(fact);
    unsupported.conditions.other.method = 'Algorithm A';
    unsupported.conditionEvidence = [{field: 'other', key: 'method', evidence: [own.evidence]}];
    assert.equal(call.schema.safeParse({facts: [unsupported]}).success, false);
    unsupported.conditions.other.method = {sourceId: header.sourceId, firstToken: 0, lastToken: 1};
    unsupported.conditionEvidence[0].evidence = [header.evidence];
    assert.equal(call.schema.safeParse({facts: [unsupported]}).success, false);
    const original = structuredClone(unsupported);
    const partial = structuredClone(unsupported);
    delete partial.conditions.other.method;
    assert.equal(call.schema.safeParse({facts: [partial]}).success, false, 'An omitted value cannot retain its evidence');
    partial.conditionEvidence = [];
    assert.ok(call.schema.safeParse({facts: [partial]}).success);
    assert.deepEqual(unsupported, original, 'The host never repairs the rejected proposal');
    fact.conditions.other.task = {sourceId: own.sourceId, firstToken: 0, lastToken: 0};
    fact.conditionEvidence = [{field: 'other', key: 'task', evidence: [own.evidence]}];
    assert.ok(call.schema.safeParse({facts: [fact]}).success, 'An exact permitted range remains available');
    return {facts: [fact, {...partial, id: 'unsupported-method-omitted'}]};
  });
  assert.equal(facts[0].conditions.other.task, 'review');
  assert.deepEqual(facts[1].conditions.other, {});
  assert.deepEqual(facts[1].conditionEvidence, []);
  assert.equal(facts[1].value.raw, '0.625');
  assert.equal(facts[1].subjectEntityId, null);
  assert.deepEqual(f, before);
});

test('source identity, field/key membership and range corruption fail without repairing model output', async () => {
  const f = fixture(['train split unknown Unknown', 'train split unknown Unknown']);
  await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content);
    const valid = base();
    valid.conditions.split = select(input, source(0), 0);
    valid.conditionEvidence = [{field: 'split', key: null, evidence: [source(0)]}];
    assert.ok(call.schema.safeParse({facts: [valid]}).success);
    const changes = [
      fact => {fact.conditions.split.sourceId = 'absent';},
      fact => {fact.conditions.split = select(input, source(1), 0);},
      fact => {fact.conditions.split.firstToken = 1; fact.conditions.split.lastToken = 0;},
      fact => {fact.conditions.split.firstToken = .5;},
      fact => {fact.conditions.split.lastToken = 9999;},
      fact => {fact.conditions.split.extra = true;},
      fact => {fact.conditionEvidence = [];},
      fact => {fact.conditionEvidence.push(structuredClone(fact.conditionEvidence[0]));},
      fact => {fact.conditionEvidence[0].field = 'budget';},
      fact => {fact.conditionEvidence[0].key = 'split';},
      fact => {fact.conditions.split = select(input, source(0), 2);},
      fact => {fact.conditions.other = {task: select(input, source(0), 0)};
        fact.conditionEvidence.push({field: 'other', key: 'wrong', evidence: [source(0)]});},
      fact => {fact.conditions.split = 'unknown';},
      fact => {fact.conditions.other = {task: 'unknown'};},
      fact => {fact.conditionEvidence[0].evidence[0] = {...source(0), quote: 'changed'};}
    ];
    for (const change of changes) {
      const fact = structuredClone(valid);
      change(fact);
      const before = JSON.stringify(fact);
      assert.equal(call.schema.safeParse({facts: [fact]}).success, false, change.toString());
      assert.equal(JSON.stringify(fact), before);
    }
    const printedUnknown = structuredClone(valid);
    printedUnknown.conditions.split = select(input, source(0), 3);
    assert.ok(call.schema.safeParse({facts: [printedUnknown]}).success, 'Only lowercase unknown is the sentinel');
    return {facts: [printedUnknown]};
  });
});

test('the entire call including token inventory remains subject to the existing pre-dispatch budget', async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(extract(f, async () => {calls++; return {facts: []};}, 1),
    /research_scientific_extraction_call_budget_exceeded/);
  assert.equal(calls, 0);
});

test('fixed/other limits, unknown omission and long complete objects retain exact source text', () => {
  const object = {kind: 'object', objectType: 'Equation', objectId: 'equation'};
  for (const [field, limit] of [['split', 16000], ['other', 2000]]) {
    for (const length of [limit, limit + 1]) {
      const quote = `${'X'.repeat(length)} short`;
      const contract = api.scientificFactConditionTokenContract({blocks: [], objects: []},
        [{proposal: object, quote}], []);
      assert.equal(contract.inputChoices.sources[0].tokens[0][1], 'X'.repeat(length));
      const fact = base(); fact.evidence = [object];
      const selection = {sourceId: contract.inputChoices.sources[0].sourceId, firstToken: 0, lastToken: 0};
      fact.conditions[field] = field === 'other' ? {configuration: selection} : selection;
      fact.conditionEvidence = [{field, key: field === 'other' ? 'configuration' : null, evidence: [object]}];
      const before = structuredClone(fact);
      assert.equal(contract.proposalSchema.safeParse({facts: [fact]}).success, length === limit);
      assert.deepEqual(fact, before);
      if (length === limit) {
        const parsed = contract.proposalSchema.parse({facts: [fact]});
        assert.deepEqual(contract.proposalSchema.parse(parsed), parsed);
        const decoded = contract.decode(parsed).facts[0];
        assert.equal(field === 'other' ? decoded.conditions.other.configuration : decoded.conditions[field], 'X'.repeat(length));
      }
      // A long complete object remains available for a shorter range, without cropping.
      if (field === 'split') fact.conditions.split = {...selection, firstToken: 1, lastToken: 1};
      else fact.conditions.other.configuration = {...selection, firstToken: 1, lastToken: 1};
      assert.ok(contract.proposalSchema.safeParse({facts: [fact]}).success);
      assert.equal(contract.inputChoices.sources[0].tokenCount, 2);
    }
  }
  const empty = api.scientificFactConditionTokenContract({blocks: [], objects: []}, [], []);
  assert.deepEqual(empty.inputChoices.sources, []);
  const native = {...base(), evidence: [{kind: 'metadata', field: 'title', raw: 'Original paper'}]};
  assert.ok(empty.proposalSchema.safeParse({facts: [native]}).success);
  const unknown = {...base(), conditions: {...base().conditions, other: {task: 'unknown'}}};
  assert.equal(empty.proposalSchema.safeParse({facts: [unknown]}).success, false);
});

test('numeric string domains intersect own-row/merged cells and full linked intervals for every retained source', () => {
  const textProposal = (blockId, start, quote) => ({kind: 'text', blockId, start, end: start + quote.length, quote});
  const proposals = [
    {kind: 'table_cell', tableId: 'table', cellId: 'own', raw: 'train'},
    {kind: 'table_cell', tableId: 'table', cellId: 'merged', raw: 'train'},
    {kind: 'table_cell', tableId: 'table', cellId: 'neighbor', raw: 'train'},
    {kind: 'table_cell', tableId: 'table', cellId: 'header', raw: 'train'},
    {kind: 'table_cell', tableId: 'foreign', cellId: 'own', raw: 'train'},
    textProposal('linked', 4, 'train'),
    textProposal('linked', 0, 'text train'),
    {kind: 'metadata', field: 'title', raw: 'train'},
    {kind: 'object', objectType: 'Table', objectId: 'table'}
  ];
  const sources = proposals.map(proposal => ({proposal,
    quote: proposal.kind === 'text' ? proposal.quote : proposal.raw ?? 'train'}));
  const contract = api.scientificFactConditionTokenContract({blocks: proposals.filter(p => p.kind === 'text').map(p =>
    ({blockId: p.blockId, start: p.start, end: p.end, text: p.quote})), objects: []}, sources,
    [{tableId: 'table', rows: [{row: 2, conditionCellIds: ['own', 'merged']}],
      metricHeaders: [{column: 1, cellIds: ['header']}], linkedTextRanges: [{blockId: 'linked', start: 4, end: 9}]}]);
  const choices = contract.inputChoices.sources;
  assert.deepEqual(contract.inputChoices.numericScopes[0].allowedSourceIds,
    [choices[0].sourceId, choices[1].sourceId, choices[5].sourceId]);
  for (const [index, evidence] of proposals.entries()) {
    const fact = base();
    fact.factType = 'experimental_result'; fact.table = {tableId: 'table', row: 2, cellId: 'value'};
    fact.value = {raw: '91', unit: null, unitEvidence: []}; fact.evidence = [proposals[0]];
    fact.conditions.split = {sourceId: choices[index].sourceId, firstToken: index === 6 ? 1 : 0,
      lastToken: index === 6 ? 1 : 0};
    fact.conditionEvidence = [{field: 'split', key: null, evidence: [evidence]}];
    const expected = [0, 1, 5].includes(index);
    assert.equal(contract.proposalSchema.safeParse({facts: [fact]}).success, expected, JSON.stringify(evidence));
    if (expected) {
      fact.conditionEvidence[0].evidence.push(proposals[3]);
      assert.equal(contract.proposalSchema.safeParse({facts: [fact]}).success, false,
        'An in-scope selected range does not authorize extra header evidence');
    }
  }
});

test('metadata selections and representable other keys decode while discarded own keys are rejected', async () => {
  const f = fixture();
  const facts = await extract(f, async call => {
    const input = JSON.parse(call.messages[1].content), evidence = {kind: 'metadata', field: 'title', raw: f.ir.metadata.title};
    const fact = base(), selection = select(input, evidence, 0, 1);
    fact.conditions.other = {constructor: selection, prototype: selection};
    fact.conditionEvidence = ['constructor', 'prototype'].map(key => ({field: 'other', key, evidence: [evidence]}));
    assert.ok(call.schema.safeParse({facts: [fact]}).success);
    const malicious = structuredClone(fact);
    malicious.conditions.other = JSON.parse(`{"__proto__":${JSON.stringify(selection)}}`);
    malicious.conditionEvidence = [{field: 'other', key: '__proto__', evidence: [evidence]}];
    const before = JSON.stringify(malicious);
    assert.equal(call.schema.safeParse({facts: [malicious]}).success, false);
    assert.equal(JSON.stringify(malicious), before);
    return {facts: [fact]};
  });
  assert.deepEqual(facts[0].conditions.other, {constructor: 'Original paper', prototype: 'Original paper'});
});
