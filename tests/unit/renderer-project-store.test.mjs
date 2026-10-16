import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the project portal's pure rules (P2/T2.1, T2.2, T2.5).
 *
 * These lock three product decisions that a future refactor could silently
 * reverse, because all three are one-liners that look interchangeable:
 *
 *   1. 进行中 means **not archived**, not `status === 'active'` — otherwise
 *      paused/completed projects would vanish from the default view.
 *   2. archived projects are read-only (`isProjectWritable`), a single predicate
 *      every panel must share.
 *   3. pinning **reorders but never filters**, so a pinned archived project
 *      cannot leak into 进行中.
 *
 * `project-store.ts` has only type-only imports, so bundling it with esbuild
 * (already a devDependency) yields a dependency-free module to import.
 */

let store;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-project-store-'));
  const outfile = join(tempDir, 'project-store.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer/project/project-store.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  store = await import(outfile);
});

after(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function project(overrides = {}) {
  return {
    id: 'p1',
    title: '示例项目',
    description: '研究目标',
    workspacePath: '/tmp/ws',
    status: 'active',
    language: 'zh',
    origin: null,
    currentStage: 'discovery',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides
  };
}

test('进行中 includes paused and completed, excludes only archived', () => {
  const { matchesStatusFilter } = store;
  for (const status of ['active', 'paused', 'completed']) {
    assert.equal(matchesStatusFilter(project({ status }), 'active'), true, `${status} must count as 进行中`);
  }
  assert.equal(matchesStatusFilter(project({ status: 'archived' }), 'active'), false);
});

test('archived filter shows only archived; all shows everything', () => {
  const { matchesStatusFilter } = store;
  for (const status of ['active', 'paused', 'completed']) {
    assert.equal(matchesStatusFilter(project({ status }), 'archived'), false);
    assert.equal(matchesStatusFilter(project({ status }), 'all'), true);
  }
  assert.equal(matchesStatusFilter(project({ status: 'archived' }), 'archived'), true);
  // The `all` branch must include archived too — it is the one filter that does.
  assert.equal(matchesStatusFilter(project({ status: 'archived' }), 'all'), true);
});

test('isProjectWritable: archived is read-only, everything else is writable, null is not', () => {
  const { isProjectWritable } = store;
  assert.equal(isProjectWritable(null), false);
  assert.equal(isProjectWritable(project({ status: 'archived' })), false);
  assert.equal(isProjectWritable(project({ status: 'active' })), true);
  assert.equal(isProjectWritable(project({ status: 'paused' })), true);
  assert.equal(isProjectWritable(project({ status: 'completed' })), true);
});

test('query matches title, description and workspacePath case-insensitively', () => {
  const { matchesQuery } = store;
  assert.equal(matchesQuery(project({ title: 'Quantum Notes' }), 'quantum'), true);
  assert.equal(matchesQuery(project({ description: '关于扩散模型' }), '扩散'), true);
  assert.equal(matchesQuery(project({ workspacePath: '/Users/x/Repos/Alpha' }), 'repos'), true);
  assert.equal(matchesQuery(project(), 'nope'), false);
  assert.equal(matchesQuery(project(), '   '), true, 'blank query matches everything');
  // `workspacePath` is nullable; the `?? false` branch must not throw.
  assert.equal(matchesQuery(project({ workspacePath: null }), 'anything'), false);
  assert.equal(matchesQuery(project({ workspacePath: null, title: 'Alpha' }), 'alpha'), true);
});

test('pinning reorders first but never filters', () => {
  const { visibleProjects } = store;
  const projects = [
    project({ id: 'a', updatedAt: '2026-03-01T00:00:00.000Z' }),
    project({ id: 'b', updatedAt: '2026-02-01T00:00:00.000Z' }),
    project({ id: 'c', updatedAt: '2026-01-01T00:00:00.000Z' })
  ];
  const pinned = visibleProjects(projects, { query: '', filter: 'all', pinnedIds: ['c'] });
  assert.deepEqual(
    pinned.map((entry) => entry.id),
    ['c', 'a', 'b']
  );
  // A pinned ARCHIVED project must not appear under 进行中.
  const archived = project({ id: 'd', status: 'archived' });
  const active = visibleProjects([...projects, archived], { query: '', filter: 'active', pinnedIds: ['d'] });
  assert.equal(active.some((entry) => entry.id === 'd'), false);
});

test('sortProjects orders by updatedAt desc within the same pin group', () => {
  const { sortProjects } = store;
  const sorted = sortProjects(
    [
      project({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      project({ id: 'new', updatedAt: '2026-06-01T00:00:00.000Z' })
    ],
    []
  );
  assert.deepEqual(sorted.map((entry) => entry.id), ['new', 'old']);
});

test('sortProjects does not mutate the input array', () => {
  const { sortProjects } = store;
  const input = [project({ id: 'a' }), project({ id: 'b', updatedAt: '2026-09-01T00:00:00.000Z' })];
  const snapshot = input.map((entry) => entry.id);
  sortProjects(input, []);
  assert.deepEqual(input.map((entry) => entry.id), snapshot);
});

test('stage and status labels use the product vocabulary from CONTEXT.md', () => {
  const { projectStageLabel, projectStatusLabel, STAGE_LABELS } = store;
  assert.equal(projectStageLabel('experiment'), '实验/数据');
  assert.equal(projectStageLabel('export'), '导出');
  assert.equal(projectStatusLabel('archived'), '已归档');
  assert.equal(projectStatusLabel('paused'), '已暂停');
  assert.equal(Object.keys(STAGE_LABELS).length, 11, 'the backend has exactly 11 workflow stages');
});

test('isLanguageLocked is true (the UI fixes language at creation)', () => {
  assert.equal(store.isLanguageLocked(), true);
});
