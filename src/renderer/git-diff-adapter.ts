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

// 解析结果含整份 patch。工作台一直挂着时，不淘汰就会按打开过的 diff 一直涨。
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
