import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the P3 workspace data layer.
 *
 * Three pure surfaces are worth guarding, because each one is a place where a
 * small mistake is invisible until a user hits it:
 *
 *   1. `planChangedDirectories` — which directories a watcher event invalidates.
 *      Get it wrong and the tree silently keeps stale rows (gate 1).
 *   2. `git-store`'s decision helpers (grouping, selection, commit gating, the
 *      parse cache bound) — ported from the legacy shell, so the tests also
 *      document *why* each case exists.
 *   3. `git-store`'s path rejection — the Git half of R10. It must refuse before
 *      the IPC call, which the fake client below proves by having no methods.
 */

let gitStore;
let fileTree;
let rtk;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
  const build = async (entry, name) => {
    const outfile = join(tempDir, name);
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'node22',
      logLevel: 'silent'
    });
    return import(outfile);
  };
  gitStore = await build('src/renderer/workspace/git-store.ts', 'git-store.mjs');
  fileTree = await build('src/renderer/workspace/use-file-tree.ts', 'use-file-tree.mjs');
  rtk = await build('src/renderer/workspace/use-rtk-status.ts', 'use-rtk-status.mjs');
});

after(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Watcher refresh planning                                            */
/* ------------------------------------------------------------------ */

test('a watcher event reloads the root and only the directories it can affect', () => {
  const cached = ['', 'src', 'src/app', 'docs'];
  const targets = fileTree.planChangedDirectories('src/app/main.ts', cached).sort();
  // Root, the file's own directory, and every cached ancestor of it. `docs` is
  // untouched: reloading it would be a wasted round trip per keystroke.
  assert.deepEqual(targets, ['', 'src', 'src/app']);
});

test('a whole-workspace event reloads every listed directory', () => {
  const cached = ['', 'src', 'src/app'];
  assert.deepEqual(fileTree.planChangedDirectories(null, cached).sort(), ['', 'src', 'src/app']);
});

test('a top-level change reloads the root and nothing else', () => {
  assert.deepEqual(fileTree.planChangedDirectories('README.md', ['', 'src']).sort(), ['']);
});

test('a sibling prefix is not mistaken for an ancestor', () => {
  // "src2" starts with "src" but is not inside it; a naive startsWith() check
  // would reload `src` for every change in `src2`.
  assert.deepEqual(fileTree.planChangedDirectories('src2/a.ts', ['', 'src', 'src2']).sort(), ['', 'src2']);
});

test('a path reveals exactly its ancestor directories, outermost first', () => {
  assert.deepEqual(fileTree.ancestorDirectoriesOf('a/b/c.ts'), ['a', 'a/b']);
  assert.deepEqual(fileTree.ancestorDirectoriesOf('top.ts'), []);
  assert.deepEqual(fileTree.ancestorDirectoriesOf('.hidden/dir/f.md'), ['.hidden', '.hidden/dir']);
});

test('row indices clamp instead of pointing past the end', () => {
  // The F13 lesson: an index into a list that can shrink must be clamped where it
  // is used, not only maintained by event handlers.
  assert.equal(fileTree.clampRowIndex(5, 9), 4);
  assert.equal(fileTree.clampRowIndex(5, -3), 0);
  assert.equal(fileTree.clampRowIndex(0, 0), -1);
});

test('the parent row is found by path, not by depth arithmetic', () => {
  const rows = [
    { entry: { name: 'a', relativePath: 'a', type: 'directory' }, depth: 0, expanded: true },
    { entry: { name: 'x.ts', relativePath: 'a/x.ts', type: 'file' }, depth: 1, expanded: false },
    { entry: { name: 'b', relativePath: 'b', type: 'directory' }, depth: 0, expanded: false }
  ];
  assert.equal(fileTree.findParentRowIndex(rows, 1), 0);
  assert.equal(fileTree.findParentRowIndex(rows, 2), null);
  // A filtered window (only some rows rendered) must not invent a parent.
  assert.equal(fileTree.findParentRowIndex([rows[1]], 0), null);
});

test('type-ahead wraps, is case-insensitive, and reports no match honestly', () => {
  const rows = ['alpha.ts', 'beta.ts', 'Binary.md', 'gamma.ts'].map((name) => ({
    entry: { name, relativePath: name, type: 'file' },
    depth: 0,
    expanded: false
  }));
  assert.equal(fileTree.findTypeAheadRowIndex(rows, 0, 'b'), 1);
  assert.equal(fileTree.findTypeAheadRowIndex(rows, 2, 'b'), 2);
  // Wrapping: from the last row, "a" finds the first row again.
  assert.equal(fileTree.findTypeAheadRowIndex(rows, 3, 'a'), 0);
  assert.equal(fileTree.findTypeAheadRowIndex(rows, 0, 'zz'), null);
  assert.equal(fileTree.findTypeAheadRowIndex(rows, 0, ''), null);
  assert.equal(fileTree.findTypeAheadRowIndex([], 0, 'a'), null);
});

/* ------------------------------------------------------------------ */
/* Git: grouping, selection, gating                                    */
/* ------------------------------------------------------------------ */

const change = (porcelain, index, worktree, relativePath) => ({ porcelain, index, worktree, relativePath });

test('changes are grouped into staged / unstaged / untracked', () => {
  const stagedOnly = change('M  a.ts', 'M', ' ', 'a.ts');
  const bothStagedAndModified = change('MM b.ts', 'M', 'M', 'b.ts');
  const modified = change(' M c.ts', ' ', 'M', 'c.ts');
  const untracked = change('?? d.ts', '?', '?', 'd.ts');
  const groups = gitStore.groupGitChanges([stagedOnly, bothStagedAndModified, modified, untracked]);

  assert.deepEqual(
    groups.staged.map((entry) => entry.relativePath),
    ['a.ts', 'b.ts']
  );
  // A staged file that was modified again must appear in *both* groups: merging
  // the rows would hide the second edit.
  assert.deepEqual(
    groups.unstaged.map((entry) => entry.relativePath),
    ['b.ts', 'c.ts']
  );
  assert.deepEqual(
    groups.untracked.map((entry) => entry.relativePath),
    ['d.ts']
  );
});

test('only rows with work left are offered for batch staging', () => {
  const stagedOnly = change('M  a.ts', 'M', ' ', 'a.ts');
  const modified = change(' M c.ts', ' ', 'M', 'c.ts');
  const untracked = change('?? d.ts', '?', '?', 'd.ts');
  assert.deepEqual(
    gitStore.selectableGitChanges([stagedOnly, modified, untracked]).map((entry) => entry.relativePath),
    ['c.ts', 'd.ts']
  );
  assert.equal(gitStore.canUnstageGitChange(stagedOnly), true);
  assert.equal(gitStore.canUnstageGitChange(untracked), false);
});

test('the change state label distinguishes the mixed case', () => {
  assert.equal(gitStore.buildGitChangeStateLabel(change('?? d.ts', '?', '?', 'd.ts')), '未跟踪');
  assert.equal(gitStore.buildGitChangeStateLabel(change('MM b.ts', 'M', 'M', 'b.ts')), '已暂存 + 工作区修改');
  assert.equal(gitStore.buildGitChangeStateLabel(change('M  a.ts', 'M', ' ', 'a.ts')), '已暂存');
  assert.equal(gitStore.buildGitChangeStateLabel(change(' M c.ts', ' ', 'M', 'c.ts')), '工作区修改');
});

test('a selection is pruned to the paths that still have changes', () => {
  const changes = [change('M  a.ts', 'M', ' ', 'a.ts')];
  assert.deepEqual(gitStore.pruneGitSelection(changes, ['a.ts', 'gone.ts']), ['a.ts']);
  assert.deepEqual(gitStore.pruneGitSelection([], ['a.ts']), []);
});

test('focus survives a refresh while the file still has changes', () => {
  const changes = [change('M  a.ts', 'M', ' ', 'a.ts'), change('M  b.ts', 'M', ' ', 'b.ts')];
  assert.equal(gitStore.findNextGitSelection(changes, 'b.ts'), 'b.ts');
  assert.equal(gitStore.findNextGitSelection(changes, null), 'a.ts');
  // The previous focus is gone: fall back to the first path in sorted order
  // rather than leaving the diff pane pointing at a file that no longer differs.
  assert.equal(gitStore.findNextGitSelection(changes, 'zzz.ts'), 'a.ts');
  assert.equal(gitStore.findNextGitSelection([], 'a.ts'), null);
});

test('commit is blocked with a reason until there are changes and a message', () => {
  assert.deepEqual(
    gitStore.buildGitCommitButtonState({ actionBusy: true, changedFiles: 2, commitMessage: 'x', writable: true }),
    { enabled: false, reason: '正在执行上一步操作。' }
  );
  assert.equal(
    gitStore.buildGitCommitButtonState({
      actionBusy: false,
      changedFiles: 0,
      commitMessage: 'x',
      writable: true
    }).enabled,
    false
  );
  // Whitespace is not a commit message; the backend schema would reject it.
  assert.deepEqual(
    gitStore.buildGitCommitButtonState({ actionBusy: false, changedFiles: 1, commitMessage: '   ', writable: true }),
    { enabled: false, reason: '请填写提交信息。' }
  );
  assert.deepEqual(
    gitStore.buildGitCommitButtonState({ actionBusy: false, changedFiles: 1, commitMessage: ' fix ', writable: true }),
    { enabled: true, reason: null }
  );
});

test('an archived project cannot commit, and says so instead of "busy"', () => {
  // The read-only gate must be reported as read-only: reusing the busy reason
  // would tell the user to wait for an operation that does not exist.
  assert.deepEqual(
    gitStore.buildGitCommitButtonState({ actionBusy: false, changedFiles: 3, commitMessage: 'fix', writable: false }),
    { enabled: false, reason: '项目已归档，仅可阅读。' }
  );
});

test('the batch selection model tracks count and all-selected', () => {
  const changes = [{ relativePath: 'a.ts' }, { relativePath: 'b.ts' }];
  assert.deepEqual(gitStore.buildGitSelectionModel(changes, ['a.ts']), {
    selectedCount: 1,
    allSelectableSelected: false
  });
  assert.deepEqual(gitStore.buildGitSelectionModel(changes, ['a.ts', 'b.ts']), {
    selectedCount: 2,
    allSelectableSelected: true
  });
  // No candidates at all must not read as "everything is selected".
  assert.equal(gitStore.buildGitSelectionModel([], []).allSelectableSelected, false);
});

test('branch filtering is case-insensitive and trims the query', () => {
  const branches = [
    { name: 'main', current: true },
    { name: 'feat/ROC-1', current: false }
  ];
  assert.deepEqual(gitStore.filterGitBranches(branches, ' ROC ').map((branch) => branch.name), ['feat/ROC-1']);
  assert.equal(gitStore.filterGitBranches(branches, '').length, 2);
});

/* ------------------------------------------------------------------ */
/* Git: diff handling                                                  */
/* ------------------------------------------------------------------ */

test('only genuinely large patches start collapsed', () => {
  assert.equal(gitStore.isLargeGitDiff('a'.repeat(gitStore.LARGE_DIFF_CHARACTER_THRESHOLD)), false);
  assert.equal(gitStore.isLargeGitDiff('a'.repeat(gitStore.LARGE_DIFF_CHARACTER_THRESHOLD + 1)), true);
});

test('CRLF patches are normalised before parsing', () => {
  assert.equal(gitStore.normalizeGitDiffText('a\r\nb\r\n'), 'a\nb\n');
});

test('the diff file is selected by path, falling back to the first entry', () => {
  const files = [
    { oldPath: 'a.ts', newPath: 'a.ts' },
    { oldPath: 'b.ts', newPath: 'c.ts' }
  ];
  assert.equal(gitStore.selectGitDiffFile(files, 'c.ts')?.newPath, 'c.ts');
  assert.equal(gitStore.selectGitDiffFile(files, 'b.ts')?.newPath, 'c.ts');
  assert.equal(gitStore.selectGitDiffFile(files, 'missing.ts')?.newPath, 'a.ts');
  assert.equal(gitStore.selectGitDiffFile([], 'a.ts'), null);
});

test('the parse cache is bounded and refreshes recency', () => {
  const cache = new Map();
  let created = 0;
  const create = (key) => {
    created += 1;
    return `parsed:${key}`;
  };
  gitStore.rememberGitDiffParse(cache, 'a', () => create('a'), 2);
  gitStore.rememberGitDiffParse(cache, 'b', () => create('b'), 2);
  // Touching "a" must make "b" the eviction candidate, not "a".
  gitStore.rememberGitDiffParse(cache, 'a', () => create('a'), 2);
  gitStore.rememberGitDiffParse(cache, 'c', () => create('c'), 2);
  assert.equal(cache.size, 2);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), true);
  assert.equal(created, 3);
  assert.throws(() => gitStore.rememberGitDiffParse(cache, 'd', () => create('d'), 0));
});

