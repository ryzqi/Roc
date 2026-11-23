import {useEffect, useRef, useState} from 'react';
import type {ResearchDocument} from '../../shared/types';
import {useWorkspaceScope} from '../app/workspace-scope';
import {useAsyncResource} from '../app/use-async-resource';
import {runIpcAction} from '../app/loaded-state';
import {useVisiblePolling} from '../shared/view-activity';
import {PipelineProgress} from './PipelineProgress';
import {acquisitionPipelineStage, literaturePipeline, type PipelineStage} from './pipeline-state';
import {canRetryAcquisition, changeLiteratureProcessing} from './literature-processing';

const buttonClass = 'min-h-7 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:opacity-50';
type RetryContext = {key: string; locked: boolean};
type RetryState = {context: RetryContext; pending: boolean; error: string | null; notice: string | null};

export function ResourceStatus({itemId, document, onMetadata, onPdf, onParse, onKnowledge}: {
  itemId: string; document: ResearchDocument | null;
  onMetadata: () => void; onPdf: () => void; onParse: () => void;
  onKnowledge: (target: 'index' | 'wiki') => void
}): React.JSX.Element {
  const scope = useWorkspaceScope();
  const [selected, setSelected] = useState<PipelineStage['id'] | null>(null);
  // Document hydration must preserve the disclosure and keyboard focus. Only mutation
  // receipts change identity; a late retry cannot publish after switching away and back.
  const retryKey = JSON.stringify([scope.projectId, itemId, document?.id ?? null]);
  const retryContext = useRef<RetryContext>({key: retryKey, locked: false});
  if (retryContext.current.key !== retryKey) retryContext.current = {key: retryKey, locked: false};
  const [retryState, setRetryState] = useState<RetryState | null>(null);
  const currentRetry = retryState?.context === retryContext.current ? retryState : null;
  const pending = currentRetry?.pending ?? false, error = currentRetry?.error ?? null, notice = currentRetry?.notice ?? null;
  const mounted = useRef(false), writable = useRef(scope.writable);
  writable.current = scope.writable;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const receipt = useAsyncResource(JSON.stringify(['library-pipeline', scope.projectId, itemId]),
    () => scope.client.api.research.listAcquisition({projectId: scope.projectId,
      destination: scope.projectId === null ? 'library_only' : 'current_project', libraryItemId: itemId, limit: 1, offset: 0}),
    {label: '读取文献处理回执'});
  const latestJob = receipt.data?.jobs[0] ?? null;
  const job = document !== null && latestJob?.documentId !== document.id ? null : latestJob;
  useVisiblePolling(receipt.reload, 4000, job?.status === 'queued' || job?.status === 'running');
  useEffect(() => scope.client.api.research.onLibraryChanged(() => receipt.reload()), [scope.client, receipt.reload]);
  const retry = async (): Promise<void> => {
    const context = retryContext.current;
    if (context.locked || !mounted.current || !writable.current || scope.projectId === null || job === null || !canRetryAcquisition(job)) return;
    context.locked = true;
    setRetryState({context, pending: true, error: null, notice: null});
    try {
      const result = await runIpcAction(() => changeLiteratureProcessing(scope.client, scope.projectId!, job, 'retry'));
      if (!mounted.current || retryContext.current !== context) return;
      setRetryState({context, pending: false, error: result.ok ? null : result.error,
        notice: result.ok ? '已提交后台重试，请查看最新进度。' : null});
      receipt.reload();
    } finally {context.locked = false;}
  };
  const stages = literaturePipeline(document, job);
  const current = stages.find(stage => stage.id === selected);
  const retrySelected = job !== null && selected === acquisitionPipelineStage(job) && canRetryAcquisition(job);
  const failedStage = job === null || !canRetryAcquisition(job) ? null : stages.find(stage => stage.id === acquisitionPipelineStage(job));
  return <details data-testid="reader-resource-status" className="reading-disclosure reading-pipeline-details">
    <summary data-testid="reader-pipeline-toggle">处理阶段{receipt.error !== null ? <span>读取失败</span> :
      failedStage ? <span>{failedStage.label}{failedStage.state}</span> : null}</summary>
    <div className="reading-disclosure-body">
    {receipt.data === null ? <p role="status" className="text-[length:var(--font-meta-size)] text-muted">
      {receipt.error === null ? '正在核验处理阶段…' : '处理阶段暂不可核验'}
    </p> : <PipelineProgress stages={stages} selected={selected} onSelect={stage => {
      setSelected(stage);
      if (stage === 'metadata') onMetadata();
      if (stage === 'pdf' && document !== null) onPdf();
      if (stage === 'parse' && document !== null) onParse();
    }}/>}
    {receipt.error !== null ? <p role="alert" className="text-[length:var(--font-meta-size)] text-muted">处理回执读取失败：{receipt.error}
      <button type="button" onClick={receipt.reload} className="ms-2 rounded-control px-2 py-1 hover:bg-[var(--overlay-hover)]">重试</button></p> : null}
    {job?.errorCode ? <p role="alert" className="text-[length:var(--font-meta-size)] text-[var(--st-bad)]">{job.errorCode}</p> : null}
    {current === undefined ? null : <div data-testid="reader-pipeline-details" className="flex flex-wrap items-center gap-2 text-[length:var(--font-meta-size)]" aria-label={`${current.label}详情`}>
      <span className="text-muted">{current.label}：{current.state}</span>
      {selected !== 'pdf' || document !== null ? null : <button type="button" className={buttonClass} disabled={!scope.writable || pending}
        onClick={onPdf}>添加 PDF</button>}
      {selected !== 'parse' || document?.error == null ? null : <span className="break-words text-[var(--st-bad)]">{document.error}</span>}
      {selected !== 'index' && selected !== 'wiki' ? null : <button type="button" className={buttonClass} disabled={scope.projectId === null}
        onClick={() => onKnowledge(selected)}>{selected === 'index' ? '查看索引任务' : '查看知识页'}</button>}
      {!retrySelected ? null : <button type="button" className={buttonClass} disabled={!scope.writable || scope.projectId === null || pending}
        data-testid="reader-pipeline-retry" onClick={() => void retry()}>{pending ? '正在提交…' : `重试${current.label}`}</button>}
    </div>}
    {error === null ? null : <p role="alert" className="text-[length:var(--font-meta-size)] text-[var(--st-bad)]">{error}</p>}
    {notice === null ? null : <p role="status" className="text-[length:var(--font-meta-size)] text-muted">{notice}</p>}
    </div>
  </details>;
}
