import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ScientificEntityProposal} from '../../../shared/schemas/research-scientific-entities';
import type {ScientificFactProposal} from '../../../shared/schemas/research-scientific-facts';
import {assertScientificBatchSources, type ScientificExtractionBatch} from './scientific-extraction-batches';
import {invokeScientificExtraction, type ScientificExtractionSession} from './scientific-extraction-model';
import {scientificKnowledgeId, scientificResultEvidenceScope, scientificSourceMentions} from './scientific-fact-validator';
import {scientificFactConditionSources, scientificFactWireSchema} from './scientific-fact-wire';
import {scientificFactConditionTokenContract} from './scientific-fact-condition-tokens';

export async function extractScientificFacts(session: ScientificExtractionSession, batch: ScientificExtractionBatch,
  ir: PaperIRV2, entities: readonly ScientificEntityProposal[], signal: AbortSignal): Promise<ScientificFactProposal[]> {
  const eligibleSubjects = entities.filter(entity =>
    ['Method', 'Model', 'Baseline', 'Experiment'].includes(entity.entityType));
  const resultEvidenceScopes = batch.objects.filter(object => object.objectType === 'Table').map(object => {
    const scope = scientificResultEvidenceScope(ir, object.objectId,
      batch.blocks.map(({blockId, start, end}) => ({blockId, start, end})));
    const table = ir.tables.find(table => table.id === scope.tableId)!;
    return {...scope, rows: scope.rows.map(row => {
      const cells = table.cells.filter(cell => row.conditionCellIds.includes(cell.id));
      const subjects = eligibleSubjects.flatMap(entity => {
        const cellIds = cells.filter(cell => scientificSourceMentions({quote: cell.text}, entity.canonicalName))
          .map(cell => cell.id);
        return cellIds.length ? [{entityId: entity.id, cellIds}] : [];
      });
      return {...row, subjects};
    })};
  });
  const resultSubjectEntityIds = [...new Set(resultEvidenceScopes.flatMap(scope =>
    scope.rows.flatMap(row => row.subjects.map(subject => subject.entityId))))];
  const ids = new Set(entities.map(entity => entity.id));
  const conditionSources = scientificFactConditionSources(ir, batch);
  const tokens = scientificFactConditionTokenContract(batch, conditionSources, resultEvidenceScopes);
  const selections = await invokeScientificExtraction(session, 'scientific_facts', tokens.proposalSchema,
    'Extract research_problem, contribution, method_component, dataset_usage, metric_definition, experimental_result and limitation facts. ' +
    'subjectEntityId, objectEntityId, conditions.datasetId, conditions.metricId and conditions.baselineId must be null ' +
    'or select a supplied entities.id. Original Table, Equation and Figure objectId values identify evidence objects, ' +
    'not Entity references; use the supplied Entity ID when one exists, otherwise null. ' +
    'Every fact needs original text or object evidence. All non-null numeric values must bind an exact ' +
    'supplied table, row and cell with unchanged raw text. table.row must equal the cited value cell\'s zero-based row, ' +
    'not a visual ordinal or a neighboring row. value.raw must equal that exact value cell\'s original text; ' +
    'do not bind a reported number to a header, subject label or another cell. Choose that tableId and exact row in resultEvidenceScopes. ' +
    'The numeric cell/raw choices retain complete original scalar or composite numerical expressions and exclude labels and declared headers. ' +
    'Preserve the whole composite cell text; a numerical choice alone does not establish scientific meaning or a known normalized value. ' +
    'A numeric result subjectEntityId must be null or a subjects.entityId listed for that exact row. ' +
    'Its fact evidence must include at least one of that subject\'s cellIds, with the unchanged cell raw text naming the subject. ' +
    'Those cells belong to the result row or a spanning merged anchor. resultSubjectEntityIds is only the union across rows; ' +
    'an ID listed for another row does not authorize the current result. ' +
    'Never use Table, Figure, Equation, Paper, Dataset or Metric as a numeric result subject. ' +
    'If no supplied eligible subject has that row evidence, preserve subjectEntityId as null. ' +
    'Entity evidence is identity data; it does not authorize Fact evidence outside the current batch.blocks and batch.objects. ' +
    'Keep nonnumeric Fact evidence within that same current batch source boundary. ' +
    'Interpret row/column semantics using complete headers, captions and footnotes. ' +
    'A result may use only its own table and row, merged anchors, its metric column headers and explicitly linked experimental context. ' +
    'Check condition permissions before choosing a condition value. For a numeric fact, first locate its exact tableId/row ' +
    'in conditionTokenChoices.numericScopes and inspect only those allowedSourceIds for string/other conditions. ' +
    'Next verify that an allowed source actually prints the desired condition value; a task label or result number ' +
    'does not support a method name visible only in another row. Visibility in the complete table does not grant permission. ' +
    'Then output the supported value as a range object with exactly the JSON keys "sourceId", "firstToken", "lastToken", ' +
    'and copy that source\'s evidence into the same field/key conditionEvidence. The printed string is not the range object. ' +
    'This applies to every other key, including method, model, configuration and label. ' +
    'If no permitted source prints an other value, leave it out: conditions.other may be {}. ' +
    'Omit both that other key and its matching conditionEvidence; never keep an orphan evidence entry or use "unknown" for an other value. ' +
    'Preserve independently supported raw values, original evidence and null subjects. Omitting an unsupported condition ' +
    'does not establish scientific meaning or comparability of the retained value. ' +
    'Each known dataset/version/split/metric/baseline/budget/hardware/trainingBudget/inferenceBudget/randomSeeds/repeats/uncertainty ' +
    'condition requires exactly one conditionEvidence entry with key null. Preserve printed hardware, training and inference ' +
    'budgets, random seeds, repeat counts and uncertainty when reported; unknown values may be omitted or use unknown. ' +
    'Each known other condition requires exactly one entry with its exact existing key. Do not duplicate field/key entries. ' +
    'Known datasetVersion, split, budget, hardware, trainingBudget, inferenceBudget, randomSeeds, repeats, uncertainty ' +
    'and every other value must select {sourceId, firstToken, lastToken} ' +
    'from conditionTokenChoices, never generated strings. sourceId identifies one complete current source. ' +
    'The same field/key conditionEvidence must include that exact source selection. firstToken and lastToken ' +
    'are zero-based indices into its tokens, with lastToken inclusive; each entry is [index, original non-whitespace token]. ' +
    'Choose one continuous range; the host retains exact punctuation, case, UTF-16 text, whitespace and split-word hyphens. ' +
    'Fixed unknown conditions use the literal "unknown" with no evidence. Never select a range spelling "unknown"; ' +
    'omit unknown other keys. Numeric string/other selections and every retained evidence source must belong to ' +
    'that exact table/row numericScopes.allowedSourceIds. Metadata, objects and out-of-row metric headers do not authorize string conditions. ' +
    'The selected condition evidence must contain the complete exact condition value as printed tokens. ' +
    'For datasetId, metricId and baselineId it must contain that supplied Entity canonicalName, not merely its identifier or an equation. ' +
    'For numeric datasetId/baselineId, choose only an Entity whose canonicalName is printed in this row\'s conditionCellIds ' +
    'or a complete text interval within linkedTextRanges. If none is supported, set that ID to null and omit its matching conditionEvidence. ' +
    'Typed numeric condition evidence cannot use whole objects, metadata or unlinked text. ' +
    'Choose Dataset, Metric and Baseline Entities respectively. Do not paraphrase string conditions or add words absent from the selected quote. ' +
    'The other key "__proto__" cannot be represented; do not propose it. ' +
    'A null entity ID or an exact "unknown" string condition must have no conditionEvidence for that field. Preserve unknowns, ' +
    'do not borrow conditions from unrelated prose or tables. Only metricId may use the result column\'s declared headerCellIds ' +
    'as condition evidence outside its row. Visual first-row labels are not declared headers unless listed in headerCellIds. ' +
    'Do not put an out-of-row column label in conditions.other. Other conditions need own-row or spanning-anchor evidence, ' +
    'or an original linked caption or explicitly linked experimental-setup statement. Missing entity IDs stay null; ' +
    'unsupported string conditions stay "unknown" and unsupported other keys are omitted, with no invented conditionEvidence. ' +
    'resultEvidenceScopes enumerates the only allowed condition evidence for each numeric result. ' +
    'Choose its tableId and exact row: any condition cell must be in that row\'s conditionCellIds, including merged anchors. ' +
    'Only metricId may additionally use that value column\'s metricHeaders.cellIds. Text conditions must select a supplied ' +
    'textId whose complete original interval fits linkedTextRanges. Empty metricHeaders.cellIds means no supported ' +
    'metric-header condition; do not substitute other/metric or other/column. ' +
    'These are source permissions, not assertions that labels are metrics or methods. Return candidates, never scientific judgments. Use unique local ids.',
    {metadata: ir.metadata, batch, entities, resultSubjectEntityIds, resultEvidenceScopes,
      conditionTokenChoices: tokens.inputChoices}, signal,
    {schema: codec => scientificFactWireSchema(ir, batch, resultEvidenceScopes, codec, [...ids],
      {entities, sources: conditionSources}, tokens), textSelections: true});
  const output = tokens.decode(selections);
  return output.facts.map((fact, ordinal) => {
    if ([fact.subjectEntityId, fact.objectEntityId, fact.conditions.datasetId, fact.conditions.metricId,
      fact.conditions.baselineId].some(id => id !== null && !ids.has(id))) {
      throw new Error('research_scientific_extraction_entity_not_supplied');
    }
    assertScientificBatchSources(batch, [...fact.evidence, ...fact.conditionEvidence.flatMap(item => item.evidence),
      ...(fact.value?.unitEvidence ?? [])], ir);
    return {...fact, id: scientificKnowledgeId('fact-candidate', [batch.id, ordinal, fact.id])};
  });
}
