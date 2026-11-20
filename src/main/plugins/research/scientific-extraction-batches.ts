import type {PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import type {ScientificSourceProposal} from '../../../shared/schemas/research-scientific-facts';
import {scientificExtractionConfigSchema, type ScientificExtractionConfig} from '../../../shared/schemas/research-scientific-extraction';
import {validatePaperIR} from './paper-ir-validation';
import {chunkTokenCount} from './knowledge-chunks';
import {scientificTextSpans} from './scientific-chunks';
import {scientificKnowledgeId, createScientificSourceValidator} from './scientific-fact-validator';
import {scientificExtractionInput} from './scientific-extraction-input';

type Text = {blockId: string; kind: string; start: number; end: number; text: string; sections: string[]};
export type ScientificExtractionObject = {
  objectType: 'Table' | 'Equation' | 'Figure' | 'Algorithm'; objectId: string; blockId: string; content: unknown;
};
export type ScientificExtractionBatch = {id: string; blocks: Text[]; objects: ScientificExtractionObject[]};
type Unit = Omit<ScientificExtractionBatch, 'id'>;

/** Every selected text interval is exact; a scientific object and its linked context are indivisible. */
export function buildScientificExtractionBatches(input: PaperIRV2, options: ScientificExtractionConfig): ScientificExtractionBatch[] {
  const ir = validatePaperIR(input), config = scientificExtractionConfigSchema.parse(options);
  const sections = new Map(ir.sections.map(section => [section.id, section.title]));
  const text = (block: PaperIRV2['blocks'][number], start = 0, end = block.text.length): Text =>
    ({blockId: block.blockId, kind: block.kind, start, end, text: block.text.slice(start, end),
      sections: block.sectionIds.map(id => sections.get(id)!)});
  const units: Unit[] = [], objectBlocks = new Set<string>();
  const linked = (objectId: string, blockId: string, evidence: readonly {blockId: string}[]): Text[] => {
    const ids = new Set([blockId, ...evidence.map(source => source.blockId)]);
    for (const relation of ir.relations) {
      if (relation.status !== 'linked' || !['references', 'explains', 'defines'].includes(relation.type)) continue;
      if (relation.toId === objectId || relation.fromId === objectId) {
        const otherId = relation.toId === objectId ? relation.fromId : relation.toId;
        const block = ir.blocks.find(block => block.id === otherId);
        if (block) ids.add(block.blockId);
      }
    }
    return ir.blocks.filter(block => ids.has(block.blockId)).map(block => text(block));
  };
  const addObject = (object: ScientificExtractionObject, evidence: readonly {blockId: string}[]): void => {
    objectBlocks.add(object.blockId);
    units.push({objects: [object], blocks: linked(object.objectId, object.blockId, evidence)});
  };
  for (const table of ir.tables) {
    const anchors = new Map(table.data.rows.flatMap(row => row.cells.map(cell => [cell.id, cell] as const)));
    addObject({objectType: 'Table', objectId: table.id, blockId: table.blockId, content: {
      number: table.data.tableNumber ?? table.visual?.objectNumber ?? null, status: table.data.status,
      caption: table.data.caption, captions: table.visual?.captions ?? [], footnotes: table.data.footnotes,
      columns: table.data.columns.map(column => ({...column, headerCellIds: column.headerCellIds.map(id =>
        table.cells.find(cell => cell.originalId === id)!.id)})),
      rows: table.data.rows.map(row => ({index: row.index, cells: row.cells.map(cell =>
        table.cells.find(original => original.originalId === cell.id)!.id)})),
      cells: table.cells.map(cell => ({id: cell.id, row: cell.row, column: cell.column, text: cell.text,
        rowSpan: anchors.get(cell.originalId)!.rowSpan, colSpan: anchors.get(cell.originalId)!.colSpan,
        header: anchors.get(cell.originalId)!.header}))
    }}, table.visual?.captions.map(caption => caption.evidence) ?? []);
  }
  for (const equation of ir.equations) {
    addObject({objectType: 'Equation', objectId: equation.id, blockId: equation.blockId, content: {
      number: equation.data.equationNumber, status: equation.data.status,
      rawLatex: equation.data.rawLatex, normalizedLatex: equation.data.normalizedLatex,
      numberEvidence: equation.data.numberEvidence, variables: equation.data.variables,
      contexts: equation.data.contexts, references: equation.data.references
    }}, [...equation.data.contexts, ...equation.data.variables.map(variable => variable.evidence)]);
  }
  for (const figure of ir.figures) {
    addObject({objectType: 'Figure', objectId: figure.id, blockId: figure.blockId, content: {
      number: figure.data.objectNumber, captions: figure.data.captions, references: figure.data.references
    }}, figure.data.captions.map(caption => caption.evidence));
  }
  for (const algorithm of ir.algorithms) {
    addObject({objectType: 'Algorithm', objectId: algorithm.id, blockId: algorithm.blockId,
      content: {text: algorithm.text, steps: algorithm.steps.map(step => ({id: step.id, text: step.text}))}}, []);
  }
  for (const block of ir.blocks) {
    if (objectBlocks.has(block.blockId) || !block.text) continue;
    // JSON escaping and source labels count toward the batch, as well as the original prose.
    for (const span of scientificTextSpans(block.text, Math.max(16, Math.floor(config.batchTokens / 4)))) {
      units.push({objects: [], blocks: [text(block, span.start, span.end)]});
    }
  }
  const batches: ScientificExtractionBatch[] = [];
  let pending: Unit = {objects: [], blocks: []};
  const flush = (): void => {
    if (!pending.blocks.length && !pending.objects.length) return;
    batches.push({id: scientificKnowledgeId('batch', [ir.identity, batches.length, pending]), ...pending});
    pending = {objects: [], blocks: []};
  };
  for (const unit of units) {
    if (chunkTokenCount(JSON.stringify(scientificExtractionInput(unit).encode(unit))) > config.batchTokens) {
      throw new Error(unit.objects.length ? 'research_scientific_extraction_object_budget_exceeded' :
        'research_scientific_extraction_text_budget_exceeded');
    }
    // Keep tables and their captions separate from unrelated tables/experimental contexts.
    if (unit.objects.length) {flush(); pending = unit; flush(); continue;}
    const combined = {objects: [], blocks: [...pending.blocks, ...unit.blocks]};
    if (chunkTokenCount(JSON.stringify(scientificExtractionInput(combined).encode(combined))) > config.batchTokens) flush();
    pending.blocks.push(...unit.blocks);
  }
  flush();
  if (batches.length > 512) throw new Error('research_scientific_extraction_batch_limit_exceeded');
  return batches;
}

export function scientificSourceIsVisible(batch: ScientificExtractionBatch, source: ScientificSourceProposal): boolean {
  if (source.kind === 'metadata') return true;
  if (source.kind === 'object') return batch.objects.some(object =>
    object.objectId === source.objectId && object.objectType === source.objectType);
  if (source.kind === 'table_cell') return batch.objects.some(object =>
    object.objectType === 'Table' && object.objectId === source.tableId);
  return batch.blocks.some(block => block.blockId === source.blockId && block.start <= source.start && block.end >= source.end);
}

export function assertScientificBatchSources(batch: ScientificExtractionBatch,
  sources: readonly ScientificSourceProposal[], ir: PaperIRV2): void {
  const validator = createScientificSourceValidator(ir);
  for (const source of sources) {
    if (!scientificSourceIsVisible(batch, source)) throw new Error('research_scientific_extraction_source_not_supplied');
    validator.read(source);
  }
}
