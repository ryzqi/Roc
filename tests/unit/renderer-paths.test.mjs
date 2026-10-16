import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the workspace-relative path rules (R10).
 *
 * `files.*` and `git.*` take a **relative** path, so the renderer's share of R10
 * is refusing to *send* escaping paths — an immediate, specific error instead of
 * a round trip that may fail vaguely. These tests are the guard for that.
 *
 * `paths.ts` has no imports at all, so it bundles to a dependency-free module.
 */

let paths;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-paths-'));
  const outfile = join(tempDir, 'paths.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer/workspace/paths.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  paths = await import(outfile);
});

after(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('the empty path is valid: it names the workspace root', () => {
  assert.deepEqual(paths.checkRelativePath(''), { ok: true });
});

test('ordinary nested relative paths are accepted', () => {
  for (const path of ['README.md', 'src/main/index.ts', 'a/b/c/d.tex', 'assets/图 1.png']) {
    assert.deepEqual(paths.checkRelativePath(path), { ok: true }, path);
  }
});

test('absolute paths are rejected', () => {
  for (const path of ['/etc/passwd', '~/secrets', 'C:/Windows', '\\\\server\\share']) {
    const result = paths.checkRelativePath(path);
    assert.equal(result.ok, false, path);
    assert.equal(result.reason, path.startsWith('C:') || path.startsWith('\\\\') ? 'absolute' : 'absolute');
  }
});

test('any traversal segment is rejected', () => {
  for (const path of ['..', '../x', 'a/../../b', 'a/..', '..\\x']) {
    const result = paths.checkRelativePath(path);
    assert.equal(result.ok, false, path);
    assert.equal(result.reason, 'escapes_workspace', path);
  }
});

test('a dot-prefixed name is not traversal', () => {
  assert.deepEqual(paths.checkRelativePath('.gitignore'), { ok: true });
  assert.deepEqual(paths.checkRelativePath('.config/tool.yml'), { ok: true });
});

test('NUL bytes and trailing/doubled separators are rejected', () => {
  assert.equal(paths.checkRelativePath('a\0b').reason, 'nul_byte');
  assert.equal(paths.checkRelativePath('dir/').reason, 'empty_segment');
  assert.equal(paths.checkRelativePath('dir//file').reason, 'empty_segment');
});

test('over-long paths are rejected', () => {
  assert.equal(paths.checkRelativePath('a'.repeat(1025)).reason, 'too_long');
});

test('isSafeRelativePath agrees with checkRelativePath', () => {
  assert.equal(paths.isSafeRelativePath('src/a.ts'), true);
  assert.equal(paths.isSafeRelativePath('../a.ts'), false);
});

test('joinRelative and parentRelative round-trip', () => {
  assert.equal(paths.joinRelative('', 'a.txt'), 'a.txt');
  assert.equal(paths.joinRelative('src', 'a.ts'), 'src/a.ts');
  assert.equal(paths.joinRelative('src', ''), 'src');
  assert.equal(paths.parentRelative('src/a.ts'), 'src');
  assert.equal(paths.parentRelative('a.ts'), '');
  assert.equal(paths.fileName('src/a.ts'), 'a.ts');
  assert.equal(paths.fileName('a.ts'), 'a.ts');
});

test('extensionOf ignores dotfiles and lowercases', () => {
  assert.equal(paths.extensionOf('a.TEX'), 'tex');
  assert.equal(paths.extensionOf('dir/b.PDF'), 'pdf');
  assert.equal(paths.extensionOf('.gitignore'), '');
  assert.equal(paths.extensionOf('Makefile'), '');
});

test('previewKindFor routes pdf/image/markdown/latex/code/text/binary', () => {
  const cases = [
    ['a.pdf', 'pdf'],
    ['a.PNG', 'image'],
    ['a.svg', 'image'],
    ['a.md', 'markdown'],
    ['a.tex', 'latex'],
    ['a.sty', 'latex'],
    ['a.ts', 'code'],
    ['a.py', 'code'],
    ['a.bib', 'text'],
    ['a.unknownext', 'binary'],
    ['README', 'text']
  ];
  for (const [path, expected] of cases) {
    assert.equal(paths.previewKindFor(path), expected, path);
  }
});

test('binary and pdf previews are not editable', () => {
  assert.equal(paths.isEditablePreviewKind('pdf'), false);
  assert.equal(paths.isEditablePreviewKind('binary'), false);
  assert.equal(paths.isEditablePreviewKind('text'), true);
  assert.equal(paths.isEditablePreviewKind('code'), true);
  assert.equal(paths.isEditablePreviewKind('latex'), true);
  assert.equal(paths.isEditablePreviewKind('markdown'), true);
});

test('tree entries sort directories first, then hidden last', () => {
  const entries = [
    { name: 'z.txt', type: 'file' },
    { name: 'src', type: 'directory' },
    { name: '.env', type: 'file' },
    { name: 'A.txt', type: 'file' },
    { name: '.git', type: 'directory' }
  ];
  assert.deepEqual([...entries].sort(paths.compareTreeEntries).map((entry) => entry.name), [
    'src',
    '.git',
    'A.txt',
    'z.txt',
    '.env'
  ]);
});

test('every rejection has a specific message', () => {
  for (const reason of ['absolute', 'escapes_workspace', 'nul_byte', 'empty_segment', 'too_long']) {
    const message = paths.pathRejectionMessage(reason);
    assert.ok(message.length > 0, reason);
    assert.notEqual(message, paths.pathRejectionMessage('unknown-reason'), reason);
  }
});
