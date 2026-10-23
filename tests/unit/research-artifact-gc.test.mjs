import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Artifact GC (proposal §8): only unreferenced, idle, over-budget directories under
 * `<storage>/artifacts` are removed — and originals are never in scope.
 *
 * The policy has three gates and two of them are easy to get backwards in a way no type checks:
 *
 *   1. **referenced** — an index file still points at it, so it is the only copy of that parse's
 *      images/tables. Deleting it silently breaks a citation's locator.
 *   2. **idle** — younger than the retention window, so it may be the previous generation the user
 *      is about to look back at.
 *   3. **budget** — removal only starts once *kept* bytes exceed the budget, and stops as soon as
 *      they are under it. "Delete everything old" would pass a naive test and be wrong.
 *
 * A staging directory (`<id>.staging-<pid>-<ts>`) is a publisher that was mid-`cp` when the app
 * died; it has its own much shorter grace because nothing can ever complete it.
 */

let tempDir;
let gc;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-artifact-gc-'));
  const outfile = join(tempDir, 'artifact-gc.mjs');
  await esbuild.build({ entryPoints: ['src/main/plugins/research/artifact-gc.ts'], outfile, bundle: true,
    format: 'esm', platform: 'node', target: 'node22', packages: 'external', logLevel: 'silent' });
  gc = await import(outfile);
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** One artifact directory holding a single `payload.bin` of `bytes` bytes, aged `ageMs`. */
function artifact(root, id, bytes, ageMs, createdAt = Date.now()) {
  const path = join(root, id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'payload.bin'), Buffer.alloc(bytes));
  const at = new Date(createdAt - ageMs);
  utimesSync(path, at, at);
  return path;
}

function root() {
  return mkdtempSync(join(tempDir, 'artifacts-'));
}

test('a referenced artifact is never removed, however old and however over budget', async () => {
  const base = root();
  artifact(base, 'ref-old', 64, 400 * DAY);
  const report = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(['ref-old']), budgetBytes: 1 });
  assert.equal(report.removed, 0);
  assert.equal(existsSync(join(base, 'ref-old')), true);
});

test('an unreferenced artifact inside the retention window survives', async () => {
  const base = root();
  artifact(base, 'fresh', 64, 1 * DAY);
  const report = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(), retentionMs: 14 * DAY, budgetBytes: 1 });
  assert.equal(report.removed, 0);
  assert.equal(existsSync(join(base, 'fresh')), true);
});

test('an unreferenced idle artifact is removed only once the budget is exceeded', async () => {
  const base = root();
  artifact(base, 'old', 1024, 400 * DAY);
  // Budget above what is kept: the old artifact is "removable" but must not be touched.
  const under = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(), retentionMs: 14 * DAY, budgetBytes: 10 * 1024 });
  assert.equal(under.removed, 0);
  assert.equal(existsSync(join(base, 'old')), true);

  // Budget below it: now it goes.
  const over = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(), retentionMs: 14 * DAY, budgetBytes: 512 });
  assert.equal(over.removed, 1);
  assert.equal(over.bytesReclaimed, 1024);
  assert.equal(existsSync(join(base, 'old')), false);
});

test('it stops removing as soon as the kept bytes are back under budget', async () => {
  const base = root();
  // Three 1 KiB artifacts, oldest first.
  artifact(base, 'a-oldest', 1024, 400 * DAY);
  artifact(base, 'b-older', 1024, 300 * DAY);
  artifact(base, 'c-newer', 1024, 200 * DAY);
  const report = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(), retentionMs: 14 * DAY,
    budgetBytes: 2048 }); // room for two: only the oldest must go
  assert.equal(report.removed, 1);
  assert.equal(existsSync(join(base, 'a-oldest')), false);
  assert.equal(existsSync(join(base, 'b-older')), true);
  assert.equal(existsSync(join(base, 'c-newer')), true);
  assert.equal(report.overBudget, false);
});

test('a staging directory gets the short grace, not the retention window', async () => {
  const base = root();
  artifact(base, 'parse.dead.staging-123-456', 64, 2 * HOUR);
  const report = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(), retentionMs: 14 * DAY,
    budgetBytes: 1, now: () => Date.now() });
  // 2 hours > the 1 hour staging grace, so the crash residue goes even though it is "fresh".
  assert.equal(report.removed, 1);
  assert.equal(existsSync(join(base, 'parse.dead.staging-123-456')), false);
});

test('a staging directory that is younger than the grace survives', async () => {
  const base = root();
  artifact(base, 'parse.live.staging-1-2', 64, 1 * 60 * 1000);
  const report = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(), retentionMs: 14 * DAY, budgetBytes: 1 });
  assert.equal(report.removed, 0);
});

test('a staging directory is treated as unreferenced even if its id is in the set', async () => {
  const base = root();
  // Contrived, but the point is the guard: a staging name never counts as published.
  artifact(base, 'x.staging-1-2', 64, 2 * HOUR);
  const report = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(['x.staging-1-2']),
    retentionMs: 14 * DAY, budgetBytes: 1 });
  assert.equal(report.removed, 1);
});

test('a missing artifacts root is an empty report, not an error', async () => {
  const report = await gc.pruneResearchArtifacts({ root: join(tempDir, 'never-existed'), referenced: new Set() });
  assert.deepEqual(report, { scanned: 0, removed: 0, bytesReclaimed: 0, keptBytes: 0, overBudget: false });
});

test('a symlink under artifacts is skipped, never followed and never deleted', async () => {
  const base = root();
  const outside = join(tempDir, 'precious');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'data.bin'), Buffer.alloc(32));
  const { symlinkSync } = await import('node:fs');
  symlinkSync(outside, join(base, 'link'), 'dir');
  const report = await gc.pruneResearchArtifacts({ root: base, referenced: new Set(),
    retentionMs: 0, budgetBytes: 0 });
  assert.equal(report.removed, 0);
  assert.equal(existsSync(join(outside, 'data.bin')), true);
});
