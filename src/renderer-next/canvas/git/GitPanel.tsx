import { useEffect, useMemo, useState } from 'react';
import { GitBranch, History, Loader2, RefreshCw, Upload } from 'lucide-react';
import { BACKEND_ERROR_CODES } from '../../app/loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { ErrorBar } from '../../shell/ErrorBar';
import { EmptyState } from '../../shell/EmptyState';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { useRtkStatus } from '../../workspace/use-rtk-status';
import { useGitWorkspace } from '../../workspace/use-git-workspace';
import {
  buildGitCommitButtonState,
  buildGitSelectionModel,
  groupGitChanges,
  pruneGitSelection,
  selectableGitChanges,
  selectAllGitChanges
} from '../../workspace/git-store';
import { GitBranchSwitcher } from './GitBranchSwitcher';
import { GitChangeLists } from './GitChangeLists';
import { GitFileDiff } from './GitFileDiff';

/**
 * Git panel (P3/T3.5) — the whole Git surface, in one component used twice:
 *
 *   - the top-bar drawer (`?tool=git`), stacked layout
 *   - the canvas `changes` view, wide two-pane layout
 *
 * Having one implementation is deliberate: the alternative was two panels that
 * drift, and the only real difference is how the change list and the diff are
 * arranged.
 *
 * Write actions are gated by `writable` (the P2 `isProjectWritable` predicate):
 * an archived project shows the lists and diffs but cannot stage, commit, push,
 * discard or switch branches — the refusal is visible up front rather than
 * arriving as a backend error after the user has typed a commit message.
 *
 * Confirmations are split by blast radius: `discard` (one file, irreversible)
 * uses the in-app `ConfirmDialog` so the keyboard trap stays inside the panel,
 * while branch create/checkout use the native `shell.confirm` in the main
 * process (see `GitBranchSwitcher`).
 *
 * Commit history has **no backend interface** (B5). What `git.status` gives us is
 * the current branch, and a commit made during this session is remembered; the
 * history section says so explicitly instead of implying the list is complete.
 */

export type GitPanelProps = {
  client: RocClient;
  /** Bound workspace path (absolute), or null when the project has none. */
  workspacePath: string | null;
  /** Archived projects are read-only. */
  writable: boolean;
  layout: 'drawer' | 'canvas';
};

