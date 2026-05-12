import type { GitStatusChange } from '../../shared/types';
import { sanitizeTestId } from '../utils/sanitize-test-id';
import { buildGitChangeStateLabel, canUnstageGitChange } from './git-helpers';

type GitChangeListProps = {
  actionBusy: boolean;
  changes: GitStatusChange[];
  emptyText: string;
  selectedPath: string | null;
  selectedPathSet: Set<string>;
  title: string;
  selectable: boolean;
  onSelectGitFile: (relativePath: string) => Promise<void>;
  onToggleSelectedPath: (relativePath: string, checked: boolean) => void;
};

export function GitChangeList({
  actionBusy,
  changes,
  emptyText,
  selectedPath,
  selectedPathSet,
  title,
  selectable,
  onSelectGitFile,
  onToggleSelectedPath
}: GitChangeListProps): React.JSX.Element {
  if (changes.length === 0) {
    return <div className="git-change-empty">{emptyText}</div>;
  }

  return (
    <section className="git-change-list" data-testid={`git-change-list-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      {changes.map((change) => {
        const safeId = sanitizeTestId(change.relativePath);
        const active = selectedPath === change.relativePath;
        const checked = selectable ? selectedPathSet.has(change.relativePath) : canUnstageGitChange(change);
        return (
          <div className={active ? 'git-change-card selected' : 'git-change-card'} key={change.porcelain}>
            <button
              aria-pressed={active}
              className="git-change-meta"
              data-testid={`git-select-${safeId}`}
              type="button"
              onClick={() => void onSelectGitFile(change.relativePath)}
            >
              <input
                checked={checked}
                data-testid={`git-select-toggle-${safeId}`}
                disabled={actionBusy || !selectable}
                type="checkbox"
                onChange={(event) => onToggleSelectedPath(change.relativePath, event.target.checked)}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              />
              <span className="git-change-path">{change.relativePath}</span>
            </button>
            <div className="git-change-side">
              <span className="git-change-state">{buildGitChangeStateLabel(change)}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
