import { describe, expect, it } from 'vitest';
import type { FileData } from 'react-diff-view';
import {
  buildGitDiffCacheKey,
  buildGitDiffTitle,
  normalizeGitDiffText,
  selectGitDiffFile
} from '../../src/renderer/git-diff-adapter';

describe('git diff adapter', () => {
  it('normalizes git diff text for react-diff-view parsing', () => {
    const result = normalizeGitDiffText(`\r\ndiff --git a/src/App.tsx b/src/App.tsx\r\nindex 1111111..2222222 100644\r\n--- a/src/App.tsx\r\n+++ b/src/App.tsx\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n`);

    expect(result).toBe(
      '\ndiff --git a/src/App.tsx b/src/App.tsx\nindex 1111111..2222222 100644\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    );
  });

  it('selects the matching diff file by current path', () => {
    const files = [
      { oldPath: 'src/one.ts', newPath: 'src/one.ts' },
      { oldPath: 'src/two.ts', newPath: 'src/two.ts' }
    ] as unknown as Array<{ oldPath: string; newPath: string }>;

    expect(selectGitDiffFile(files, 'src/two.ts')).toBe(files[1]);
    expect(selectGitDiffFile(files, 'src/missing.ts')).toBe(files[0]);
    expect(selectGitDiffFile([], 'src/missing.ts')).toBe(null);
  });

  it('builds a single path title when old and new paths match', () => {
    const file = { oldPath: 'src/renderer/App.tsx', newPath: 'src/renderer/App.tsx' } as FileData;

    expect(buildGitDiffTitle(file)).toBe('src/renderer/App.tsx');
  });

  it('keeps old and new paths in the title for renames', () => {
    const file = { oldPath: 'src/old-name.ts', newPath: 'src/new-name.ts' } as FileData;

    expect(buildGitDiffTitle(file)).toBe('src/old-name.ts \u2192 src/new-name.ts');
  });

  it('builds diff parse cache keys from the selected path and patch text', () => {
    const firstKey = buildGitDiffCacheKey({
      relativePath: 'src/renderer/App.tsx',
      patch: 'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    });
    const sameKey = buildGitDiffCacheKey({
      relativePath: 'src/renderer/App.tsx',
      patch: 'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    });
    const differentPathKey = buildGitDiffCacheKey({
      relativePath: 'src/renderer/styles.css',
      patch: 'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx\n@@ -1 +1 @@\n-old\n+new\n'
    });
    const differentPatchKey = buildGitDiffCacheKey({
      relativePath: 'src/renderer/App.tsx',
      patch: 'diff --git a/src/renderer/App.tsx b/src/renderer/App.tsx\n@@ -1 +1 @@\n-old\n+newer\n'
    });

    expect(sameKey).toBe(firstKey);
    expect(differentPathKey).not.toBe(firstKey);
    expect(differentPatchKey).not.toBe(firstKey);
  });
});
