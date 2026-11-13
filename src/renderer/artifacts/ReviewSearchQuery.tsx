import {useRef, useState} from 'react';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewSearchInspection, ResearchReviewSearchStart, ResearchReviewSearchCancel} from '../../shared/schemas/research-review-search';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ArtifactDraftDiscard, useArtifactDraft} from './artifact-editor-guard';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export const reviewSearchStatuses: Record<ResearchReviewSearchInspection['status'], string> = {
  running: '检索中', cancelling: '正在取消', complete: '检索完成', partial: '结果不完整',
  failed: '检索失败', cancelled: '已取消', interrupted: '重启中断'
};
const stopReasons: Record<ResearchReviewSearchInspection['sources'][number]['stopReason'], string> = {
  reported_end: '已到数据库报告终点', page_limit: '到达所设页数上限',
  provider_limit: '到达数据库上限', continuation_unavailable: '无法继续分页', failed: '来源请求失败'
};

export function ReviewSearchQuery({client, protocol, databaseIndex, queryIndex, searches, historyComplete, ready, writable, onPending, onChanged, onInspect}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; databaseIndex: number; queryIndex: number;
  searches: ResearchReviewSearchInspection[]; historyComplete: boolean; ready: boolean; writable: boolean;
  onPending: (pending: boolean) => void; onChanged: () => void; onInspect: (id: string) => void
}): React.JSX.Element {
  const database = protocol.version.body.databases[databaseIndex]!;
  const latest = searches[0];
  const [cancelNote, setCancelNote] = useState('');
  const requests = useRef(new Map<string, string>());
  const busy = useRef(false);
  const draft = useArtifactDraft('检索取消原因', cancelNote, busy);
  const start = useAsyncAction((request: ResearchReviewSearchStart) => client.api.research.startReviewSearch(request), {label: '启动冻结协议检索'});
  const cancel = useAsyncAction((request: ResearchReviewSearchCancel) => client.api.research.cancelReviewSearch(request), {label: '取消冻结协议检索'});
  const pending = start.pending || cancel.pending;
  const active = latest?.status === 'running' || latest?.status === 'cancelling';
  const editable = ready && writable && protocol.isLatest && protocol.freezeHash !== null;
  const requestId = (key: string): string => {
    const existing = requests.current.get(key);
    if (existing !== undefined) return existing;
    const id = crypto.randomUUID(); requests.current.set(key, id); return id;
  };
  const begin = (): void => {busy.current = true; onPending(true);};
  const finish = (ok: boolean): void => {busy.current = false; onPending(false); if (ok) {draft.saved(); onChanged();}};
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-query">
    <h3 className="font-medium">{database.source} 检索式 {queryIndex + 1}</h3>
    <p className="whitespace-pre-wrap break-words">{database.queries[queryIndex]}</p>
    <p className="text-muted">每页 {database.pageSize} 条，最多 {database.maxPages} 页</p>
    {latest === undefined ? <p className="text-muted">{historyComplete ? '尚未执行' : '最近100次记录未包含此查询，执行状态尚未核查。'}</p> :
      <p role="status" data-testid="artifact-review-query-status">
      {reviewSearchStatuses[latest.status]}{latest.receipt === null ? '，记录数待终态回执' :
        `，原始记录 ${latest.rawRecordCount} 条，${latest.coverageComplete ? '查询范围已到报告终点' : '检索覆盖不完整'}`}
    </p>}
    {!editable || active || latest?.coverageComplete || (latest === undefined && !historyComplete) ? null :
      <button type="button" className={`${button} self-start`} disabled={pending || draft.locked}
      data-testid="artifact-review-query-start" onClick={() => {
        if (busy.current || draft.isLocked() || protocol.freezeHash === null) return;
        const request: ResearchReviewSearchStart = {
          projectId: protocol.version.projectId, versionId: protocol.version.id, expectedFreezeHash: protocol.freezeHash,
          requestId: requestId(`start:${latest?.snapshotHash ?? 'first'}`), databaseIndex, queryIndex,
          retryOf: latest?.snapshot.id ?? null, expectedRetrySnapshotHash: latest?.snapshotHash ?? null
        };
        begin(); void start.run(request).then(result => finish(result.ok));
      }}>{latest === undefined ? '执行此查询' : '按原查询新建重试'}</button>}
    {!editable || latest?.status !== 'running' ? null : <form className="flex flex-col gap-2" onSubmit={event => {
      event.preventDefault();
      if (busy.current || draft.isLocked()) return;
      const request: ResearchReviewSearchCancel = {
        projectId: protocol.version.projectId, reviewSearchId: latest.snapshot.id,
        requestId: requestId(`cancel:${latest.snapshot.id}:${latest.revision}:${cancelNote}`),
        expectedRevision: latest.revision, note: cancelNote
      };
      begin(); void cancel.run(request).then(result => finish(result.ok));
    }}>
      <label className="flex flex-col gap-1 text-muted">取消原因
        <input required maxLength={10000} className={`${formInputClass} border-[0.5px]`} disabled={pending || draft.locked}
          value={cancelNote} onChange={event => {setCancelNote(event.target.value); cancel.reset();}} />
      </label>
      <button type="submit" className={`${button} self-start`} disabled={pending || draft.locked || cancelNote.trim() === ''}
        data-testid="artifact-review-query-cancel">取消此查询</button>
    </form>}
    <ArtifactDraftDiscard dirty={draft.dirty} testId={`artifact-review-query-discard-${databaseIndex}-${queryIndex}`} onDiscard={() => {
      setCancelNote(''); cancel.reset(); draft.reset('');
    }} />
    {start.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{start.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{cancel.error}</p>}
    {searches.length === 0 ? null : <details>
      <summary className="cursor-pointer text-muted">最近执行记录 {searches.length} 次</summary>
      <ul className="mt-2 flex flex-col gap-2">{searches.map(search => <li key={search.snapshot.id} className="flex flex-col gap-1">
        <p className="text-muted break-words">{search.snapshot.startedAt} {reviewSearchStatuses[search.status]}
          {search.receipt === null ? '' : ` 原始记录 ${search.rawRecordCount} 条`}</p>
        <p className="text-muted break-all">记录人 {search.snapshot.actor.id}</p>
        {search.receipt?.errorCode == null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{search.receipt.errorCode}</p>}
        {search.sources.map((source, index) => <div key={index} className="text-muted break-words">
          <p>{source.source} {stopReasons[source.stopReason]} {source.errorCode}</p>
          {source.pages.map((page, pageIndex) => page.cache.state !== 'hit' ? null :
            <p key={pageIndex}>使用缓存 原始取回时间 {page.cache.fetchedAt}</p>)}
        </div>)}
        {search.receipt?.poolHash == null ? null : <button type="button" className={`${button} self-start`}
          data-testid="artifact-review-query-pool" onClick={() => onInspect(search.snapshot.id)}>核对原始记录</button>}
      </li>)}</ul>
    </details>}
  </section>;
}
