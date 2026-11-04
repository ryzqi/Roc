import {useEffect, useRef, useState} from 'react';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewCorpusCreate} from '../../shared/schemas/research-review-corpus';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass, formPrimaryButtonClass, formInputClass} from '../shared/form-ui';
import {ReviewSearchQuery, reviewSearchStatuses} from './ReviewSearchQuery';
import {ReviewSearchPool} from './ReviewSearchPool';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ReviewSearchCorpus({client, protocol, writable, onPending}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; writable: boolean; onPending: (pending: boolean) => void
}): React.JSX.Element {
  const projectId = protocol.version.projectId, versionId = protocol.version.id;
  const searches = useAsyncResource(`review:searches:${projectId}:${versionId}`,
    () => client.api.research.listReviewSearches({projectId, versionId, limit: 100}), {label: '读取协议检索'});
  const corpora = useAsyncResource(`review:corpora:${projectId}:${versionId}`,
    () => client.api.research.listReviewCorpora({projectId, versionId, limit: 100}), {label: '读取固定语料'});
  const create = useAsyncAction((request: ResearchReviewCorpusCreate) => client.api.research.createReviewCorpus(request), {label: '固定人工选择语料'});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [poolId, setPoolId] = useState<string | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const requests = useRef(new Map<string, string>());
  const busy = useRef(false);
  const active = searches.data?.some(search => search.status === 'running' || search.status === 'cancelling') === true;
  useEffect(() => {
    if (!active || searches.status !== 'ready') return;
    const timer = setTimeout(searches.reload, 1000);
    return () => clearTimeout(timer);
  }, [active, searches.status, searches.reload]);
  const queries = protocol.version.body.databases.flatMap((database, databaseIndex) =>
    database.queries.map((query, queryIndex) => ({database, query, databaseIndex, queryIndex, key: `${databaseIndex}:${queryIndex}`})));
  const picked = queries.map(query => searches.data?.find(search => search.snapshot.id === selected[query.key]));
  const completeSelection = picked.every((search, index) => search !== undefined && search.receiptHash !== null &&
    `${search.snapshot.request.databaseIndex}:${search.snapshot.request.queryIndex}` === queries[index]!.key);
  const editable = writable && protocol.isLatest && protocol.freezeHash !== null && searches.status === 'ready';
  const pending = queryPending || create.pending;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-search">
    <h2 className="font-medium">冻结协议检索与语料</h2>
    <p className="text-muted">显示最近100次执行记录</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={pending || searches.status === 'loading'}
      data-testid="artifact-review-search-refresh" onClick={() => {searches.reload(); corpora.reload();}}>刷新检索与语料</button></div>
    {searches.status !== 'loading' ? null : <p role="status">正在读取实际检索状态…</p>}
    {searches.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{searches.error}</p>}
    {searches.error === null || searches.data === null ? null : <p className="text-muted">以下为上次成功读取的回执，当前状态核查失败。</p>}
    {searches.data === null ? null : queries.map(query => <ReviewSearchQuery key={query.key} client={client} protocol={protocol}
      databaseIndex={query.databaseIndex} queryIndex={query.queryIndex}
      searches={searches.data!.filter(search => search.snapshot.request.databaseIndex === query.databaseIndex &&
        search.snapshot.request.queryIndex === query.queryIndex)} historyComplete={searches.data!.length < 100} ready={searches.status === 'ready'}
      writable={writable && !pending} onPending={value => {setQueryPending(value); onPending(value);}}
      onChanged={searches.reload} onInspect={setPoolId} />)}
    {poolId === null ? null : <ReviewSearchPool key={poolId} client={client} projectId={projectId} searchId={poolId} />}
    <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2">
      <h3 className="font-medium">选择语料来源</h3>
      {searches.data === null ? null : queries.map(query => <label key={query.key} className="flex flex-col gap-1 text-muted">
        {query.database.source} 检索式 {query.queryIndex + 1}
        <select aria-label={`语料来源 ${query.databaseIndex + 1}-${query.queryIndex + 1}`} className={`${formInputClass} border-[0.5px]`}
          disabled={!editable || pending} value={selected[query.key] ?? ''} onChange={event => {
            setSelected({...selected, [query.key]: event.target.value}); create.reset();
          }}>
          <option value="">选择已结束的实际检索</option>
          {searches.data!.filter(search => search.snapshot.request.databaseIndex === query.databaseIndex &&
            search.snapshot.request.queryIndex === query.queryIndex && search.receiptHash !== null).map(search =>
            <option key={search.snapshot.id} value={search.snapshot.id}>{search.snapshot.startedAt} {reviewSearchStatuses[search.status]}
              原始记录 {search.rawRecordCount} 条{search.coverageComplete ? '' : ' 覆盖不完整'}</option>)}
        </select>
      </label>)}
      {!completeSelection ? <p className="text-muted">每条协议查询需明确选择一个终态检索。</p> :
        picked.some(search => !search!.coverageComplete) ? <p role="note" className="text-[var(--st-warn)]">所选检索覆盖不完整，将如实记录失败、取消或分页边界。</p> : null}
      {!editable ? null : <button type="button" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
        disabled={pending || !completeSelection} data-testid="artifact-review-corpus-create" onClick={() => {
          if (busy.current || protocol.freezeHash === null || !completeSelection) return;
          const refs = picked.map(search => ({reviewSearchId: search!.snapshot.id, expectedSnapshotHash: search!.snapshotHash,
            expectedReceiptHash: search!.receiptHash!}));
          const signature = JSON.stringify(refs);
          let requestId = requests.current.get(signature);
          if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
          const request: ResearchReviewCorpusCreate = {projectId, versionId, expectedFreezeHash: protocol.freezeHash, requestId, searches: refs};
          busy.current = true; onPending(true);
          void create.run(request).then(result => {busy.current = false; onPending(false); if (result.ok) corpora.reload();});
        }}>确认并固定所选语料</button>}
      {create.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{create.error}</p>}
      {corpora.status !== 'loading' ? null : <p role="status">正在读取固定语料…</p>}
      {corpora.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{corpora.error}</p>}
      {corpora.status !== 'ready' ? null : <ul className="flex flex-col gap-2">{corpora.data!.map(corpus =>
        <li key={corpus.snapshot.id} data-testid="artifact-review-corpus" className="flex flex-col gap-1">
          <p>固定语料 原始记录 {corpus.identifiedRecords} 条 {corpus.currentProtocol ? '当前协议' : '历史协议'}</p>
          <p className="text-muted break-words">{corpus.snapshot.recordedAt} 记录人 {corpus.snapshot.actor.id}</p>
          <p className="text-muted">{corpus.searchCoverageComplete ? '已到所选查询报告终点' : '检索覆盖不完整'}</p>
          <details><summary className="cursor-pointer text-muted">固定来源与计数</summary>
            <ul>{corpus.snapshot.sources.map(source => <li key={source.reviewSearchId} className="break-words text-muted">
              数据库 {source.databaseIndex + 1} 检索式 {source.queryIndex + 1} {reviewSearchStatuses[source.status]}
              原始记录 {source.rawRecordCount} 条
            </li>)}</ul>
          </details>
        </li>)}</ul>}
    </section>
  </section>;
}
