import type { FileData } from 'react-diff-view';
import type { GitFileDiffResult } from '../shared/types';

export function normalizeGitDiffText(patch: string): string {
  return patch.replaceAll('\r\n', '\n');
}

export function selectGitDiffFile<T extends { oldPath: string; newPath: string }>(
  files: T[],
  relativePath: string
): T | null {
  if (files.length === 0) {
    return null;
  }
  const directMatch = files.find((file) => file.newPath === relativePath || file.oldPath === relativePath);
  return directMatch ?? files[0] ?? null;
}

export function buildGitDiffTitle(file: FileData): string {
  return file.oldPath === file.newPath ? file.newPath : `${file.oldPath} → ${file.newPath}`;
}

export function buildGitDiffCacheKey(diff: Pick<GitFileDiffResult, 'relativePath' | 'patch'>): string {
  return JSON.stringify([diff.relativePath, diff.patch]);
}
