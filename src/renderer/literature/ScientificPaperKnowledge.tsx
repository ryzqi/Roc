import {useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import type {WikiPaperKnowledgeSource, WikiScientificStatement} from '../../shared/schemas/research-wiki-pages';
import type {ScientificKnowledgeSearchHit} from '../../shared/schemas/research-scientific-knowledge-search';
import type {ScientificEntity} from '../../shared/schemas/research-scientific-entities';
import type {ScientificSource} from '../../shared/schemas/research-scientific-facts';
import {useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ErrorBar} from '../shell/ErrorBar';
import {scientificHitLabel, scientificHitType, currentScientificHit, scientificEntityLabels} from './scientific-wiki';
import {ScientificDocumentSource} from './ScientificDocumentSource';
import {ScientificObjectView} from './ScientificObjectView';
import {ScientificNeighbors} from './ScientificNeighbors';
import {PaperDeepKnowledge} from './PaperDeepKnowledge';

type Reference = {kind: 'entity' | 'fact' | 'relation'; id: string; candidateId?: string} |
  {kind: 'object'; id: string; objectType?: 'Table' | 'Figure' | 'Equation' | 'Algorithm'};
const conditionLabels = {datasetId: '数据集', datasetVersion: '数据集版本', split: '划分',
  metricId: '指标', baselineId: '基线', budget: '训练 / 计算预算', other: '其他条件'} as const;
export function ScientificPaperKnowledge({client, projectId, reference, record, onSelectEntity, onFactFilter, graph = false}: {
  client: RocClient; projectId: string; reference: WikiPaperKnowledgeSource; record?: Reference;
  onSelectEntity?: (entity: ScientificEntity, source: WikiPaperKnowledgeSource) => void;
  onFactFilter?: (entity: ScientificEntity) => void; graph?: boolean
}): React.JSX.Element {
  const [neighborsOpen, setNeighborsOpen] = useState(graph);
  const read = useAsyncResource(JSON.stringify([projectId, reference, record]), () =>
    client.api.research.readWikiPaperKnowledge({projectId, ...reference}), {label: '读取科研知识与来源状态'});
  const card = read.status === 'ready' ? read.data : null;
  const current = card?.state === 'current' && card.publishedJob?.id === reference.generationId ? card : null;
  const hit = current && record && record.kind !== 'object' ? currentScientificHit(current, record) : null;
  return <section className="min-w-0 space-y-3" data-testid="wiki-paper-knowledge" aria-label="结构化科研知识">
    {read.status === 'loading' ? <p role="status" className="text-xs">核对科研知识来源…</p> : null}
    {read.error ? <ErrorBar error={{level: 'blocked', message: read.error, retry: read.reload}}/> : null}
    {card ? <p className="flex flex-wrap gap-x-3 text-xs text-muted" data-testid="wiki-scientific-source-status">
      <span>{current ? '来源当前有效' : card.state === 'missing' ? '科研知识尚未生成' : '科研来源已失效'}</span>
      <span>生成草稿</span>
    </p> : null}
    {card?.configurationError ? <p role="alert" className="break-words text-xs">{card.configurationError}</p> : null}
    <button type="button" className={formSecondaryButtonClass} onClick={read.reload}>刷新科研来源</button>
    <PaperDeepKnowledge client={client} projectId={projectId} documentId={reference.documentId}/>
    {current === null ? null : record?.kind === 'object' ?
      <ScientificObjectView key={record.id} client={client} projectId={projectId} reference={reference} card={current} objectId={record.id}/> :
      record && hit === null ? <p role="alert">所选记录缺失或存在多个来源候选，请重新检索。</p> :
      hit ? <>
        <ScientificRecord hit={hit} client={client} projectId={projectId} onSelectEntity={onSelectEntity}/>
        {hit.kind === 'entity' ? <>
          <div className="flex flex-wrap gap-2">
            <button className={formSecondaryButtonClass} aria-expanded={neighborsOpen}
              onClick={() => setNeighborsOpen(value => !value)}>展开科研关系</button>
            {onFactFilter && ['Method', 'Model', 'Dataset', 'Metric', 'Baseline'].includes(hit.value.entityType) ?
              <button className={formSecondaryButtonClass} onClick={() => onFactFilter(hit.value)}>查看相关事实</button> : null}
          </div>
          {neighborsOpen ? <ScientificNeighbors key={hit.value.id} client={client} projectId={projectId}
            entity={hit.value} onSelectEntity={onSelectEntity}/> : null}
          {['Table', 'Figure', 'Equation', 'Algorithm'].includes(hit.value.proposal.entityType) &&
            'objectId' in hit.value.proposal.attributes ? <ScientificObjectView client={client} projectId={projectId}
              reference={reference} card={current} objectId={hit.value.proposal.attributes.objectId}/> : null}
        </> : hit.kind === 'fact' && hit.value.table ? <ScientificObjectView client={client} projectId={projectId}
          reference={reference} card={current} objectId={hit.value.table.tableId}/> : null}
      </> : <p className="text-xs text-muted">实体 {current.knowledge?.entities.length ?? 0} 条，事实 {current.knowledge?.facts.length ?? 0} 条，关系 {current.knowledge?.relations.length ?? 0} 条。</p>}
  </section>;
}

function ScientificRecord({hit, client, projectId, onSelectEntity}: {
  hit: ScientificKnowledgeSearchHit; client: RocClient; projectId: string;
  onSelectEntity?: (entity: ScientificEntity, source: WikiPaperKnowledgeSource) => void
}): React.JSX.Element {
  const entities = hit.kind === 'entity' ? [] : hit.entities;
  const entityName = (id: string | null): string => id === null ? '未记录' : entities.find(entity => entity.id === id)?.canonicalName ?? id;
  return <div className="min-w-0 space-y-3" data-testid="wiki-scientific-record">
    <h3 className="break-words font-medium">{scientificHitLabel(hit)}</h3>
    <p className="text-xs text-muted">{scientificHitType(hit)}</p>
    {hit.kind === 'entity' ? <>
      <dl className="space-y-2 text-xs">
        <div><dt className="text-muted">别名</dt><dd className="whitespace-pre-wrap break-words">{hit.value.aliases.join('\n') || '未记录'}</dd></div>
        <div><dt className="text-muted">原始名称</dt><dd className="break-words">{hit.value.proposal.canonicalName}</dd></div>
        <div><dt className="text-muted">原始别名</dt><dd className="whitespace-pre-wrap break-words">{hit.value.proposal.aliases.join('\n') || '未记录'}</dd></div>
        <div><dt className="text-muted">身份状态</dt><dd>{{exact: '精确身份', source_scoped: '来源内身份', alias: '人工别名绑定', conflict: '身份冲突'}[hit.value.resolutionStatus]}</dd></div>
      </dl>
      <details><summary className="cursor-pointer text-xs">实体属性与身份依据</summary>
        <pre className="ui-scroll-region max-h-60 whitespace-pre-wrap break-words text-xs">{JSON.stringify({
          attributes: hit.value.proposal.attributes, identityBasis: hit.value.identityBasis}, null, 2)}</pre>
      </details>
    </> : hit.kind === 'fact' ? <>
      {hit.value.value ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs tabular-nums" data-testid="wiki-scientific-value">
        <dt className="text-muted">原始值</dt><dd className="whitespace-pre-wrap break-words">{hit.value.value.raw}</dd>
        <dt className="text-muted">原始单位</dt><dd>{hit.value.value.rawUnit ?? '未记录'}</dd>
        <dt className="text-muted">规范化值</dt><dd className="whitespace-pre-wrap break-words">{hit.value.value.normalized ?? '未归一化'}</dd>
        <dt className="text-muted">规范化单位</dt><dd>{hit.value.value.unit ?? '未记录'}</dd>
      </dl> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-testid="wiki-scientific-conditions">
        {([['方法 / 主体', entityName(hit.value.subjectEntityId)], ['对象', entityName(hit.value.objectEntityId)],
          ['数据集', entityName(hit.value.conditions.datasetId)], ['数据集版本', hit.value.conditions.datasetVersion],
          ['划分', hit.value.conditions.split], ['指标', entityName(hit.value.conditions.metricId)],
          ['基线', entityName(hit.value.conditions.baselineId)], ['训练 / 计算预算', hit.value.conditions.budget],
          ...Object.entries(hit.value.conditions.other)] as [string, string][]).map(([name, value]) => <div key={name} className="contents">
          <dt className="text-muted">{name}</dt><dd className="whitespace-pre-wrap break-words">{value === 'unknown' ? '未知' : value}</dd>
        </div>)}
      </dl>
      <p className="text-xs text-muted">跨论文比较待审核</p>
      {hit.value.table ? <p className="text-xs text-muted">原始表格第 {hit.value.table.row + 1} 行</p> : null}
      {hit.value.conditionEvidence.map((condition, index) => <ScientificEvidenceList key={index} title={`条件依据：${conditionLabels[condition.field]}${condition.key ? ` / ${condition.key}` : ''}`}
        sources={condition.evidence} client={client} projectId={projectId} reference={hit.source}/>)}
      {hit.value.value?.unitEvidence.length ? <ScientificEvidenceList title="单位依据" sources={hit.value.value.unitEvidence}
        client={client} projectId={projectId} reference={hit.source}/> : null}
    </> : <>
      <p className="text-xs text-muted">{scientificHitType(hit)}，{hit.value.type}</p>
      <p className="text-xs text-muted">关联事实 {hit.value.factIds.length} 条</p>
    </>}
    {entities.length ? <div className="flex flex-wrap gap-2">{entities.map(entity => <button key={entity.id}
      type="button" className={formSecondaryButtonClass} disabled={onSelectEntity === undefined}
      onClick={() => onSelectEntity?.(entity, hit.source)}>{scientificEntityLabels[entity.entityType]}：{entity.canonicalName}</button>)}</div> : null}
    <ScientificEvidenceList title="原始依据" sources={hit.value.evidence} client={client} projectId={projectId} reference={hit.source}/>
  </div>;
}

export function ScientificEvidenceList({title, sources, client, projectId, reference}: {
  title: string; sources: readonly ScientificSource[]; client: RocClient; projectId: string; reference: WikiPaperKnowledgeSource
}): React.JSX.Element {
  return <section className="min-w-0 space-y-2"><h4 className="text-xs font-medium">{title}</h4>
    {sources.map((source, index) => <EvidenceSource key={JSON.stringify([reference, source, index])}
      source={source} client={client} projectId={projectId} reference={reference}/>)}
  </section>;
}
function EvidenceSource({source, client, projectId, reference}: {
  source: ScientificSource; client: RocClient; projectId: string; reference: WikiPaperKnowledgeSource
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer break-words text-xs">{source.proposal.kind === 'table_cell' ? '表格单元格' :
      source.proposal.kind === 'object' ? scientificEntityLabels[source.proposal.objectType] :
      source.proposal.kind === 'metadata' ? '元数据' : '正文区间'}{source.locator?.locations[0] ? `，第 ${source.locator.locations[0].page} 页` : ''}</summary>
    <p className="whitespace-pre-wrap break-words py-2 text-xs">{source.quote}</p>
    {open ? <ScientificDocumentSource client={client} projectId={projectId} reference={reference} source={source}/> : null}
  </details>;
}

export function ScientificStatementReference({client, projectId, statement}: {
  client: RocClient; projectId: string; statement: WikiScientificStatement
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (statement.kind === 'unknown') return <p className="text-xs text-muted">此处知识未知。</p>;
  const label = statement.kind === 'object' ? scientificEntityLabels[statement.objectType] :
    statement.kind === 'entity' ? '实体' : statement.kind === 'fact' ? '事实' : '关系';
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer break-words text-xs">科研{label}与原始来源</summary>
    {open ? <ScientificPaperKnowledge key={JSON.stringify(statement)} client={client} projectId={projectId}
      reference={statement.source} record={statement}/> : null}
  </details>;
}
