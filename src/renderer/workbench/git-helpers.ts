import type { GitStatusChange, GitStatusResult } from '../../shared/types';
import type { LoadedState } from '../loaded-state';

export function gitStatusChanges(status: GitStatusResult): GitStatusChange[] {
  return status.changes;
}

export function canStageGitChange(change: GitStatusChange): boolean {
  return change.worktree !== ' ' || change.index === '?' || change.index === '!';
}

export function canUnstageGitChange(change: GitStatusChange): boolean {
  return change.index !== ' ' && change.index !== '?';
}

export function canDiscardGitChange(change: GitStatusChange): boolean {
  return change.index !== '?';
}

export function buildGitChangeStateLabel(change: GitStatusChange): string {
  if (change.index === '?') {
    return '未跟踪';
  }
  if (change.index !== ' ' && change.worktree !== ' ') {
    return '已暂存 + 工作区修改';
  }
  if (change.index !== ' ') {
    return '已暂存';
  }
  return '工作区修改';
}

export function findNextGitSelection(changes: GitStatusChange[], preferredPath: string | null): string | null {
  if (changes.length === 0) {
    return null;
  }
  if (preferredPath === null) {
    return changes[0]?.relativePath ?? null;
  }
  const preferredIndex = changes.findIndex((change) => change.relativePath === preferredPath);
  if (preferredIndex >= 0) {
    return changes[preferredIndex]?.relativePath ?? null;
  }
  const nextBySort = [...changes]
    .map((change) => change.relativePath)
    .sort((left, right) => left.localeCompare(right, 'en'));
  return nextBySort[0] ?? null;
}

export function gitSelectionEmptyMessage(state: LoadedState): string {
  if (state.gitStatus === null || state.gitStatus.changedFiles === 0) {
    return '当前没有可选择的 Git 变更文件。';
  }
  return '从下方列表选择一个变更文件后，这里会显示当前焦点文件的状态和内容预览。';
}