test('the cache key changes with the patch, not only with the path', () => {
  const first = gitStore.buildGitDiffCacheKey({ relativePath: 'a.ts', patch: '@@ -1 +1 @@' });
  const second = gitStore.buildGitDiffCacheKey({ relativePath: 'a.ts', patch: '@@ -2 +2 @@' });
  assert.notEqual(first, second);
});

test('the diff title shows both sides of a rename', () => {
  assert.equal(gitStore.buildGitDiffTitle({ oldPath: 'a.ts', newPath: 'a.ts' }), 'a.ts');
  assert.equal(gitStore.buildGitDiffTitle({ oldPath: 'a.ts', newPath: 'b.ts' }), 'a.ts → b.ts');
});

/* ------------------------------------------------------------------ */
/* R10 on the Git side                                                 */
/* ------------------------------------------------------------------ */

test('escaping paths are refused before any IPC call', async () => {
  // No methods at all: if the guard ran late, this would throw instead.
  const clientWithNoApi = { api: Object.freeze({ git: Object.freeze({}) }) };
  for (const path of ['../outside.ts', '/etc/passwd', 'src/../../up.ts', 'a\0b']) {
    const diff = await gitStore.gitFileDiff(clientWithNoApi, path);
    assert.equal(diff.ok, false, path);
    assert.match(diff.error.message, /相对路径|不能越出|非法字符/u);
    assert.equal(diff.error.code, 'renderer_path_rejected');

    const stage = await gitStore.gitStageFile(clientWithNoApi, path);
    assert.equal(stage.ok, false, path);

    const batch = await gitStore.gitStageFiles(clientWithNoApi, ['ok.ts', path]);
    assert.equal(batch.ok, false, path);
  }
});

