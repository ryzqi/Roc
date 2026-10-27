import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { importTypeScriptModule } from '../../lib/bundle-ts.mjs';

const corpusSize = Number(process.env.CORPUS_SIZE ?? 20_000);
const maxResults = 20;
const samples = 20;
const fuzzyThreshold = 0.25;
const scriptPath = fileURLToPath(import.meta.url);
const fuzzysortModulePath = process.env.FUZZYSORT_MODULE ?? resolve(process.cwd(), '.runtime/fuzzysort-trial/package/fuzzysort.js');

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50Ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3))
  };
}

function createService(FileService, workspacePath) {
  const workspace = { path: workspacePath, id: `workspace:${workspacePath}` };
  const workspaceService = { getCurrentWorkspace: () => workspace, requireWorkspace: () => workspace };
  const ripgrep = { isAvailable: () => false, search: async () => { throw new Error('unused'); } };
  return new FileService({}, { db: null }, workspaceService, ripgrep);
}

function tieBreak(left, right) {
  if (left.obj.relativePath.length !== right.obj.relativePath.length) {
    return left.obj.relativePath.length - right.obj.relativePath.length;
  }
  return left.obj.relativePath.localeCompare(right.obj.relativePath);
}

function fuzzySearch(fuzzysort, query, entries, basenameIndex, pathIndex, limit, snapshotTruncated) {
  const normalizedQuery = query.trim().toLowerCase();
  const basenameResults = fuzzysort.go(normalizedQuery, basenameIndex, { limit, threshold: fuzzyThreshold });
  const basenameHits = [...basenameResults]
    .map((result) => ({ obj: result.obj, score: result.score, source: 'basename' }))
    .sort((left, right) => right.score - left.score || tieBreak(left, right));
  const basenamePaths = new Set(basenameHits.map(({ obj }) => obj.relativePath));

  if (basenameResults.total > limit) {
    return { matches: basenameHits.slice(0, limit), total: basenameResults.total, truncated: true };
  }
  const pathLimit = Math.min(entries.length, limit + basenameResults.total);
  const pathResults = fuzzysort.go(normalizedQuery, pathIndex, { limit: pathLimit, threshold: fuzzyThreshold });
  assert.ok(pathResults.total >= basenameResults.total, `basename matches must be included in full-path matches for ${query}`);
  const pathOnlyHits = [...pathResults]
    .filter((result) => !basenamePaths.has(result.obj.relativePath))
    .map((result) => ({ obj: result.obj, score: result.score, source: 'path' }))
    .sort((left, right) => right.score - left.score || tieBreak(left, right));
  const matches = [...basenameHits, ...pathOnlyHits].slice(0, limit);
  return { matches, total: pathResults.total, truncated: snapshotTruncated || pathResults.total > limit };
}

