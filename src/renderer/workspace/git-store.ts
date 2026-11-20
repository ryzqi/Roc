import type {
  GitBranchListResult,
  GitBranchMutationResult,
  GitCommitResult,
  GitDiffStatResult,
  GitFileDiffResult,
  GitPushResult,
  GitStatusChange,
  GitStatusResult
} from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import { checkRelativePath, pathRejectionMessage } from './paths';

/**
 * Git data layer (P3/T3.5).
 *
 * Thin wrappers, plus the pure decision helpers the panel renders from. The
 * helpers are ported from the legacy `git-workbench.ts` / `git-helpers.ts` /
 * `git-diff-adapter.ts` (F11) — they encode real edge cases (mixed
 * staged+worktree rows, keeping selection across a status refresh, cache bounds
 * for parsed diffs) that are cheap to keep and expensive to rediscover.
 *
 * Every file-scoped call validates its `relativePath` first, for the same reason
 * `files.*` does: `git.fileDiff` / `stageFile` / … resolve the path inside the
 * workspace, and an escaping path must fail with a specific message here rather
 * than as a vague backend error (R10).
 */

function reject<R>(relativePath: string): IpcLikeResult<R> | null {
  const check = checkRelativePath(relativePath);
  if (check.ok) {
    return null;
  }
  return { ok: false, error: { message: pathRejectionMessage(check.reason), code: 'renderer_path_rejected' } };
}

/*
 * Which porcelain status letters mean what. `index` is the staged column and
 * `worktree` the working-tree column; `?` in the index column means untracked.
 */
export function canUnstageGitChange(change: GitStatusChange): boolean {
  return change.index !== ' ' && change.index !== '?';
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

/**
 * Changes split the way the panel lists them. A change can legitimately appear
 * in both groups (staged *and* modified again afterwards) — that is git's own
 * model, and merging them into one row would hide the second edit.
 */
export type GitChangeGroups = {
  staged: GitStatusChange[];
  unstaged: GitStatusChange[];
  untracked: GitStatusChange[];
};

export function groupGitChanges(changes: readonly GitStatusChange[]): GitChangeGroups {
  const staged: GitStatusChange[] = [];
  const unstaged: GitStatusChange[] = [];
  const untracked: GitStatusChange[] = [];
  for (const change of changes) {
    if (change.index === '?') {
      untracked.push(change);
      continue;
    }
    if (canUnstageGitChange(change)) {
      staged.push(change);
    }
    if (change.worktree !== ' ') {
      unstaged.push(change);
    }
  }
  return { staged, unstaged, untracked };
}

/** Every path a stage batch can act on: staged rows are excluded (nothing to do). */
export function selectableGitChanges(changes: readonly GitStatusChange[]): GitStatusChange[] {
  return changes.filter((change) => !canUnstageGitChange(change));
}

export function selectAllGitChanges<T extends { relativePath: string }>(changes: readonly T[]): string[] {
  return changes.map((change) => change.relativePath);
}

/**
 * Keeps a selection valid across a status refresh: paths that disappeared are
 * dropped, and a brand-new set of changes selects nothing rather than silently
 * selecting whatever now happens to be first.
 */
export function pruneGitSelection(changes: readonly GitStatusChange[], selectedPaths: readonly string[]): string[] {
  if (changes.length === 0) {
    return [];
  }
  const available = new Set(changes.map((change) => change.relativePath));
  return selectedPaths.filter((relativePath) => available.has(relativePath));
}

/**
 * Which file should be focused after a refresh. The previously focused file wins
 * while it still has changes; otherwise the first row.
 */
export function findNextGitSelection(changes: readonly GitStatusChange[], preferredPath: string | null): string | null {
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

export function buildGitCommitButtonState({
  actionBusy,
  changedFiles,
  commitMessage,
  writable
}: {
  actionBusy: boolean;
  changedFiles: number;
  commitMessage: string;
  /** Archived projects are read-only; the reason must say so, not "busy". */
  writable: boolean;
}): { enabled: boolean; reason: string | null } {
  if (!writable) {
    return { enabled: false, reason: '项目已归档，仅可阅读。' };
  }
  if (actionBusy) {
    return { enabled: false, reason: '正在执行上一步操作。' };
  }
  if (changedFiles === 0) {
    return { enabled: false, reason: '没有可提交的变更。' };
  }
  // The message is required by `gitCommitRequestSchema`; the backend also refuses
  // an empty one, but disabling the button up front is the honest UI.
  if (commitMessage.trim().length === 0) {
    return { enabled: false, reason: '请填写提交信息。' };
  }
  return { enabled: true, reason: null };
}

export function buildGitSelectionModel(
  changes: readonly { relativePath: string }[],
  selectedPaths: readonly string[]
): { allSelectableSelected: boolean; selectedCount: number } {
  const selectedPathSet = new Set(selectedPaths);
  return {
    selectedCount: selectedPaths.length,
    allSelectableSelected: changes.length > 0 && changes.every((change) => selectedPathSet.has(change.relativePath))
  };
}

export function filterGitBranches(
  branches: readonly { name: string; current: boolean }[],
  search: string
): Array<{ name: string; current: boolean }> {
  const normalized = search.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return [...branches];
  }
  return branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalized));
}

