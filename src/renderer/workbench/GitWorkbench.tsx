import { useEffect, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import type { GitBranchMutationResult, GitStatusResult } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import {
  buildGitBranchSwitcherModel,
  buildGitCommitButtonState,
  buildGitSelectionModel,
  clampGitSplitWidth,
  GIT_SPLIT_DEFAULT_WIDTH,
  selectAllGitChanges
} from '../git-workbench';
import type { LazyLoadState, WorkspaceData } from '../app/types';
import type { LoadedState } from '../loaded-state';
import {
  canUnstageGitChange,
  findNextGitSelection,
  gitStatusChanges
} from './git-helpers';
import { GitBranchPopover } from './GitBranchPopover';
import { GitChangeList } from './GitChangeList';
import { GitDiffPanel } from './GitDiffPanel';
import { useGitDiffPreview } from './useGitDiffPreview';

export function GitWorkbench({
  loadState,
  state,
  updateWorkspaceData
}: {
  loadState: LazyLoadState;
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
}): React.JSX.Element {
  const [commitMessage, setCommitMessage] = useState('');
  const [pendingAction, setPendingAction] = useState<
    'refresh' | 'stage' | 'unstage' | 'stage-batch' | 'discard' | 'commit' | 'push' | 'branch-create' | 'branch-checkout' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [branchDraft, setBranchDraft] = useState('');
  const [checkoutAfterCreate, setCheckoutAfterCreate] = useState(true);
  const [branchTarget, setBranchTarget] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);
  const [gitPaneWidth, setGitPaneWidth] = useState(GIT_SPLIT_DEFAULT_WIDTH);

  const changes = state.gitStatus === null ? [] : gitStatusChanges(state.gitStatus);
  const selectedPath = findNextGitSelection(changes, state.gitSelectedPath);
  const selectedChange = selectedPath === null ? null : changes.find((change) => change.relativePath === selectedPath) ?? null;
  const branchInfo = state.gitBranches;
  const currentBranch = branchInfo?.currentBranch ?? state.gitStatus?.branch ?? '';
  const selectableChanges = changes;
  const selectedPathSet = new Set(selectedPaths);
  const { allSelectableSelected, selectedCount } = buildGitSelectionModel(selectableChanges, selectedPaths);
  const { failedPath, loadingPath, loadGitDiffPreview, selectedDiffFile, selectionPreview } = useGitDiffPreview({
    onActionError: setActionError,
    selectedChange,
    selectedPath,
    selectedPreview: state.gitSelectedPreview,
    updateWorkspaceData
  });

  useEffect(() => {
    if (state.gitSelectedPath === selectedPath) {
      return;
    }
    if (selectedPath === null) {
      if (state.gitSelectedPath === null && state.gitSelectedPreview === null) {
        return;
      }
      updateWorkspaceData({
        gitSelectedPath: null,
        gitSelectedPreview: null
      });
      return;
    }
    if (state.gitSelectedPath !== selectedPath) {
      updateWorkspaceData({ gitSelectedPath: selectedPath, gitSelectedPreview: null });
    }
  }, [selectedPath, state.gitSelectedPath, state.gitSelectedPreview, updateWorkspaceData]);

  useEffect(() => {
    if (changes.length === 0) {
      if (selectedPaths.length > 0) {
        setSelectedPaths([]);
      }
      return;
    }
    const available = new Set(changes.map((change) => change.relativePath));
    const nextSelected = selectedPaths.filter((relativePath) => available.has(relativePath));
    if (nextSelected.length === selectedPaths.length) {
      return;
    }
    setSelectedPaths(nextSelected);
  }, [changes, selectedPaths]);

  useEffect(() => {
    if (branchInfo === null) {
      if (branchTarget !== '') {
        setBranchTarget('');
      }
      return;
    }
    if (branchTarget === '' || !branchInfo.branches.some((branch) => branch.name === branchTarget)) {
      setBranchTarget(branchInfo.currentBranch);
    }
  }, [branchInfo, branchTarget]);

  async function selectGitFile(relativePath: string): Promise<void> {
    updateWorkspaceData({
      gitSelectedPath: relativePath,
      gitSelectedPreview: null
    });
    await loadGitDiffPreview(relativePath);
  }

  async function applyGitStatusResult(status: GitStatusResult, preferredPath: string | null): Promise<void> {
    const nextSelectedPath = findNextGitSelection(status.changes, preferredPath);
    updateWorkspaceData({
      gitStatus: status,
      gitError: null,
      gitSelectedPath: nextSelectedPath,
      gitSelectedPreview: nextSelectedPath === preferredPath ? state.gitSelectedPreview : null
    });
    if (nextSelectedPath === null) {
      updateWorkspaceData({ gitSelectedPreview: null });
      return;
    }
    await loadGitDiffPreview(nextSelectedPath);
  }

  function applyBranchMutationResult(result: GitBranchMutationResult): void {
    updateWorkspaceData({
      gitBranches: result.branchInfo
    });
  }

  function toggleSelectedPath(relativePath: string, checked: boolean): void {
    setSelectedPaths((current) => {
      if (checked) {
        return current.includes(relativePath) ? current : [...current, relativePath];
      }
      return current.filter((path) => path !== relativePath);
    });
  }

  function selectAllGitChangesAction(): void {
    setSelectedPaths(selectAllGitChanges(selectableChanges));
  }

  function clearSelectedGitChanges(): void {
    setSelectedPaths([]);
  }

  async function refreshGitWorkspace(): Promise<void> {
    const [gitStatus, branches] = await Promise.all([window.roc.git.status(), window.roc.git.listBranches()]);
    if (gitStatus.ok && branches.ok) {
      updateWorkspaceData({
        gitBranches: branches.data
      });
      await applyGitStatusResult(gitStatus.data, state.gitSelectedPath);
      return;
    }
    const message = !gitStatus.ok ? gitStatus.error.message : !branches.ok ? branches.error.message : 'Git 状态刷新失败。';
    updateWorkspaceData({
      gitStatus: gitStatus.ok ? gitStatus.data : null,
      gitBranches: branches.ok ? branches.data : null,
      gitError: message,
      gitSelectedPath: null,
      gitSelectedPreview: null
    });
    setActionError(message);
  }

  async function refreshGitStatus(): Promise<void> {
    setPendingAction('refresh');
    setActionError(null);
    await refreshGitWorkspace();
    setPendingAction(null);
  }

  async function stageSelectedFiles(): Promise<void> {
    setPendingAction('stage-batch');
    setActionError(null);
    const result = await window.roc.git.stageFiles({ relativePaths: selectedPaths });
    if (result.ok) {
      await applyGitStatusResult(result.data, state.gitSelectedPath);
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  async function commitChanges(): Promise<void> {
    if (!commitButtonState.enabled) {
      return;
    }
    setPendingAction('commit');
    setActionError(null);
    const result = await window.roc.git.commit({ message: commitMessage });
    if (result.ok) {
      updateWorkspaceData({
        gitStatus: result.data.status,
        gitError: null,
        gitSelectedPath: null,
        gitSelectedPreview: null,
        gitLastCommit: result.data
      });
      setSelectedPaths([]);
      setCommitMessage('');
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  async function createBranch(): Promise<void> {
    const gitStatus = state.gitStatus;
    if (gitStatus === null) {
      return;
    }
    const branchName = branchDraft.trim();
    const workspacePath = gitStatus.workspacePath;
    if (
      !window.confirm(
        checkoutAfterCreate
          ? `确认在工作区 ${workspacePath} 创建并切换到分支 ${branchName} 吗？`
          : `确认在工作区 ${workspacePath} 创建分支 ${branchName} 吗？`
      )
    ) {
      return;
    }
    setPendingAction('branch-create');
    setActionError(null);
    const result = await window.roc.git.createBranch({
      name: branchName,
      checkoutAfterCreate
    });
    if (result.ok) {
      applyBranchMutationResult(result.data);
      setBranchTarget(result.data.branchInfo.currentBranch);
      setBranchDraft('');
      await applyGitStatusResult(result.data.status, state.gitSelectedPath);
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  async function checkoutNamedBranch(targetBranch: string): Promise<void> {
    const gitStatus = state.gitStatus;
    if (gitStatus === null) {
      return;
    }
    if (targetBranch.length === 0 || targetBranch === currentBranch) {
      return;
    }
    const workspacePath = gitStatus.workspacePath;
    if (!window.confirm(`确认在工作区 ${workspacePath} 切换到分支 ${targetBranch} 吗？`)) {
      return;
    }
    setPendingAction('branch-checkout');
    setActionError(null);
    const result = await window.roc.git.checkoutBranch({ name: targetBranch });
    if (result.ok) {
      applyBranchMutationResult(result.data);
      setBranchTarget(result.data.branchInfo.currentBranch);
      setBranchSwitcherOpen(false);
      await applyGitStatusResult(result.data.status, state.gitSelectedPath);
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  function startGitPaneResize(event: React.PointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = gitPaneWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      setGitPaneWidth(clampGitSplitWidth(startWidth + moveEvent.clientX - startX));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  if (state.workspace === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-git-empty" title="未选择工作区" />
      </section>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-git-loading" title="Git 工作台加载中" tone="loading" />
      </section>
    );
  }

  if (loadState.status === 'error') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-git-load-error" title="Git 工作台加载失败" tone="error" />
      </section>
    );
  }

  if (state.gitStatus === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState
          testId="workbench-git-empty"
          title="当前工作区不是 Git 仓库"
          tone="error"
        />
      </section>
    );
  }

  const stagedCount = gitStatusChanges(state.gitStatus).filter((change) => canUnstageGitChange(change)).length;
  const dirtyCount = gitStatusChanges(state.gitStatus).filter((change) => change.worktree !== ' ').length;
  const actionBusy = pendingAction !== null;
  const commitButtonState = buildGitCommitButtonState({
    actionBusy,
    changedFiles: state.gitStatus.changedFiles,
    commitMessage
  });
  const branchSwitcherModel = buildGitBranchSwitcherModel({
    actionBusy,
    branchInfo,
    branchSearch
  });
  const visibleBranches = branchSwitcherModel.visibleBranches;
  return (
    <section className="tool-panel workbench-surface workbench-surface--git">
      <div className="workbench-git workbench-git--split" style={{ '--git-pane-width': `${gitPaneWidth}px` } as React.CSSProperties}>
        <aside className="git-sidebar">
          <header className="git-header">
            <textarea
              className="git-commit-message"
              data-testid="workbench-git-commit-message"
              disabled={actionBusy}
              placeholder="Commit message..."
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            <button
              className={commitButtonState.enabled ? 'git-commit-button git-commit-button--ready' : 'git-commit-button'}
              data-testid="workbench-git-commit"
              disabled={!commitButtonState.enabled}
              type="button"
              onClick={() => void commitChanges()}
            >
              ✓ Commit ({state.gitStatus.changedFiles} files)
            </button>
          </header>
          <section className="git-changes-pane" data-testid="workbench-git-changes">
            <div className="git-section-header git-section-header--staged">
              <span>待提交变更</span>
              <span className="git-section-count">{stagedCount}</span>
            </div>
            <GitChangeList
              actionBusy={actionBusy}
              changes={changes.filter((change) => canUnstageGitChange(change))}
              emptyText="当前没有待提交变更。"
              selectable={false}
              selectedPath={selectedPath}
              selectedPathSet={selectedPathSet}
              title="待提交变更"
              onSelectGitFile={selectGitFile}
              onToggleSelectedPath={toggleSelectedPath}
            />
            <div className="git-section-header">
              <span>工作区变更</span>
              <span className="git-section-count">{state.gitStatus.changedFiles - stagedCount}</span>
              <button
                className="git-stage-all-button"
                data-testid="git-select-all"
                disabled={actionBusy || selectableChanges.length === 0 || allSelectableSelected}
                type="button"
                onClick={selectAllGitChangesAction}
              >
                ALL
              </button>
            </div>
            <div className="git-batch-actions">
              <button
                className="action-button action-button--git-secondary"
                data-testid="git-clear-selection"
                disabled={actionBusy || selectedCount === 0}
                type="button"
                onClick={clearSelectedGitChanges}
              >
                清空选择
              </button>
              <button
                className="action-button action-button--git"
                data-testid="git-stage-selected"
                disabled={actionBusy || selectedCount === 0}
                type="button"
                onClick={() => void stageSelectedFiles()}
              >
                批量暂存
              </button>
              <span data-testid="git-selected-count">{selectedCount} selected</span>
            </div>
            <GitChangeList
              actionBusy={actionBusy}
              changes={changes.filter((change) => !canUnstageGitChange(change))}
              emptyText="工作区干净。"
              selectable
              selectedPath={selectedPath}
              selectedPathSet={selectedPathSet}
              title="工作区变更"
              onSelectGitFile={selectGitFile}
              onToggleSelectedPath={toggleSelectedPath}
            />
          </section>
          <footer className="git-sidebar-statusbar">
            <button
              className="git-branch-status"
              data-testid="git-current-branch"
              disabled={actionBusy}
              type="button"
              onClick={() => setBranchSwitcherOpen((current) => !current)}
            >
              <GitBranch size={15} />
              <span>{currentBranch}</span>
            </button>
            <button
              className="git-status-refresh"
              aria-label="刷新 Git 状态"
              disabled={actionBusy}
              type="button"
              onClick={() => void refreshGitStatus()}
            >
              <RefreshCw size={15} />
            </button>
            <span className="git-sync-stat">↓ {stagedCount}</span>
            <span className="git-sync-stat">↑ {dirtyCount}</span>
          </footer>
          {branchSwitcherOpen ? (
            <GitBranchPopover
              actionBusy={actionBusy}
              branchDraft={branchDraft}
              branchSearch={branchSearch}
              checkoutAfterCreate={checkoutAfterCreate}
              visibleBranches={visibleBranches}
              onBranchDraftChange={setBranchDraft}
              onBranchSearchChange={setBranchSearch}
              onCheckoutAfterCreateChange={setCheckoutAfterCreate}
              onCheckoutBranch={async (targetBranch) => {
                setBranchTarget(targetBranch);
                await checkoutNamedBranch(targetBranch);
              }}
              onClose={() => setBranchSwitcherOpen(false)}
              onCreateBranch={createBranch}
            />
          ) : null}
        </aside>
        <div
          aria-label="调节 Git 面板宽度"
          className="workbench-git-splitter"
          data-testid="workbench-git-splitter"
          role="separator"
          tabIndex={0}
          onPointerDown={startGitPaneResize}
        />
        <section className="git-detail-pane">
          {actionError === null ? null : (
            <span className="inline-warning" data-testid="workbench-git-action-error">
              {actionError}
            </span>
          )}
          <div className="git-selection-slot">
            <GitDiffPanel
              failedPath={failedPath}
              loadingPath={loadingPath}
              selectedChange={selectedChange}
              selectedDiffFile={selectedDiffFile}
              selectionPreview={selectionPreview}
              state={state}
            />
          </div>
          {state.gitLastCommit === null && state.gitLastPush === null ? null : (
            <div className="git-last-result">
              {state.gitLastCommit === null ? null : <span>最近提交：{state.gitLastCommit.commitMessage}</span>}
              {state.gitLastPush === null ? null : <span>最近 Push：{state.gitLastPush.remoteName}/{state.gitLastPush.branch}</span>}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
