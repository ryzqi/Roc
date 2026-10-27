import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { importTypeScriptModule } from '../../lib/bundle-ts.mjs';

const fuzzysortModulePath = process.env.FUZZYSORT_MODULE ?? resolve(process.cwd(), '.runtime/fuzzysort-trial/package/fuzzysort.js');
const fuzzysort = (await import(pathToFileURL(fuzzysortModulePath).href)).default;

const { FileService } = await importTypeScriptModule('src/main/services/file-service.ts', { platform: 'node' });
const root = mkdtempSync(join(tmpdir(), 'roc-fuzzysort-snapshot-compat-'));
const workspaceA = join(root, 'workspace-a');
const workspaceB = join(root, 'workspace-b');
const external = join(root, 'external');
mkdirSync(join(workspaceA, 'docs'), { recursive: true });
mkdirSync(join(workspaceA, 'reports'), { recursive: true });
mkdirSync(join(workspaceA, 'a'), { recursive: true });
mkdirSync(join(workspaceA, 'b'), { recursive: true });
mkdirSync(join(workspaceA, 'node_modules'), { recursive: true });
mkdirSync(join(workspaceA, '.git'), { recursive: true });
mkdirSync(workspaceB, { recursive: true });
mkdirSync(external, { recursive: true });
writeFileSync(join(workspaceA, 'report.md'), '');
writeFileSync(join(workspaceA, 'docs', 'report-notes.md'), '');
writeFileSync(join(workspaceA, 'reports', 'history.md'), '');
writeFileSync(join(workspaceA, 'a', 'report.md'), '');
writeFileSync(join(workspaceA, 'b', 'report.md'), '');
writeFileSync(join(workspaceA, 'node_modules', 'secret-report.md'), '');
writeFileSync(join(workspaceA, '.git', 'secret-report.md'), '');
writeFileSync(join(external, 'linked-report.md'), '');
symlinkSync(join(external, 'linked-report.md'), join(workspaceA, 'linked-report.md'));
writeFileSync(join(workspaceB, 'foreign-report.md'), '');

const workspace = { path: workspaceA, id: 'workspace-a' };
const workspaceService = {
  getCurrentWorkspace: () => workspace,
  requireWorkspace: () => workspace,
  resolveInsideWorkspace: (relativePath) => join(workspace.path, relativePath)
};
const ripgrep = { isAvailable: () => false, search: async () => { throw new Error('unused'); } };
const service = new FileService({ tasksDir: join(root, 'tasks') }, { db: { prepare: () => ({ run() {} }) } }, workspaceService, ripgrep);
let capturedSnapshot;
const originalBuilder = service.buildFileNamePathSnapshot.bind(service);
service.buildFileNamePathSnapshot = async (workspacePath) => {
  capturedSnapshot = await originalBuilder(workspacePath);
  return capturedSnapshot;
};

function tieBreak(left, right) {
  if (left.obj.relativePath.length !== right.obj.relativePath.length) {
    return left.obj.relativePath.length - right.obj.relativePath.length;
  }
  return left.obj.relativePath.localeCompare(right.obj.relativePath);
}

function buildIndexes(snapshot) {
  return {
    basename: fuzzysort.snapshot(snapshot.entries, { key: 'normalizedName' }),
    path: fuzzysort.snapshot(snapshot.entries, { key: 'normalizedPath' })
  };
}

function searchCandidate(query, snapshot, indexes, maxResults = 20) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    const matches = snapshot.entries.slice(0, maxResults).map((obj) => ({ obj, source: 'traversal' }));
    return { matches, truncated: snapshot.truncated || snapshot.entries.length > maxResults };
  }
  const basename = fuzzysort.go(normalizedQuery, indexes.basename, { limit: maxResults, threshold: 0.25 });
  const basenameHits = [...basename].map((item) => ({ obj: item.obj, score: item.score, source: 'basename' }))
    .sort((left, right) => right.score - left.score || tieBreak(left, right));
  if (basename.total > maxResults) {
    return { matches: basenameHits.slice(0, maxResults), truncated: true };
  }
  const basenamePaths = new Set(basenameHits.map(({ obj }) => obj.relativePath));
  const pathResults = fuzzysort.go(normalizedQuery, indexes.path, {
    limit: Math.min(snapshot.entries.length, maxResults + basename.total),
    threshold: 0.25
  });
  const pathHits = [...pathResults]
    .filter(({ obj }) => !basenamePaths.has(obj.relativePath))
    .map((item) => ({ obj: item.obj, score: item.score, source: 'path' }))
    .sort((left, right) => right.score - left.score || tieBreak(left, right));
  return {
    matches: [...basenameHits, ...pathHits].slice(0, maxResults),
    truncated: snapshot.truncated || pathResults.total > maxResults
  };
}

