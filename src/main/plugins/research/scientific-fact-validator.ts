import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {scientificSourceProposalSchema, scientificFactProposalSchema, scientificFactSchema, scientificStringConditionFields,
  type ScientificSourceProposal, type ScientificSource, type ScientificFactProposal, type ScientificFact} from '../../../shared/schemas/research-scientific-facts';
import {scientificEntitySchema, type ScientificEntity} from '../../../shared/schemas/research-scientific-entities';
import {scientificRelationProposalSchema, scientificRelationSchema,
  type ScientificRelationProposal, type ScientificRelation} from '../../../shared/schemas/research-scientific-relations';
import {researchContentHash} from './research-files';
import {validatePaperIR} from './paper-ir-validation';
import {isDeepStrictEqual} from 'node:util';

export type ScientificValidationBasis = {projectId: string; generationId: string; ir: PaperIRV2};
export const scientificKnowledgeId = (kind: string, input: unknown): string =>
  `scientific-${kind}:${researchContentHash(JSON.stringify(input))}`;
export const scientificTableRowId = (tableId: string, row: number): string => `${tableId}/row/${row}`;

/** Match printed tokens, so a unit "m" cannot be supported by the word "Method". */
export function scientificSourceMentions(source: Pick<ScientificSource, 'quote'>, value: string): boolean {
  if (!value) return false;
  const word = /[\p{L}\p{N}_]/u;
  for (let offset = source.quote.indexOf(value); offset >= 0; offset = source.quote.indexOf(value, offset + 1)) {
    if ((!word.test(value[0]!) || offset === 0 || !word.test(source.quote[offset - 1]!)) &&
      (!word.test(value.at(-1)!) || offset + value.length === source.quote.length ||
        !word.test(source.quote[offset + value.length]!))) return true;
  }
  return false;
}

/** Reconstruct locators, original values and object identities. This does not establish semantic entailment. */
export function validateScientificSource(input: ScientificSourceProposal, irInput: PaperIRV2): ScientificSource {
  return sourceFromValidatedIR(input, validatePaperIR(irInput));
}
export function createScientificSourceValidator(irInput: PaperIRV2): {
  ir: PaperIRV2; read: (input: ScientificSourceProposal) => ScientificSource;
  assertCurrent: (sources: readonly ScientificSource[]) => void;
} {
  const ir = validatePaperIR(irInput), read = (input: ScientificSourceProposal) => sourceFromValidatedIR(input, ir);
  return {ir, read, assertCurrent: sources => {
    if (sources.some(source => !isDeepStrictEqual(source, read(source.proposal)))) {
      throw new Error('research_scientific_fact_source_version_invalid');
    }
  }};
}
type SourceValidator = ReturnType<typeof createScientificSourceValidator>;
function sourceFromValidatedIR(input: ScientificSourceProposal, ir: PaperIRV2): ScientificSource {
  const proposal = scientificSourceProposalSchema.parse(input);
  const base: ScientificSource = {proposal, identity: ir.identity, locator: null, quote: '',
    tableId: null, rowId: null, row: null, column: null, cellId: null};
  if (proposal.kind === 'text') {
    const block = ir.blocks.find(b => b.blockId === proposal.blockId);
    if (!block || proposal.end <= proposal.start || proposal.end > block.text.length ||
      block.text.slice(proposal.start, proposal.end) !== proposal.quote) {
      throw new Error('research_scientific_fact_quote_invalid');
    }
    const tables = ir.tables.filter(table => table.blockId === block.blockId ||
      table.visual?.captions.some(caption => caption.evidence.blockId === block.originalId &&
        caption.evidence.textSpan.start < proposal.end && caption.evidence.textSpan.end > proposal.start));
    if (tables.length > 1) throw new Error('research_scientific_fact_table_scope_ambiguous');
    return {...base, locator: {...block.sourceLocator, textSpan: {start: proposal.start, end: proposal.end}},
      quote: proposal.quote, tableId: tables[0]?.id ?? null};
  }
  if (proposal.kind === 'table_cell') {
    const table = ir.tables.find(t => t.id === proposal.tableId), cell = table?.cells.find(c => c.id === proposal.cellId);
    if (!table || !cell || cell.text !== proposal.raw) throw new Error('research_scientific_fact_cell_invalid');
    return {...base, locator: cell.sourceLocator, quote: cell.text, tableId: table.id,
      rowId: scientificTableRowId(table.id, cell.row), row: cell.row, column: cell.column, cellId: cell.id};
  }
  if (proposal.kind === 'metadata') {
    const expected = proposal.field === 'author' ? ir.metadata.authors :
      [String(proposal.field === 'paperId' ? ir.identity.paperId : ir.metadata[proposal.field] ?? '')];
    if (!expected.includes(proposal.raw)) throw new Error('research_scientific_fact_metadata_invalid');
    return {...base, quote: proposal.raw};
  }
  const object = proposal.objectType === 'Equation' ? ir.equations.find(e => e.id === proposal.objectId) :
    proposal.objectType === 'Figure' ? ir.figures.find(e => e.id === proposal.objectId) :
    proposal.objectType === 'Table' ? ir.tables.find(e => e.id === proposal.objectId) :
    ir.algorithms.find(e => e.id === proposal.objectId);
  if (!object) throw new Error('research_scientific_fact_object_invalid');
  const block = ir.blocks.find(b => b.blockId === object.blockId);
  if (!block) throw new Error('research_scientific_fact_object_invalid');
  const quote = proposal.objectType === 'Equation'
    ? ir.equations.find(e => e.id === object.id)!.data.rawLatex ?? block.text : block.text;
  return {...base, locator: object.sourceLocator, quote,
    tableId: proposal.objectType === 'Table' ? object.id : null};
}

