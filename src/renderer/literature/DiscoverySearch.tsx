import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { LiteratureImportResult, LiteratureSearchResult, LiteratureSearchProgress } from '../../shared/schemas/literature-import';
import { formButtonClass, formInputClass, formPrimaryButtonClass } from '../shared/form-ui';
import { useImeGuard } from '../shared/hooks/use-ime-guard';
import { EmptyState } from '../shell/EmptyState';
import { LiteratureCandidateReview } from './LiteratureCandidateReview';
import type { LiteratureSearchSource } from './library-store';
import type { LiteratureStore } from './use-literature-store';
import type { LiteratureImportActions } from './use-literature-import-actions';
import {DiscoveryCandidatePreview} from './DiscoveryCandidatePreview';
import {useViewSelected} from '../shared/view-activity';
import {ReadingViewBoundary} from './ReadingViewBoundary';
import './discovery-search.css';

const SOURCES: { id: LiteratureSearchSource; label: string }[] = [
  { id: 'openalex', label: 'OpenAlex' }, { id: 'crossref', label: 'Crossref' },
  { id: 'semantic_scholar', label: 'Semantic Scholar' }, { id: 'arxiv', label: 'arXiv' },
  { id: 'pubmed', label: 'PubMed' }, { id: 'europe_pmc', label: 'Europe PMC' },
  { id: 'openreview', label: 'OpenReview' }, { id: 'dblp', label: 'DBLP' }
];
const SOURCE_STATUS: Record<LiteratureSearchResult['sources'][number]['status'], string> = {
  ok: '已返回', empty: '无结果', partial: '部分结果', timeout: '超时', rate_limited: '请求受限', error: '失败'
};
const DISPOSITION: Record<LiteratureImportResult['items'][number]['disposition'], string> = {
  created: '已收录', linked: '已关联', already_present: '已在文献库', skipped_archived: '已归档，未加入',
  failed: '添加失败', cancelled: '已取消', not_processed: '尚未处理'
};

type Props = {
  store: LiteratureStore; actions: LiteratureImportActions; writable: boolean; onOpenLibrary: () => void;
};

export default function DiscoverySearch(props: Props): React.JSX.Element {
  return <DiscoverySearchScope key={props.store.projectId ?? 'global'} {...props}/>;
}

