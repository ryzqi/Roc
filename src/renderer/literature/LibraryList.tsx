import { useEffect, useState } from 'react';
import { AlertCircle, Archive, BookOpen, Check, Copy, FilePlus2, Loader2, RefreshCw, Search } from 'lucide-react';
import type { ResearchLibraryItem } from '../../shared/types';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatAuthorList, formatYear, libraryItemTitle, readVenue } from './format';
import { useLiterature } from './literature-scope';
import { useCopyFeedback } from '../shared/hooks/use-copy-feedback';
import {useAsyncAction} from '../app/use-async-resource';
import {formSecondaryButtonClass, formSelectClass} from '../shared/form-ui';
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
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {setCheckedIds(new Set());}, [literature.projectId, literature.query, literature.includeArchived, entryType]);
  const items = literature.items.filter(item => entryType === null || item.bibliography.entryType === entryType).sort((left, right) => sort === 'year'
    ? (right.metadata.publishedYear ?? 0) - (left.metadata.publishedYear ?? 0)
    : sort === 'title' ? libraryItemTitle(left).localeCompare(libraryItemTitle(right), 'zh-CN')
      : right.updatedAt.localeCompare(left.updatedAt));
  const checkedItems = items.filter(item => checkedIds.has(item.id));

  // Keep the box in sync when something else changes the query (e.g. clearing it
  // from a view switch) without fighting the user's typing.
  useEffect(() => {
    setSearchDraft(literature.query);
  }, [literature.query]);

  const rowPad = compact ? 'px-2 py-2' : 'px-3 py-2';
  const bodyClass = compact ? 'min-h-0 flex-1 overflow-y-auto py-1' : 'min-h-0 flex-1 overflow-y-auto p-2';

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col" data-testid="literature-list">
      <div className={compact ? 'flex shrink-0 flex-col gap-2 px-2 py-2' : 'flex shrink-0 flex-col gap-2 px-3 py-2'}>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-control border-[0.5px] border-line bg-surface px-2">
            <Search size={11} aria-hidden="true" className="shrink-0 text-subtle" />
            <input
              type="search"
              value={searchDraft}
              onChange={(event) => {
                setSearchDraft(event.target.value);
                literature.setQuery(event.target.value);
              }}
              placeholder="搜索文献"
              aria-label="搜索文献"
              data-testid="literature-search"
              className="h-[var(--control-height-compact)] min-w-0 flex-1 bg-transparent text-ink text-[length:var(--font-meta-size)] placeholder:text-subtle"
            />
          </div>
          <button
            type="button"
            onClick={literature.reload}
            aria-label="重新读取文献库"
            title="重新读取文献库"
            data-testid="literature-refresh"
            disabled={literature.status === 'loading'}
            aria-busy={literature.status === 'loading'}
            className="flex h-[var(--control-height-compact)] w-[var(--control-height-compact)] shrink-0 items-center justify-center rounded-control border-[0.5px] border-line text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
          >
            {literature.status === 'loading' ? (
              <Loader2 size={12} aria-hidden="true" className="animate-spin" />
            ) : (
              <RefreshCw size={12} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={onRequestImport}
            aria-label="导入文献"
            title="导入文献（DOI / 参考文献文件 / 手工录入 / 文档）"
            data-testid="literature-import-open"
            className="flex h-[var(--control-height-compact)] w-[var(--control-height-compact)] shrink-0 items-center justify-center rounded-control border-[0.5px] border-line text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <FilePlus2 size={12} aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex min-h-6 items-center gap-2 text-muted text-[length:var(--font-meta-size)]">
            <input
              type="checkbox"
              checked={literature.includeArchived}
              onChange={(event) => literature.setIncludeArchived(event.target.checked)}
              data-testid="literature-archived-toggle"
              className="h-3 w-3 accent-[var(--accent)]"
            />
            显示已归档
          </label>
          <span className="tabular-nums text-subtle text-[length:var(--font-micro-size)]" data-testid="literature-count">
            {literature.status === 'ready' ? `${items.length.toLocaleString('zh-CN')} 条` : ''}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <select aria-label="当前结果排序" value={sort} onChange={event => setSort(event.target.value as SortOrder)}
            data-testid="literature-sort" className={`${formSelectClass} flex-1 text-[length:var(--font-meta-size)]`}>
            <option value="updated">最近更新</option><option value="year">发表年份</option><option value="title">文献题名</option>
          </select>
          <button type="button" className={formSecondaryButtonClass} aria-pressed={selecting}
            data-testid="literature-multiselect" onClick={() => {setSelecting(current => !current); setCheckedIds(new Set());}}>
            {selecting ? '完成' : '多选'}
          </button>
        </div>
        {selecting ? <label className="flex min-h-6 items-center gap-2 text-[length:var(--font-meta-size)] text-muted">
          <input type="checkbox" checked={items.length > 0 && checkedItems.length === items.length} disabled={items.length === 0}
            onChange={event => setCheckedIds(new Set(event.target.checked ? items.map(item => item.id) : []))}/>
          选择当前结果
        </label> : null}
      </div>

      {literature.status === 'error' ? (
        <div className="px-3 py-2">
          <ErrorBar
            error={{
              level: 'page',
              message: literature.error ?? '读取文献库失败',
              retry: literature.reload
            }}
          />
        </div>
      ) : null}

      {literature.status === 'loading' && literature.items.length === 0 ? (
        <EmptyState compact tone="loading" icon={Loader2} title="正在读取文献库…" testId="literature-loading" />
      ) : literature.items.length === 0 && literature.status === 'ready' ? (
        <EmptyState
          compact
          icon={BookOpen}
          title={literature.query.trim().length > 0 ? '没有匹配的文献' : '尚无文献'}
          action={literature.query.trim().length > 0
            ? {label: '清除搜索', onClick: () => literature.setQuery('')}
            : {label: '导入文献', onClick: onRequestImport}}
          testId="literature-empty"
        />
      ) : (
        <ul className={bodyClass} role="list" aria-label="文献列表">
          {items.map((item) => {
            const selected = item.id === literature.selectedId;
            const venue = readVenue(item.bibliography);
            const copyKey = item.bibliography.citationKey;
            return (
              <li key={item.id} className="relative min-w-0">
                {selecting ? <label className="flex min-h-6 items-center gap-2 px-2 text-[length:var(--font-meta-size)] text-muted">
                  <input type="checkbox" checked={checkedIds.has(item.id)} aria-label={`选择文献 ${libraryItemTitle(item)}`}
                    onChange={event => setCheckedIds(current => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.id); else next.delete(item.id);
                      return next;
                    })}/>
                  选择
                </label> : null}
                <button
                  type="button"
                  onClick={() => {
                    if (onOpenItem) onOpenItem(item.id);
                    else literature.select(item.id);
                  }}
                  aria-current={selected ? 'true' : undefined}
                  data-testid={`literature-row-${item.id}`}
                  className={`flex min-w-0 w-full flex-col gap-2 rounded-control pr-8 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${rowPad} ${
                    selected
                      ? 'bg-accent-soft active:bg-[var(--accent-soft-strong)]'
                      : 'hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                  }`}
                >
                  <span className="line-clamp-2 break-words font-medium text-ink text-[length:var(--font-body-size)]" title={libraryItemTitle(item)}>{libraryItemTitle(item)}</span>
                  <span className="flex w-full min-w-0 items-baseline gap-2 text-muted text-[length:var(--font-meta-size)]">
                    <span className="min-w-0 truncate">{formatAuthorList(item.metadata.authors)}</span>
                    <span className="shrink-0 tabular-nums">{formatYear(item.metadata.publishedYear)}</span>
                    {venue === null ? null : <span className="min-w-0 truncate" title={venue}>{venue}</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-[length:var(--font-meta-size)] text-muted">
                    <span data-testid={`literature-fulltext-${item.id}`}>{fullTextLabel(item, literature)}</span>
                    <span title="打开文献查看解析、索引与知识生成的实际状态">检索待核验</span>
                    {item.archived ? (
                      <span className="flex items-center gap-1">
                        <Archive size={12} aria-hidden="true" />
                        已归档
                      </span>
                    ) : null}
                  </span>
                </button>
                <CitationKeyCopy key={copyKey} itemId={item.id} citationKey={copyKey}/>
              </li>
            );
          })}
        </ul>
      )}

      {selecting && checkedItems.length > 0 ? <BulkCitationActions key={checkedItems.map(item => item.id).join(':')}
        items={checkedItems} literature={literature}/> : null}

      {literature.status === 'ready' && literature.items.length >= 200 ? (
        <p
          className="shrink-0 px-2 pb-2 text-subtle text-[length:var(--font-micro-size)]"
          data-testid="literature-truncated"
          role="note"
        >
          只显示前 200 条。
        </p>
      ) : null}

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

function CitationKeyCopy({itemId, citationKey}: {itemId: string; citationKey: string}): React.JSX.Element {
  const {copied, error, copy} = useCopyFeedback();
  return <>
    <button type="button" onClick={() => copy(citationKey)}
      aria-label={`${copied ? '已复制引用键' : '复制引用键'} ${citationKey}`}
      title={copied ? '已复制' : '复制引用键'} data-testid={`literature-citekey-copy-${itemId}`}
      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-ink focus-visible:bg-[var(--overlay-hover)] focus-visible:outline-2 focus-visible:outline-accent active:bg-[var(--overlay-active)]">
      {copied ? <Check size={11} aria-hidden="true"/> : <Copy size={11} aria-hidden="true"/>}
    </button>
    {error ? <p role="alert" className="px-2 py-1 text-[var(--st-bad)] text-[length:var(--font-meta-size)]">{error}</p> : null}
  </>;
}

function BulkCitationActions({items, literature}: {items: ResearchLibraryItem[]; literature: LiteratureStore}): React.JSX.Element {
  const {copied, error, copy} = useCopyFeedback();
  const exportAction = useAsyncAction(() => literature.client.api.research.exportBibliography({
    ids: items.map(item => item.id), format: 'bibtex'
  }), {label: '导出引用'});
  return <div className="grid shrink-0 gap-2 border-t-[0.5px] border-line p-2" data-testid="literature-bulk-actions">
    <p className="text-[length:var(--font-meta-size)] tabular-nums text-muted" role="status">
      {copied ? '已复制' : `已选 ${items.length.toLocaleString('zh-CN')} 篇`}
    </p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={formSecondaryButtonClass} disabled={exportAction.pending}
        onClick={() => copy(items.map(item => item.bibliography.citationKey).join(','))}>复制引用键</button>
      <button type="button" className={formSecondaryButtonClass} disabled={exportAction.pending} aria-busy={exportAction.pending}
        onClick={() => void exportAction.run().then(result => {if (result.ok) copy(result.data.content);})}>
        {exportAction.pending ? <Loader2 size={12} aria-hidden="true" className="animate-spin"/> : <Copy size={12} aria-hidden="true"/>}
        复制 BibTeX
      </button>
    </div>
    {error === null && exportAction.error === null ? null : <p role="alert" className="text-[length:var(--font-meta-size)] text-[var(--st-bad)]">{error ?? exportAction.error}</p>}
  </div>;
}
