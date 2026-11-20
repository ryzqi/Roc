import type {ScientificEntity} from '../../../shared/schemas/research-scientific-entities';
import type {ScientificFact} from '../../../shared/schemas/research-scientific-facts';
import type {WikiPaperKnowledgeSource, WikiSection} from '../../../shared/schemas/research-wiki-pages';

export type ScientificComparisonColumn = {
  source: WikiPaperKnowledgeSource; fact: ScientificFact; entities: ScientificEntity[];
};
type Check = {field: string; status: 'match' | 'different' | 'unknown'};
export type ScientificComparisonCheck = {status: 'conditions_match' | 'not_directly_comparable'; checks: Check[]};
const known = (value: string | null | undefined): value is string =>
  !!value?.trim() && !/^(unknown|unspecified|not reported|n\/a|未知|未记录)$/iu.test(value.trim());
const entity = (column: ScientificComparisonColumn, id: string | null, type?: ScientificEntity['entityType']) =>
  column.entities.find(item => item.id === id && item.status === 'source_validated' &&
    item.resolutionStatus !== 'conflict' && (!type || item.entityType === type));
const same = (values: Array<string | null | undefined>): Check['status'] =>
  values.some(value => !known(value)) ? 'unknown' : new Set(values).size === 1 ? 'match' : 'different';

export function isScientificComparisonTarget(target: Pick<WikiSection, 'id' | 'title'>): boolean {
  return target.id === 'scientific:comparison' || /research comparison|跨论文比较|研究比较/iu.test(target.title);
}

/** Identity alignment is explicit; identical printed names alone never establish cross-source equality. */
export function checkScientificComparison(columns: ScientificComparisonColumn[],
  expectedSources: WikiPaperKnowledgeSource[]): ScientificComparisonCheck {
  const checks: Check[] = [];
  const documents = new Set(columns.map(column => column.source.documentId));
  checks.push({field: 'paper_coverage', status: columns.length >= 2 && columns.length <= 12 &&
    documents.size === columns.length && new Set(columns.map(column => column.fact.paperId)).size === columns.length &&
    expectedSources.length === documents.size && expectedSources.every(source => columns.some(column =>
      column.source.documentId === source.documentId && column.source.generationId === source.generationId)) ? 'match' : 'unknown'});
  if (columns.length === 0) return {status: 'not_directly_comparable', checks};
  const values = (field: string, input: Array<string | null | undefined>): void => {checks.push({field, status: same(input)});};
  const identities = (field: string, input: Array<ScientificEntity | undefined>): void => {
    const status = input.some(item => !item) ? 'unknown' : new Set(input.map(item => item!.id)).size === 1 ? 'match' :
      new Set(input.map(item => item!.proposal.canonicalName)).size === 1 ? 'unknown' : 'different';
    checks.push({field, status});
  };
  identities('dataset', columns.map(column => entity(column, column.fact.conditions.datasetId, 'Dataset')));
  values('dataset_version', columns.map(column => column.fact.conditions.datasetVersion));
  values('split', columns.map(column => column.fact.conditions.split));
  identities('metric', columns.map(column => entity(column, column.fact.conditions.metricId, 'Metric')));
  const metrics = columns.map(column => entity(column, column.fact.conditions.metricId, 'Metric')?.proposal);
  values('metric_definition', metrics.map(item => item?.entityType === 'Metric' ? item.attributes.definition : null));
  values('unit', columns.map(column => column.fact.value?.unit));
  const baselines = columns.map(column => entity(column, column.fact.conditions.baselineId, 'Baseline'));
  identities('baseline', baselines);
  values('baseline_version', baselines.map(item => item?.proposal.entityType === 'Baseline' ? item.proposal.attributes.version : null));
  values('budget', columns.map(column => column.fact.conditions.budget));
  values('other_conditions', columns.map(column => {
    const pairs = Object.entries(column.fact.conditions.other).sort(([a], [b]) => a.localeCompare(b));
    return pairs.length && pairs.every(([, value]) => known(value)) ? JSON.stringify(pairs) : null;
  }));
  values('numeric_value', columns.map(column => column.fact.value?.normalized ? 'recorded' : null));
  return {status: checks.every(check => check.status === 'match') ? 'conditions_match' : 'not_directly_comparable', checks};
}

// JSON preserves original whitespace inside a table cell; Markdown escapes preserve literal source characters.
const cell = (value: unknown): string => JSON.stringify(value ?? 'unknown').replace(/([\\`*_[\]<>|])/gu, '\\$1');
export function scientificComparisonText(columns: ScientificComparisonColumn[], sources: WikiPaperKnowledgeSource[]): string {
  const result = checkScientificComparison(columns, sources);
  const rows: Array<[string, (column: ScientificComparisonColumn) => unknown]> = [
    ['Method / Model（未审核候选）', column => entity(column, column.fact.subjectEntityId)?.canonicalName],
    ['Architecture（未审核候选）', column => {
      const subject = entity(column, column.fact.subjectEntityId)?.proposal;
      return subject?.entityType === 'Model' ? subject.attributes.architecture : null;
    }],
    ['Dataset', column => entity(column, column.fact.conditions.datasetId, 'Dataset')?.canonicalName],
    ['Dataset version', column => column.fact.conditions.datasetVersion],
    ['Split', column => column.fact.conditions.split],
    ['Metric', column => entity(column, column.fact.conditions.metricId, 'Metric')?.canonicalName],
    ['Result（原始值）', column => column.fact.value?.raw],
    ['Unit（原始单位）', column => column.fact.value?.rawUnit],
    ['Baseline', column => entity(column, column.fact.conditions.baselineId, 'Baseline')?.canonicalName],
    ['Budget', column => column.fact.conditions.budget],
    ['Fact', column => column.fact.id],
    ['Original table / cell', column => column.fact.table]
  ];
  const matrix = columns.length ? [
    `| 维度 | ${columns.map((_, index) => `Paper ${index + 1}`).join(' | ')} |`,
    `| --- | ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(([name, value]) => `| ${name} | ${columns.map(column => cell(value(column))).join(' | ')} |`)
  ].join('\n') : 'unknown：没有完整的原始实验结果可供比较。';
  const verdict = result.status === 'conditions_match'
    ? '已记录条件一致 · Recorded conditions match。结果仍为未审核候选，需要人工核查科学支持。'
    : '不可直接比较 · Not directly comparable。条件缺失、身份未对齐或条件不同，不能据此判断方法优劣。';
  return [matrix, verdict, '此比较不生成方法排名。', ...result.checks.map(check =>
    `${check.field}: ${check.status === 'match' ? '一致' : check.status === 'different' ? '不同' : 'unknown / 未对齐'}`),
  ...columns.map((column, index) => `Paper ${index + 1} · 原始来源 ${JSON.stringify(column.source)}\n` +
    `完整实验条件（未记录字段保留 unknown / null）：\n\`\`\`json\n${JSON.stringify(column.fact.conditions, null, 2)}\n\`\`\``)].join('\n\n');
}
