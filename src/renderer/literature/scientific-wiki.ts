import type {ScientificKnowledgeSearchHit} from '../../shared/schemas/research-scientific-knowledge-search';
import type {ScientificSource} from '../../shared/schemas/research-scientific-facts';
import type {PaperCardKnowledge} from '../../shared/schemas/research-paper-card-knowledge';
import type {ResearchDocumentParse} from '../../shared/types';
import type {WikiScientificStatement} from '../../shared/schemas/research-wiki-pages';
import type {ScientificEntity} from '../../shared/schemas/research-scientific-entities';

export const scientificEntityLabels = {
  Paper: '论文', Method: '方法', Model: '模型', Dataset: '数据集', Metric: '指标',
  Experiment: '实验', Baseline: '基线', Equation: '公式', Figure: '图像', Table: '表格', Algorithm: '算法'
} as const;
export const scientificFactLabels = {
  research_problem: '研究问题', contribution: '贡献', method_component: '方法组件',
  dataset_usage: '数据集使用', metric_definition: '指标定义', experimental_result: '实验结果', limitation: '局限'
} as const;
export const scientificRelationLabels = {
  PROPOSES: '提出', USES: '使用', EVALUATES_WITH: '采用指标评估', CONTAINS: '包含',
  DEFINES: '定义', EXTENDS: '扩展', EVALUATES_ON: '在数据集上评估', COMPARES_WITH: '比较',
  SUPPORTS: '支持', CONTRADICTS: '矛盾', RELATED_TO: '相关'
} as const;

export function scientificHitKey(hit: ScientificKnowledgeSearchHit): string {
  return JSON.stringify([hit.kind, hit.source.documentId, hit.source.generationId, hit.value.candidateId]);
}
export function scientificHitLabel(hit: ScientificKnowledgeSearchHit): string {
  if (hit.kind === 'entity') return hit.value.canonicalName;
  if (hit.kind === 'fact') return hit.value.predicate;
  const name = (id: string): string => hit.entities.find(entity => entity.id === id)?.canonicalName ?? id;
  return `${name(hit.value.fromEntityId)} → ${name(hit.value.toEntityId)}`;
}
export function scientificHitType(hit: ScientificKnowledgeSearchHit): string {
  return hit.kind === 'entity' ? scientificEntityLabels[hit.value.entityType] :
    hit.kind === 'fact' ? scientificFactLabels[hit.value.factType] : scientificRelationLabels[hit.value.type];
}

/** A new publication cannot silently replace the record selected from an older search page. */
export function currentScientificHit(card: PaperCardKnowledge, reference: {
  kind: 'entity' | 'fact' | 'relation'; id: string; candidateId?: string
}): ScientificKnowledgeSearchHit | null {
  if (card.state !== 'current' || card.knowledge === null || card.publishedJob === null) return null;
  const source = {documentId: card.documentId, generationId: card.publishedJob.id};
  const matches = (value: {id: string; candidateId: string}): boolean =>
    value.id === reference.id && (reference.candidateId === undefined || value.candidateId === reference.candidateId);
  if (reference.kind === 'entity') {
    const values = card.knowledge.entities.filter(matches);
    return values.length === 1 ? {kind: 'entity', source, exactMatch: false, value: values[0]!} : null;
  }
  const related = (ids: readonly (string | null)[]): ScientificEntity[] =>
    [...new Set(ids.filter((id): id is string => id !== null))].flatMap(id => {
      const entity = card.knowledge!.entities.find(entity => entity.id === id);
      return entity ? [entity] : [];
    });
  if (reference.kind === 'fact') {
    const values = card.knowledge.facts.filter(matches), value = values[0];
    return values.length === 1 && value ? {kind: 'fact', source, exactMatch: false, value,
      entities: related([value.subjectEntityId, value.objectEntityId, value.conditions.datasetId,
        value.conditions.metricId, value.conditions.baselineId])} : null;
  }
  const values = card.knowledge.relations.filter(matches), value = values[0];
  return values.length === 1 && value ? {kind: 'relation', source, exactMatch: false, value,
    entities: related([value.fromEntityId, value.toEntityId])} : null;
}

