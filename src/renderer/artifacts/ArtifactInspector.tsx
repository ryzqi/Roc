import {lazy, Suspense, useEffect, useRef} from 'react';
import type {ResearchArtifactInspectRequest} from '../../shared/schemas/research-artifact-inspector';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {ModalShell} from '../shell/ModalShell';
import {formSecondaryButtonClass} from '../shared/form-ui';

const StageContent = lazy(async () => ({default: (await import('./ArtifactStageContent')).ArtifactStageContent}));
const button = `${formSecondaryButtonClass} border-[0.5px]`;

export function ArtifactInspector({client, request, onClose, onOpenTask}: {
  client: RocClient; request: ResearchArtifactInspectRequest; onClose: () => void; onOpenTask: (taskId: string) => void
}): React.JSX.Element {
  const baseline = useRef(request.expectedVersion);
  const read = useAsyncResource(`artifact:inspect:${JSON.stringify(request)}`,
    () => client.api.research.inspectArtifact({...request, expectedVersion: baseline.current}), {label: '读取科研工件'});
  const result = read.status === 'ready' ? read.data : null;
  const snapshot = result?.snapshot;
  useEffect(() => {
    if (result?.status === 'current') baseline.current = result.snapshot.version;
  }, [result]);
  const statuses = {draft: '草稿', approved: '已批准', superseded: '已被替代'};
  return <ModalShell open kind="drawer" title={snapshot?.artifact.title ?? '科研工件'} onClose={onClose}
    widthClassName="w-[560px]" testId="artifact-inspector">
    <div className="flex flex-col gap-3 text-[var(--font-body-size)]">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={read.status === 'loading'}
          data-testid="artifact-inspector-refresh" onClick={read.reload}>刷新工件</button>
        {result?.status !== 'stale' ? null : <button type="button" className={button}
          data-testid="artifact-inspector-recapture" onClick={() => {baseline.current = result.snapshot.version; read.reload();}}>
          按当前版本重新核对
        </button>}
        {snapshot?.origin === null || snapshot?.origin === undefined || snapshot.origin.taskId === null ||
          !snapshot.availableActions.includes('return_to_task') ? null : <button type="button" className={button}
          data-testid="artifact-inspector-task" onClick={() => onOpenTask(snapshot.origin!.taskId!)}>查看关联任务</button>}
      </div>
      {read.status === 'loading' ? <p role="status">正在读取工件…</p> : null}
      {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
      {result?.status === 'stale' ? <p role="alert" className="text-[var(--st-warn)]">
        工件或来源已变更。当前内容需要重新核对。
      </p> : null}
      {snapshot === undefined ? null : <>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
          <dt>工件状态</dt><dd>{statuses[snapshot.artifact.status]}</dd>
          <dt>人工闸门</dt><dd>{snapshot.stage.gateApproved ? '已通过' :
            snapshot.stage.status === 'waiting_approval' ? '等待人工审核' : '尚未通过'}</dd>
          <dt>快照版本</dt><dd className="break-all font-mono text-[var(--font-meta-size)]">{snapshot.version}</dd>
        </dl>
        <Suspense fallback={<p role="status">正在加载工件正文…</p>}>
          <StageContent snapshot={snapshot} />
        </Suspense>
        <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" aria-label="工件证据来源">
          <h2 className="font-medium text-ink">证据来源</h2>
          {snapshot.evidence.length === 0 ? <p className="text-muted">尚无保存的证据关联。</p> :
            snapshot.evidence.map(source => <details key={source.evidence.id} className="border-b-[0.5px] border-line py-2">
              <summary className="cursor-pointer break-words text-ink">{source.evidence.title}
                <span className="ml-2 text-muted">{source.referenceStatus === 'superseded' ? '旧定位已失效' : '已保存的来源片段'}</span>
              </summary>
              <p className="mt-2 break-words text-muted">{source.evidence.locator}</p>
              <blockquote className="mt-1 whitespace-pre-wrap break-words text-ink">{source.evidence.excerpt}</blockquote>
              {source.invalidatedAt === null ? null : <p className="text-muted">失效时间 {source.invalidatedAt}</p>}
              <p className="break-all text-muted">来源版本 {source.evidence.sourceVersion}</p>
              <p className="break-all font-mono text-[var(--font-meta-size)] text-muted">SHA-256 {source.evidence.contentHash}</p>
            </details>)}
        </section>
        <details className="text-muted"><summary className="cursor-pointer">工件与来源快照原文</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(snapshot, null, 2)}</pre>
        </details>
      </>}
    </div>
  </ModalShell>;
}
