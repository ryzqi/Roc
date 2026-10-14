import { useEffect, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { EmptyState } from '../shell/EmptyState';

/**
 * Project portal shell (P1). P2 wires `research.projects.*`.
 *
 * Structure is already final because P2 only swaps the data source, not the
 * layout: page title, toolbar (search + status filter), card grid, and an empty
 * state whose action reveals the create form. Three behaviours from MASTER v2 §0
 * are encoded here rather than left to P2:
 *
 *   - the create form is **collapsed by default** and only open when the user
 *     asks (or arrives via `page=research-new` / ⌘N)
 *   - "no projects" is an empty state, never a pre-expanded form
 *   - the status filter is a pure view filter; starred projects are a local UI
 *     preference (ADR-M06) and must never become the filter authority
 *
 * ## Why the form's open state is component state, not the URL
 *
 * The URL carries only a one-shot *request* (`?page=research-new`). Whether the
 * form is open, and what is typed into it, lives here. Two reasons:
 *
 *   1. `?page` can hold a single value, so `page=settings` (⌘, at any moment,
 *      since it is a native accelerator) would have to clear the request. If the
 *      open state lived in the URL, that would silently discard a half-filled
 *      form. Settings is an overlay, so this component stays mounted and the
 *      draft survives.
 *   2. It keeps `parseAppRoute ∘ writeAppRoute` an identity, which the route
 *      round-trip tests assert.
 */

export type ProjectStatusFilter = 'active' | 'archived' | 'all';

export type ProjectPortalViewProps = {
  /** One-shot request from the route (`page=research-new`). */
  createFormRequested: boolean;
  onRequestConsumed: (requested: boolean) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  statusFilter: ProjectStatusFilter;
  onStatusFilterChange: (filter: ProjectStatusFilter) => void;
};

const STATUS_FILTERS: Array<{ id: ProjectStatusFilter; label: string }> = [
  { id: 'active', label: '进行中' },
  { id: 'archived', label: '已归档' },
  { id: 'all', label: '全部' }
];

export function ProjectPortalView({
  createFormRequested,
  onRequestConsumed,
  searchQuery,
  onSearchQueryChange,
  statusFilter,
  onStatusFilterChange
}: ProjectPortalViewProps): React.JSX.Element {
  const [formOpen, setFormOpen] = useState(createFormRequested);

  // Follow later requests (a second ⌘N after the user closed the form).
  useEffect(() => {
    if (createFormRequested) {
      setFormOpen(true);
    }
  }, [createFormRequested]);

  const closeForm = (): void => {
    setFormOpen(false);
    // Drop the URL request so a reload does not re-open it.
    if (createFormRequested) {
      onRequestConsumed(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto" data-testid="portal">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3 px-7 pb-10 pt-5">
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 text-ink text-[var(--font-h1-size)]">研究项目</h1>
          <button
            type="button"
            data-testid="portal-new-project"
            onClick={() => {
              setFormOpen(true);
            }}
            className="flex h-[var(--control-height)] items-center gap-1.5 rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)]"
          >
            <Plus size={14} aria-hidden="true" />
            新建研究项目
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-[var(--control-height)] min-w-[220px] flex-1 items-center gap-2 rounded-control border border-line bg-surface px-2.5">
            <Search size={13} aria-hidden="true" className="shrink-0 text-subtle" />
            <input
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder="搜索项目"
              aria-label="搜索项目"
              data-testid="portal-search"
              className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-subtle"
            />
            {searchQuery.length === 0 ? null : (
              <button
                type="button"
                onClick={() => onSearchQueryChange('')}
                className="rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
              >
                清空
              </button>
            )}
          </div>
          <div role="group" aria-label="项目状态筛选" className="flex items-center gap-0.5">
            {STATUS_FILTERS.map((filter) => {
              const selected = filter.id === statusFilter;
              return (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onStatusFilterChange(filter.id)}
                  data-testid={`portal-filter-${filter.id}`}
                  className={
                    selected
                      ? 'h-[var(--control-height)] rounded-control bg-accent-soft px-2.5 text-ink active:bg-[var(--accent-soft-strong)]'
                      : 'h-[var(--control-height)] rounded-control px-2.5 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                  }
                >
                  <span className="text-[var(--font-meta-size)]">{filter.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {formOpen ? (
          <section
            aria-label="新建研究项目"
            data-testid="portal-create-form"
            className="rounded-card border border-line bg-surface px-4 py-3"
          >
            <p className="text-ink">新建研究项目</p>
            <p className="mt-1 text-muted text-[var(--font-meta-size)]">
              标题、研究目标、文稿语言、工作目录。目录必须用原生选择器挑选，一个目录同时只属于一个项目。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled
                className="h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] disabled:opacity-50"
              >
                创建
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="h-[var(--control-height)] rounded-control px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
              >
                取消
              </button>
              <span className="text-subtle text-[var(--font-micro-size)]">P2 接入 research.projects.create</span>
            </div>
          </section>
        ) : null}

        <EmptyState
          title="还没有研究项目"
          description="新建研究项目后才会进入该项目的工作台。"
          action={{ label: '新建研究项目', onClick: () => setFormOpen(true) }}
          testId="portal-empty"
        />
        <p className="text-center text-subtle text-[var(--font-micro-size)]">
          卡片网格与数据来自 research.projects.list · P2 实现
        </p>
      </div>
    </div>
  );
}
