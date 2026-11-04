import {lazy, Suspense, useState} from 'react';
import type {ResearchDocument, ResearchDocumentParse} from '../../shared/types';
import type {ResearchReviewProtocolInspection} from '../../shared/schemas/research-systematic-review';
import type {ResearchReviewFullTextFrozenPhase} from '../../shared/schemas/research-review-fulltext-screening';
import type {RocClient} from '../shared/roc-client';
import type {IpcLikeResult} from '../app/loaded-state';
import {useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';
import {documentContentHash} from '../literature/document-content-hash';
import {ReviewFullTextDecision} from './ReviewFullTextDecision';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
const PaperPdfView = lazy(() => import('../literature/PaperPdfView'));
type LoadedSource = {document: ResearchDocument; parsed: ResearchDocumentParse | null};
export function ReviewFullTextEligibility({client, protocol, phase, item, writable, onPending, onSaved}: {
  client: RocClient; protocol: ResearchReviewProtocolInspection; phase: ResearchReviewFullTextFrozenPhase;
  item: ResearchReviewFullTextFrozenPhase['items'][number]; writable: boolean;
  onPending: (pending: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const binding = item.binding, source = binding?.snapshot.source ?? null;
  const {projectId, corpusId} = phase.plan.snapshot.request;
  const read = useAsyncResource(source === null ? null : `review:full-source:${projectId}:${corpusId}:${binding!.snapshotHash}`,
    async (): Promise<IpcLikeResult<LoadedSource>> => {
      if (source === null) throw new Error('research_review_fulltext_retrieved_source_required');
      const documentRequest = client.api.research.getDocument({documentId: source.documentId});
      const contentRequest = source.parse === null ? null : client.api.research.getDocumentContent({projectId,
        documentId: source.documentId, sourceHash: source.sourceHash, parseId: source.parse.id, parseHash: source.parse.hash});
      const [documentResult, contentResult] = await Promise.all([documentRequest, contentRequest]);
      if (!documentResult.ok) return documentResult;
      if (documentResult.data.id !== source.documentId || documentResult.data.sourceHash !== source.sourceHash) {
        throw new Error('保存的全文来源与文档身份不一致。');
      }
      if (source.parse === null) return {ok: true, data: {document: documentResult.data, parsed: null}};
      if (contentResult === null) throw new Error('research_review_fulltext_content_required');
      if (!contentResult.ok) return contentResult;
      const parsed = contentResult.data;
      if (parsed.run.id !== source.parse.id || parsed.run.documentId !== source.documentId ||
          parsed.content.sourceHash !== source.sourceHash || await documentContentHash(parsed.content) !== source.parse.hash) {
        throw new Error('保存的全文解析版本与返回内容不一致。');
      }
      return {ok: true, data: {document: documentResult.data, parsed}};
    }, {label: '读取准确全文来源'});
  const loaded = read.status === 'ready' ? read.data : null;
  const [reviewerId, setReviewerId] = useState(''), [pending, setPending] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false), [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<{blockId: string; locationIndex: number} | null>(null);
  const parent = item.decisions.find(decision => decision.snapshot.request.reviewerId === reviewerId) ?? null;
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-full-eligibility">
    <h3 className="font-medium">全文资格筛选</h3>
    {source === null ? <p className="text-muted">尚未取得并绑定原始全文。</p> : <>
      <p className="break-words">{source.filename}</p>
      {read.status !== 'loading' ? null : <p role="status">正在读取保存版本的全文…</p>}
      {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{read.error}</p>}
      <button type="button" className={`${button} self-start`} disabled={pending || read.status === 'loading'}
        data-testid="artifact-review-full-source-refresh" onClick={read.reload}>重读保存的全文版本</button>
      {loaded === null ? null : <>
        {loaded.parsed === null ? <p className="text-muted">此绑定仅固定原文件，未固定解析文本。</p> : <>
          <h4 className="font-medium">保存版本的解析文本</h4>
          <ol start={offset + 1} className="flex flex-col gap-2">{loaded.parsed.content.blocks.slice(offset, offset + 20).map(block =>
            <li key={block.id} className="flex flex-col gap-1" data-testid="artifact-review-full-source-block">
              <p className="text-muted break-words">{block.label} {block.locator}</p>
              <p tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{block.text}</p>
            </li>)}</ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={pending || offset === 0} onClick={() => setOffset(offset - 20)}>上一页解析块</button>
            <span className="text-muted">第 {Math.floor(offset / 20) + 1} 页</span>
            <button type="button" className={button} disabled={pending || offset + 20 >= loaded.parsed!.content.blocks.length}
              onClick={() => setOffset(offset + 20)}>下一页解析块</button>
            {loaded.document.mediaType !== 'application/pdf' ? null : <button type="button" className={button} disabled={pending}
              aria-expanded={pdfOpen} data-testid="artifact-review-full-pdf-toggle" onClick={() => setPdfOpen(!pdfOpen)}>核对原始 PDF</button>}
          </div>
          {!pdfOpen ? null : <div className="h-[480px] min-h-0 min-w-0 border-[0.5px] border-line">
            <Suspense fallback={<p role="status">正在加载原始 PDF 阅读器…</p>}>
              <PaperPdfView client={client} projectId={projectId} document={loaded.document} parsed={loaded.parsed}
                selection={selection} onSelectBlock={setSelection} canAnnotate={false} />
            </Suspense>
          </div>}
        </>}
        <label className="flex flex-col gap-1 text-muted">全文资格审核人
          <select aria-label="全文资格审核人" className={`${formInputClass} border-[0.5px]`} disabled={pending} value={reviewerId}
            onChange={event => setReviewerId(event.target.value)}>
            <option value="">选择已声明全文审核人</option>
            {phase.plan.snapshot.request.fullTextReviewers.map(reviewer => <option key={reviewer.id} value={reviewer.id}>
              {reviewer.name} {reviewer.id}</option>)}
          </select>
        </label>
        {reviewerId === '' || binding === null ? null : <ReviewFullTextDecision
          key={`full-decision:${binding.snapshotHash}:${reviewerId}:${parent?.snapshotHash ?? 'new'}`}
          client={client} protocol={protocol} plan={phase.plan} titleFreezeHash={phase.titleFreezeHash} binding={binding}
          hitId={item.hit.id} reviewerId={reviewerId} parent={parent} writable={writable && binding.referenceStatus === 'current'}
          onPending={value => {setPending(value); onPending(value);}} onSaved={onSaved} />}
      </>}
    </>}
  </section>;
}
