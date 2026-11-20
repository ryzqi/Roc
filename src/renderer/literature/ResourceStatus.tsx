import {useEffect} from 'react';
import type {ResearchDocument} from '../../shared/types';
import {useWorkspaceScope} from '../app/workspace-scope';
import {useAsyncResource} from '../app/use-async-resource';
import {useVisiblePolling} from '../shared/view-activity';
import {PipelineProgress} from './PipelineProgress';
import {literaturePipeline} from './pipeline-state';

export function ResourceStatus({itemId, document}: {itemId: string; document: ResearchDocument | null}): React.JSX.Element {
  const scope = useWorkspaceScope();
  const receipt = useAsyncResource(JSON.stringify(['library-pipeline', scope.projectId, itemId]),
    () => scope.client.api.research.listAcquisition({projectId: scope.projectId,
      destination: scope.projectId === null ? 'library_only' : 'current_project', libraryItemId: itemId, limit: 1, offset: 0}),
    {label: '读取文献处理回执'});
  const latestJob = receipt.data?.jobs[0] ?? null;
  const job = document !== null && latestJob?.documentId !== document.id ? null : latestJob;
  useVisiblePolling(receipt.reload, 4000, job?.status === 'queued' || job?.status === 'running');
  useEffect(() => scope.client.api.research.onLibraryChanged(() => receipt.reload()), [scope.client, receipt.reload]);
  return <section data-testid="reader-resource-status" className="shrink-0 space-y-2 border-b-[0.5px] border-line px-4 py-3">
    {receipt.data === null ? <p role="status" className="text-[length:var(--font-meta-size)] text-muted">
      {receipt.error === null ? '正在核验处理阶段…' : '处理阶段暂不可核验'}
    </p> : <PipelineProgress stages={literaturePipeline(document, job)}/>}
    {receipt.error !== null ? <p role="alert" className="text-[length:var(--font-meta-size)] text-muted">处理回执读取失败：{receipt.error}
      <button type="button" onClick={receipt.reload} className="ms-2 rounded-control px-2 py-1 hover:bg-[var(--overlay-hover)]">重试</button></p> : null}
    {job?.errorCode ? <p role="alert" className="text-[length:var(--font-meta-size)] text-[var(--st-bad)]">{job.errorCode}</p> : null}
    {job === null && receipt.data !== null && document === null ? <p className="text-[length:var(--font-meta-size)] text-muted">尚未获取全文。可添加 PDF 后解析。</p> : null}
    {job?.stage === 'wiki' ? <button type="button" onClick={() => scope.openView('knowledge')}
      className="min-h-7 rounded-control px-2 text-[length:var(--font-meta-size)] text-muted hover:bg-[var(--overlay-hover)]">问我的资料</button> : null}
  </section>;
}