/** Diffs above this many patch characters start collapsed (large-diff handling). */
export const LARGE_DIFF_CHARACTER_THRESHOLD = 20_000;

export function isLargeGitDiff(patch: string): boolean {
  return patch.length > LARGE_DIFF_CHARACTER_THRESHOLD;
}

export function normalizeGitDiffText(patch: string): string {
  return patch.replaceAll('\r\n', '\n');
}

export function buildGitDiffTitle(file: { oldPath: string; newPath: string }): string {
  return file.oldPath === file.newPath ? file.newPath : `${file.oldPath} → ${file.newPath}`;
}

export function buildGitDiffCacheKey(diff: Pick<GitFileDiffResult, 'relativePath' | 'patch'>): string {
  return JSON.stringify([diff.relativePath, diff.patch]);
}

/**
 * Parsed diffs are kept in a bounded LRU: the panel stays mounted for the whole
 * session, so an unbounded map would grow with every file ever inspected.
 */
export const maxGitDiffParseCacheEntries = 8;

export function rememberGitDiffParse<T>(
  cache: Map<string, T>,
  key: string,
  create: () => T,
  maxEntries = maxGitDiffParseCacheEntries
): T {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('git_diff_parse_cache_limit_invalid');
  }
  const existing = cache.get(key);
  if (existing !== undefined) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const created = create();
  cache.set(key, created);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  return created;
}

/** A diff's file data, matching the subset of `react-diff-view`'s `FileData` used here. */
export function selectGitDiffFile<T extends { oldPath: string; newPath: string }>(
  files: readonly T[],
  relativePath: string
): T | null {
  if (files.length === 0) {
    return null;
  }
  const directMatch = files.find((file) => file.newPath === relativePath || file.oldPath === relativePath);
  return directMatch ?? files[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** True when the backend refused because the workspace is not a Git repository. */
export function isNotAGitRepository(code: string | undefined): boolean {
  return code === 'git_repository_missing';
}

export function gitStatus(client: RocClient): Promise<IpcLikeResult<GitStatusResult>> {
  return client.api.git.status();
}

export function gitDiffStat(client: RocClient): Promise<IpcLikeResult<GitDiffStatResult>> {
  return client.api.git.diffStat();
}

export function gitFileDiff(client: RocClient, relativePath: string): Promise<IpcLikeResult<GitFileDiffResult>> {
  const rejected = reject<GitFileDiffResult>(relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.git.fileDiff({ relativePath });
}

export function gitStageFile(client: RocClient, relativePath: string): Promise<IpcLikeResult<GitStatusResult>> {
  const rejected = reject<GitStatusResult>(relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.git.stageFile({ relativePath });
}

export function gitStageFiles(client: RocClient, relativePaths: readonly string[]): Promise<IpcLikeResult<GitStatusResult>> {
  for (const relativePath of relativePaths) {
    const rejected = reject<GitStatusResult>(relativePath);
    if (rejected !== null) {
      return Promise.resolve(rejected);
    }
  }
  return client.api.git.stageFiles({ relativePaths: [...relativePaths] });
}

export function gitUnstageFile(client: RocClient, relativePath: string): Promise<IpcLikeResult<GitStatusResult>> {
  const rejected = reject<GitStatusResult>(relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.git.unstageFile({ relativePath });
}

export function gitDiscardFile(client: RocClient, relativePath: string): Promise<IpcLikeResult<GitStatusResult>> {
  const rejected = reject<GitStatusResult>(relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.git.discardFile({ relativePath });
}

export function gitCommit(client: RocClient, message: string): Promise<IpcLikeResult<GitCommitResult>> {
  return client.api.git.commit({ message });
}

export function gitPush(client: RocClient, operationId: string): Promise<IpcLikeResult<GitPushResult>> {
  return client.api.git.push({ operationId });
}

export function gitCancelPush(client: RocClient, operationId: string): Promise<IpcLikeResult<boolean>> {
  return client.api.git.cancel({ operationId });
}

export function gitListBranches(client: RocClient): Promise<IpcLikeResult<GitBranchListResult>> {
  return client.api.git.listBranches();
}

export function gitCreateBranch(
  client: RocClient,
  name: string,
  checkoutAfterCreate: boolean
): Promise<IpcLikeResult<GitBranchMutationResult>> {
  return client.api.git.createBranch({ name, checkoutAfterCreate });
}

export function gitCheckoutBranch(client: RocClient, name: string): Promise<IpcLikeResult<GitBranchMutationResult>> {
  return client.api.git.checkoutBranch({ name });
}
