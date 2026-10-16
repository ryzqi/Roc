import { useMemo, useState } from 'react';
import { Check, GitBranch, Loader2, Plus, X } from 'lucide-react';
import type { GitBranchListResult } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import { filterGitBranches } from '../../workspace/git-store';

/**
 * Branch switching and creation (P3/T3.5), reusing the legacy
 * `GitBranchPopover` interaction: search, checkout, create-with-optional-checkout.
 *
 * Rendering is inline rather than a nested modal: the Git panel already lives in
 * a drawer (or in the canvas), and stacking a second dialog on top would create
 * two Escape layers and two focus traps for one decision.
 *
 * Both mutations are confirmed through `shell.confirm`, which shows a **native**
 * macOS message box in the main process. That is the same choice the legacy shell
 * made, for the same reason: switching or creating a branch rewrites the working
 * tree, and the confirmation must be a real system modal the user cannot click
 * past. (`git.discardFile` is confirmed in-app instead, because its blast radius
 * is one file and the panel should stay interactive — see `GitPanel`.)
 */

export type GitBranchSwitcherProps = {
  client: RocClient;
  workspacePath: string;
  branchInfo: GitBranchListResult | null;
  currentBranch: string;
  busy: boolean;
  /** Archived projects are read-only: branch mutations rewrite the working tree. */
  writable: boolean;
  onCheckoutBranch: (name: string) => Promise<boolean>;
  onCreateBranch: (name: string, checkoutAfterCreate: boolean) => Promise<boolean>;
  onClose: () => void;
};

export function GitBranchSwitcher({
  client,
  workspacePath,
  branchInfo,
  currentBranch,
  busy,
  writable,
  onCheckoutBranch,
  onCreateBranch,
  onClose
}: GitBranchSwitcherProps): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [checkoutAfterCreate, setCheckoutAfterCreate] = useState(true);
  // One name for the gate, so no read path can forget it.
  const readOnly = !writable;

  const visibleBranches = useMemo(
    () => filterGitBranches(branchInfo?.branches ?? [], search),
    [branchInfo, search]
  );

  const confirm = async (request: { title: string; message: string; confirmLabel: string; cancelLabel: string }): Promise<boolean> => {
    const result = await client.api.shell.confirm(request);
    if (!result.ok) {
      return false;
    }
    return result.data.confirmed;
  };

  const checkout = async (name: string): Promise<void> => {
    if (name === currentBranch || !writable) {
      return;
    }
    const confirmed = await confirm({
      title: '切换分支',
      message: `确认在工作区 ${workspacePath} 切换到分支 ${name} 吗？未提交的改动会随之带入。`,
      confirmLabel: '切换',
      cancelLabel: '取消'
    });
    if (!confirmed) {
      return;
    }
    const ok = await onCheckoutBranch(name);
    if (ok) {
      onClose();
    }
  };

  const create = async (): Promise<void> => {
    const name = draft.trim();
    if (name.length === 0 || !writable) {
      return;
    }
    const confirmed = await confirm({
      title: '创建分支',
      message: checkoutAfterCreate
        ? `确认在工作区 ${workspacePath} 创建并切换到分支 ${name} 吗？`
        : `确认在工作区 ${workspacePath} 创建分支 ${name} 吗？`,
      confirmLabel: '创建',
      cancelLabel: '取消'
    });
    if (!confirmed) {
      return;
    }
    const ok = await onCreateBranch(name, checkoutAfterCreate);
    if (ok) {
      setDraft('');
      onClose();
    }
  };

  return (
    <section
      aria-label="分支切换"
      data-testid="git-branch-controls"
      className="flex flex-col gap-2 rounded-card border border-line bg-surface-strong p-2"
    >
      <header className="flex items-center gap-2">
        <GitBranch size={13} aria-hidden="true" className="shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate text-ink text-[var(--font-meta-size)]">
          当前分支 · {currentBranch.length === 0 ? '（未命名）' : currentBranch}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭分支切换"
          data-testid="git-branch-close"
          className="flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]"
        >
          <X size={12} aria-hidden="true" />
        </button>
      </header>

      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={busy}
        placeholder="搜索分支…"
        aria-label="搜索分支"
        data-testid="git-branch-search"
        className="h-[var(--control-height-compact)] w-full rounded-control border border-line bg-surface px-2 text-ink placeholder:text-subtle"
      />

      {readOnly ? (
        <p role="note" className="text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="git-branch-readonly-note">
          项目已归档，仅可阅读：不能创建或切换分支。
        </p>
      ) : null}

      <ul className="max-h-52 min-h-0 overflow-y-auto" data-testid="git-branch-list">
        {visibleBranches.length === 0 ? (
          <li className="px-1 py-2 text-muted text-[var(--font-meta-size)]">
            {branchInfo === null ? '分支列表尚未加载。' : '没有匹配的分支。'}
          </li>
        ) : (
          visibleBranches.map((branch) => (
            <li key={branch.name}>
              <button
                type="button"
                disabled={busy || readOnly || branch.current}
                onClick={() => void checkout(branch.name)}
                data-testid={`git-branch-option-${branch.name}`}
                className="flex h-[var(--control-height-compact)] w-full items-center gap-2 rounded-control px-2 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 size={12} aria-hidden="true" className="animate-spin text-muted" />
                ) : branch.current ? (
                  <Check size={12} aria-hidden="true" className="text-[var(--st-ok)]" />
                ) : (
                  <span className="w-3 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--font-meta-size)]">{branch.name}</span>
                {branch.current ? <span className="text-subtle text-[var(--font-micro-size)]">当前</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="flex items-center gap-1.5 border-t border-line-soft pt-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft.trim().length > 0 && !busy && !readOnly) {
              event.preventDefault();
              void create();
            }
          }}
          disabled={busy || readOnly}
          placeholder="新分支名称"
          aria-label="新分支名称"
          data-testid="git-branch-create-input"
          className="h-[var(--control-height-compact)] min-w-0 flex-1 rounded-control border border-line bg-surface px-2 font-mono text-ink placeholder:text-subtle"
        />
        <label className="flex shrink-0 items-center gap-1 text-muted text-[var(--font-micro-size)]">
          <input
            type="checkbox"
            checked={checkoutAfterCreate}
            disabled={busy}
            onChange={(event) => setCheckoutAfterCreate(event.target.checked)}
            data-testid="git-branch-create-checkout"
          />
          创建后切换
        </label>
        <button
          type="button"
          disabled={busy || readOnly || draft.trim().length === 0}
          onClick={() => void create()}
          data-testid="git-branch-create"
          className="flex h-[var(--control-height-compact)] shrink-0 items-center gap-1 rounded-control border border-line px-2 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40"
        >
          <Plus size={11} aria-hidden="true" />
          创建
        </button>
      </div>
    </section>
  );
}
