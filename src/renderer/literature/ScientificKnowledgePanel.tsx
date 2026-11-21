import {useState} from 'react';
import {ArrowLeft, Network} from 'lucide-react';
import {EmptyState} from '../shell/EmptyState';
import './knowledge-workspace.css';
import type {RocClient} from '../shared/roc-client';
import type {ScientificEntity} from '../../shared/schemas/research-scientific-entities';
import type {ScientificKnowledgeSearchHit, ScientificKnowledgeSearchRequest} from '../../shared/schemas/research-scientific-knowledge-search';
import type {WikiPaperKnowledgeSource} from '../../shared/schemas/research-wiki-pages';
import {useAsyncResource} from '../app/use-async-resource';
import {useDebouncedValue} from '../app/use-debounced-value';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ErrorBar} from '../shell/ErrorBar';
import {scientificEntityLabels, scientificFactLabels, scientificRelationLabels, scientificHitKey} from './scientific-wiki';
import {scientificConceptRows} from './wiki-concepts';
import {ScientificPaperKnowledge} from './ScientificPaperKnowledge';

type Props = {client: RocClient; projectId: string; documentIds?: readonly string[]; graph?: boolean};
const kinds = {entity: '实体', fact: '事实', relation: '关系'} as const;
const noDocuments: readonly string[] = [];

export function ScientificKnowledgePanel(props: Props): React.JSX.Element {
  return <KnowledgeScope key={JSON.stringify([props.projectId, props.documentIds ?? noDocuments, props.graph ?? false])} {...props}/>;
}

function KnowledgeScope({client, projectId, documentIds = noDocuments, graph = false}: Props): React.JSX.Element {
  const [kind, setKind] = useState<ScientificKnowledgeSearchRequest['kind']>('entity');
  const [query, setQuery] = useState(''), [type, setType] = useState('');
  const [filter, setFilter] = useState<ScientificEntity | null>(null);
  const [version, setVersion] = useState(''), [split, setSplit] = useState('');
  const searchQuery = useDebouncedValue(query, 250);
  const labels = kind === 'entity' ? scientificEntityLabels : kind === 'fact' ? scientificFactLabels : scientificRelationLabels;
  const base = {projectId, documentIds: [...documentIds], query: searchQuery, offset: 0, limit: 20, basisDigest: null};
  const request: ScientificKnowledgeSearchRequest = kind === 'entity' ? {...base, kind,
    entityTypes: type === '' ? [] : [type as ScientificEntity['entityType']]} : kind === 'relation' ? {...base, kind,
    relationTypes: type === '' ? [] : [type as keyof typeof scientificRelationLabels],
    entityId: null, fromEntityId: null, toEntityId: null} : {...base, kind,
    factTypes: type === '' ? [] : [type as keyof typeof scientificFactLabels],
    methodId: filter && ['Method', 'Model'].includes(filter.entityType) ? filter.id : null,
    datasetId: filter?.entityType === 'Dataset' ? filter.id : null,
    metricId: filter?.entityType === 'Metric' ? filter.id : null,
    baselineId: filter?.entityType === 'Baseline' ? filter.id : null,
    datasetVersion: version.trim() || null, split: split.trim() || null};
  const chooseFilter = (entity: ScientificEntity): void => {
    setFilter(entity); setKind('fact'); setType(''); setQuery('');
  };
  return <section className="knowledge-scientific flex min-h-0 min-w-0 flex-1 flex-col" data-testid="wiki-scientific-panel" aria-label={graph ? '科研知识关系' : '结构化知识'}>
    <div className="knowledge-toolbar">
      <div className="flex flex-wrap gap-2" aria-label="科研知识种类">{Object.entries(kinds).map(([value, label]) =>
        <button type="button" key={value} aria-pressed={kind === value}
          className="knowledge-view-button"
          onClick={() => {setKind(value as typeof kind); setType(''); setFilter(null); setVersion(''); setSplit('');}}>{label}</button>)}</div>
      <label className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-xs">
        <span>搜索</span><input type="search" aria-label="搜索科研知识" className={`${formInputClass} min-w-0 flex-1`}
          value={query} maxLength={300} placeholder="名称、别名或原始内容" onChange={event => setQuery(event.target.value)}/>
      </label>
      <label className="flex shrink-0 items-center gap-2 text-xs"><span className="whitespace-nowrap">类型</span>
        <select aria-label="科研知识类型" className={formInputClass} value={type} onChange={event => setType(event.target.value)}>
          <option value="">全部类型</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {kind === 'fact' ? <details className="w-full"><summary className="cursor-pointer text-xs">实验条件筛选</summary>
        <div className="flex flex-wrap gap-2 pt-2">
          {filter ? <p className="flex flex-wrap items-center gap-2 text-xs">{scientificEntityLabels[filter.entityType]}：{filter.canonicalName}
            <button type="button" className={formSecondaryButtonClass} onClick={() => setFilter(null)}>清除实体筛选</button></p> : null}
          <label className="flex min-w-0 items-center gap-2 text-xs">数据集版本<input aria-label="科研数据集版本" className={`${formInputClass} min-w-0`}
            value={version} maxLength={16000} onChange={event => setVersion(event.target.value)}/></label>
          <label className="flex min-w-0 items-center gap-2 text-xs">划分<input aria-label="科研数据集划分" className={`${formInputClass} min-w-0`}
            value={split} maxLength={16000} onChange={event => setSplit(event.target.value)}/></label>
        </div>
      </details> : null}
    </div>
    {query !== searchQuery ? <p role="status" className="p-3 text-xs text-muted">等待搜索输入…</p> :
      <KnowledgePage key={JSON.stringify(request)} client={client} request={request} graph={graph} onFactFilter={chooseFilter}/>}
  </section>;
}

