import {useRef, useState} from 'react';
import type {ResearchReviewFullTextBindingInspection, ResearchReviewFullTextBindingSave} from '../../shared/schemas/research-review-fulltext';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ArtifactDraftDiscard, useArtifactDraft} from './artifact-editor-guard';

const input = `${formInputClass} border-[0.5px]`, button = `${formSecondaryButtonClass} border-[0.5px]`;
type Selection = Extract<ResearchReviewFullTextBindingSave['outcome'], {kind: 'retrieved'}>['selection'];
export function ReviewFullTextBinding({client, projectId, corpusId, hitId, titleFreezeHash, parent, writable, onPending, onSaved}: {
  client: RocClient; projectId: string; corpusId: string; hitId: string; titleFreezeHash: string;
  parent: ResearchReviewFullTextBindingInspection | null; writable: boolean;
  onPending: (pending: boolean) => void; onSaved: () => void
}): React.JSX.Element {
  const raw = useAsyncResource(`review:fulltext-raw:${projectId}:${corpusId}:${hitId}`,
    () => client.api.research.getReviewCorpusHit({projectId, corpusId, hitId}), {label: '读取全文对应原始命中'});
  const history = useAsyncResource(`review:fulltext-history:${projectId}:${corpusId}:${hitId}:${parent?.snapshotHash ?? 'new'}`,
    () => client.api.research.getReviewFullTextBindingHistory({projectId, corpusId, hitId}), {label: '读取全文获取历史'});
  const [editing, setEditing] = useState(parent === null);
  const [kind, setKind] = useState<ResearchReviewFullTextBindingSave['outcome']['kind'] | ''>(parent?.snapshot.request.outcome.kind ?? '');
  const [reason, setReason] = useState(parent?.snapshot.request.outcome.kind === 'not_retrieved' ? parent.snapshot.request.outcome.reason : '');
  const [relationNote, setRelationNote] = useState(parent?.snapshot.request.outcome.kind === 'retrieved' ? parent.snapshot.request.outcome.relationNote : '');
  const [revisionReason, setRevisionReason] = useState('');
  const [query, setQuery] = useState(''), [queryInput, setQueryInput] = useState('');
  const [libraryId, setLibraryId] = useState(''), [documentId, setDocumentId] = useState('');
  const [parseMode, setParseMode] = useState<'original' | 'current' | ''>('');
  const save = useAsyncAction((request: ResearchReviewFullTextBindingSave) => client.api.research.saveReviewFullTextBinding(request),
    {label: '保存人工全文获取与来源绑定'});
  const choosing = writable && editing && kind === 'retrieved';
  const library = useAsyncResource(choosing ? `review:fulltext-library:${projectId}:${query}` : null,
    () => client.api.research.listLibrary({projectId, query, includeArchived: false, limit: 500}), {label: '读取已有项目文献'});
  const documents = useAsyncResource(!choosing || libraryId === '' ? null : `review:fulltext-documents:${projectId}:${libraryId}`,
    () => client.api.research.listDocuments({libraryItemId: libraryId}), {label: '读取已有文献原文件'});
  const document = library.status === 'ready' && library.data!.some(item => item.id === libraryId) && documents.status === 'ready' ?
    documents.data!.find(item => item.id === documentId) : undefined;
  const preview = useAsyncResource(document === undefined || parseMode !== 'current' || document.currentParseId === null ? null :
    `review:fulltext-preview:${projectId}:${document.id}:${document.sourceHash}:${document.currentParseId}`, async () => {
      if (document === undefined || document.currentParseId === null) throw new Error('research_review_fulltext_current_parse_required');
      const result = await client.api.research.previewDocument({projectId, documentId: document.id, sourceHash: document.sourceHash,
        parseId: document.currentParseId, parseHash: null});
      if (result.ok && (result.data.documentId !== document.id || result.data.sourceHash !== document.sourceHash ||
        result.data.parseId !== document.currentParseId)) throw new Error('所选原文预览与文档版本不一致。');
      return result;
    }, {label: '读取准确原文解析版本'});
  const selection: Selection | null = document === undefined ? null : parseMode === 'original' ?
    {documentId: document.id, sourceHash: document.sourceHash, parseId: null, parseHash: null} :
    parseMode === 'current' && preview.status === 'ready' ? {documentId: document.id, sourceHash: document.sourceHash,
      parseId: preview.data!.parseId, parseHash: preview.data!.parseHash} : null;
  const busy = useRef(false), requests = useRef(new Map<string, string>());
  const draft = useArtifactDraft('全文获取与来源绑定', {kind, reason, relationNote, revisionReason, libraryId, documentId, parseMode}, busy);
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2" data-testid="artifact-review-fulltext-binding">
    <h3 className="font-medium">全文获取与原始命中关联</h3>
    {raw.status !== 'loading' ? null : <p role="status">正在读取准确原始命中…</p>}
    {raw.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{raw.error}</p>}
    {raw.status !== 'ready' ? null : <>
      <p className="font-medium break-words">{raw.data!.record.record.title}</p>
      <p className="text-muted break-words">{raw.data!.record.record.doi ?? 'DOI 未提供'}</p>
      <p className="break-words">{raw.data!.record.record.abstract ?? '摘要未提供'}</p>
      <details><summary className="cursor-pointer text-muted">固定原始命中与完整元数据</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(raw.data, null, 2)}</pre>
      </details>
    </>}
    {parent === null ? null : <section className="flex flex-col gap-1" data-testid="artifact-review-fulltext-binding-current">
      <h4 className="font-medium">全文 {parent.snapshot.request.outcome.kind === 'retrieved' ? '已获取' : '未获取'} 版本 {parent.snapshot.version}</h4>
      <p className="text-muted">{parent.referenceStatus === 'superseded' ? '所选来源已变化' : parent.referenceStatus === 'current' ? '当前来源引用' : '未获取全文'}</p>
      <p className="break-words">{parent.snapshot.request.outcome.kind === 'retrieved' ? parent.snapshot.request.outcome.relationNote : parent.snapshot.request.outcome.reason}</p>
      {parent.snapshot.source === null ? null : <p className="break-words">{parent.snapshot.source.filename}
        {' '}{parent.snapshot.source.parse === null ? '仅原文件' : `解析 ${parent.snapshot.source.parse.id}`}</p>}
      <p className="text-muted break-all">记录人 {parent.snapshot.actor.id} {parent.snapshot.recordedAt}</p>
      <details><summary className="cursor-pointer text-muted">保存的来源与版本</summary>
        <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[length:var(--font-meta-size)] font-mono">{JSON.stringify(parent.snapshot, null, 2)}</pre>
      </details>
      {!writable || editing ? null : <button type="button" className={`${button} self-start`}
        disabled={draft.locked} data-testid="artifact-review-fulltext-binding-revise" onClick={() => {if (!draft.isLocked()) setEditing(true);}}>修订全文获取与来源</button>}
    </section>}
    {!writable || !editing ? null : <form className="flex flex-col gap-2" data-testid="artifact-review-fulltext-binding-form" onSubmit={event => {
      event.preventDefault();
      if (busy.current || draft.isLocked() || !writable || raw.status !== 'ready' || kind === '' || (kind === 'retrieved' && selection === null)) return;
      const outcome: ResearchReviewFullTextBindingSave['outcome'] = kind === 'not_retrieved' ?
        {kind, reason} : {kind, selection: selection!, relationNote};
      const body = {projectId, corpusId, hitId, expectedTitleFreezeHash: titleFreezeHash, outcome,
        parentBindingId: parent === null ? null : parent.snapshot.id, expectedParentHash: parent === null ? null : parent.snapshotHash,
        revisionReason: parent === null ? null : revisionReason};
      const signature = JSON.stringify(body);
      let requestId = requests.current.get(signature);
      if (requestId === undefined) {requestId = crypto.randomUUID(); requests.current.set(signature, requestId);}
      busy.current = true; onPending(true);
      void save.run({...body, requestId}).then(result => {
        busy.current = false; onPending(false); if (result.ok) {draft.saved(); onSaved();}
      });
    }}>
      <fieldset disabled={save.pending || draft.locked || raw.status !== 'ready'} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-muted">全文获取状态
          <select required aria-label="全文获取状态" className={input} value={kind}
            onChange={event => {setKind(event.target.value as typeof kind); save.reset();}}>
            <option value="">选择人工获取状态</option><option value="retrieved">已获取并选择来源</option><option value="not_retrieved">未获取全文</option>
          </select>
        </label>
        {kind !== 'not_retrieved' ? null : <label className="flex flex-col gap-1 text-muted">未获取全文原因
          <textarea required aria-label="未获取全文原因" maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
            value={reason} onChange={event => {setReason(event.target.value); save.reset();}} />
        </label>}
        {kind !== 'retrieved' ? null : <>
          <label className="flex flex-col gap-1 text-muted">查找已有项目文献
            <input aria-label="查找已有项目文献" maxLength={1000} className={input} value={queryInput} onChange={event => setQueryInput(event.target.value)} />
          </label>
          <button type="button" className={`${button} self-start`} onClick={() => {setQuery(queryInput); setLibraryId(''); setDocumentId(''); setParseMode(''); library.reload();}}>查找文献</button>
          <p className="text-muted">显示最多500条匹配文献</p>
          {library.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{library.error}</p>}
          <label className="flex flex-col gap-1 text-muted">全文对应已有文献
            <select required aria-label="全文对应已有文献" className={input} disabled={library.status !== 'ready'} value={libraryId}
              onChange={event => {setLibraryId(event.target.value); setDocumentId(''); setParseMode(''); save.reset();}}>
              <option value="">人工选择已有文献</option>
              {library.status !== 'ready' ? null : library.data!.map(item => <option key={item.id} value={item.id}>{item.metadata.title}</option>)}
            </select>
          </label>
          {documents.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{documents.error}</p>}
          <label className="flex flex-col gap-1 text-muted">全文原文件
            <select required aria-label="全文原文件" className={input} disabled={documents.status !== 'ready'} value={documentId}
              onChange={event => {setDocumentId(event.target.value); setParseMode(''); save.reset();}}>
              <option value="">选择已有原文件</option>
              {documents.status !== 'ready' ? null : documents.data!.map(item => <option key={item.id} value={item.id}>{item.filename} {item.status}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-muted">全文绑定版本
            <select required aria-label="全文绑定版本" className={input} disabled={document === undefined} value={parseMode}
              onChange={event => {setParseMode(event.target.value as typeof parseMode); save.reset();}}>
              <option value="">明确选择绑定版本</option><option value="original">仅绑定原文件</option>
              {document?.currentParseId === null || document === undefined ? null : <option value="current">原文件与当前解析 {document.currentParseId}</option>}
            </select>
          </label>
          {preview.status !== 'loading' ? null : <p role="status">正在读取准确解析版本…</p>}
          {preview.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{preview.error}</p>}
          <label className="flex flex-col gap-1 text-muted">原文件与命中关联说明
            <textarea required aria-label="原文件与命中关联说明" maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
              value={relationNote} onChange={event => {setRelationNote(event.target.value); save.reset();}} />
          </label>
        </>}
        {parent === null ? null : <label className="flex flex-col gap-1 text-muted">全文绑定修订原因
          <textarea required aria-label="全文绑定修订原因" maxLength={10000} rows={3} className={`${input} h-auto resize-y py-1`}
            value={revisionReason} onChange={event => {setRevisionReason(event.target.value); save.reset();}} />
        </label>}
        <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px] self-start`}
          disabled={kind === '' || (kind === 'retrieved' && selection === null)}
          data-testid="artifact-review-fulltext-binding-save">保存人工全文获取与来源绑定</button>
      </fieldset>
      <ArtifactDraftDiscard dirty={draft.dirty} testId="artifact-review-fulltext-binding-discard" onDiscard={() => {
        const outcome = parent?.snapshot.request.outcome;
        const next = {kind: outcome?.kind ?? '' as typeof kind, reason: outcome?.kind === 'not_retrieved' ? outcome.reason : '',
          relationNote: outcome?.kind === 'retrieved' ? outcome.relationNote : '', revisionReason: '', libraryId: '', documentId: '', parseMode: '' as typeof parseMode};
        setKind(next.kind); setReason(next.reason); setRelationNote(next.relationNote); setRevisionReason('');
        setLibraryId(''); setDocumentId(''); setParseMode(''); setEditing(parent === null); save.reset(); draft.reset(next);
      }} />
    </form>}
    {save.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{save.error}</p>}
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)] break-words">{history.error}</p>}
    {history.status !== 'ready' ? null : <details data-testid="artifact-review-fulltext-binding-history">
      <summary className="cursor-pointer text-muted">全文获取与来源历史 {history.data!.length} 版</summary>
      <ul className="mt-2 flex flex-col gap-2">{history.data!.map(item => <li key={item.snapshot.id} className="text-muted break-words">
        版本 {item.snapshot.version} {item.snapshot.request.outcome.kind === 'retrieved' ? '已获取' : '未获取'}
        <p>{item.snapshot.request.outcome.kind === 'retrieved' ? item.snapshot.request.outcome.relationNote : item.snapshot.request.outcome.reason}</p>
        <p>{item.snapshot.request.revisionReason}</p><p>记录人 {item.snapshot.actor.id} {item.snapshot.recordedAt}</p>
      </li>)}</ul>
    </details>}
  </section>;
}
