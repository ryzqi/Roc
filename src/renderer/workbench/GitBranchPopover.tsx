import { GitBranch } from 'lucide-react';

type GitBranchPopoverProps = {
  actionBusy: boolean;
  branchDraft: string;
  branchSearch: string;
  checkoutAfterCreate: boolean;
  onBranchDraftChange: (value: string) => void;
  onBranchSearchChange: (value: string) => void;
  onCheckoutAfterCreateChange: (checked: boolean) => void;
  onCheckoutBranch: (targetBranch: string) => Promise<void>;
  onClose: () => void;
  onCreateBranch: () => Promise<void>;
  visibleBranches: Array<{ current: boolean; name: string }>;
};

export function GitBranchPopover({
  actionBusy,
  branchDraft,
  branchSearch,
  checkoutAfterCreate,
  onBranchDraftChange,
  onBranchSearchChange,
  onCheckoutAfterCreateChange,
  onCheckoutBranch,
  onClose,
  onCreateBranch,
  visibleBranches
}: GitBranchPopoverProps): React.JSX.Element {
  return (
    <section className="git-branch-popover" data-testid="git-branch-controls">
      <div className="git-branch-popover-head">
        <strong>SWITCH BRANCH</strong>
        <button type="button" onClick={onClose}>
          ×
        </button>
      </div>
      <input
        className="git-branch-search"
        data-testid="git-branch-select"
        disabled={actionBusy}
        placeholder="Search branches..."
        value={branchSearch}
        onChange={(event) => onBranchSearchChange(event.target.value)}
      />
      <div className="git-branch-list">
        {visibleBranches.map((branch) => (
          <button
            className={branch.current ? 'git-branch-option active' : 'git-branch-option'}
            key={branch.name}
            type="button"
            onClick={() => {
              void onCheckoutBranch(branch.name);
            }}
          >
            <GitBranch size={15} />
            <span>{branch.name}</span>
            {branch.current ? <strong>•</strong> : null}
          </button>
        ))}
      </div>
      <div className="git-branch-create-row">
        <input
          className="git-branch-search"
          data-testid="git-branch-create-input"
          disabled={actionBusy}
          placeholder="new branch name"
          value={branchDraft}
          onChange={(event) => onBranchDraftChange(event.target.value)}
        />
        <label className="git-branch-checkbox">
          <input
            checked={checkoutAfterCreate}
            data-testid="git-branch-create-checkout"
            disabled={actionBusy}
            type="checkbox"
            onChange={(event) => onCheckoutAfterCreateChange(event.target.checked)}
          />
          checkout
        </label>
        <button
          className="git-branch-create-button"
          data-testid="git-branch-create"
          disabled={actionBusy || branchDraft.trim().length === 0}
          type="button"
          onClick={() => {
            void onCreateBranch();
          }}
        >
          Create
        </button>
      </div>
    </section>
  );
}
