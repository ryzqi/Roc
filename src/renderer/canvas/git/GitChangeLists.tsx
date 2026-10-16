import { CheckSquare, Square, Undo2, Upload } from 'lucide-react';
import type { GitStatusChange } from '../../../shared/types';
import { buildGitChangeStateLabel, canUnstageGitChange, type GitChangeGroups } from '../../workspace/git-store';

/**
 * The three change groups of the Git panel (P3/T3.5).
 *
 * Split out of `GitPanel` so the panel stays a composition of decisions rather
 * than a 500-line component, and so the group semantics are in one place:
 *
 *   - 已暂存 — `index` set: only "unstage" is meaningful
 *   - 未暂存 — tracked but modified in the working tree: stage, diff, discard
 *   - 未跟踪 — `?`: stage, diff (against `/dev/null` on the backend), discard
 *
 * A path can appear in 已暂存 **and** 未暂存 at once (staged, then modified
 * again); that is git's own model and merging the rows would hide the second
 * edit. Batch staging therefore only offers the rows that have work left to do.
 *
 * Every row keeps a real checkbox for batch selection and a separate button for
 * the row's own action, so a click never means two things. Selection lives in the
 * parent; this component only reports.
 */

export type GitChangeListsProps = {
  groups: GitChangeGroups;
  selectedPath: string | null;
  selectedPaths: ReadonlySet<string>;
  busy: boolean;
  /** Archived projects are read-only. */
  writable: boolean;
  selectablePaths: string[];
  allSelectableSelected: boolean;
  onSelect: (relativePath: string) => void;
  onToggleSelected: (relativePath: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onStage: (relativePaths: string[]) => void;
  onUnstage: (relativePath: string) => void;
  onDiscard: (relativePath: string) => void;
};

function ChangeRow({
  change,
  selected,
  checked,
  busy,
  writable,
  selectable,
  onSelect,
  onToggleSelected,
  onStage,
  onUnstage,
  onDiscard
}: {
  change: GitStatusChange;
  selected: boolean;
  checked: boolean;
  busy: boolean;
  writable: boolean;
  selectable: boolean;
  onSelect: () => void;
  onToggleSelected: (checked: boolean) => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  const staged = canUnstageGitChange(change);
  const label = buildGitChangeStateLabel(change);
  const disabled = busy || !writable;

  return (
    <div
      data-testid={`git-change-${change.relativePath}`}
      data-staged={staged ? 'true' : 'false'}
      className={
        selected
          ? 'flex items-center gap-1.5 rounded-control bg-accent-soft pr-1'
          : 'flex items-center gap-1.5 rounded-control pr-1 hover:bg-[var(--overlay-hover)]'
      }
    >
      {selectable ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`选择 ${change.relativePath}`}
          disabled={disabled}
          data-testid={`git-select-toggle-${change.relativePath}`}
          onClick={() => onToggleSelected(!checked)}
          className="flex h-6 w-6 shrink-0 items-center justify-center text-muted disabled:opacity-40"
        >
          {checked ? (
            <CheckSquare size={12} aria-hidden="true" className="text-accent" />
          ) : (
            <Square size={12} aria-hidden="true" />
          )}
        </button>
      ) : (
        <span className="w-6 shrink-0" aria-hidden="true" />
      )}

      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={change.relativePath}
        data-testid={`git-select-${change.relativePath}`}
        className="flex h-6 min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--font-meta-size)]">{change.relativePath}</span>
        <span className="shrink-0 text-subtle text-[var(--font-micro-size)]">{label}</span>
      </button>

      <div className="flex shrink-0 items-center">
        {staged ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onUnstage}
            data-testid={`git-unstage-${change.relativePath}`}
            className="flex h-6 items-center gap-1 rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
          >
            <Undo2 size={11} aria-hidden="true" />
            取消暂存
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={onStage}
            data-testid={`git-stage-${change.relativePath}`}
            className="flex h-6 items-center gap-1 rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
          >
            <Upload size={11} aria-hidden="true" />
            暂存
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={onDiscard}
          data-testid={`git-discard-${change.relativePath}`}
          title={staged ? '丢弃已暂存的改动' : '丢弃工作区改动'}
          className="flex h-6 items-center rounded-control px-1.5 text-[var(--st-bad)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40"
        >
          丢弃
        </button>
      </div>
    </div>
  );
}

function Group({
  title,
  count,
  children,
  actions
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mt-2 first:mt-0">
      <header className="flex items-center gap-2 px-1 py-0.5">
        <h3 className="flex-1 text-subtle text-[var(--font-micro-size)]">
          {title} · {count}
        </h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function GitChangeLists({
  groups,
  selectedPath,
  selectedPaths,
  busy,
  writable,
  selectablePaths,
  allSelectableSelected,
  onSelect,
  onToggleSelected,
  onSelectAll,
  onClearSelection,
  onStage,
  onUnstage,
  onDiscard
}: GitChangeListsProps): React.JSX.Element {
  const selectableCount = selectedPaths.size;
  const noChanges =
    groups.staged.length === 0 && groups.unstaged.length === 0 && groups.untracked.length === 0;

  if (noChanges) {
    return (
      <p className="px-2 py-4 text-muted text-[var(--font-meta-size)]" data-testid="git-changes-clean">
        工作区干净，没有未提交的改动。
      </p>
    );
  }

  const row = (change: GitStatusChange, selectable: boolean): React.JSX.Element => (
    <ChangeRow
      key={`${selectable ? 'w' : 'i'}:${change.porcelain}`}
      change={change}
      selected={selectedPath === change.relativePath}
      checked={selectedPaths.has(change.relativePath)}
      busy={busy}
      writable={writable}
      selectable={selectable}
      onSelect={() => onSelect(change.relativePath)}
      onToggleSelected={(checked) => onToggleSelected(change.relativePath, checked)}
      onStage={() => onStage([change.relativePath])}
      onUnstage={() => onUnstage(change.relativePath)}
      onDiscard={() => onDiscard(change.relativePath)}
    />
  );

  return (
    <div data-testid="git-changes">
      {groups.staged.length === 0 ? null : (
        <Group title="已暂存" count={groups.staged.length}>
          {groups.staged.map((change) => row(change, false))}
        </Group>
      )}

      <Group
        title="未暂存"
        count={groups.unstaged.length}
        actions={
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={busy || !writable || selectablePaths.length === 0 || allSelectableSelected}
              onClick={onSelectAll}
              data-testid="git-select-all"
              className="rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
            >
              <span className="text-[var(--font-micro-size)]">全选</span>
            </button>
            <button
              type="button"
              disabled={busy || !writable || selectableCount === 0}
              onClick={() => onStage([...selectedPaths])}
              data-testid="git-stage-selected"
              className="rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
            >
              <span className="text-[var(--font-micro-size)]">暂存所选（{selectableCount}）</span>
            </button>
            <button
              type="button"
              disabled={busy || selectableCount === 0}
              onClick={onClearSelection}
              data-testid="git-clear-selection"
              className="rounded-control px-1.5 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
            >
              <span className="text-[var(--font-micro-size)]">清空</span>
            </button>
          </div>
        }
      >
        {groups.unstaged.length === 0 ? (
          <p className="px-2 py-1 text-subtle text-[var(--font-micro-size)]">没有未暂存的改动。</p>
        ) : (
          groups.unstaged.map((change) => row(change, true))
        )}
      </Group>

      {groups.untracked.length === 0 ? null : (
        <Group title="未跟踪" count={groups.untracked.length}>
          {groups.untracked.map((change) => row(change, true))}
        </Group>
      )}
    </div>
  );
}
