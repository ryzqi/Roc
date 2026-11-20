import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {loadScientificSearchApi, scientificSearchFixture} from './fixtures/scientific-search-fixture.mjs';

let api, knowledge;
before(async () => {
  const modules = await Promise.all([
    loadScientificSearchApi(),
    ...['scientific-fact-validator', 'scientific-entity-resolution', 'paper-ir-builder'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node'})),
    ...['facts', 'entities', 'relations'].map(name =>
      importTypeScriptModule(`src/shared/schemas/research-scientific-${name}.ts`))
  ]);
  api = modules[0]; knowledge = Object.assign({}, ...modules.slice(1));
});
after(() => api?.dispose());
const basis = (f, ir = f.ir) => ({projectId: f.project.id, generationId: 'extraction-test-generation', ir});
const text = (ir, blockId, quote = null) => {
  const block = ir.blocks.find(block => block.blockId === blockId);
  const value = quote ?? block.text, start = block.text.indexOf(value);
  assert.ok(start >= 0);
  return {kind: 'text', blockId, start, end: start + value.length, quote: value};
};
const cell = (ir, value, tableIndex = 0) => {
  const table = ir.tables[tableIndex], cell = table.cells.find(cell => cell.text === value);
  assert.ok(cell, value);
  return {kind: 'table_cell', tableId: table.id, cellId: cell.id, raw: cell.text};
};
const unknown = () => ({datasetId: null, datasetVersion: 'unknown', split: 'unknown',
  metricId: null, baselineId: null, budget: 'unknown', other: {}});
const proposal = (id, entityType, canonicalName, evidence, attributes) =>
  ({id, entityType, canonicalName, aliases: [], evidence, attributes});
const resolve = (id, type, name, evidence, attributes, context, aliases = [], targets = []) =>
  knowledge.resolveScientificEntity(proposal(id, type, name, evidence, attributes), context, aliases, targets);
const paper = context => resolve('paper', 'Paper', context.ir.metadata.title ?? context.ir.identity.paperId,
  [{kind: 'metadata', field: context.ir.metadata.title === null ? 'paperId' : 'title',
    raw: context.ir.metadata.title ?? context.ir.identity.paperId}],
  {title: context.ir.metadata.title, doi: context.ir.metadata.doi, year: context.ir.metadata.year}, context);
function result(context, raw = '90') {
  const {ir} = context;
  const dataset = resolve('dataset', 'Dataset', 'Dataset C', [text(ir, 'table-caption')],
    {version: null, task: null}, context);
  const metric = resolve('metric', 'Metric', 'F1', [cell(ir, 'F1 (%)')],
    {definition: null, direction: 'unknown', unit: '%'}, context);
  const baseline = resolve('baseline', 'Baseline', 'Original baseline', [cell(ir, 'Original baseline')],
    {version: null}, context);
  const source = cell(ir, raw), original = ir.tables[0].cells.find(cell => cell.id === source.cellId);
  return {entities: [dataset, metric, baseline], proposal: {
    id: `result-${raw}`, factType: 'experimental_result', subjectEntityId: baseline.candidateId,
    predicate: 'Reported F1 value', objectEntityId: null, value: {raw, unit: null, unitEvidence: []},
    table: {tableId: source.tableId, cellId: source.cellId, row: original.row},
    conditions: {...unknown(), datasetId: dataset.candidateId, metricId: metric.candidateId,
      baselineId: baseline.candidateId},
    conditionEvidence: [
      {field: 'datasetId', key: null, evidence: [text(ir, 'table-caption')]},
      {field: 'metricId', key: null, evidence: [cell(ir, 'F1 (%)')]},
      {field: 'baselineId', key: null, evidence: [cell(ir, 'Original baseline')]}
    ],
    evidence: [source, cell(ir, 'Original baseline')], confidence: .8
  }};
}
const buildIR = (f, {blocks = f.data.content.blocks, metadata = f.ir.metadata, identity = {}} = {}) => {
  const {parseHash, ...originalIdentity} = f.ir.identity;
  return knowledge.buildPaperIR({identity: {...originalIdentity, ...identity},
    content: {...f.data.content, blocks}, metadata});
};
const block = (id, kind, value, y) => ({id, kind, text: value, label: kind, locator: `page 1 ${id}`,
  imageAssetId: null, locations: [{page: 1, bbox: [10, y, 300, y + 20], coordinateOrigin: 'TOPLEFT'}]});

test('separate extraction schemas reject injected authority, unknown ontology and duplicate candidate IDs', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const context = basis(f), sample = result(context);
    const entity = sample.entities[0].proposal;
    for (const extra of [{projectId: 'other'}, {status: 'source_validated'}, {scientificApproval: 'approved'}]) {
      assert.equal(knowledge.scientificEntityProposalSchema.safeParse({...entity, ...extra}).success, false);
      assert.equal(knowledge.scientificFactProposalSchema.safeParse({...sample.proposal, ...extra}).success, false);
    }
    assert.equal(knowledge.scientificEntityProposalSchema.safeParse({...entity, entityType: 'UnboundedType'}).success, false);
    assert.equal(knowledge.scientificEntityProposalSchema.safeParse({...entity, attributes: {arbitrary: true}}).success, false);
    assert.equal(knowledge.scientificEntityExtractionSchema.safeParse({entities: [entity, entity]}).success, false);
    assert.equal(knowledge.scientificFactExtractionSchema.safeParse({facts: [sample.proposal, sample.proposal]}).success, false);
    const relation = {id: 'uses', type: 'USES', fromEntityId: 'a', toEntityId: 'b', factIds: [],
      evidence: [text(f.ir, 'body')]};
    assert.equal(knowledge.scientificRelationProposalSchema.safeParse({...relation, type: 'SIMILAR_TO'}).success, false);
    assert.equal(knowledge.scientificRelationExtractionSchema.safeParse({relations: [relation, relation]}).success, false);
  } finally {await f.close();}
});

