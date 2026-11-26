import {z} from 'zod';
import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {scientificFactExtractionSchema, scientificFactProposalSchema, scientificStringConditionFields,
  scientificSourceProposalSchema, type ScientificFactProposal, type ScientificSource,
  type ScientificSourceProposal} from '../../../shared/schemas/research-scientific-facts';
import type {ScientificEntityProposal} from '../../../shared/schemas/research-scientific-entities';
import type {scientificExtractionInput} from './scientific-extraction-input';
import {createScientificSourceValidator, scientificSourceMentions, type ScientificResultEvidenceScope} from './scientific-fact-validator';
import type {ScientificExtractionBatch} from './scientific-extraction-batches';
import type {ScientificFactConditionTokenContract} from './scientific-fact-condition-tokens';

type ResultScope = Omit<ScientificResultEvidenceScope, 'rows'> & {
  rows: Array<ScientificResultEvidenceScope['rows'][number] & {
    subjects: Array<{entityId: string; cellIds: string[]}>;
  }>;
};
type ConditionSelection = Pick<ScientificFactProposal, 'conditions'> & {
  conditionEvidence: readonly {
    field: ScientificFactProposal['conditionEvidence'][number]['field']; key: string | null; evidence: unknown[];
  }[];
};
type ConditionContext = {
  entities: readonly Pick<ScientificEntityProposal, 'id' | 'entityType' | 'canonicalName'>[];
  sources: readonly Pick<ScientificSource, 'proposal' | 'quote'>[];
};
const conditionIdFields = ['datasetId', 'metricId', 'baselineId'] as const;
const conditionStringFields = scientificStringConditionFields;
const fixedConditionFields = [...conditionIdFields, ...conditionStringFields];
const conditionTypes = {datasetId: 'Dataset', metricId: 'Metric', baselineId: 'Baseline'} as const;

/** Enumerate original visible sources once through the existing source validator; no model-derived quotes. */
export function scientificFactConditionSources(ir: PaperIRV2, batch: ScientificExtractionBatch): ScientificSource[] {
  const sources = createScientificSourceValidator(ir);
  const selectable = (proposal: ScientificSourceProposal): ScientificSource[] => {
    // Inventory is a choice domain, not the input: retain only complete sources
    // representable by the original proposal contract, without cropping their values.
    const parsed = scientificSourceProposalSchema.safeParse(proposal);
    return parsed.success ? [sources.read(parsed.data)] : [];
  };
  return [
    ...batch.blocks.filter(block => block.text).flatMap(block => selectable({
      kind: 'text', blockId: block.blockId, start: block.start, end: block.end, quote: block.text
    })),
    ...batch.objects.flatMap(object => {
      const complete = sources.read({kind: 'object', objectType: object.objectType, objectId: object.objectId});
      if (object.objectType !== 'Table') return [complete];
      const table = sources.ir.tables.find(table => table.id === object.objectId)!;
      return [complete, ...table.cells.flatMap(cell => selectable({
        kind: 'table_cell', tableId: table.id, cellId: cell.id, raw: cell.text
      }))];
    }),
    ...(['paperId', 'title', 'doi', 'year', 'author'] as const).flatMap(field => {
      const values = field === 'author' ? sources.ir.metadata.authors :
        [field === 'paperId' ? sources.ir.identity.paperId : sources.ir.metadata[field]];
      return values.flatMap(value => value === null || String(value) === '' ? [] :
        selectable({kind: 'metadata', field, raw: String(value)}));
    })
  ];
}

// Eligibility only: retain complete composite text even when scalar normalization is unknown.
const numericAtom = String.raw`[+−-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+−-]?\d+)?%?`;
const numericExpression = new RegExp(String.raw`^[<≤>≥≈~]?\s*(?:` +
  `${numericAtom}(?:\\s+${numericAtom})*|` +
  `${numericAtom}\\s*(?:±|\\+/-|[-−–—/])\\s*${numericAtom}|` +
  `\\[\\s*${numericAtom}\\s*,\\s*${numericAtom}\\s*\\]|` +
  `\\(\\s*${numericAtom}\\s*,\\s*${numericAtom}\\s*\\)|` +
  `${numericAtom}\\s*\\(\\s*${numericAtom}\\s*\\))\\s*[*†‡]*$`, 'u');

