import { describe, expect, it } from 'vitest';
import { normalizeGitDiffText, selectGitDiffFile } from '../../src/renderer/git-diff-adapter';

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
});