/** Decimal arithmetic stays in strings, including percentages and exponent notation. No binary float conversion. */
export function normalizeScientificValue(raw: string, suppliedUnit: string | null = null): NonNullable<ScientificFact['value']> {
  const percent = raw.trim().endsWith('%'), rawUnit = percent ? '%' : suppliedUnit;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,4}))?%?$/u.exec(raw.trim());
  if (!match || raw.length > 1000) return {raw, normalized: null, rawUnit, unit: rawUnit, unitEvidence: []};
  const exponent = Number(match[5] ?? '0');
  if (Math.abs(exponent) > 1000) return {raw, normalized: null, rawUnit, unit: rawUnit, unitEvidence: []};
  const fraction = match[3] ?? match[4] ?? '', digits = (match[2] ?? '0') + fraction;
  const point = digits.length - fraction.length + exponent - (rawUnit === '%' ? 2 : 0);
  let value = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` :
    point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  value = value.replace(/^0+(?=\d)/u, '').replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
  if (match[1] === '-' && !/^0(?:\.0*)?$/u.test(value)) value = `-${value}`;
  return {raw, normalized: value, rawUnit, unit: rawUnit === '%' ? 'ratio' : rawUnit, unitEvidence: []};
}

function entityReference(id: string | null, entities: readonly ScientificEntity[],
  basis: ScientificValidationBasis, sources: SourceValidator, type?: ScientificEntity['entityType']): ScientificEntity | null {
  if (id === null) return null;
  const matches = entities.filter(e => e.candidateId === id);
  const entity = matches.length === 1 ? scientificEntitySchema.parse(matches[0]) : null;
  if (!entity || entity.projectId !== basis.projectId || entity.documentId !== basis.ir.identity.documentId ||
    entity.paperId !== basis.ir.identity.paperId || entity.generationId !== basis.generationId ||
    entity.status !== 'source_validated' || type && entity.entityType !== type) {
    throw new Error('research_scientific_fact_entity_invalid');
  }
  sources.assertCurrent(entity.evidence);
  return entity;
}
const normalizeSources = (proposals: readonly ScientificSourceProposal[], sources: SourceValidator): ScientificSource[] =>
  proposals.map(sources.read);

type ScientificTable = PaperIRV2['tables'][number];
function rowCell(table: ScientificTable, source: ScientificSource, resultRow: number): boolean {
  const cell = table.cells.find(cell => cell.id === source.cellId);
  if (!cell || source.tableId !== table.id) return false;
  const original = table.data.rows[cell.row]?.cells.find(raw => raw.id === cell.originalId);
  return !!original && cell.row <= resultRow && cell.row + original.rowSpan > resultRow;
}
function columnHeader(table: ScientificTable, source: ScientificSource, column: number): boolean {
  return source.tableId === table.id && table.data.columns[column]?.headerCellIds.some(id =>
    table.cells.some(cell => cell.id === source.cellId && cell.originalId === id)) === true;
}
function resultTextScope(source: Pick<ScientificSource, 'proposal'>, table: ScientificTable, ir: PaperIRV2): boolean {
  if (source.proposal.kind !== 'text') return false;
  const proposal = source.proposal, block = ir.blocks.find(block => block.blockId === proposal.blockId)!;
  if (table.visual?.captions.some(caption => caption.status === 'linked' &&
    caption.evidence.blockId === block.originalId && caption.evidence.textSpan.start <= proposal.start &&
    caption.evidence.textSpan.end >= proposal.end)) return true;
  const tableBlock = ir.blocks.find(block => block.blockId === table.blockId)!;
  // A section/role alone cannot identify which experiment a sentence describes.
  return block.semantic.roles.some(role => role.role === 'experimental_setup' && role.source === 'rule' &&
    role.confidence >= .9) && !!block.sectionIds.length &&
    block.sectionIds.at(-1) === tableBlock.sectionIds.at(-1) &&
    ir.relations.some(relation => relation.type === 'references' && relation.status === 'linked' &&
      relation.fromId === block.id && relation.toId === table.id);
}

export type ScientificResultEvidenceScope = {
  tableId: string; rows: {row: number; conditionCellIds: string[]}[];
  metricHeaders: {column: number; cellIds: string[]}[];
  linkedTextRanges: {blockId: string; start: number; end: number}[];
};

/** Expose the validator's existing evidence scope without deciding what a cell or statement means. */
export function scientificResultEvidenceScope(irInput: PaperIRV2, tableId: string,
  textRanges: readonly {blockId: string; start: number; end: number}[]): ScientificResultEvidenceScope {
  const sources = createScientificSourceValidator(irInput), {ir} = sources;
  const table = ir.tables.find(table => table.id === tableId);
  if (!table) throw new Error('research_scientific_fact_object_invalid');
  const cells = table.cells.map(cell => sources.read({kind: 'table_cell', tableId, cellId: cell.id, raw: cell.text}));
  const candidates = textRanges.flatMap(range => {
    const block = ir.blocks.find(block => block.blockId === range.blockId);
    if (!block || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
      range.start < 0 || range.end < range.start || range.end > block.text.length ||
      range.end === range.start && block.text.length > 0) {
      throw new Error('research_scientific_fact_quote_invalid');
    }
    if (!block.text.length) return [];
    const captions = table.visual?.captions.filter(caption => caption.status === 'linked' &&
      caption.evidence.blockId === block.originalId).map(caption => ({
        blockId: range.blockId, start: Math.max(range.start, caption.evidence.textSpan.start),
        end: Math.min(range.end, caption.evidence.textSpan.end)
      })).filter(caption => caption.end > caption.start) ?? [];
    return [range, ...captions];
  });
  const linkedTextRanges = [...new Map(candidates.filter(range => {
    const block = ir.blocks.find(block => block.blockId === range.blockId)!;
    const proposal: ScientificSourceProposal = {kind: 'text', ...range, quote: block.text.slice(range.start, range.end)};
    return resultTextScope({proposal}, table, ir);
  }).map(range => [JSON.stringify(range), {...range}])).values()];
  return {tableId,
    rows: table.data.rows.map(row => ({row: row.index,
      conditionCellIds: cells.filter(source => rowCell(table, source, row.index)).map(source => source.cellId!)})),
    metricHeaders: table.data.columns.map(column => ({column: column.index,
      cellIds: cells.filter(source => columnHeader(table, source, column.index)).map(source => source.cellId!)})),
    linkedTextRanges};
}

export function validateScientificFact(input: ScientificFactProposal, basis: ScientificValidationBasis,
  entities: readonly ScientificEntity[]): ScientificFact {
  const proposal = scientificFactProposalSchema.parse(input), sources = createScientificSourceValidator(basis.ir),
    {ir} = sources, identity = ir.identity;
  const evidence = normalizeSources(proposal.evidence, sources);
  if (!evidence.some(e => e.locator !== null)) throw new Error('research_scientific_fact_source_required');
  const subject = entityReference(proposal.subjectEntityId, entities, basis, sources),
    object = entityReference(proposal.objectEntityId, entities, basis, sources);
  const dataset = entityReference(proposal.conditions.datasetId, entities, basis, sources, 'Dataset'),
    metric = entityReference(proposal.conditions.metricId, entities, basis, sources, 'Metric'),
    baseline = entityReference(proposal.conditions.baselineId, entities, basis, sources, 'Baseline');
  const conditions = {...proposal.conditions, datasetId: dataset?.id ?? null,
    metricId: metric?.id ?? null, baselineId: baseline?.id ?? null};
  const conditionEvidence = proposal.conditionEvidence.map(e => ({...e, evidence: normalizeSources(e.evidence, sources)}));
  const keys = new Set<string>();
  for (const item of conditionEvidence) {
    const key = `${item.field}/${item.key ?? ''}`;
    if (keys.has(key) || (item.field === 'other') !== (item.key !== null)) {
      throw new Error('research_scientific_fact_condition_invalid');
    }
    keys.add(key);
    const value = item.field === 'other' ? conditions.other[item.key!] :
      item.field === 'datasetId' ? dataset?.proposal.canonicalName :
      item.field === 'metricId' ? metric?.proposal.canonicalName :
      item.field === 'baselineId' ? baseline?.proposal.canonicalName : conditions[item.field];
    if (!value || value === 'unknown' || !item.evidence.some(e => scientificSourceMentions(e, value))) {
      throw new Error('research_scientific_fact_condition_invalid');
    }
  }
  for (const [field, value] of Object.entries(proposal.conditions)) {
    if (field === 'other') {
      if (Object.keys(proposal.conditions.other).some(key => !keys.has(`other/${key}`))) {
        throw new Error('research_scientific_fact_condition_source_required');
      }
    } else if (value !== undefined && value !== null && value !== 'unknown' && !keys.has(`${field}/`)) {
      throw new Error('research_scientific_fact_condition_source_required');
    }
  }
  let table: ScientificFact['table'] = null, value: ScientificFact['value'] = null;
  if (proposal.value !== null) {
    if (!proposal.table) throw new Error('research_scientific_result_cell_required');
    const object = ir.tables.find(t => t.id === proposal.table!.tableId);
    const cell = object?.cells.find(c => c.id === proposal.table!.cellId);
    if (!object || !cell || cell.row !== proposal.table.row || cell.text !== proposal.value.raw ||
      !evidence.some(e => e.cellId === cell.id && e.tableId === object.id)) {
      throw new Error('research_scientific_fact_value_invalid');
    }
    const allSources = [...evidence, ...conditionEvidence.flatMap(item => item.evidence)];
    if (allSources.some(source => source.tableId !== null && source.tableId !== object.id)) {
      throw new Error('research_scientific_fact_result_tables_mixed');
    }
    if (evidence.some(source => source.cellId !== null && !rowCell(object, source, cell.row) &&
      !columnHeader(object, source, cell.column))) throw new Error('research_scientific_fact_result_row_invalid');
    if (subject && (!['Method', 'Model', 'Baseline', 'Experiment'].includes(subject.entityType) ||
      !evidence.some(source => rowCell(object, source, cell.row) &&
        scientificSourceMentions(source, subject.proposal.canonicalName)))) {
      throw new Error('research_scientific_fact_result_subject_invalid');
    }
    for (const item of conditionEvidence) {
      if (item.evidence.some(source => !rowCell(object, source, cell.row) &&
        !(item.field === 'metricId' && columnHeader(object, source, cell.column)) &&
        !resultTextScope(source, object, ir))) throw new Error('research_scientific_fact_condition_scope_invalid');
    }
    const units = normalizeSources(proposal.value.unitEvidence, sources), column = object.data.columns[cell.column]!;
    const printedUnit = cell.text.trim().endsWith('%') ? '%' : column.unit;
    if (proposal.value.unit !== null && printedUnit !== null && proposal.value.unit !== printedUnit ||
      units.some(source => !columnHeader(object, source, cell.column) && !resultTextScope(source, object, ir)) ||
      proposal.value.unit !== null && printedUnit === null &&
        !units.some(source => scientificSourceMentions(source, proposal.value!.unit!))) {
      throw new Error('research_scientific_fact_unit_source_required');
    }
    const headers = printedUnit === column.unit && printedUnit !== null ? object.cells
      .filter(header => column.headerCellIds.includes(header.originalId))
      .map(header => sources.read({kind: 'table_cell', tableId: object.id, cellId: header.id, raw: header.text})) : [];
    value = {...normalizeScientificValue(cell.text, proposal.value.unit ?? printedUnit),
      unitEvidence: [...new Map([...units, ...headers].map(source =>
        [JSON.stringify(source.proposal), source])).values()]};
    table = {...proposal.table, rowId: scientificTableRowId(object.id, cell.row)};
  } else if (proposal.table !== null) {
    throw new Error('research_scientific_fact_value_invalid');
  }
  const result = {candidateId: proposal.id, projectId: basis.projectId, generationId: basis.generationId,
    paperId: identity.paperId, documentId: identity.documentId,
    factType: proposal.factType, subjectEntityId: subject?.id ?? null, predicate: proposal.predicate,
    objectEntityId: object?.id ?? null, value, conditions, conditionEvidence, table, evidence,
    confidence: proposal.confidence, status: 'source_validated', scientificApproval: 'unreviewed',
    comparisonStatus: 'requires_review'};
  return scientificFactSchema.parse({id: scientificKnowledgeId('fact', result), ...result});
}

export function validateScientificRelation(input: ScientificRelationProposal, basis: ScientificValidationBasis,
  entities: readonly ScientificEntity[], facts: readonly ScientificFact[]): ScientificRelation {
  const proposal = scientificRelationProposalSchema.parse(input), sources = createScientificSourceValidator(basis.ir);
  const from = entityReference(proposal.fromEntityId, entities, basis, sources)!,
    to = entityReference(proposal.toEntityId, entities, basis, sources)!;
  const methodTypes = ['Method', 'Model', 'Algorithm', 'Baseline'];
  const allowed = proposal.type === 'PROPOSES' ? from.entityType === 'Paper' && ['Method', 'Model', 'Algorithm'].includes(to.entityType) :
    proposal.type === 'USES' ? ['Experiment', 'Method', 'Model', 'Algorithm'].includes(from.entityType) &&
      ['Dataset', 'Method', 'Model', 'Algorithm', 'Equation', 'Metric'].includes(to.entityType) :
    proposal.type === 'EVALUATES_WITH' ? from.entityType === 'Experiment' && to.entityType === 'Metric' :
    proposal.type === 'CONTAINS' ? ['Method', 'Model'].includes(from.entityType) &&
      ['Method', 'Model', 'Algorithm', 'Equation'].includes(to.entityType) :
    proposal.type === 'DEFINES' ? ['Paper', 'Method', 'Model'].includes(from.entityType) && to.entityType !== 'Paper' :
    proposal.type === 'EVALUATES_ON' ? ['Experiment', 'Method', 'Model', 'Algorithm'].includes(from.entityType) && to.entityType === 'Dataset' :
    proposal.type === 'EXTENDS' || proposal.type === 'COMPARES_WITH' ? methodTypes.includes(from.entityType) && methodTypes.includes(to.entityType) :
    proposal.type === 'SUPPORTS' || proposal.type === 'CONTRADICTS' ?
      ['Paper', 'Experiment', ...methodTypes].includes(from.entityType) && ['Paper', 'Experiment', ...methodTypes].includes(to.entityType) :
    proposal.type === 'RELATED_TO';
  if (!allowed || from.id === to.id) throw new Error('research_scientific_relation_types_invalid');
  const factIds = proposal.factIds.map(id => {
    const matches = facts.filter(f => f.candidateId === id);
    const fact = matches.length === 1 ? scientificFactSchema.parse(matches[0]) : null;
    if (!fact || fact.projectId !== basis.projectId || fact.generationId !== basis.generationId ||
      fact.documentId !== basis.ir.identity.documentId || fact.paperId !== basis.ir.identity.paperId ||
      fact.status !== 'source_validated') throw new Error('research_scientific_relation_fact_invalid');
    sources.assertCurrent([...fact.evidence, ...fact.conditionEvidence.flatMap(item => item.evidence),
      ...(fact.value?.unitEvidence ?? [])]);
    return fact.id;
  });
  if (new Set(factIds).size !== factIds.length) throw new Error('research_scientific_relation_fact_invalid');
  const evidence = normalizeSources(proposal.evidence, sources);
  if (!evidence.some(e => e.locator !== null)) throw new Error('research_scientific_fact_source_required');
  if (['DEFINES', 'EXTENDS', 'EVALUATES_ON', 'COMPARES_WITH', 'SUPPORTS', 'CONTRADICTS', 'RELATED_TO'].includes(proposal.type)) {
    // New semantic links need an original statement naming both endpoints. This is a source check,
    // never semantic approval; the Wiki projection keeps these links pending review.
    if (!evidence.some(source => source.locator !== null && scientificSourceMentions(source, from.proposal.canonicalName) &&
      scientificSourceMentions(source, to.proposal.canonicalName))) throw new Error('research_scientific_relation_statement_required');
  }
  const selectedFacts = factIds.map(id => facts.find(fact => fact.id === id)!);
  if (['SUPPORTS', 'CONTRADICTS', 'COMPARES_WITH'].includes(proposal.type) && !selectedFacts.length) {
    throw new Error('research_scientific_relation_fact_required');
  }
  if (proposal.type === 'CONTRADICTS' || proposal.type === 'COMPARES_WITH') {
    const known = (value: unknown): value is string => typeof value === 'string' &&
      !!value.trim() && !/^(unknown|unspecified|not reported|n\/a|未知|未记录)$/iu.test(value.trim());
    const signature = (fact: ScientificFact): string | null => {
      const conditions = fact.conditions;
      if (fact.factType !== 'experimental_result' || !fact.value?.normalized || !known(fact.value.unit) ||
        !conditions.datasetId || !conditions.metricId || !conditions.baselineId ||
        scientificStringConditionFields.some(field => !known(conditions[field])) ||
        Object.values(conditions.other).some(value => !known(value))) return null;
      return JSON.stringify([conditions.datasetId, conditions.metricId, conditions.baselineId,
        ...scientificStringConditionFields.map(field => conditions[field]),
        Object.entries(conditions.other).sort(([a], [b]) => a.localeCompare(b)), fact.value.unit]);
    };
    const signatures = selectedFacts.map(signature);
    if (selectedFacts.length < 2 || signatures.some(value => value === null) || new Set(signatures).size !== 1 ||
      ![from.id, to.id].every(id => selectedFacts.some(fact => fact.subjectEntityId === id))) {
      throw new Error('research_scientific_relation_conditions_incomparable');
    }
  }
  const result = {candidateId: proposal.id, projectId: basis.projectId, generationId: basis.generationId,
    paperId: basis.ir.identity.paperId, documentId: basis.ir.identity.documentId,
    type: proposal.type, fromEntityId: from.id, toEntityId: to.id, factIds, evidence,
    status: 'source_validated', scientificApproval: 'unreviewed'};
  return scientificRelationSchema.parse({id: scientificKnowledgeId('relation', result), ...result});
}
