import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryVirtualizedRowsHandle } from './LibraryVirtualizedRows';
import { AlertCircle, Archive, BookOpen, Check, Copy, FilePlus2, ListChecks, Loader2, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import type { ResearchLibraryItem } from '../../shared/types';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatAuthorList, formatYear, libraryItemTitle, readVenue } from './format';
import { useLiterature } from './literature-scope';
import { useCopyFeedback } from '../shared/hooks/use-copy-feedback';
import {useAsyncAction} from '../app/use-async-resource';
import {ActionButton, formSecondaryButtonClass, formSelectClass} from '../shared/form-ui';
import {ActionStatus} from '../shared/action-status';
import {LazyBoundary, retryableLazy} from '../shell/LazyBoundary';
import './library-list.css';
import type {LiteratureStore} from './use-literature-store';

/**
 * The library list (P5/T5.1–T5.2), rendered by **both** the sidebar's 文献 tab and
 * the canvas hub — they read the same store, so an import in one place is visible
 * in the other without a refresh convention.
 *
 * Search goes to the backend (`library.list` takes `query`), so this component
 * debounces the *store's* query rather than filtering an array: a client-side
 * filter could only ever search the page that was fetched, which silently makes
 * matches beyond `limit` unreachable.
 *
 * A row shows only what the record actually has: an absent year, citation count or
 * venue is rendered as absent, never as a plausible-looking default.
 *
 * Citation keys remain searchable and available through the copy action. The first
 * row surface prioritizes title, authors and availability. The list contract has
 * no index status: only the selected item's loaded documents can verify full text.
 */

export type LibraryListProps = {
  /** Tight rows/spacing for the 256px sidebar. */
  compact?: boolean;
  /** Bibliography category selected in the context drawer. */
  entryType?: string | null;
  /** Owns guarded selection and any navigation; without it the list selects directly. */
  onOpenItem?: (id: string) => void;
  onRequestImport: () => void;
};

type SortOrder = 'updated' | 'year' | 'title';

const VIRTUALIZE_THRESHOLD = 60;
const LazyLibraryVirtualizedRows = retryableLazy(async () => {
  const module = await import('./LibraryVirtualizedRows');
  return {default: module.LibraryVirtualizedRows};
});

function fullTextLabel(item: ResearchLibraryItem, store: LiteratureStore): string {
  if (item.id !== store.selectedId || store.documentsStatus !== 'ready') return '全文待核验';
  const documents = store.documents.filter(document => document.libraryItemId === item.id);
  if (documents.length === 0) return '全文未添加';
  if (documents.some(document => document.status === 'parsing')) return '全文解析中';
  if (documents.some(document => document.currentParseId !== null)) return '全文已解析';
  if (documents.some(document => document.status === 'failed')) return '全文解析失败';
  if (documents.some(document => document.status === 'cancelled')) return '全文解析已取消';
  return '全文已保存';
}