test('source validation reconstructs exact text spans, original cells, caption table binding and all version fields', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const input = text(f.ir, 'body', 'Dataset C'), output = knowledge.validateScientificSource(input, f.ir);
    assert.deepEqual(output.identity, f.ir.identity);
    assert.deepEqual(output.locator.textSpan, {start: input.start, end: input.end});
    assert.equal(output.locator.parseHash, f.ir.identity.parseHash);
    assert.equal(output.quote, 'Dataset C');
    assert.equal(knowledge.validateScientificSource(text(f.ir, 'table-caption'), f.ir).tableId, f.ir.tables[0].id);
    const original = cell(f.ir, '91'), normalized = knowledge.validateScientificSource(original, f.ir);
    assert.equal(normalized.row, 2);
    assert.equal(normalized.rowId, knowledge.scientificTableRowId(f.ir.tables[0].id, 2));
    assert.equal(normalized.cellId, original.cellId);
    assert.throws(() => knowledge.validateScientificSource({...input, quote: 'invented'}, f.ir), /quote_invalid/);
    assert.throws(() => knowledge.validateScientificSource({...original, raw: '100'}, f.ir), /cell_invalid/);
    const damaged = structuredClone(f.ir); damaged.identity.parseHash = 'a'.repeat(64);
    assert.throws(() => knowledge.validateScientificSource(input, damaged), /paper_ir_binding_invalid/);
    assert.equal(knowledge.scientificSourceMentions({...output, quote: 'Method'}, 'm'), false);
    assert.equal(knowledge.scientificSourceMentions({...output, quote: 'Length (m)'}, 'm'), true);
  } finally {await f.close();}
});