export function statementReferenceKey(statement: WikiScientificStatement): string {
  return JSON.stringify(statement);
}
export function scientificObject(card: PaperCardKnowledge, objectId: string) {
  const objects = card.objects;
  if (objects === null) return null;
  const table = objects.tables.find(value => value.id === objectId);
  if (table) return {kind: 'Table' as const, value: table};
  const figure = objects.figures.find(value => value.id === objectId);
  if (figure) return {kind: 'Figure' as const, value: figure};
  const equation = objects.equations.find(value => value.id === objectId);
  if (equation) return {kind: 'Equation' as const, value: equation};
  const algorithm = objects.algorithms.find(value => value.id === objectId);
  return algorithm ? {kind: 'Algorithm' as const, value: algorithm} : null;
}

/** Structural equality, independent of JSON property order; all inputs are sealed JSON contracts. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key =>
    Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

/** Validate the real text interval/cell/object against the returned parse before opening a PDF. */
export function scientificSourceBlock(source: ScientificSource, card: PaperCardKnowledge, parsed: ResearchDocumentParse) {
  const locator = source.locator;
  if (locator === null || card.state !== 'current' || card.paperIR === null ||
      !sameJson(source.identity, card.paperIR.identity) ||
      parsed.run.id !== locator.parseId || parsed.run.documentId !== locator.documentId ||
      parsed.content.sourceHash !== locator.sourceHash ||
      parsed.content.parserFingerprint !== locator.parserFingerprint) throw new Error('科研来源版本已改变。');
  const blocks = parsed.content.blocks.filter(block => block.id === locator.blockId);
  const block = blocks[0];
  if (blocks.length !== 1 || !block || block.locator !== locator.rawLocator) throw new Error('科研来源缺少唯一的原始解析块。');
  for (const key of ['documentId', 'parseId', 'knowledgeDocumentId', 'sourceHash', 'parseHash', 'parserFingerprint'] as const) {
    if (locator[key] !== source.identity[key]) throw new Error('科研来源身份不一致。');
  }
  const proposal = source.proposal;
  if (proposal.kind === 'text') {
    const expectedLocations = block.locations;
    if (proposal.blockId !== block.id || proposal.end > block.text.length ||
        block.text.slice(proposal.start, proposal.end) !== source.quote || source.quote !== proposal.quote ||
        !sameJson(locator.textSpan, {start: proposal.start, end: proposal.end}) ||
        !sameJson(locator.locations, expectedLocations)) throw new Error('科研原文区间不一致。');
  } else if (proposal.kind === 'table_cell') {
    const table = card.objects?.tables.find(table => table.id === proposal.tableId);
    const cell = table?.cells.find(cell => cell.id === proposal.cellId);
    if (!table || !cell || table.blockId !== block.id || !sameJson(table.data, block.table) ||
        !sameJson(cell.sourceLocator, locator) || cell.text !== source.quote || cell.text !== proposal.raw ||
        source.tableId !== table.id || source.cellId !== cell.id || source.row !== cell.row ||
        source.column !== cell.column) throw new Error('科研单元格与原始表格不一致。');
  } else if (proposal.kind === 'object') {
    const object = scientificObject(card, proposal.objectId);
    if (object === null || object.kind !== proposal.objectType || object.value.blockId !== block.id ||
        !sameJson(object.value.sourceLocator, locator)) throw new Error('科研原始对象不一致。');
    const expected = object.kind === 'Equation' ? object.value.data.rawLatex ?? block.text : block.text;
    if (expected !== source.quote || object.kind === 'Table' && !sameJson(object.value.data, block.table) ||
        object.kind === 'Equation' && !sameJson(object.value.data, block.equation) ||
        object.kind === 'Figure' && !sameJson(object.value.data, block.visual)) throw new Error('科研对象与原始解析内容不一致。');
  } else throw new Error('元数据没有 PDF 来源位置。');
  return block;
}
