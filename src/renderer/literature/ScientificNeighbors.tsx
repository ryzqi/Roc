import {useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import type {ScientificEntity} from '../../shared/schemas/research-scientific-entities';
import type {WikiPaperKnowledgeSource} from '../../shared/schemas/research-wiki-pages';
import type {ScientificRelation} from '../../shared/schemas/research-scientific-relations';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ErrorBar} from '../shell/ErrorBar';
import {scientificHitKey, scientificRelationLabels} from './scientific-wiki';

type Props = {
  client: RocClient; projectId: string; entity: ScientificEntity;
  onSelectEntity?: (entity: ScientificEntity, source: WikiPaperKnowledgeSource) => void
};

/** Mounted only after selecting an entity and explicitly opening its neighborhood. */
export function ScientificNeighbors(props: Props): React.JSX.Element {
  const [type, setType] = useState<ScientificRelation['type'] | ''>('');
  return <section className="min-w-0 space-y-2" aria-label="类型化科研关系">
    <label className="flex flex-wrap items-center gap-2 text-xs">关系类型
      <select className={formInputClass} aria-label="科研邻居关系类型" value={type}
        onChange={event => setType(event.target.value as typeof type)}>
        <option value="">全部关系</option>
        {Object.entries(scientificRelationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <NeighborPage key={JSON.stringify([props.projectId, props.entity.id, props.entity.candidateId, type])}
      {...props} type={type}/>
  </section>;
}

function NeighborPage({client, projectId, entity, type, onSelectEntity}: Props & {
  type: ScientificRelation['type'] | ''
}): React.JSX.Element {
  const [paging, setPaging] = useState<{offset: number; basisDigest: string | null}>({offset: 0, basisDigest: null});
  const [attempt, setAttempt] = useState(0);
  const read = useAsyncResource(JSON.stringify([projectId, entity.id, type, paging, attempt]), () =>
    client.api.research.searchWikiKnowledge({
      projectId, documentIds: [], kind: 'relation', query: '', ...paging, limit: 10,
      relationTypes: type === '' ? [] : [type], entityId: entity.id, fromEntityId: null, toEntityId: null
    }), {label: '读取科研实体邻居'});
  const data = read.status === 'ready' ? read.data : null;
  const restart = (): void => {setPaging({offset: 0, basisDigest: null}); setAttempt(value => value + 1);};
  return <div className="min-w-0 space-y-2" data-testid="wiki-scientific-neighbors">
    {read.status === 'loading' ? <p role="status" className="text-xs">核对关系来源…</p> : null}
    {read.error ? <ErrorBar error={{level: 'blocked', message: read.error, retry: restart}}/> : null}
    {data?.hits.length === 0 ? <p className="text-xs text-muted">没有当前有效的科研关系。</p> : null}
    <ul className="space-y-2">{data?.hits.map(hit => hit.kind !== 'relation' ? null :
      <li key={scientificHitKey(hit)} className="space-y-1 border-b-[0.5px] border-line pb-2">
        <p className="text-xs text-muted">{scientificRelationLabels[hit.value.type]}，{hit.value.type}，科学支持未审核</p>
        <div className="flex flex-wrap items-center gap-2">{[hit.value.fromEntityId, hit.value.toEntityId].map((id, index) => {
          const endpoint = hit.entities.find(value => value.id === id);
          return <span key={index} className="contents">
            {index === 1 ? <span aria-hidden="true">→</span> : null}
            {endpoint ? <button type="button" className={formSecondaryButtonClass}
              disabled={onSelectEntity === undefined}
              onClick={() => onSelectEntity?.(endpoint, hit.source)}>{endpoint.canonicalName}</button> :
              <span className="text-xs text-muted">端点缺失</span>}
          </span>;
        })}</div>
      </li>)}</ul>
    {data?.unavailable.length ? <p role="status" className="text-xs text-muted">部分科研来源已失效或尚未生成。</p> : null}
    <nav className="flex flex-wrap gap-2" aria-label="科研邻居分页">
      <button type="button" className={formSecondaryButtonClass} disabled={data === null || paging.offset === 0}
        onClick={() => setPaging({offset: Math.max(0, paging.offset - 10), basisDigest: data!.basisDigest})}>前 10 条关系</button>
      <button type="button" className={formSecondaryButtonClass} disabled={data?.nextOffset == null}
        onClick={() => setPaging({offset: data!.nextOffset!, basisDigest: data!.basisDigest})}>后 10 条关系</button>
      <button type="button" className={formSecondaryButtonClass} onClick={restart}>重新读取关系</button>
    </nav>
  </div>;
}