function KnowledgePage({client, request, graph, onFactFilter}: {
  client: RocClient; request: ScientificKnowledgeSearchRequest; graph: boolean; onFactFilter: (entity: ScientificEntity) => void
}): React.JSX.Element {
  const [paging, setPaging] = useState<{offset: number; basisDigest: string | null}>({offset: 0, basisDigest: null});
  const [attempt, setAttempt] = useState(0), [selected, setSelected] = useState<ScientificKnowledgeSearchHit | null>(null);
  const read = useAsyncResource(JSON.stringify([request, paging, attempt]), () =>
    client.api.research.searchWikiKnowledge({...request, ...paging}), {label: '搜索结构化科研知识'});
  const data = read.status === 'ready' ? read.data : null;
  const rows = scientificConceptRows(data?.hits ?? []);
  const restart = (): void => {setSelected(null); setPaging({offset: 0, basisDigest: null}); setAttempt(value => value + 1);};
  const selectEntity = (entity: ScientificEntity, source: WikiPaperKnowledgeSource): void =>
    setSelected({kind: 'entity', value: entity, source, exactMatch: false});
  return <div className="knowledge-scientific-results flex min-h-0 min-w-0 flex-1 flex-col" data-browsing={selected === null}>
    {read.status === 'loading' ? <p role="status" className="p-4 text-xs">核对科研知识与原始来源…</p> : null}
    {read.error ? <><ErrorBar error={{level: 'blocked', message: read.error, retry: restart}}/><button type="button" className={`${formSecondaryButtonClass} self-start m-3`} onClick={restart}>重新检索科研知识</button></> : null}
    {data ? <>
      <div className="knowledge-scientific-status flex flex-wrap items-center justify-between gap-2">
        <span>{rows.length} 项</span>
        <button type="button" className={formSecondaryButtonClass} onClick={restart}>重新检索科研知识</button>
        {data.unavailable.map(source => <p key={source.documentId} role="status" className="w-full break-words">
          {source.state === 'missing' ? '部分来源的科研知识尚未生成' : '部分科研来源已失效'}
          {source.configurationError ? `：${source.configurationError}` : ''}
        </p>)}
      </div>
      <div className="knowledge-browser">
        <div className="knowledge-directory">
          <div className="knowledge-directory-heading"><span>{graph ? '关系节点' : '知识目录'}</span></div>
          <div className="knowledge-directory-scroll">
            {rows.length === 0 ? <p className="p-3 text-xs text-muted">没有当前有效的匹配记录。</p> : null}
            <ul className="space-y-1" aria-label="科研知识搜索结果">{rows.map((row, index) => <li key={row.id}>
              <button type="button" data-testid="wiki-scientific-row" aria-pressed={selected !== null && scientificHitKey(selected) === row.id}
                className="knowledge-page-row aria-pressed:bg-[var(--overlay-active)]"
                onClick={() => setSelected(data.hits[index]!)}>
                <span className="knowledge-row-title break-words">{row.label}</span>
                <span className="block break-words text-xs text-muted">{row.subtitle}</span>
              </button>
            </li>)}</ul>
          </div>
          <nav className="knowledge-directory-footer" aria-label="科研知识分页">
            <button type="button" className={formSecondaryButtonClass} disabled={paging.offset === 0}
              onClick={() => {setSelected(null); setPaging({offset: Math.max(0, paging.offset - 20), basisDigest: data.basisDigest});}}>前 20 条</button>
            <button type="button" className={formSecondaryButtonClass} disabled={data.nextOffset === null}
              onClick={() => {setSelected(null); setPaging({offset: data.nextOffset!, basisDigest: data.basisDigest});}}>后 20 条</button>
          </nav>
        </div>
        <div className="knowledge-detail">
          {selected ? <>
            <button type="button" className={`knowledge-back ${formSecondaryButtonClass}`} onClick={() => setSelected(null)}><ArrowLeft size={14} aria-hidden="true"/>返回知识目录</button>
            <div className="knowledge-detail-scroll"><div className="knowledge-reading-column">
              <ScientificPaperKnowledge key={scientificHitKey(selected)} client={client} projectId={request.projectId}
                reference={selected.source} record={{kind: selected.kind, id: selected.value.id, candidateId: selected.value.candidateId}}
                onSelectEntity={selectEntity} onFactFilter={onFactFilter} graph={graph}/>
            </div></div>
          </> : <EmptyState icon={Network} title="选择一个知识条目"/>}
        </div>
      </div>
    </> : null}
  </div>;
}