test('table result retains exact value, header-derived percentage, complete conditions and merged-row provenance', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const context = basis(f), before = f.db.prepare('SELECT total_changes() AS count').get().count;
    for (const raw of ['90', '91']) {
      const sample = result(context, raw);
      const fact = knowledge.validateScientificFact(sample.proposal, context, sample.entities);
      assert.equal(fact.value.raw, raw);
      assert.equal(fact.value.normalized, raw === '90' ? '0.9' : '0.91');
      assert.equal(fact.value.rawUnit, '%');
      assert.equal(fact.value.unit, 'ratio');
      assert.deepEqual(fact.value.unitEvidence.map(source => source.quote), ['F1 (%)']);
      assert.equal(fact.conditions.split, 'unknown');
      assert.equal(fact.conditions.datasetVersion, 'unknown');
      assert.equal(fact.conditions.budget, 'unknown');
      assert.equal(fact.conditions.datasetId, sample.entities[0].id);
      assert.equal(fact.status, 'source_validated');
      assert.equal(fact.scientificApproval, 'unreviewed');
      assert.equal(fact.comparisonStatus, 'requires_review');
      assert.equal(fact.table.rowId, knowledge.scientificTableRowId(f.ir.tables[0].id, raw === '90' ? 1 : 2));
      assert.ok(fact.evidence.every(source => source.locator.parseId === f.ir.identity.parseId));
    }
    assert.equal(f.db.prepare('SELECT total_changes() AS count').get().count, before);
  } finally {await f.close();}
});

test('decimal normalization preserves large integers, exponents, original units and unsupported values', () => {
  for (const [raw, unit, expected] of [
    ['89.1%', null, '0.891'], ['9007199254740993', null, '9007199254740993'],
    ['1.0000000000000000001', 's', '1.0000000000000000001'], ['-1.25e-3', null, '-0.00125'],
    ['.5%', null, '0.005'], ['-0.00', null, '0'], ['+1e3', 'ms', '1000']
  ]) {
    const value = knowledge.normalizeScientificValue(raw, unit);
    assert.equal(value.raw, raw); assert.equal(value.normalized, expected);
  }
  for (const raw of ['90 ± 1', '1,234', '1e9999']) {
    assert.equal(knowledge.normalizeScientificValue(raw).normalized, null);
  }
});

test('result validation denies wrong raw values, rows, units and globally named subjects', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const context = basis(f), sample = result(context), validate = input =>
      knowledge.validateScientificFact(input, context, sample.entities);
    assert.throws(() => validate({...sample.proposal, value: {...sample.proposal.value, raw: '99'}}), /value_invalid/);
    assert.throws(() => validate({...sample.proposal, table: {...sample.proposal.table, row: 2}}), /value_invalid/);
    assert.throws(() => validate({...sample.proposal, value: {...sample.proposal.value, unit: 'm',
      unitEvidence: [cell(f.ir, 'Method')]}}), /unit_source_required/);
    assert.throws(() => validate({...sample.proposal, evidence: [...sample.proposal.evidence, cell(f.ir, '91')]}),
      /result_row_invalid/);
    const method = resolve('method', 'Method', 'Original method', [text(f.ir, 'body')], {description: null}, context);
    assert.throws(() => knowledge.validateScientificFact({...sample.proposal, subjectEntityId: 'method'},
      context, [...sample.entities, method]), /result_subject_invalid/);
  } finally {await f.close();}
});

test('known conditions need explicit sources and unrelated true prose cannot become an experiment condition', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const context = basis(f), sample = result(context), input = structuredClone(sample.proposal);
    input.conditions.split = 'test';
    assert.throws(() => knowledge.validateScientificFact(input, context, sample.entities), /condition_source_required/);
    input.conditionEvidence.push({field: 'split', key: null, evidence: [text(f.ir, 'body', 'test')]});
    assert.throws(() => knowledge.validateScientificFact(input, context, sample.entities), /condition_scope_invalid/);
    input.conditionEvidence.push(input.conditionEvidence.at(-1));
    assert.throws(() => knowledge.validateScientificFact(input, context, sample.entities), /condition_invalid/);
  } finally {await f.close();}
});

