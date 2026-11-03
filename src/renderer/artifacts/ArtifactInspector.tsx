import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import type {ResearchArtifactInspectRequest} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchGateReviewContext} from '../../shared/schemas/research-gate-review';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {ModalShell} from '../shell/ModalShell';
import {formSecondaryButtonClass} from '../shared/form-ui';

const StageContent = lazy(async () => ({default: (await import('./ArtifactStageContent')).ArtifactStageContent}));
const button = `${formSecondaryButtonClass} border-[0.5px]`;

export function ArtifactInspector({client, request, onClose, onOpenTask, onReviewContext}: {
  client: RocClient; request: ResearchArtifactInspectRequest; onClose: () => void; onOpenTask: (taskId: string) => void;
  onReviewContext: (context: ResearchGateReviewContext) => void
}): React.JSX.Element {
  const baseline = useRef(request.expectedVersion);
  const read = useAsyncResource(`artifact:inspect:${JSON.stringify(request)}`,
    () => client.api.research.inspectArtifact({...request, expectedVersion: baseline.current}), {label: '读取科研工件'});
  const result = read.status === 'ready' ? read.data : null;
  const snapshot = result?.snapshot;
  const [reviewNonce, setReviewNonce] = useState(0);
  const review = useAsyncResource(reviewNonce > 0 ? `gate:${JSON.stringify(request)}:${reviewNonce}` : null,
    () => {
      if (snapshot === undefined) throw new Error('research_artifact_snapshot_required');
      return client.api.research.getGateReviewContext({projectId: request.projectId, expectedStage: snapshot.currentStage, artifactId: request.artifactId});
    }, {label: '读取整阶段审核上下文'});
  const reviewedSelection = review.data?.artifactLinks.find(link => link.artifactId === request.artifactId);
  const matchesDisplayedSnapshot = reviewedSelection !== undefined && snapshot !== undefined &&
    reviewedSelection.expectedVersion === snapshot.version;
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
        {snapshot?.availableActions.includes('review_gate') ? <button type="button" className={button}
          disabled={review.status === 'loading'} data-testid="artifact-inspector-review"
          onClick={() => setReviewNonce(value => value + 1)}>读取本阶段全部审核工件</button> : null}
      </div>
      {read.status === 'loading' ? <p role="status">正在读取工件…</p> : null}
      {read.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{read.error}</p>}
      {result?.status === 'stale' ? <p role="alert" className="text-[var(--st-warn)]">
        工件或来源已变更。当前内容需要重新核对。
      </p> : null}
      {reviewNonce > 0 && review.status === 'loading' ? <p role="status">正在读取整个阶段的审核上下文…</p> : null}
      {review.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{review.error}</p>}
      {review.data === null ? null : <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-inspector-gate-context">
        <h2 className="font-medium">本阶段全部待核对工件</h2>
        <ul className="flex flex-col gap-1">
          {review.data.artifactLinks.map(link => <li className="break-words" key={link.artifactId}>{link.title}
            <span className="ml-2 break-all font-mono text-muted text-[var(--font-meta-size)]">{link.expectedVersion}</span>
          </li>)}
        </ul>
        <p className="text-muted">重读时间 {review.data.readAt}。返回后核对全部内容，再提交人工决定。</p>
        {matchesDisplayedSnapshot ? null : <p role="alert" className="text-[var(--st-warn)]">
          审核版本与当前显示的工件快照不同。请刷新工件，核对新内容后再返回助手。
        </p>}
        <button type="button" disabled={!matchesDisplayedSnapshot || read.status !== 'ready' || review.status !== 'ready'}
          className={`${button} self-start disabled:cursor-not-allowed disabled:opacity-50`} data-testid="artifact-inspector-return-review" onClick={() => {
          onReviewContext(review.data!);
          onClose();
        }}>返回助手重新确认</button>
      </section>}
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
