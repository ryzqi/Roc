import { useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { ModalShell } from './ModalShell';

/**
 * ⌘K search palette (P1 shell; data sources land in P5/P6).
 *
 * P1 delivers the interaction contract only: a query field, grouped results,
 * arrow-key navigation, and Enter to open. Groups come from the caller so
 * availability is explicit — a group whose backend query failed renders as
 * "该分组不可用" instead of silently disappearing, and an empty group renders
 * an empty state rather than fabricated rows (R12).
 *
 * Querying is the caller's job (P5/T5.8 fans out to projects, library, files,
 * sessions, skills, concepts and artifacts, and each group degrades
 * independently).
 */

export type SearchItem = {
  id: string;
  title: string;
  subtitle?: string;
  onOpen: () => void;
};

export type SearchGroup = {
  id: string;
  label: string;
  status: 'ready' | 'loading' | 'unavailable';
  items: SearchItem[];
  /** Shown when the group is ready but has no matches. */
  emptyLabel?: string;
  /** Why the group is unavailable (backend error text). */
  unavailableReason?: string;
};

export type SearchPaletteModalProps = {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  groups: SearchGroup[];
};

export function SearchPaletteModal({
  open,
  onClose,
  query,
  onQueryChange,
  groups
}: SearchPaletteModalProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  // Focus the query field, not the header's close button. Relying on React's
  // `autoFocus` lost to the overlay's own "focus the first focusable" pass, so
  // the ref is handed to `ModalShell` explicitly.
  const inputRef = useRef<HTMLInputElement>(null);

  // Flat list drives arrow navigation across group boundaries.
  const flat = useMemo(() => {
    const items: Array<{ groupId: string; item: SearchItem }> = [];
    for (const group of groups) {
      if (group.status !== 'ready') {
        continue;
      }
      for (const item of group.items) {
        items.push({ groupId: group.id, item });
      }
    }
    return items;
  }, [groups]);

  const clampedIndex = flat.length === 0 ? 0 : Math.min(activeIndex, flat.length - 1);
  const activeKey = flat.length === 0 ? null : `${flat[clampedIndex]!.groupId}:${flat[clampedIndex]!.item.id}`;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (flat.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % flat.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + flat.length) % flat.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      flat[clampedIndex]!.item.onOpen();
      onClose();
    }
  };

  return (
    <ModalShell
      open={open}
      title="搜索"
      onClose={onClose}
      widthClassName="w-[640px]"
      testId="search-palette"
      initialFocusRef={inputRef}
    >
      <div onKeyDown={onKeyDown} className="flex flex-col gap-3">
        <div className="flex h-[var(--control-height)] items-center gap-2 rounded-control border border-line bg-surface-strong px-2.5">
          <Search size={13} aria-hidden="true" className="shrink-0 text-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索项目、文献、文件、会话、技能、概念、产物"
            aria-label="搜索"
            data-testid="search-palette-input"
            className="min-w-0 flex-1 bg-transparent text-ink placeholder:text-subtle"
          />
          {query.length === 0 ? null : (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
            >
              清空
            </button>
          )}
        </div>

        <div className="min-h-[8rem]">
          {query.trim().length === 0 ? (
            /* An empty query is not a search that found nothing: rendering the
               groups here would show "没有匹配的文件名" the moment ⌘K opens, which
               reads as "your files are gone" rather than "type something". */
            <p className="px-1 py-6 text-center text-muted" data-testid="search-palette-idle">
              输入关键词开始搜索。
            </p>
          ) : groups.length === 0 ? (
            <p className="px-1 py-6 text-center text-muted">尚未接入任何搜索分组。</p>
          ) : (
            groups.map((group) => (
              <section key={group.id} className="mb-3" data-testid={`search-group-${group.id}`} data-status={group.status}>
                <h3 className="px-1 py-1 text-subtle text-[var(--font-micro-size)]">{group.label}</h3>
                {group.status === 'unavailable' ? (
                  <p className="px-1 py-1.5 text-[var(--st-warn)] text-[var(--font-meta-size)]">
                    该分组不可用{group.unavailableReason === undefined ? '' : `：${group.unavailableReason}`}
                  </p>
                ) : group.status === 'loading' ? (
                  <p className="px-1 py-1.5 text-muted text-[var(--font-meta-size)]">正在搜索…</p>
                ) : group.items.length === 0 ? (
                  <p className="px-1 py-1.5 text-muted text-[var(--font-meta-size)]">
                    {group.emptyLabel ?? '没有匹配项'}
                  </p>
                ) : (
                  <ul className="flex flex-col">
                    {group.items.map((item) => {
                      const key = `${group.id}:${item.id}`;
                      const active = key === activeKey;
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            onClick={() => {
                              item.onOpen();
                              onClose();
                            }}
                            data-testid={`search-item-${item.id}`}
                            className={
                              active
                                ? 'flex w-full flex-col items-start rounded-control bg-accent-soft px-2 py-1.5 text-left active:bg-[var(--accent-soft-strong)]'
                                : 'flex w-full flex-col items-start rounded-control px-2 py-1.5 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                            }
                          >
                            <span className="w-full truncate text-ink">{item.title}</span>
                            {item.subtitle === undefined ? null : (
                              <span className="w-full truncate text-muted text-[var(--font-micro-size)]">
                                {item.subtitle}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))
          )}
        </div>

        <p className="text-subtle text-[var(--font-micro-size)]">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p>
      </div>
    </ModalShell>
  );
}