test('a value cannot borrow another table caption or another metric column', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const other = block('other-table', 'table', 'Another baseline 40', 380);
    other.table = api.extractPaperTable(other, {id: other.id,
      rawHtml: '<table><tr><th>Method</th><th>F1 (%)</th><th>Precision (%)</th></tr><tr><td>Another baseline</td><td>40</td><td>60</td></tr></table>'});
    const blocks = api.attachPaperVisuals([...f.data.content.blocks.map(({visual, ...source}) => source),
      block('other-caption', 'paragraph', 'Table 4: Dataset D validation results.', 350), other]);
    const ir = buildIR(f, {blocks}), context = basis(f, ir), sample = result(context);
    const mixed = structuredClone(sample.proposal);
    mixed.evidence.push(text(ir, 'other-caption'));
    assert.equal(knowledge.validateScientificSource(text(ir, 'other-caption'), ir).tableId, ir.tables[1].id);
    assert.throws(() => knowledge.validateScientificFact(mixed, context, sample.entities), /result_tables_mixed/);
    const metric = resolve('precision', 'Metric', 'Precision', [cell(ir, 'Precision (%)', 1)],
      {definition: null, direction: 'unknown', unit: '%'}, context);
    const source = cell(ir, '40', 1);
    const wrongColumn = {...sample.proposal, subjectEntityId: null, evidence: [source],
      table: {tableId: source.tableId, cellId: source.cellId, row: 1},
      value: {raw: '40', unit: null, unitEvidence: []},
      conditions: {...unknown(), metricId: metric.candidateId},
      conditionEvidence: [{field: 'metricId', key: null, evidence: [cell(ir, 'Precision (%)', 1)]}]};
    assert.throws(() => knowledge.validateScientificFact(wrongColumn, context, [metric]), /condition_scope_invalid/);
  } finally {await f.close();}
});

test('Paper uses exact literature identity with arXiv aliases and null title retains a real metadata identity', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const first = paper(basis(f));
    const other = buildIR(f, {identity: {documentId: 'other-document', parseId: 'other-parse'}});
    assert.equal(paper(basis(f, other)).id, first.id);
    assert.notEqual(paper({...basis(f), projectId: 'other-project'}).id, first.id);
    const missing = buildIR(f, {metadata: {...f.ir.metadata, title: null, doi: null}});
    assert.equal(paper(basis(f, missing)).canonicalName, missing.identity.paperId);
    const arxiv = buildIR(f, {metadata: {...f.ir.metadata, doi: '10.48550/arXiv.2601.12345'}});
    assert.deepEqual(paper(basis(f, arxiv)).identityBasis.aliases,
      ['doi:10.48550/arxiv.2601.12345', 'arxiv:2601.12345']);
    const invalid = {...first.proposal, canonicalName: 'Invented title'};
    assert.throws(() => knowledge.resolveScientificEntity(invalid, basis(f)), /metadata_invalid/);
  } finally {await f.close();}
});

test('same entity spelling stays source-scoped; only verified explicit alias targets merge and conflicts survive', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const context = basis(f), sample = result(context), original = sample.entities[2];
    const otherIR = buildIR(f, {identity: {documentId: 'other-document', parseId: 'other-parse'}});
    const other = result(basis(f, otherIR)).entities[2];
    assert.notEqual(original.id, other.id);
    const target = resolve('short', 'Baseline', 'baseline', [cell(f.ir, 'Original baseline')], {version: null}, context);
    const alias = {id: 'explicit-alias', projectId: context.projectId, entityType: 'Baseline',
      alias: 'Original baseline', targetEntityId: target.id, canonicalName: target.canonicalName,
      revision: 1, createdBy: 'local-user'};
    assert.throws(() => knowledge.resolveScientificEntity(original.proposal, context, [alias]), /alias_target_invalid/);
    assert.throws(() => knowledge.resolveScientificEntity(original.proposal, context, [alias],
      [{...target, projectId: 'foreign'}]), /alias_target_invalid/);
    const merged = knowledge.resolveScientificEntity(original.proposal, context, [alias], [target]);
    assert.equal(merged.id, target.id); assert.equal(merged.resolutionStatus, 'alias');
    assert.equal(merged.canonicalName, 'baseline');
    assert.equal(merged.proposal.canonicalName, 'Original baseline');
    const fact = knowledge.validateScientificFact(sample.proposal, context,
      sample.entities.map(entity => entity.candidateId === original.candidateId ? merged : entity));
    assert.equal(fact.conditions.baselineId, target.id);
    const conflict = knowledge.resolveScientificEntity(original.proposal, context, [alias,
      {...alias, id: 'other-alias', targetEntityId: other.id, canonicalName: other.canonicalName}], [target, other]);
    assert.equal(conflict.resolutionStatus, 'conflict');
    assert.equal(conflict.id, original.id);
  } finally {await f.close();}
});