function DiscoverySearchScope({store, actions, writable, onOpenLibrary}: Props): React.JSX.Element {
  const viewSelected = useViewSelected();
  const readingRoot = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [years, setYears] = useState<0 | 2 | 5>(0);
  const [sources, setSources] = useState<LiteratureSearchSource[]>(SOURCES.slice(0, 6).map(source => source.id));
  const [resultQuery, setResultQuery] = useState('');
  const [result, setResult] = useState<LiteratureSearchResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewCandidate = result?.candidates.find(candidate => candidate.candidateId === previewId) ?? result?.candidates[0] ?? null;
  const resultList = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<'search' | 'more' | 'add' | null>(null);
  const [progress, setProgress] = useState<LiteratureSearchProgress[]>([]);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const operationInFlight = useRef(false);
  const [addingIds, setAddingIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ result: LiteratureImportResult; titles: string[] } | null>(null);
  const receiptRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (viewSelected && receipt !== null) {receiptRef.current?.focus(); receiptRef.current?.scrollIntoView({block: 'nearest'});}
  }, [receipt]);
  useEffect(() => {
    if (error === null) return;
    setPreviewOpen(false);
    if (!viewSelected) return;
    const frame = requestAnimationFrame(() => {errorRef.current?.focus(); errorRef.current?.scrollIntoView({block: 'nearest'});});
    return () => cancelAnimationFrame(frame);
  }, [error]);
  const ime = useImeGuard();
  const inLibrary = (candidate: LiteratureSearchResult['candidates'][number]): boolean => added.has(candidate.candidateId) ||
    (candidate.matchedLibraryItemId !== null && store.items.some(item => item.id === candidate.matchedLibraryItemId));
  const selectable = result?.candidates.filter(candidate => !candidate.archived && !inLibrary(candidate)) ?? [];
  const batch = selectable.slice(0, 30);

  const search = async (): Promise<void> => {
    if (operationInFlight.current || query.trim() === '' || sources.length === 0) return;
    operationInFlight.current = true;
    setPending('search'); setError(null); setReceipt(null); setProgress([]);
    try {
      const year = new Date().getFullYear();
      const response = await actions.searchLiterature(query.trim(), sources, 30,
        years === 0 ? undefined : { yearFrom: year - years + 1, yearTo: year },
        {paginated: true, onProgress: event => {
          if (mounted.current) setProgress(current => [...current.filter(item => item.source.source !== event.source.source), event]);
        }});
      if (!mounted.current) return;
      if (!response.ok) { setError(response.message); return; }
      setResult(response.result); setResultQuery(query.trim()); setSelected(new Set()); setAdded(new Set());
      setPreviewId(response.result.candidates[0]?.candidateId ?? null); setPreviewOpen(false);
      resultList.current?.scrollTo({top: 0});
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operationInFlight.current = false; if (mounted.current) {setPending(null); setProgress([]);} }
  };

  const loadMore = async (): Promise<void> => {
    if (operationInFlight.current || result?.nextOffset == null) return;
    operationInFlight.current = true;
    const previous = result;
    setPending('more'); setError(null);
    try {
      const response = await actions.readSearch(previous.searchId, previous.nextOffset!, 30);
      if (!mounted.current) return;
      if (!response.ok) {setError(response.message); return;}
      const next = response.result;
      if (next.searchId !== previous.searchId || next.total !== previous.total ||
          next.nextOffset !== null && next.nextOffset <= previous.nextOffset!) throw new Error('检索分页未推进，请重新搜索。');
      const ids = new Set(previous.candidates.map(candidate => candidate.candidateId));
      if (next.candidates.some(candidate => ids.has(candidate.candidateId)) || next.candidates.length === 0) {
        throw new Error('检索分页内容不一致，请重新搜索。');
      }
      setResult({...next, candidates: [...previous.candidates, ...next.candidates]});
    } catch (cause) {if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));}
    finally {operationInFlight.current = false; if (mounted.current) setPending(null);}
  };
  const add = async (ids: string[]): Promise<void> => {
    if (operationInFlight.current || result === null || !writable || ids.length === 0 || ids.length > 30) return;
    operationInFlight.current = true;
    setPending('add'); setAddingIds(new Set(ids)); setError(null); setReceipt(null);
    try {
      const response = await actions.addCandidates(result.searchId, ids);
      if (!mounted.current) return;
      if (!response.ok) { setError(response.message); return; }
      const successful = response.result.items.filter(item =>
        item.disposition === 'created' || item.disposition === 'linked' || item.disposition === 'already_present')
        .flatMap(item => item.inputPositions.map(index => ids[index]!));
      setAdded(current => new Set([...current, ...successful]));
      setSelected(current => new Set([...current].filter(id => !successful.includes(id))));
      setReceipt({ result: response.result, titles: ids.map(id => result.candidates.find(candidate => candidate.candidateId === id)!.record.title) });
      setPreviewOpen(false);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operationInFlight.current = false; if (mounted.current) {setPending(null); setAddingIds(new Set());} }
  };

  return <ReadingViewBoundary selected={viewSelected} identity={result?.searchId} containerRef={readingRoot}
    scrollSelectors={['.discovery-result-list', '.discovery-preview-scroll']}>
  <section ref={readingRoot} className="discovery-search flex h-full min-h-0 flex-col" aria-label="学术搜索" data-testid="discovery-search">
    <form className="ui-scroll-region flex max-h-[48%] shrink-0 flex-col gap-3 border-b-[0.5px] border-line p-4" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label htmlFor="discovery-query" className="font-medium text-ink">研究主题或关键词</label>
      <div className="flex items-center gap-2">
        <input id="discovery-query" value={query} disabled={pending !== null} onChange={event => setQuery(event.target.value)} className={formInputClass}
          onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={event => { if (event.key === 'Enter' && ime.shouldIgnoreKeyDown(event)) event.preventDefault(); }} />
        <button type="submit" disabled={pending !== null || query.trim() === '' || sources.length === 0}
          className={selected.size > 0 ? formButtonClass : formPrimaryButtonClass} data-testid="discovery-submit" aria-busy={pending === 'search'}>
          {pending === 'search' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
          {pending === 'search' ? '搜索中' : '搜索'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="发表时间">
        {([0, 2, 5] as const).map(value => <button key={value} type="button" aria-pressed={years === value} disabled={pending !== null}
          onClick={() => setYears(value)} className={`${formButtonClass} aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink`}>
          {value === 0 ? '不限时间' : `近 ${value} 年`}
        </button>)}
      </div>
      <details>
        <summary className="min-h-7 cursor-pointer py-1 text-muted">检索来源（{sources.length} 个）</summary>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {SOURCES.map(source => <label key={source.id} className="flex min-h-6 items-center gap-2 text-muted">
            <input type="checkbox" checked={sources.includes(source.id)} disabled={pending !== null}
              onChange={event => setSources(current => event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))} />
            {source.label}
          </label>)}
        </div>
      </details>
    </form>

    {viewSelected ? <div className="discovery-result-workspace" data-preview-open={previewOpen}>
    <div ref={resultList} className="discovery-result-list" aria-busy={pending === 'search'}>
      {error === null ? null : <p ref={errorRef} tabIndex={-1} role="alert" className="mb-3 text-[var(--st-bad)]">{error}</p>}
      {pending !== 'search' ? null : <section className="mb-4 flex flex-col gap-2" aria-label="来源检索进度" data-testid="discovery-source-progress">
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-muted">{sources.map(source => {
          const completed = progress.find(item => item.source.source === source)?.source;
          return <li key={source}>{SOURCES.find(item => item.id === source)?.label ?? source}：
            {completed === undefined ? '等待结果' : SOURCE_STATUS[completed.status]}
            {completed !== undefined && completed.returnedCount > 0 ? ` ${completed.returnedCount} 篇` : ''}</li>;
        })}</ul>
        {progress.every(item => item.records.length === 0) ? null : <>
          <p className="text-muted">已返回原始记录，来源合并完成后可选择加入。</p>
          <ul>{progress.flatMap(item => item.records.map((record, index) => <li key={`${item.source.source}:${index}`}
            className="border-b-[0.5px] border-line py-2 break-words">{record.title}</li>)).slice(0, 30)}</ul>
        </>}
      </section>}
      {result === null ? <EmptyState compact tone={pending === 'search' ? 'loading' : 'empty'}
        icon={pending === 'search' ? Loader2 : Search} title={pending === 'search' ? '正在检索论文…' : '搜索论文后选择加入项目'} /> : <>
        <div role="status" className="flex flex-col gap-2" data-testid="discovery-source-report">
          <h3 className="break-words font-medium text-ink">{resultQuery}</h3>
          <p className="tabular-nums text-ink">{result.status === 'failed' ? '各来源均未完成检索' : result.status === 'partial' ? '部分来源未完成，已保留可用结果' : '检索已返回'}，{result.total.toLocaleString('zh-CN')} 篇候选</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-muted">
            {result.sources.map(source => <li key={source.source}>
              {SOURCES.find(entry => entry.id === source.source)?.label ?? source.source}：{SOURCE_STATUS[source.status]}
              {source.returnedCount > 0 ? ` ${source.returnedCount.toLocaleString('zh-CN')} 篇` : ''}
              {source.retryAfterMs === null ? '' : `，${Math.ceil(source.retryAfterMs / 1000)} 秒后可重试`}
              {source.errorCode === null ? '' : `（${source.errorCode}）`}
            </li>)}
          </ul>
          {result.warnings.length === 0 ? null : <details data-reading-detail="search-warnings" className="text-muted"><summary>检索说明</summary>
            <ul className="mt-2 space-y-2">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </details>}
          {result.truncated ? <p className="text-muted">候选仅覆盖本次已请求的来源页面，可缩小主题或时间范围继续检索。</p> : null}
        </div>
        {result.candidates.length === 0 ? <EmptyState compact title="没有匹配的文献" action={{ label: '修改查询', onClick: () => document.getElementById('discovery-query')?.focus() }} /> : <>
          <div className="mt-4 flex items-center justify-between gap-2 border-b-[0.5px] border-line py-2">
            <label className="flex min-h-6 items-center gap-2 text-muted">
              <input type="checkbox" checked={batch.length > 0 && batch.every(candidate => selected.has(candidate.candidateId))}
                disabled={!writable || pending !== null || batch.length === 0}
                onChange={event => setSelected(event.target.checked ? new Set(batch.map(candidate => candidate.candidateId)) : new Set())} />
              选择可添加文献
            </label>
            <span className="tabular-nums text-muted">已选 {selected.size} 篇{selectable.length > 30 ? '，每次最多 30 篇' : ''}</span>
          </div>
          <ul>{result.candidates.map(candidate => <LiteratureCandidateReview key={candidate.candidateId} candidate={candidate}
            compact active={candidate.candidateId === previewCandidate?.candidateId}
            onPreview={() => {setPreviewId(candidate.candidateId); setPreviewOpen(true);}}
            inLibrary={inLibrary(candidate)} adding={addingIds.has(candidate.candidateId)} selected={selected.has(candidate.candidateId)} pending={pending !== null || !writable}
            onSelectionChange={checked => setSelected(current => {
              const next = new Set(current); if (checked && next.size < 30) next.add(candidate.candidateId); else if (!checked) next.delete(candidate.candidateId); return next;
            })} onAdd={() => void add([candidate.candidateId])} />)}</ul>
          {result.nextOffset == null ? null : <button type="button" className={`${formButtonClass} my-3`} data-testid="discovery-load-more"
            disabled={pending !== null} aria-busy={pending === 'more'} onClick={() => void loadMore()}>
            {pending === 'more' ? '正在加载…' : `加载更多（${result.candidates.length} / ${result.total}）`}
          </button>}
        </>}
      </>}
      {receipt === null ? null : <section ref={receiptRef} tabIndex={-1} aria-label="添加结果" data-testid="discovery-receipt" className="mt-4 border-t-[0.5px] border-line pt-4">
        <p role="status" className="tabular-nums">已收录 {receipt.result.counts.created + receipt.result.counts.linked} 篇，重复 {receipt.result.counts.alreadyPresent} 篇，
          需处理 {receipt.result.counts.skippedArchived + receipt.result.counts.cancelled + receipt.result.counts.notProcessed} 篇，失败 {receipt.result.counts.failed} 篇</p>
        <p className="mt-2 text-muted">全文、解析与索引进度见文献库。</p>
        <ul className="mt-2 space-y-2">{receipt.result.items.map(item => <li key={item.entryKey} className="text-muted">
          {item.inputPositions.map(index => receipt.titles[index]).join('、')}：{DISPOSITION[item.disposition]}{item.errorCode === null ? '' : `（${item.errorCode}）`}
        </li>)}</ul>
        <button type="button" className={`${formButtonClass} mt-3`} onClick={onOpenLibrary}>查看文献库</button>
      </section>}
      {!writable ? <p role="note" className="mt-3 text-muted">项目已归档，可搜索和查看，恢复项目后可添加文献。</p> : null}
    </div>
    {previewCandidate ? <DiscoveryCandidatePreview key={previewCandidate.candidateId} candidate={previewCandidate} revealed={previewOpen}
      pending={pending !== null || !writable} adding={addingIds.has(previewCandidate.candidateId)} inLibrary={inLibrary(previewCandidate)}
      onAdd={() => void add([previewCandidate.candidateId])}
      onBack={() => {setPreviewOpen(false); requestAnimationFrame(() => {
        resultList.current?.querySelector<HTMLButtonElement>(`[data-testid="discovery-preview-${CSS.escape(previewCandidate.candidateId)}"]`)?.focus({preventScroll: true});
      });}}/> : null}
    </div> : null}
    {selected.size === 0 ? null : <div className="flex shrink-0 items-center justify-end gap-2 border-t-[0.5px] border-line p-3">
      <button type="button" className={formPrimaryButtonClass} disabled={pending !== null || !writable} aria-busy={pending === 'add'}
        data-testid="discovery-add-selected" onClick={() => void add([...selected])}>
        {pending === 'add' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {pending === 'add' ? '添加中' : `加入文献库（${selected.size} 篇）`}
      </button>
    </div>}
  </section></ReadingViewBoundary>;
}