function numericRaw(raw: string, declaredUnit: string | null): boolean {
  const text = raw.trim();
  if (numericExpression.test(text)) return true;
  // A suffix is eligible only when the validated original column declares that exact unit.
  // Markers may follow the unit; this recognition view never changes the selected raw.
  return !!declaredUnit && [text, text.replace(/[*†‡]+\s*$/u, '').trimEnd()].some(expression =>
    expression.endsWith(declaredUnit) &&
      numericExpression.test(expression.slice(0, -declaredUnit.length).trim()));
}

/** Narrow model selections; original proposals, source resolution and business validation remain authoritative. */
export function scientificFactWireSchema(ir: PaperIRV2, batch: ScientificExtractionBatch, scopes: readonly ResultScope[],
  codec: Pick<ReturnType<typeof scientificExtractionInput>, 'cellHandle'>, suppliedEntityIds: readonly string[],
  conditionContext: ConditionContext, tokens?: ScientificFactConditionTokenContract): z.ZodType {
  const [, tableCell, object, metadata] = scientificSourceProposalSchema.options;
  const textOptions = [z.object({
    kind: z.literal('text_span'),
    textId: z.enum(batch.blocks.flatMap((block, index) => block.text ? [`text-${index}`] : []))
  }).strict()];
  const objectSources = object.shape.objectType.options.map(objectType => object.safeExtend({
    objectType: z.literal(objectType),
    objectId: z.enum(batch.objects.filter(item => item.objectType === objectType).map(item => item.objectId))
  }));
  const tableSources = batch.objects.filter(item => item.objectType === 'Table').map(item => {
    const table = ir.tables.find(table => table.id === item.objectId);
    if (!table) throw new Error('research_scientific_extraction_table_input_invalid');
    return tableCell.safeExtend({tableId: z.literal(table.id),
      cellId: z.enum(table.cells.map(cell => codec.cellHandle(table.id, cell.id)))});
  });
  const batchSources = z.union([...textOptions, ...tableSources, ...objectSources, metadata]);
  const batchEvidence = z.array(batchSources).min(1).max(50);
  // Wire selections differ from decoded proposals. Keep runtime strictness/refinements
  // through generic object boundaries; the original typed schema parses after decoding.
  const suppliedIds = new Set(suppliedEntityIds);
  const entityId = suppliedIds.size ? z.enum([...suppliedIds]).nullable() : z.null();
  const printedSources = conditionContext.sources.map(source => {
    const proposal = source.proposal;
    if (proposal.kind === 'text') {
      const index = batch.blocks.findIndex(block => block.blockId === proposal.blockId &&
        block.start === proposal.start && block.end === proposal.end && block.text === proposal.quote);
      if (index < 0) throw new Error('research_scientific_extraction_condition_input_invalid');
      return {quote: source.quote, proposal, selection: {kind: 'text_span' as const, textId: `text-${index}`}};
    }
    return {quote: source.quote, proposal, selection: proposal.kind === 'table_cell' ?
      {...proposal, cellId: codec.cellHandle(proposal.tableId, proposal.cellId)} : proposal};
  });
  const sourceKey = (input: unknown): string => {
    const parsed = batchSources.safeParse(input);
    return parsed.success ? JSON.stringify(Object.entries(parsed.data).sort(([a], [b]) => a.localeCompare(b))) : '';
  };
  const quotes = new Map(printedSources.map(source => [sourceKey(source.selection), source.quote]));
  type NamedSources = (field: typeof conditionIdFields[number]) => typeof printedSources;
  const allNamedSources: NamedSources = () => printedSources;
  const conditionEntities = (field: typeof conditionIdFields[number], sources = printedSources) => conditionContext.entities.filter(entity =>
    suppliedIds.has(entity.id) && entity.entityType === conditionTypes[field] &&
    sources.some(source => scientificSourceMentions(source, entity.canonicalName)));
  const conditionIds = (field: typeof conditionIdFields[number], sources = printedSources) => {
    const ids = conditionEntities(field, sources).map(entity => entity.id);
    return ids.length ? z.enum(ids).nullable() : z.null();
  };
  const conditionEvidence = (evidence: z.ZodType, namedSources = allNamedSources, stringEvidence = evidence) => {
    const base = scientificFactProposalSchema.shape.conditionEvidence.element;
    const named = conditionIdFields.flatMap(field => {
      const sources = namedSources(field);
      const entities = conditionEntities(field, sources);
      const options = sources.filter(source =>
        entities.some(entity => scientificSourceMentions(source, entity.canonicalName))).map(source => {
        // Exact original source selections are provider-visible, including cell/raw pairs.
        const shape = Object.fromEntries(Object.entries(source.selection).map(([key, value]) => [key, z.literal(value)]));
        return z.object(shape).strict();
      });
      if (!options.length) return [];
      return [base.extend({field: z.literal(field), key: z.null(),
        evidence: z.array(options.length === 1 ? options[0]! : z.union(options)).min(1).max(50)})];
    });
    return z.array(z.union([
      base.extend({field: z.enum(conditionStringFields), evidence: stringEvidence}),
      base.extend({field: z.literal('other'), evidence: stringEvidence}),
      ...named
    ])).max(32);
  };
  const conditionsSchema = (sources = allNamedSources) => scientificFactProposalSchema.shape.conditions.safeExtend({
    datasetId: conditionIds('datasetId', sources('datasetId')),
    metricId: conditionIds('metricId', sources('metricId')), baselineId: conditionIds('baselineId', sources('baselineId'))
  });
  const conditionIdsSchema = conditionsSchema();
  const proposal: z.ZodObject = scientificFactProposalSchema;
  const wireProposal: z.ZodObject = proposal.safeExtend({
    subjectEntityId: entityId, objectEntityId: entityId,
    conditions: tokens ? tokens.conditions(conditionIdsSchema, tokens.allowedSources()) : conditionIdsSchema
  });
  const wireExtraction: z.ZodObject = scientificFactExtractionSchema;
  const nonnumeric = wireProposal.safeExtend({
    factType: scientificFactProposalSchema.shape.factType.exclude(['experimental_result']),
    value: z.null(), table: z.null(), evidence: batchEvidence,
    conditionEvidence: conditionEvidence(batchEvidence, allNamedSources,
      tokens ? tokens.evidence(codec, tokens.allowedSources()) : batchEvidence)
  });
  const numeric = scopes.flatMap(scope => {
    const table = ir.tables.find(table => table.id === scope.tableId);
    if (!table) throw new Error('research_scientific_extraction_table_input_invalid');
    const handles = (ids: readonly string[]) => [...new Set(ids.map(id => codec.cellHandle(scope.tableId, id)))];
    const rawSchema = scientificFactProposalSchema.shape.value.unwrap().shape.raw;
    const headers = new Set(table.data.columns.flatMap(column => column.headerCellIds));
    return scope.rows.flatMap(row => {
      const valueCells = table.cells.filter(cell => {
        if (cell.row !== row.row || headers.has(cell.originalId)) return false;
        const original = table.data.rows.find(item => item.index === cell.row)?.cells.find(item => item.id === cell.originalId);
        const unit = table.data.columns.find(column => column.index === cell.column)?.unit ?? null;
        return original?.header === false && rawSchema.safeParse(cell.text).success && numericRaw(cell.text, unit);
      });
      // Every original cell remains available as evidence/input; labels cannot be numeric values.
      if (!valueCells.length) return [];
      const rawValues = [...new Set(valueCells.map(cell => cell.text))];
      const ownCells = new Set(row.conditionCellIds);
      const metricCells = new Set(scope.metricHeaders.flatMap(header => header.cellIds));
      // Use original source identities before wire handle conversion. A visible object,
      // metadata value or unlinked text cannot authorize a numeric typed condition.
      const namedSources: NamedSources = field => printedSources.filter(({proposal}) =>
        proposal.kind === 'table_cell' ? proposal.tableId === scope.tableId &&
          (ownCells.has(proposal.cellId) || field === 'metricId' && metricCells.has(proposal.cellId)) :
        proposal.kind === 'text' && scope.linkedTextRanges.some(range =>
          range.blockId === proposal.blockId && range.start <= proposal.start && range.end >= proposal.end));
      const rowConditions = conditionsSchema(namedSources);
      const evidenceCells = handles([...row.conditionCellIds, ...scope.metricHeaders.flatMap(header => header.cellIds)]);
      const sources = z.union([
        ...textOptions, tableCell.safeExtend({tableId: z.literal(scope.tableId), cellId: z.enum(evidenceCells)}),
        ...objectSources, metadata
      ]);
      const evidence = z.array(sources).min(1).max(50);
      const subjectIds = row.subjects.map(subject => subject.entityId).filter(id => suppliedIds.has(id));
      return [wireProposal.safeExtend({
        conditions: tokens ? tokens.conditions(rowConditions, tokens.allowedSources(scope.tableId, row.row)) : rowConditions,
        subjectEntityId: subjectIds.length ? z.enum(subjectIds).nullable() : z.null(),
        table: scientificFactProposalSchema.shape.table.unwrap().safeExtend({
          tableId: z.literal(scope.tableId), row: z.literal(row.row),
          cellId: z.enum(handles(valueCells.map(cell => cell.id)))
        }),
        value: scientificFactProposalSchema.shape.value.unwrap().extend({
          raw: z.enum(rawValues),
          unitEvidence: z.array(sources).max(10)
        }),
        evidence,
        conditionEvidence: conditionEvidence(evidence, namedSources, tokens ?
          tokens.evidence(codec, tokens.allowedSources(scope.tableId, row.row)) : evidence)
      })];
    });
  });
  const selections = wireExtraction.safeExtend({
    facts: z.array(numeric.length ? z.union([nonnumeric, ...numeric]) : nonnumeric).max(500)
  }).superRefine((bundle, ctx) => {
    // Host-only structural consistency. JSON Schema cannot represent this refinement;
    // original source, canonical-name, numeric scope and business checks still follow decoding.
    const facts = tokens ? tokens.project(bundle, ctx, codec)?.facts : bundle.facts;
    if (tokens && !facts) return;
    if (!Array.isArray(facts)) {
      ctx.addIssue({code: 'custom', path: ['facts'], message: 'fact_selections_required'});
      return;
    }
    facts.forEach((fact: ConditionSelection, index: number) => {
      const at = ['facts', index];
      const seen = new Set<string>();
      const issue = (path: (string | number)[], message: string) =>
        ctx.addIssue({code: 'custom', path: [...at, ...path], message});
      for (const [evidenceIndex, item] of fact.conditionEvidence.entries()) {
        const path = ['conditionEvidence', evidenceIndex];
        const signature = JSON.stringify([item.field, item.key]);
        if (seen.has(signature)) issue(path, 'duplicate_condition_evidence');
        seen.add(signature);
        if (item.field === 'other') {
          if (item.key === null) issue([...path, 'key'], 'other_key_required');
          else if (!Object.hasOwn(fact.conditions.other, item.key)) {
            issue([...path, 'key'], 'other_key_not_selected');
          } else if (fact.conditions.other[item.key] === 'unknown') {
            issue(path, 'unknown_condition_has_evidence');
          }
        } else {
          if (item.key !== null) issue([...path, 'key'], 'fixed_condition_key_must_be_null');
          if (fact.conditions[item.field] === undefined || fact.conditions[item.field] === null ||
            (conditionStringFields.some(field => field === item.field) && fact.conditions[item.field] === 'unknown')) {
            issue(path, 'unknown_condition_has_evidence');
          }
        }
        const value = item.field === 'other' ? fact.conditions.other[item.key ?? ''] :
          conditionIdFields.some(field => field === item.field) ?
            conditionContext.entities.find(entity => entity.id === fact.conditions[item.field])?.canonicalName :
            fact.conditions[item.field];
        if (typeof value === 'string' && value !== 'unknown' && !item.evidence.some(source => {
          const quote = quotes.get(sourceKey(source));
          return quote !== undefined && scientificSourceMentions({quote}, value);
        })) issue(path, 'condition_value_not_supported');
      }
      for (const field of fixedConditionFields) {
        // Keep the original coverage loop's raw "unknown" ID exemption.
        if (fact.conditions[field] !== undefined && fact.conditions[field] !== null && fact.conditions[field] !== 'unknown' &&
          !seen.has(JSON.stringify([field, null]))) {
          issue(['conditions', field], 'known_condition_evidence_required');
        }
      }
      for (const [key, value] of Object.entries(fact.conditions.other)) {
        if (value === 'unknown') issue(['conditions', 'other', key], 'unknown_other_must_be_omitted');
        if (!seen.has(JSON.stringify(['other', key]))) {
          issue(['conditions', 'other', key], 'known_condition_evidence_required');
        }
      }
    });
  });
  return z.preprocess((input, ctx) => {
    // Inspect unrepaired JSON before z.record discards its own "__proto__" key.
    // Reject an unrepresentable selection rather than accepting a changed condition set.
    if (typeof input === 'object' && input !== null && 'facts' in input && Array.isArray(input.facts)) {
      input.facts.forEach((fact, index) => {
        if (typeof fact !== 'object' || fact === null || !('conditions' in fact)) return;
        const conditions = fact.conditions;
        if (typeof conditions !== 'object' || conditions === null || !('other' in conditions)) return;
        const other = conditions.other;
        if (typeof other === 'object' && other !== null && Object.hasOwn(other, '__proto__')) {
          ctx.addIssue({code: 'custom', path: ['facts', index, 'conditions', 'other', '__proto__'],
            message: 'condition_key_not_representable'});
        }
      });
    }
    return input;
  }, selections);
}