test('object entities retain full raw equations, printed numbers and source captions', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const context = basis(f), equation = f.ir.equations[0], figure = f.ir.figures[0];
    const output = resolve('equation', 'Equation', 'Equation 7',
      [{kind: 'object', objectType: 'Equation', objectId: equation.id}],
      {objectId: equation.id, number: '7', latex: equation.data.rawLatex}, context);
    assert.equal(output.proposal.attributes.latex, equation.data.rawLatex);
    assert.throws(() => knowledge.resolveScientificEntity({...output.proposal,
      attributes: {...output.proposal.attributes, latex: 'x = y'}}, context), /object_invalid/);
    const caption = figure.data.captions.find(caption => caption.status === 'linked').evidence.text;
    const visual = resolve('figure', 'Figure', 'Figure 2', [{kind: 'object', objectType: 'Figure', objectId: figure.id},
      text(f.ir, 'figure-caption')], {objectId: figure.id, number: '2', caption}, context);
    assert.equal(visual.proposal.attributes.caption, caption);
    const latex = `\\text{${'x'.repeat(6000)}}`;
    const blocks = api.attachPaperVisuals(api.attachPaperEquations(f.data.content.blocks.map(({visual, equation, ...block}) =>
      block.id === 'equation' ? {...block, text: latex} : block), [{regions: [{id: 'equation', formula: latex}]}]));
    const ir = buildIR(f, {blocks}), long = ir.equations[0];
    const full = resolve('long', 'Equation', long.id, [{kind: 'object', objectType: 'Equation', objectId: long.id}],
      {objectId: long.id, number: null, latex}, basis(f, ir));
    assert.equal(full.evidence[0].quote, latex);
    assert.equal(full.proposal.attributes.latex.length, latex.length);
  } finally {await f.close();}
});

test('relations validate typed endpoints and current entity/fact evidence without approving claims', async () => {
  const f = await scientificSearchFixture(api);
  try {
    const context = basis(f), sample = result(context);
    const method = resolve('method', 'Method', 'Original method', [text(f.ir, 'body')], {description: null}, context);
    const entities = [...sample.entities, method, paper(context)];
    const fact = knowledge.validateScientificFact(sample.proposal, context, entities);
    const input = {id: 'proposes', type: 'PROPOSES', fromEntityId: 'paper', toEntityId: 'method',
      factIds: [fact.candidateId], evidence: [text(f.ir, 'body')]};
    const relation = knowledge.validateScientificRelation(input, context, entities, [fact]);
    assert.equal(relation.type, 'PROPOSES'); assert.equal(relation.scientificApproval, 'unreviewed');
    assert.deepEqual(relation.factIds, [fact.id]);
    assert.throws(() => knowledge.validateScientificRelation({...input, toEntityId: 'metric'}, context, entities, [fact]),
      /types_invalid/);
    assert.throws(() => knowledge.validateScientificRelation(input, context, entities, [{...fact, documentId: 'foreign'}]),
      /relation_fact_invalid/);
    const tampered = structuredClone(fact); tampered.value.unitEvidence[0].identity.sourceHash = 'a'.repeat(64);
    assert.throws(() => knowledge.validateScientificRelation(input, context, entities, [tampered]), /source_version_invalid/);
    assert.throws(() => knowledge.validateScientificFact(sample.proposal, context,
      sample.entities.map(entity => ({...entity, generationId: 'old'}))), /entity_invalid/);
  } finally {await f.close();}
});