async function runWorker(mode, workspacePath) {
  const { FileService } = await importTypeScriptModule('src/main/services/file-service.ts', { platform: 'node' });
  const service = createService(FileService, workspacePath);
  let capturedSnapshot;
  let snapshotBuildMs = 0;
  const originalBuilder = service.buildFileNamePathSnapshot.bind(service);
  service.buildFileNamePathSnapshot = async (path) => {
    const started = performance.now();
    const result = await originalBuilder(path);
    snapshotBuildMs = performance.now() - started;
    capturedSnapshot = result;
    return result;
  };

  const coldNameStarted = performance.now();
  const baselineName = await service.searchByName({ query: 'file-0', maxResults });
  const coldNameMs = performance.now() - coldNameStarted;
  assert.ok(capturedSnapshot);
  assert.equal(capturedSnapshot.entries.length, Math.min(corpusSize, 20_000));
  assert.equal(capturedSnapshot.truncated, corpusSize > 20_000);

  const hotBaselineName = [];
  const coldPathStarted = performance.now();
  const baselinePath = await service.searchByName({ query: 'nested', maxResults });
  const coldPathMs = performance.now() - coldPathStarted;
  for (let i = 0; i < 3; i += 1) {
    await service.searchByName({ query: 'file-0', maxResults });
    await service.searchByName({ query: 'nested', maxResults });
  }
  const hotBaselinePath = [];
  for (let i = 0; i < samples; i += 1) {
    let started = performance.now();
    const result = await service.searchByName({ query: 'file-0', maxResults });
    hotBaselineName.push(performance.now() - started);
    assert.equal(result.truncated, baselineName.truncated);
    started = performance.now();
    const pathResult = await service.searchByName({ query: 'nested', maxResults });
    hotBaselinePath.push(performance.now() - started);
    assert.equal(pathResult.truncated, baselinePath.truncated);
  }
  const baselineMemory = process.memoryUsage();
  const baselinePeakRssKb = process.resourceUsage().maxRSS;

  if (mode === 'baseline') {
    return {
      mode,
      corpusSize: capturedSnapshot.entries.length,
      snapshotTruncated: capturedSnapshot.truncated,
      query: 'file-0',
      pathQuery: 'nested',
      maxResults,
      baselineName: { coldMs: Number(coldNameMs.toFixed(3)), buildMs: Number(snapshotBuildMs.toFixed(3)), truncated: baselineName.truncated, returned: baselineName.matches.length, ...percentiles(hotBaselineName) },
      baselinePath: { coldMs: Number(coldPathMs.toFixed(3)), truncated: baselinePath.truncated, returned: baselinePath.matches.length, ...percentiles(hotBaselinePath) },
      heapUsedKb: Math.round(baselineMemory.heapUsed / 1024),
      rssKb: Math.round(baselineMemory.rss / 1024),
      peakRssKb: baselinePeakRssKb
    };
  }

  const fuzzysort = (await import(pathToFileURL(fuzzysortModulePath).href)).default;
  global.gc?.();
  const beforeFuzzy = process.memoryUsage();
  const createIndexesStarted = performance.now();
  const basenameIndex = fuzzysort.snapshot(capturedSnapshot.entries, { key: 'normalizedName' });
  const pathIndex = fuzzysort.snapshot(capturedSnapshot.entries, { key: 'normalizedPath' });
  const snapshotCallMs = performance.now() - createIndexesStarted;
  let candidateName;
  let candidatePath;
  let fuzzyNameFirstGoMs;
  let fuzzyPathFirstGoMs;
  if (mode === 'candidate-path-first') {
    const firstPathStarted = performance.now();
    candidatePath = fuzzySearch(fuzzysort, 'nested', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
    fuzzyPathFirstGoMs = performance.now() - firstPathStarted;
    const firstNameStarted = performance.now();
    candidateName = fuzzySearch(fuzzysort, 'file-0', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
    fuzzyNameFirstGoMs = performance.now() - firstNameStarted;
  } else {
    const firstNameStarted = performance.now();
    candidateName = fuzzySearch(fuzzysort, 'file-0', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
    fuzzyNameFirstGoMs = performance.now() - firstNameStarted;
    const firstPathStarted = performance.now();
    candidatePath = fuzzySearch(fuzzysort, 'nested', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
    fuzzyPathFirstGoMs = performance.now() - firstPathStarted;
  }
  assert.equal(candidateName.truncated, baselineName.truncated);
  assert.equal(candidatePath.truncated, baselinePath.truncated);
  assert.equal(candidateName.matches.length, maxResults);
  assert.equal(candidatePath.matches.length, maxResults);

  for (let i = 0; i < 3; i += 1) {
    fuzzySearch(fuzzysort, 'file-0', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
    fuzzySearch(fuzzysort, 'nested', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
  }
  const hotFuzzyName = [];
  const hotFuzzyPath = [];
  for (let i = 0; i < samples; i += 1) {
    let started = performance.now();
    const result = fuzzySearch(fuzzysort, 'file-0', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
    hotFuzzyName.push(performance.now() - started);
    assert.equal(result.truncated, baselineName.truncated);
    started = performance.now();
    const pathResult = fuzzySearch(fuzzysort, 'nested', capturedSnapshot.entries, basenameIndex, pathIndex, maxResults, capturedSnapshot.truncated);
    hotFuzzyPath.push(performance.now() - started);
    assert.equal(pathResult.truncated, baselinePath.truncated);
  }
  global.gc?.();
  const afterFuzzy = process.memoryUsage();
  const memoryAdded = afterFuzzy.heapUsed - beforeFuzzy.heapUsed;
  const result = {
    mode,
    corpusSize: capturedSnapshot.entries.length,
    snapshotTruncated: capturedSnapshot.truncated,
    query: 'file-0',
    pathQuery: 'nested',
    maxResults,
    fuzzyThreshold,
    snapshotCallMs: Number(snapshotCallMs.toFixed(3)),
    fuzzyNameFirstGoMs: Number(fuzzyNameFirstGoMs.toFixed(3)),
    fuzzyPathFirstGoMs: Number(fuzzyPathFirstGoMs.toFixed(3)),
    candidateName: { total: candidateName.total, truncated: candidateName.truncated, returned: candidateName.matches.length, ...percentiles(hotFuzzyName) },
    candidatePath: { total: candidatePath.total, truncated: candidatePath.truncated, returned: candidatePath.matches.length, ...percentiles(hotFuzzyPath) },
    heapBeforeFuzzyKb: Math.round(beforeFuzzy.heapUsed / 1024),
    heapAfterFuzzyKb: Math.round(afterFuzzy.heapUsed / 1024),
    heapAddedKb: Math.round(memoryAdded / 1024),
    rssAfterFuzzyKb: Math.round(afterFuzzy.rss / 1024),
    peakRssKb: process.resourceUsage().maxRSS,
    baselineSnapshotBuildFirstSearchMs: Number(coldNameMs.toFixed(3)),
    baselinePathColdEndToEndMs: Number((snapshotBuildMs + coldPathMs).toFixed(3)),
    snapshotBuildMs: Number(snapshotBuildMs.toFixed(3)),
    candidateNameColdEndToEndMs: Number((snapshotBuildMs + snapshotCallMs + fuzzyNameFirstGoMs).toFixed(3)),
    candidatePathColdEndToEndMs: Number((snapshotBuildMs + snapshotCallMs + fuzzyPathFirstGoMs).toFixed(3))
  };
  fuzzysort.cleanup();
  return result;
}

if (process.argv[2] === '--worker') {
  const result = await runWorker(process.argv[3], process.argv[4]);
  console.log(JSON.stringify(result));
} else {
  const tempRoot = mkdtempSync(join(tmpdir(), 'roc-fuzzysort-perf-'));
  const workspacePath = join(tempRoot, 'workspace');
  const nestedPath = join(workspacePath, 'nested');
  mkdirSync(nestedPath, { recursive: true });
  for (let index = 0; index < corpusSize; index += 1) {
    writeFileSync(join(nestedPath, `file-${String(index).padStart(6, '0')}.txt`), `corpus:${index}\n`);
  }
  try {
    const results = {};
    for (const mode of ['baseline', 'candidate', 'candidate-path-first']) {
      const child = spawnSync(process.execPath, ['--expose-gc', scriptPath, '--worker', mode, workspacePath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      });
      if (child.status !== 0) throw new Error(child.stderr || child.stdout || `worker_failed:${mode}`);
      results[mode] = JSON.parse(child.stdout.trim());
    }
    console.log(JSON.stringify({
      benchmark: 'offline file-name matcher comparison',
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      corpusSize,
      fileShape: `nested/file-000000.txt … nested/file-${String(corpusSize - 1).padStart(6, '0')}.txt`,
      samplesPerHotQuery: samples,
      results
    }, null, 2));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
