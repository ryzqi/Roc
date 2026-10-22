import { useEffect, useState } from 'react';
import { AlertCircle, Archive, BookOpen, Check, Copy, FilePlus2, Link2, Loader2, RefreshCw, Search } from 'lucide-react';
import type { ResearchLibraryItem } from '../../shared/types';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatAuthorList, formatCitationCount, formatYear, libraryItemTitle, readVenue } from './format';
import { useLiterature } from './literature-scope';

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
 * ## 引用键
 *
 * 每一行带上条目自己的引用键（`bibliography.citationKey`）。它是用户与外部世界交接的那个
 * 字符串——模板里的 `\cite{…}`、合作者的 Zotero 库、投稿系统里的参考文献表都认它。
 * 所以这里不只显示，还能一键复制：从“看到一个键”到“拿到这个键”不该需要打开读写器。
 * 后端搜索也认这个字段（`library-repository.list()`），粘贴一个键就能找到那一条。
 */

export type LibraryListProps = {
  /** Tight rows/spacing for the 256px sidebar. */
  compact?: boolean;
  /** The sidebar uses this to open the item in the canvas hub. */
  onOpenItem?: (id: string) => void;
  onRequestImport: () => void;
};

/** Row badge: where the record came from, as the contract names it. */
const SOURCE_LABELS: Readonly<Record<ResearchLibraryItem['metadata']['source'], string>> = {
  openalex: 'OpenAlex',
  crossref: 'Crossref',
  semantic_scholar: 'Semantic Scholar',
  arxiv: 'arXiv',
  pubmed: 'PubMed',
  europe_pmc: 'Europe PMC',
  local: '本地',
  doi: 'DOI'
};

export function LibraryList({ compact = false, onOpenItem, onRequestImport }: LibraryListProps): React.JSX.Element {
  const literature = useLiterature();
  const [searchDraft, setSearchDraft] = useState(literature.query);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 复制反馈只活 1.5 秒：它是“刚才那一下成功了”的确认，不是持久状态。
  useEffect(() => {
    if (copiedId === null) return undefined;
    const timer = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(timer);
  }, [copiedId]);

  // Keep the box in sync when something else changes the query (e.g. clearing it
  // from a view switch) without fighting the user's typing.
  useEffect(() => {
    setSearchDraft(literature.query);
  }, [literature.query]);

  const rowPad = compact ? 'px-2 py-1.5' : 'px-3 py-2';
  const bodyClass = compact ? 'min-h-0 flex-1 overflow-y-auto py-1' : 'min-h-0 flex-1 overflow-y-auto p-2';

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="literature-list">
      <div className={compact ? 'flex shrink-0 flex-col gap-1 px-2 py-1.5' : 'flex shrink-0 flex-col gap-2 px-3 py-2'}>
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-control border border-line bg-surface px-2">
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
              className="h-[var(--control-height-compact)] min-w-0 flex-1 bg-transparent text-ink text-[var(--font-meta-size)] placeholder:text-subtle"
            />
          </div>
          <button
            type="button"
            onClick={literature.reload}
            aria-label="重新读取文献库"
            title="重新读取文献库"
            data-testid="literature-refresh"
            className="flex h-[var(--control-height-compact)] w-[var(--control-height-compact)] shrink-0 items-center justify-center rounded-control border border-line text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
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
            className="flex h-[var(--control-height-compact)] w-[var(--control-height-compact)] shrink-0 items-center justify-center rounded-control border border-line text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
          >
            <FilePlus2 size={12} aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-muted text-[var(--font-micro-size)]">
            <input
              type="checkbox"
              checked={literature.includeArchived}
              onChange={(event) => literature.setIncludeArchived(event.target.checked)}
              data-testid="literature-archived-toggle"
              className="h-3 w-3 accent-[var(--accent)]"
            />
            显示已归档
          </label>
          <span className="text-subtle text-[var(--font-micro-size)]" data-testid="literature-count">
            {literature.status === 'ready' ? `${literature.items.length} 条` : ''}
          </span>
        </div>
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
          action={{ label: '导入文献', onClick: onRequestImport }}
          testId="literature-empty"
        />
      ) : (
        <ul className={bodyClass} role="list" aria-label="文献列表">
          {literature.items.map((item) => {
            const selected = item.id === literature.selectedId;
            const venue = readVenue(item.bibliography);
            const linked = literature.projectId !== null && item.projectIds.includes(literature.projectId);
            const copyKey = item.bibliography.citationKey;
            const copied = copiedId === item.id;
            return (
              <li key={item.id} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    literature.select(item.id);
                    onOpenItem?.(item.id);
                  }}
                  aria-current={selected ? 'true' : undefined}
                  data-testid={`literature-row-${item.id}`}
                  className={`flex w-full flex-col gap-0.5 rounded-control pr-7 text-left ${rowPad} ${
                    selected
                      ? 'bg-accent-soft active:bg-[var(--accent-soft-strong)]'
                      : 'hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                  }`}
                >
                  <span className="line-clamp-2 text-ink text-[var(--font-meta-size)]">{libraryItemTitle(item)}</span>
                  <span className="truncate text-muted text-[var(--font-micro-size)]">
                    {formatAuthorList(item.metadata.authors)} · {formatYear(item.metadata.publishedYear)}
                    {venue === null ? '' : ` · ${venue}`}
                  </span>
                  <span className="flex flex-wrap items-center gap-1">
                    <span className="rounded-control border border-line px-1 text-subtle text-[var(--font-micro-size)]">
                      {SOURCE_LABELS[item.metadata.source]}
                    </span>
                    <span className="font-mono text-subtle text-[var(--font-micro-size)]" data-testid={`literature-citekey-${item.id}`}>
                      {copyKey}
                    </span>
                    <span className="text-subtle text-[var(--font-micro-size)]">
                      {formatCitationCount(item.metadata.citationCount)}
                    </span>
                    {linked ? (
                      <span className="flex items-center gap-0.5 text-[var(--st-ok)] text-[var(--font-micro-size)]">
                        <Link2 size={9} aria-hidden="true" />
                        本项目
                      </span>
                    ) : null}
                    {item.archived ? (
                      <span className="flex items-center gap-0.5 text-[var(--st-warn)] text-[var(--font-micro-size)]">
                        <Archive size={9} aria-hidden="true" />
                        已归档
                      </span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(copyKey).then(() => setCopiedId(item.id), () => setCopiedId(null));
                  }}
                  aria-label={copied ? `已复制引用键 ${copyKey}` : `复制引用键 ${copyKey}`}
                  title={copied ? '已复制' : '复制引用键'}
                  data-testid={`literature-citekey-copy-${item.id}`}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-control text-subtle hover:bg-[var(--overlay-hover)] hover:text-ink focus-visible:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
                >
                  {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {literature.status === 'ready' && literature.items.length >= 200 ? (
        <p
          className="shrink-0 px-2 pb-2 text-subtle text-[var(--font-micro-size)]"
          data-testid="literature-truncated"
          role="note"
        >
          只显示前 200 条。
        </p>
      ) : null}

      {literature.action.error === null ? null : (
        <div className="shrink-0 px-2 pb-2">
          <p role="alert" className="flex items-start gap-1 text-[var(--st-bad)] text-[var(--font-micro-size)]">
            <AlertCircle size={11} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{literature.action.error}</span>
          </p>
        </div>
      )}
    </div>
  );
}