/* ------------------------------------------------------------------ */
/* RTK summary                                                         */
/* ------------------------------------------------------------------ */

const rtkBase = {
  binaryPath: '/opt/rtk/bin/rtk',
  configPath: '/Users/x/.rtk/config.toml',
  teeDir: '/tmp/rtk-tee'
};

test('RTK reads as enabled, degraded, or bypassed with a reason', () => {
  const enabled = rtk.describeRtkStatus({
    ...rtkBase,
    enabledForAgentCommands: true,
    resourceState: 'ready'
  });
  assert.equal(enabled.tone, 'ok');
  assert.match(enabled.label, /已启用/u);
  assert.match(enabled.detail, /binary: \/opt\/rtk\/bin\/rtk/u);

  const missing = rtk.describeRtkStatus({
    ...rtkBase,
    enabledForAgentCommands: true,
    resourceState: 'missing'
  });
  assert.equal(missing.tone, 'warn');

  const bypassed = rtk.describeRtkStatus({
    ...rtkBase,
    enabledForAgentCommands: false,
    resourceState: 'ready',
    bypassReason: 'user_terminal_raw_output'
  });
  assert.equal(bypassed.tone, 'muted');
  assert.match(bypassed.label, /用户在终端直接输入命令/u);

  // An unknown bypass reason must not print an enum value at the user.
  const unknown = rtk.describeRtkStatus({
    ...rtkBase,
    enabledForAgentCommands: false,
    resourceState: 'ready'
  });
  assert.match(unknown.label, /未对 Agent 命令启用/u);
});