export function GitPanel({ client, workspacePath, writable, layout }: GitPanelProps): React.JSX.Element {
  const git = useGitWorkspace(client, workspacePath);
  const rtk = useRtkStatus(client, workspacePath !== null);
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);

  const changes = git.snapshot?.changes ?? [];
  const groups = useMemo(() => groupGitChanges(changes), [changes]);
  const selectable = useMemo(() => selectableGitChanges(changes), [changes]);
  const selectionModel = useMemo(() => buildGitSelectionModel(selectable, selectedPaths), [selectable, selectedPaths]);

  // A refresh can remove the path that was selected for a batch; keeping it would
  // make the next batch act on a nonexistent file.
  useEffect(() => {
    setSelectedPaths((current) => {
      const next = pruneGitSelection(changes, current);
      return next.length === current.length ? current : next;
    });
  }, [changes]);

  const busy = git.pending !== null;
  const commitState = buildGitCommitButtonState({
    actionBusy: busy,
    changedFiles: git.snapshot?.changedFiles ?? 0,
    commitMessage,
    writable
  });
  const currentBranch = git.branches?.currentBranch ?? git.snapshot?.branch ?? '';
  const selectedChange = changes.find((change) => change.relativePath === git.selectedPath) ?? null;

  const runCommit = async (): Promise<void> => {
    if (!commitState.enabled) {
      return;
    }
    const ok = await git.commit(commitMessage);
    if (ok) {
      setCommitMessage('');
      setSelectedPaths([]);
    }
  };

  const header = (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        // Branch create/checkout rewrite the working tree, so they are behind the
        // same read-only gate as stage/commit (M-1).
        disabled={busy || !writable || workspacePath === null}
        onClick={() => setBranchOpen((open) => !open)}
        data-testid="git-current-branch"
        aria-expanded={branchOpen}
        title={writable ? '切换或创建分支' : '项目已归档，仅可阅读'}
        className="flex h-[var(--control-height-compact)] min-w-0 flex-1 items-center gap-1.5 rounded-control px-2 text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
      >
        <GitBranch size={13} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-left text-[var(--font-meta-size)]">
          {currentBranch.length === 0 ? '无分支信息' : currentBranch}
        </span>
      </button>
      <button
        type="button"
        disabled={busy || !writable || workspacePath === null}
        onClick={() => void git.push()}
        data-testid="git-push"
        title={writable ? '推送当前分支' : '项目已归档，无法推送'}
        className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
      >
        <Upload size={12} aria-hidden="true" />
        <span className="text-[var(--font-micro-size)]">Push</span>
      </button>
      <button
        type="button"
        disabled={busy || workspacePath === null}
        onClick={() => void git.refresh()}
        aria-label="刷新 Git 状态"
        data-testid="git-refresh"
        className="flex h-[var(--control-height-compact)] w-[var(--control-height-compact)] items-center justify-center rounded-control text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
      >
        {git.pending === 'refresh' ? (
          <Loader2 size={12} aria-hidden="true" className="animate-spin" />
        ) : (
          <RefreshCw size={12} aria-hidden="true" />
        )}
      </button>
    </div>
  );

  const commitBox = (
    <div className="flex shrink-0 flex-col gap-1.5">
      <textarea
        value={commitMessage}
        onChange={(event) => setCommitMessage(event.target.value)}
        disabled={busy || !writable}
        placeholder="提交信息（必填）"
        aria-label="提交信息"
        rows={layout === 'drawer' ? 2 : 3}
        data-testid="git-commit-message"
        className="w-full resize-none rounded-control border border-line bg-surface px-2 py-1.5 text-ink placeholder:text-subtle disabled:opacity-60"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!commitState.enabled}
          onClick={() => void runCommit()}
          data-testid="git-commit"
          className="h-[var(--control-height)] rounded-control bg-[var(--fill-strong)] px-3 text-[var(--fill-strong-text)] active:bg-[var(--accent-deep)] disabled:opacity-40"
        >
          {git.pending === 'commit' ? '提交中…' : `提交（${git.snapshot?.changedFiles ?? 0} 个文件）`}
        </button>
        <span className="min-w-0 flex-1 truncate text-muted text-[var(--font-micro-size)]">
          {commitState.enabled || git.pending === 'commit' ? '' : commitState.reason}
        </span>
      </div>
    </div>
  );

  const historySection = (
    <section className="mt-3 border-t border-line-soft pt-2" data-testid="git-history">
      <h3 className="flex items-center gap-1.5 px-1 py-0.5 text-subtle text-[var(--font-micro-size)]">
        <History size={11} aria-hidden="true" />
        提交历史
      </h3>
      {git.lastCommit === null ? (
        <p className="px-1 py-1 text-subtle text-[var(--font-micro-size)]">
          后端没有提交历史接口（登记为 B5），这里只能显示当前分支
          {currentBranch.length === 0 ? '' : ` ${currentBranch}`} 与本次会话中的提交。
        </p>
      ) : (
        <p className="px-1 py-1 text-muted text-[var(--font-micro-size)]" data-testid="git-last-commit">
          本次会话提交 <span className="font-mono">{git.lastCommit.commitSha.slice(0, 8)}</span> ·{' '}
          {git.lastCommit.commitMessage}
        </p>
      )}
    </section>
  );

  const footer = (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line-soft px-1 pt-1.5 text-[var(--font-micro-size)]"
      data-testid="git-footer"
    >
      {rtk.status === 'idle' ? null : (
        <span
          data-testid="git-rtk-status"
          data-tone={rtk.summary?.tone ?? 'muted'}
          title={rtk.summary?.detail ?? rtk.error ?? ''}
          className={
            rtk.summary?.tone === 'warn'
              ? 'text-[var(--st-warn)]'
              : rtk.summary?.tone === 'ok'
                ? 'text-[var(--st-ok)]'
                : 'text-subtle'
          }
        >
          {rtk.status === 'loading' ? 'RTK 状态读取中…' : rtk.status === 'error' ? 'RTK 状态不可用' : rtk.summary?.label}
        </span>
      )}
      {git.diffStatError === null ? null : <span className="text-[var(--st-warn)]">diff --stat：{git.diffStatError}</span>}
      {git.lastPush === null ? null : (
        <span className="text-muted" data-testid="git-last-push">
          最近推送：{git.lastPush.remoteName}/{git.lastPush.branch}
        </span>
      )}
    </div>
  );

  if (workspacePath === null || git.unavailable) {
    /**
     * Two different reasons for the same empty surface. "Not a repository" and "the
     * directory is gone" both need the user to change the working directory, but the
     * second one is not something you fix with `git init` — telling a user their
     * directory has no `.git` when the directory does not exist sends them the wrong
     * way.
     */
    const missingWorkspace = git.errorCode === BACKEND_ERROR_CODES.workspacePathMissing;
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-testid="git-panel" data-state="unavailable">
        <EmptyState
          icon={GitBranch}
          title={
            workspacePath === null
              ? '未绑定工作目录'
              : missingWorkspace
                ? '工作目录不存在'
                : '当前目录不是 Git 仓库'
          }
          description={
            workspacePath === null
              ? '先在项目里选择工作目录，Git 面板才有内容可显示。'
              : missingWorkspace
                ? '项目绑定的目录已经不存在或不可读。重新选择工作目录后再打开面板。'
                : '这个目录没有 .git。换一个仓库目录，或在外部初始化仓库后再打开面板。'
          }
          testId="git-unavailable"
        />
        {footer}
      </div>
    );
  }

  if (git.phase === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-testid="git-panel" data-state="error">
        <ErrorBar
          error={{ level: 'page', message: git.error ?? '读取 Git 状态失败', retry: () => void git.refresh() }}
        />
        {footer}
      </div>
    );
  }

  if (git.phase === 'loading' && git.snapshot === null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-testid="git-panel" data-state="loading">
        <p className="flex items-center gap-2 text-muted" role="status">
          <Loader2 size={13} aria-hidden="true" className="animate-spin" />
          正在读取 Git 状态…
        </p>
        {footer}
      </div>
    );
  }

  const diffColumn =
    selectedChange === null ? (
      <EmptyState
        title="选择一个变更文件"
        description="左侧列表中的文件被选中后，这里显示它的补丁。"
        testId="git-diff-none"
      />
    ) : (
      <GitFileDiff
        client={client}
        workspacePath={workspacePath}
        relativePath={selectedChange.relativePath}
        stateLabel={
          selectedChange.index === '?'
            ? '未跟踪'
            : selectedChange.index !== ' '
              ? '已暂存'
              : '工作区修改'
        }
      />
    );

  const listColumn = (
    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-testid="git-change-scroll">
      {writable ? null : (
        <p role="note" className="mb-1 px-1 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="git-readonly-note">
          项目已归档，仅可阅读：暂存、提交、推送与丢弃都不可用。
        </p>
      )}
      {git.actionError === null ? null : (
        <div className="mb-1">
          <ErrorBar
            error={{ level: 'page', message: git.actionError }}
            onDismiss={git.clearActionError}
          />
        </div>
      )}
      {git.diffStat !== null && git.diffStat.trim().length > 0 ? (
        <pre
          data-testid="git-diff-stat"
          className="mb-1 overflow-x-auto rounded-control bg-code-surface px-2 py-1 font-mono text-[var(--font-micro-size)] text-[var(--code-text)]"
        >
          {git.diffStat.trimEnd()}
        </pre>
      ) : null}
      <GitChangeLists
        groups={groups}
        selectedPath={git.selectedPath}
        selectedPaths={new Set(selectedPaths)}
        busy={busy}
        writable={writable}
        selectablePaths={selectAllGitChanges(selectable)}
        allSelectableSelected={selectionModel.allSelectableSelected}
        onSelect={git.selectFile}
        onToggleSelected={(relativePath, checked) =>
          setSelectedPaths((current) =>
            checked
              ? current.includes(relativePath)
                ? current
                : [...current, relativePath]
              : current.filter((path) => path !== relativePath)
          )
        }
        onSelectAll={() => setSelectedPaths(selectAllGitChanges(selectable))}
        onClearSelection={() => setSelectedPaths([])}
        onStage={(paths) => void git.stage(paths)}
        onUnstage={(path) => void git.unstage(path)}
        onDiscard={(path) => setDiscardTarget(path)}
      />
      {historySection}
    </div>
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 p-2"
      data-testid="git-panel"
      data-layout={layout}
      data-state="ready"
    >
      {header}
      {commitBox}
      {branchOpen ? (
        <GitBranchSwitcher
          client={client}
          workspacePath={workspacePath}
          branchInfo={git.branches}
          currentBranch={currentBranch}
          busy={busy}
          writable={writable}
          onCheckoutBranch={git.checkoutBranch}
          onCreateBranch={git.createBranch}
          onClose={() => setBranchOpen(false)}
        />
      ) : null}

      {layout === 'canvas' ? (
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="flex min-h-0 w-[360px] shrink-0 flex-col border-r border-line-soft pr-1">{listColumn}</div>
          <div className="flex min-h-0 flex-1 flex-col">{diffColumn}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {listColumn}
          <div className="flex min-h-[40%] flex-col border-t border-line-soft pt-1">{diffColumn}</div>
        </div>
      )}

      {footer}

      <ConfirmDialog
        open={discardTarget !== null}
        title="丢弃改动？"
        message={`将丢弃 ${discardTarget ?? ''} 中未提交的改动。`}
        detail="已暂存的内容也会一并丢弃，且无法通过撤销恢复（后端会保留恢复点，但不保证可用）。"
        confirmLabel="丢弃"
        tone="destructive"
        testId="git-discard-confirm"
        onCancel={() => setDiscardTarget(null)}
        onConfirm={() => {
          const target = discardTarget;
          setDiscardTarget(null);
          if (target !== null) {
            void git.discard(target);
          }
        }}
      />
    </div>
  );
}