export function LibraryList({ compact = false, entryType = null, onOpenItem, onRequestImport }: LibraryListProps): React.JSX.Element {
  const literature = useLiterature();
  const [searchDraft, setSearchDraft] = useState(literature.query);
  const [sort, setSort] = useState<SortOrder>('updated');
  const [selecting, setSelecting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(literature.selectedId);
  const [visibleRange, setVisibleRange] = useState({startIndex: 0, endIndex: 0});
  const [virtualizerReady, setVirtualizerReady] = useState(false);
  const listBodyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const virtualizerRef = useRef<LibraryVirtualizedRowsHandle | null>(null);
  const pendingFocusId = useRef<string | null>(null);
  const lastScrolledSelection = useRef<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {setCheckedIds(new Set());}, [literature.projectId, literature.query, literature.includeArchived, entryType]);
  const items = useMemo(() => literature.items.filter(item => entryType === null || item.bibliography.entryType === entryType).sort((left, right) => sort === 'year'
    ? (right.metadata.publishedYear ?? 0) - (left.metadata.publishedYear ?? 0)
    : sort === 'title' ? libraryItemTitle(left).localeCompare(libraryItemTitle(right), 'zh-CN')
      : right.updatedAt.localeCompare(left.updatedAt)), [literature.items, entryType, sort]);
  const checkedItems = useMemo(() => checkedIds.size === 0 ? [] : items.filter(item => checkedIds.has(item.id)), [items, checkedIds]);
  const checkedItemsKey = useMemo(() => checkedItems.map(item => item.id).join(':'), [checkedItems]);

  // Keep the box in sync when something else changes the query (e.g. clearing it
  // from a view switch) without fighting the user's typing.
  useEffect(() => {
    setSearchDraft(literature.query);
  }, [literature.query]);
  useEffect(() => {
    setFocusedId(literature.selectedId);
  }, [literature.projectId, literature.selectedId]);

  const virtualize = items.length > VIRTUALIZE_THRESHOLD;
  const selectedIndex = useMemo(() => items.findIndex(item => item.id === literature.selectedId), [items, literature.selectedId]);
  const activeIndex = useMemo(() => {
    const focusedIndex = items.findIndex(item => item.id === focusedId);
    return focusedIndex < 0 ? (items.length === 0 ? -1 : Math.max(0, selectedIndex)) : focusedIndex;
  }, [items, focusedId, selectedIndex]);
  const activeId = items[activeIndex]?.id;
  // A manually scrolled list keeps a Tab entry within the mounted range.
  const tabStopId = virtualize && (activeIndex < visibleRange.startIndex || activeIndex > visibleRange.endIndex)
    ? items[visibleRange.startIndex]?.id : activeId;
  const setVirtualizerRef = useCallback((handle: LibraryVirtualizedRowsHandle | null): void => {
    virtualizerRef.current = handle;
    setVirtualizerReady(handle !== null);
  }, []);
  const onNavigationInterrupted = useCallback((): void => {
    const ownedFocus = pendingFocusId.current !== null;
    pendingFocusId.current = null;
    if (ownedFocus && document.activeElement === document.body) listBodyRef.current?.focus({preventScroll: true});
  }, []);
  useEffect(() => {
    if (selectedIndex < 0) {lastScrolledSelection.current = null; return;}
    const key = JSON.stringify([literature.projectId, literature.selectedId, literature.query, sort, entryType, virtualize, virtualizerReady]);
    if (lastScrolledSelection.current === key) return;
    lastScrolledSelection.current = key;
    if (virtualize) virtualizerRef.current?.scrollIntoView({index: selectedIndex, behavior: 'auto'});
    else rowRefs.current.get(literature.selectedId!)?.scrollIntoView({block: 'nearest'});
  }, [selectedIndex, literature.projectId, literature.selectedId, literature.query, sort, entryType, virtualize, virtualizerReady]);

  const focusRow = (index: number): void => {
    const item = items[index];
    if (item === undefined) return;
    setFocusedId(item.id);
    pendingFocusId.current = item.id;
    const focusMountedRow = (): void => {
      if (pendingFocusId.current !== item.id) return;
      const row = rowRefs.current.get(item.id);
      if (row === undefined) return;
      pendingFocusId.current = null;
      row.focus({preventScroll: true});
      if (!virtualize) row.scrollIntoView({block: 'nearest'});
    };
    if (virtualize) virtualizerRef.current?.scrollIntoView({index, behavior: 'auto', done: () => {
      requestAnimationFrame(focusMountedRow);
    }});
    else focusMountedRow();
  };
  const renderRow = (index: number, item: ResearchLibraryItem): React.JSX.Element => {
    const selected = item.id === literature.selectedId;
    const venue = readVenue(item.bibliography);
    const tabIndex = item.id === tabStopId ? 0 : -1;
    return <div className="library-row" data-selected={selected}>
      {selecting ? <label className="library-row-selection">
        <input type="checkbox" checked={checkedIds.has(item.id)} tabIndex={tabIndex}
          aria-label={`选择文献 ${libraryItemTitle(item)}`}
          onChange={event => setCheckedIds(current => {
            const next = new Set(current);
            if (event.target.checked) next.add(item.id); else next.delete(item.id);
            return next;
          })}/>
        <span className="sr-only">选择</span>
      </label> : null}
      <button type="button" tabIndex={tabIndex}
        ref={element => {
          if (element === null) {
            const row = rowRefs.current.get(item.id);
            if (row?.parentElement?.contains(document.activeElement) && pendingFocusId.current === null) {
              // Manual scrolling may unmount the focused row. Keep keyboard control
              // within this list without scrolling the user's viewport back.
              requestAnimationFrame(() => {
                if (document.activeElement === document.body) listBodyRef.current?.focus({preventScroll: true});
              });
            }
            rowRefs.current.delete(item.id);
          }
          else rowRefs.current.set(item.id, element);
        }}
        onFocus={() => setFocusedId(item.id)}
        onKeyDown={event => {
          const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1)
            : event.key === 'ArrowUp' ? Math.max(0, index - 1)
              : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          focusRow(next);
        }}
        onClick={() => {
          if (onOpenItem) onOpenItem(item.id);
          else literature.select(item.id);
        }}
        aria-current={selected ? 'true' : undefined}
        data-testid={`literature-row-${item.id}`} className="library-row-open">
        <span className="library-row-title" title={libraryItemTitle(item)}>{libraryItemTitle(item)}</span>
        <span className="library-row-metadata">
          <span>{formatAuthorList(item.metadata.authors)}</span>
          <span className="tabular-nums">{formatYear(item.metadata.publishedYear)}</span>
          {venue === null ? null : <span title={venue}>{venue}</span>}
        </span>
        {selected || item.archived ? <span className="library-row-status">
          {selected ? <span data-testid={`literature-fulltext-${item.id}`}>{fullTextLabel(item, literature)}</span> : null}
          {item.archived ? <span><Archive size={12} aria-hidden="true"/>已归档</span> : null}
        </span> : null}
      </button>
      <CitationKeyCopy key={item.bibliography.citationKey} itemId={item.id}
        citationKey={item.bibliography.citationKey} tabIndex={tabIndex}/>
    </div>;
  };

  return (
    <div className="library-list" data-compact={compact} data-selecting={selecting} data-testid="literature-list">
      <div className="library-list-toolbar">
        <div className="library-search-row">
          <label className="library-search">
            <Search size={14} aria-hidden="true"/>
            <input type="search" value={searchDraft}
              onChange={event => {setSearchDraft(event.target.value); literature.setQuery(event.target.value);}}
              placeholder="搜索文献" aria-label="搜索文献" data-testid="literature-search"/>
          </label>
          <button type="button" onClick={literature.reload} aria-label="重新读取文献库" title="重新读取文献库"
            data-testid="literature-refresh" disabled={literature.status === 'loading'} aria-busy={literature.status === 'loading'}
            className="library-icon-button">
            {literature.status === 'loading' ? <Loader2 size={14} aria-hidden="true" className="animate-spin"/>
              : <RefreshCw size={14} aria-hidden="true"/>}
          </button>
          <button type="button" onClick={onRequestImport} aria-label="导入文献" title="导入文献"
            data-testid="literature-import-open" className="library-icon-button">
            <FilePlus2 size={14} aria-hidden="true"/>
          </button>
        </div>
        <div className="library-filter-row">
          <select aria-label="已加载结果排序" value={sort} onChange={event => setSort(event.target.value as SortOrder)}
            data-testid="literature-sort" className={formSelectClass}>
            <option value="updated">最近更新</option><option value="year">发表年份</option><option value="title">文献题名</option>
          </select>
          <button type="button" className="library-icon-button" aria-label="文献筛选" title="文献筛选"
            aria-expanded={filtersOpen} aria-pressed={literature.includeArchived}
            data-testid="literature-filter-toggle" onClick={() => setFiltersOpen(current => !current)}>
            <SlidersHorizontal size={14} aria-hidden="true"/>
          </button>
          <button type="button" className="library-icon-button" aria-pressed={selecting}
            aria-label={selecting ? '结束多选' : '多选文献'} title={selecting ? '结束多选' : '多选文献'}
            data-testid="literature-multiselect" onClick={() => {setSelecting(current => !current); setCheckedIds(new Set());}}>
            <ListChecks size={14} aria-hidden="true"/>
          </button>
        </div>
        {filtersOpen ? <label className="library-filter-option">
          <input type="checkbox" checked={literature.includeArchived}
            onChange={event => literature.setIncludeArchived(event.target.checked)} data-testid="literature-archived-toggle"/>
          显示已归档
        </label> : null}
        {selecting ? <label className="library-filter-option">
          <input type="checkbox" checked={items.length > 0 && checkedItems.length === items.length} disabled={items.length === 0}
            onChange={event => setCheckedIds(new Set(event.target.checked ? items.map(item => item.id) : []))}/>
          选择已加载结果
        </label> : null}
      </div>

      {literature.status === 'error' ? (
        <div className="px-3 py-2">
          <ErrorBar
            error={{
              level: 'page',
              message: literature.error ?? '读取文献库失败'
            }}
          />
        </div>
      ) : null}

      {literature.status === 'loading' && literature.items.length === 0 ? (
        <EmptyState compact tone="loading" icon={Loader2} title="正在读取文献库…" testId="literature-loading" />
      ) : items.length === 0 && literature.status === 'ready' ? (
        <EmptyState
          compact
          icon={BookOpen}
          title={entryType !== null && literature.hasMore ? '已加载文献中没有当前分类'
            : literature.query.trim().length > 0 ? '没有匹配的文献' : entryType !== null ? '当前分类没有文献' : '尚无文献'}
          action={literature.query.trim().length > 0
            ? {label: '清除搜索', onClick: () => literature.setQuery('')}
            : undefined}
          testId="literature-empty"
        />
      ) : (
        <div ref={listBodyRef} className="library-list-body" data-testid="literature-list-body"
          role="group" aria-label="文献列表导航" tabIndex={-1} onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, activeIndex + 1)
              : event.key === 'ArrowUp' ? Math.max(0, activeIndex - 1)
                : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            focusRow(next);
          }}>
          {virtualize ? <LazyBoundary fallback={<p role="status" className="p-3 text-muted">正在准备文献列表…</p>}>
            <LazyLibraryVirtualizedRows ref={setVirtualizerRef} items={items}
              initialIndex={Math.max(0, selectedIndex)}
              navigationScope={JSON.stringify([literature.projectId, literature.selectedId, literature.query, literature.includeArchived, sort, entryType])}
              onRangeChanged={setVisibleRange} onNavigationInterrupted={onNavigationInterrupted} renderRow={renderRow}/>
          </LazyBoundary> : <ul aria-label="文献列表" className="library-plain-list">
            {items.map((item, index) => <li key={item.id}>{renderRow(index, item)}</li>)}
          </ul>}
        </div>
      )}

      {selecting && checkedItems.length > 0 ? <BulkCitationActions key={checkedItemsKey}
        items={checkedItems} literature={literature}/> : null}

      {literature.status === 'ready' ? <div className="library-list-footer">
        <span data-testid="literature-count">已加载 {literature.items.length.toLocaleString('zh-CN')} / {literature.total?.toLocaleString('zh-CN')} 条</span>
        {entryType !== null ? <span>当前分类 {items.length.toLocaleString('zh-CN')} 条</span> : null}
        {literature.includeArchived ? <span>含已归档</span> : null}
        {literature.hasMore ? <button type="button" className={formSecondaryButtonClass}
          data-testid="literature-load-more" disabled={literature.loadingMore} aria-busy={literature.loadingMore}
          onClick={literature.loadMore}>
          {literature.loadingMore ? <Loader2 size={12} aria-hidden="true" className="animate-spin"/> : null}
          {literature.loadingMore ? '正在加载…' : literature.loadMoreError === null ? '加载更多' : '重试加载'}
        </button> : null}
        {literature.loadMoreError ? <p role="alert">{literature.loadMoreError}</p> : null}
      </div> : null}

      {literature.action.error === null ? null : (
        <div className="shrink-0 px-2 pb-2">
          <p role="alert" className="flex items-start gap-1 text-[var(--st-bad)] text-[length:var(--font-micro-size)]">
            <AlertCircle size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{literature.action.error}</span>
          </p>
        </div>
      )}
    </div>
  );
}

