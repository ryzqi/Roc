import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import type {ResearchExportExecution} from '../../shared/schemas/research-exports';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {ExportPublicationReceipt} from './ExportPublicationReceipt';

export const exportStatusLabels = {preparing: '正在生成', ready: '已生成', failed: '失败', cancelled: '已取消', interrupted: '已中断'} as const;
const approvals = {unpublished: '尚未登记科研工件', draft: '等待科研审核', approved: '科研审核已批准', superseded: '已被替代'} as const;
const Zenodo = lazy(async () => ({default: (await import('./ZenodoPanel')).ZenodoPanel}));
export function ExportExecutionReceipt({client, record, writable, onPending, onDirty}: {
  client: RocClient; record: ResearchExportExecution; writable: boolean; onPending: (value: boolean) => void;
  onDirty: (value: boolean) => void
}): React.JSX.Element {
  const [zenodoOpen, setZenodoOpen] = useState(false), [zenodoDirty, setZenodoDirty] = useState(false);
  const [zenodoPending, setZenodoPending] = useState(false);
  const zenodoLocked = zenodoDirty || zenodoPending;
  const mounted = useRef(true), busy = useRef(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const read = useAsyncResource(`export:execution:${record.projectId}:${record.id}`,
    () => client.api.research.getExport({projectId: record.projectId, exportId: record.id}), {label: '读取导出状态'});
  const cancel = useAsyncAction(() => client.api.research.cancelExport({projectId: record.projectId, exportId: record.id}), {label: '取消导出'});
  const current = read.status === 'ready' ? read.data : null;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-export-execution">
    <h3 className="font-medium break-words">{record.request.title}</h3>
    <p className="break-all text-muted">导出 ID {record.id}</p>
    {read.status === 'loading' ? <p role="status">正在读取生成状态…</p> : null}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{read.error}</p>}
    {cancel.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{cancel.error}</p>}
    {current === null ? null : <>
      <p role="status">{exportStatusLabels[current.status]}，{approvals[current.approval]}</p>
      {current.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{current.error}</p>}
      {current.archive === null ? null : <p className="break-all font-mono text-muted">ZIP {current.archive.size} B，SHA-256 {current.archive.sha256}</p>}
      <p className="text-muted">创建时间 {current.createdAt}{current.endedAt === null ? '' : `，结束时间 ${current.endedAt}`}</p>
    </>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px]`} disabled={read.status === 'loading' || cancel.pending || zenodoLocked}
        data-testid="artifact-export-status-refresh" onClick={read.reload}>刷新生成状态</button>
      {current?.status !== 'preparing' ? null : <button type="button" className={`${formSecondaryButtonClass} border-[0.5px]`}
        disabled={cancel.pending || !writable} data-testid="artifact-export-cancel" onClick={() => {
          if (!writable || busy.current) return;
          busy.current = true;
          onPending(true);
          void cancel.run().then(() => {
            busy.current = false;
            if (!mounted.current) return;
            onPending(false); read.reload();
          });
        }}>取消生成</button>}
    </div>
    <details className="min-w-0">
      <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-accent">查看已提交的公开交付清单</summary>
      <ExportPublicationReceipt review={record.request.publicationReview}/>
    </details>
    {current?.status !== 'ready' ? null : <>
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px] self-start`}
        aria-expanded={zenodoOpen} disabled={zenodoLocked} data-testid="artifact-zenodo-toggle"
        onClick={() => setZenodoOpen(value => !value)}>{zenodoOpen ? '收起 Zenodo 发布' : '审查 Zenodo 发布'}</button>
      {!zenodoOpen ? null : <Suspense fallback={<p role="status">正在加载 Zenodo 发布审查…</p>}>
        <Zenodo key={`${current.projectId}:${current.id}`} client={client} record={current}
          writable={writable && current.approval === 'approved'}
          onDirty={value => {setZenodoDirty(value); onDirty(value);}}
          onPending={value => {setZenodoPending(value); onPending(value);}}/>
      </Suspense>}
    </>}
  </section>;
}