try {
  const unicodeProbe = join(root, 'unicode-normalization-probe');
  mkdirSync(unicodeProbe);
  writeFileSync(join(unicodeProbe, 'café.md'), '');
  writeFileSync(join(unicodeProbe, 'cafe\u0301.md'), '');
  const unicodeProbeNames = readdirSync(unicodeProbe);
  const baselineA = await service.searchByName({ query: 'report', maxResults: 20 });
  assert.ok(capturedSnapshot);
  const snapshotA = capturedSnapshot;
  const indexesA = buildIndexes(snapshotA);
  const candidateA = searchCandidate('report', snapshotA, indexesA, 20);
  const candidateAAgain = searchCandidate('report', snapshotA, indexesA, 20);
  const candidatePathsA = candidateA.matches.map(({ obj }) => obj.relativePath);
  const tiePaths = new Set(['a/report.md', 'b/report.md']);
  const candidateTies = candidateA.matches.filter(({ obj }) => tiePaths.has(obj.relativePath));
  const baselineTiePaths = baselineA.matches.filter(({ relativePath }) => tiePaths.has(relativePath)).map(({ relativePath }) => relativePath);
  assert.equal(candidateTies.length, 2);
  assert.equal(candidateTies[0].score, candidateTies[1].score);
  assert.deepEqual(candidateTies.map(({ obj }) => obj.relativePath), baselineTiePaths);
  assert.ok(candidatePathsA.includes('report.md'));
  assert.ok(candidatePathsA.includes('docs/report-notes.md'));
  assert.ok(candidatePathsA.includes('reports/history.md'));
  assert.ok(candidatePathsA.every((path) => !path.startsWith('node_modules/') && !path.startsWith('.git/')));
  assert.ok(!candidatePathsA.includes('linked-report.md'));
  assert.equal(new Set(candidatePathsA).size, candidatePathsA.length);
  assert.deepEqual(candidateAAgain.matches.map(({ obj }) => obj.relativePath), candidatePathsA);
  assert.ok(candidateA.matches.findIndex(({ source }) => source === 'path') > candidateA.matches.findLastIndex(({ source }) => source === 'basename'));
  assert.equal(candidateA.truncated, baselineA.truncated);
  const limitedA = searchCandidate('report', snapshotA, indexesA, 2);
  assert.equal(limitedA.matches.length, 2);
  assert.equal(limitedA.truncated, (await service.searchByName({ query: 'report', maxResults: 2 })).truncated);

  workspace.path = workspaceB;
  workspace.id = 'workspace-b';
  service.invalidateAllFileNameSnapshots();
  const baselineB = await service.searchByName({ query: 'report', maxResults: 20 });
  const snapshotB = capturedSnapshot;
  const indexesB = buildIndexes(snapshotB);
  const candidateB = searchCandidate('report', snapshotB, indexesB, 20);
  assert.deepEqual(candidateB.matches.map(({ obj }) => obj.relativePath), ['foreign-report.md']);
  assert.deepEqual(baselineB.matches.map(({ relativePath }) => relativePath), ['foreign-report.md']);
  assert.equal(candidateB.truncated, baselineB.truncated);

  const baselineEmpty = await service.searchByName({ query: '', maxResults: 20 });
  const candidateEmpty = searchCandidate('', snapshotB, indexesB, 20);
  assert.deepEqual(candidateEmpty.matches.map(({ obj }) => obj.relativePath), baselineEmpty.matches.map(({ relativePath }) => relativePath));
  assert.equal(candidateEmpty.truncated, baselineEmpty.truncated);

  console.log(JSON.stringify({
    status: 'passed',
    checks: {
      actualFileServiceSnapshot: true,
      ignoredNodeModulesAndGitDirectoriesExcluded: true,
      symlinkExcluded: true,
      basenameHitsRankBeforePathOnlyHits: true,
      duplicatePathsRemoved: true,
      stableTies: true,
      candidateTieOrderMatchesBaseline: true,
      maxResultsTruncationMatchesBaseline: true,
      emptyQueryTraversalOrderAndTruncationMatch: true,
      workspaceSnapshotsStayIsolated: true
    },
    workspaceAEntries: snapshotA.entries.length,
    workspaceBEntries: snapshotB.entries.length,
    unicodeCanonicalPathProbe: {
      requestedNames: ['café.md', 'cafe\u0301.md'],
      observedNames: unicodeProbeNames,
      observedCodePoints: unicodeProbeNames.map((name) => Array.from(name).map((character) => character.codePointAt(0).toString(16)))
    },
    candidateA: candidatePathsA,
    candidateB: candidateB.matches.map(({ obj }) => obj.relativePath)
  }, null, 2));
} finally {
  fuzzysort.cleanup();
  rmSync(root, { recursive: true, force: true });
}
