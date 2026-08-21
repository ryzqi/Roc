import { GitBranch, X } from 'lucide-react';
import { Checkbox, IconButton, TextInput } from '../components/ui';

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
        <strong>切换分支</strong>
        <IconButton label="关闭分支选择" onClick={onClose}><X size={15} /></IconButton>
      </div>
      <TextInput
        className="git-branch-search"
        data-testid="git-branch-select"
        disabled={actionBusy}
        placeholder="搜索分支..."
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
        <TextInput
          className="git-branch-search"
          data-testid="git-branch-create-input"
          disabled={actionBusy}
          placeholder="新分支名称"
          value={branchDraft}
          onChange={(event) => onBranchDraftChange(event.target.value)}
        />
        <Checkbox
          className="git-branch-checkbox"
            checked={checkoutAfterCreate}
            data-testid="git-branch-create-checkout"
            disabled={actionBusy}
            onChange={(event) => onCheckoutAfterCreateChange(event.target.checked)}
        >
          创建后切换
        </Checkbox>
        <button
          className="git-branch-create-button"
          data-testid="git-branch-create"
          disabled={actionBusy || branchDraft.trim().length === 0}
          type="button"
          onClick={() => {
            void onCreateBranch();
          }}
        >
          创建
        </button>
      </div>
    </section>
  );
}