function CitationKeyCopy({itemId, citationKey, tabIndex}: {itemId: string; citationKey: string; tabIndex: number}): React.JSX.Element {
  const {copied, error, copy} = useCopyFeedback();
  return <>
    <button type="button" tabIndex={tabIndex} onClick={() => copy(citationKey)}
      aria-label={`${copied ? '已复制引用键' : '复制引用键'} ${citationKey}`}
      title={copied ? '已复制' : '复制引用键'} data-testid={`literature-citekey-copy-${itemId}`}
      className="library-row-copy library-icon-button">
      {copied ? <Check size={11} aria-hidden="true"/> : <Copy size={11} aria-hidden="true"/>}
    </button>
    {error ? <p role="alert" className="library-row-error">{error}</p> : null}
  </>;
}

function BulkCitationActions({items, literature}: {items: ResearchLibraryItem[]; literature: LiteratureStore}): React.JSX.Element {
  const {copied, error, copy} = useCopyFeedback();
  const exportAction = useAsyncAction(() => literature.client.api.research.exportBibliography({
    ids: items.map(item => item.id), format: 'bibtex'
  }), {label: '导出引用'});
  return <div className="grid shrink-0 gap-2 border-t-[0.5px] border-line p-2" data-testid="literature-bulk-actions">
    <ActionStatus state={copied ? 'success' : 'idle'} className="text-[length:var(--font-meta-size)] tabular-nums text-muted" role="status">
      {copied ? '已复制' : `已选 ${items.length.toLocaleString('zh-CN')} 篇`}
    </ActionStatus>
    <div className="flex flex-wrap gap-2">
      <ActionButton variant="compact" disabled={exportAction.pending}
        onClick={() => copy(items.map(item => item.bibliography.citationKey).join(','))}>复制引用键</ActionButton>
      <ActionButton variant="compact" loading={exportAction.pending} loadingLabel="正在导出 BibTeX…"
        onClick={() => void exportAction.run().then(result => {if (result.ok) copy(result.data.content);})}>
        <Copy size={12} aria-hidden="true"/>复制 BibTeX
      </ActionButton>
    </div>
    {error === null && exportAction.error === null ? null : <ActionStatus state="error" className="text-[length:var(--font-meta-size)] text-[var(--st-bad)]">{error ?? exportAction.error}</ActionStatus>}
  </div>;
}
