import {useEffect, useRef, useState} from 'react';
import type {ResearchCitationCoverageBody} from '../../shared/schemas/research-citation-coverage';
import {researchCitationReviewSaveSchema, type ResearchCitationReviewSave} from '../../shared/schemas/research-citation-reviews';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {CitationReviewReceipt, directnessLabels} from './CitationReviewReceipt';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const pageSize = 10;

export function CitationReviewEditor({client, report, reportHash, claimId, evidenceId, writable, onDirty, onPending, onSaved}: {
  client: RocClient; report: ResearchCitationCoverageBody; reportHash: string;
  claimId: string; evidenceId: string; writable: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const paragraph = report.paragraphs.find(item => item.claim.id === claimId)!;
  const citation = paragraph.citations.find(item => item.evidenceId === evidenceId)!;
  const source = report.sources.find(item => item.source.evidence.id === evidenceId)!;
  const [directness, setDirectness] = useState<ResearchCitationReviewSave['directness'] | ''>('');
  const [rationale, setRationale] = useState('');
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<string[]>([]);
  const [offset, setOffset] = useState<number | null>(null);
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const save = useAsyncAction((request: ResearchCitationReviewSave) => client.api.research.saveCitationReview(request),
    {label: '保存引用直接性审核'});
  const history = useAsyncResource(offset === null ? null : `citation:history:${report.projectId}:${report.artifactId}:${claimId}:${evidenceId}:${offset}`,
    () => client.api.research.getCitationReviewHistory({
      projectId: report.projectId, artifactId: report.artifactId, claimId, evidenceId, offset: offset!, limit: pageSize
    }), {label: '读取引用审核历史'});
  const change = (): void => {
    requestId.current = crypto.randomUUID(); setDirty(true); onDirty(true); setValidation([]); save.reset();
  };
  const locked = dirty || save.pending;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2"
    aria-label="人工引用直接性审核" data-testid="artifact-citation-review-editor">
    <h3 className="font-medium">人工引用直接性审核</h3>
    <p className="whitespace-pre-wrap break-words">{paragraph.claim.content}</p>
    <p className="whitespace-pre-wrap break-words text-muted">来源原文：{source.source.evidence.excerpt}</p>
    <p className="break-all text-muted">证据 {evidenceId}</p>
    {citation.directnessReview === null ? <p className="text-muted">尚无保存的直接性审核。</p> : <>
      <p className={citation.directnessReview.current ? 'text-muted' : 'text-[var(--st-warn)]'}>
        {citation.directnessReview.current ? '当前主张与来源版本的人工判断' : '保存判断已过期，请核对当前主张与来源。'}
      </p>
      <CitationReviewReceipt receipt={citation.directnessReview.receipt}/>
    </>}
    <form className="flex min-w-0 flex-col gap-3" onSubmit={event => {
      event.preventDefault();
      if (!writable || busy.current) return;
      const parent = citation.directnessReview?.receipt;
      const parsed = researchCitationReviewSaveSchema.safeParse({
        projectId: report.projectId, artifactId: report.artifactId, claimId, evidenceId, requestId: requestId.current,
        expectedReportHash: reportHash, parent: parent === undefined ? null : {reviewId: parent.snapshot.id, reviewHash: parent.snapshotHash},
        directness, rationale
      });
      if (!parsed.success) {setValidation(['请选择直接性并填写审核理由。']); return;}
      busy.current = true; onPending(true);
      void save.run(parsed.data).then(reply => {
        busy.current = false;
        if (!mounted.current) return;
        onPending(false);
        if (reply.ok) {setDirty(false); onDirty(false); onSaved();}
      });
    }}>
      <fieldset disabled={!writable || save.pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-muted">引用直接性
          <select required aria-label="引用直接性" className={`${formInputClass} border-[0.5px]`} value={directness}
            onChange={event => {setDirectness(event.target.value as typeof directness); change();}}>
            <option value="">请选择人工判断</option>
            {Object.entries(directnessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-muted">审核理由
          <textarea required maxLength={12000} aria-label="引用直接性审核理由" rows={4}
            className={`${formInputClass} resize-y border-[0.5px]`} value={rationale}
            onChange={event => {setRationale(event.target.value); change();}}/>
        </label>
        <button type="submit" className={`${formPrimaryButtonClass} self-start`} data-testid="artifact-citation-review-save">
          保存直接性审核
        </button>
        <button type="button" className={`${button} self-start`} disabled={!dirty} data-testid="artifact-citation-review-discard"
          onClick={() => {setDirectness(''); setRationale(''); setDirty(false); onDirty(false);
            requestId.current = crypto.randomUUID(); setValidation([]); save.reset();}}>放弃审核修改</button>
      </fieldset>
      {save.pending ? <p role="status">正在保存引用审核，请等待回执。</p> : null}
      {validation.map(message => <p role="alert" key={message} className="text-[var(--st-warn)]">{message}</p>)}
      {save.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{save.error}</p>}
    </form>
    <button type="button" className={`${button} self-start`} disabled={locked || history.status === 'loading'}
      data-testid="artifact-citation-review-history-open" onClick={() => {if (offset === 0) history.reload(); else setOffset(0);}}>
      读取引用审核历史
    </button>
    {history.status === 'loading' ? <p role="status">正在读取保存的审核历史…</p> : null}
    {history.error === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null || offset === null ? null : <section className="flex min-w-0 flex-col gap-3"
      data-testid="artifact-citation-review-history">
      <p className="text-muted">保存回执，共 {history.data.total} 版。历史来源未按当前版本复核。</p>
      {history.data.items.map(receipt => <CitationReviewReceipt key={receipt.snapshot.id} receipt={receipt}/>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={locked || offset === 0}
          data-testid="artifact-citation-review-history-prev" onClick={() => setOffset(offset - pageSize)}>上一页审核</button>
        <button type="button" className={button} disabled={locked || offset + pageSize >= history.data.total}
          data-testid="artifact-citation-review-history-next" onClick={() => setOffset(offset + pageSize)}>下一页审核</button>
      </div>
    </section>}
  </section>;
}
