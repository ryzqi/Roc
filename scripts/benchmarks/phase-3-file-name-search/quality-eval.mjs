import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { importTypeScriptModule } from '../../lib/bundle-ts.mjs';

const fuzzysortModulePath = process.env.FUZZYSORT_MODULE ?? resolve(process.cwd(), '.runtime/fuzzysort-trial/package/fuzzysort.js');
const fuzzysort = (await import(pathToFileURL(fuzzysortModulePath).href)).default;

const fileServiceModule = await importTypeScriptModule('src/main/services/file-service.ts', { platform: 'node' });
const root = mkdtempSync(join(tmpdir(), 'roc-fuzzysort-quality-'));
const fuzzyThreshold = Number(process.env.FUZZY_THRESHOLD ?? 0);
const filePaths = [
  'docs/weekly-report.md',
  'docs/annual-project-report.md',
  'docs/research-plan-template.md',
  'tmp/arpot-cache.md',
  'reports/quarterly-report.md',
  'src/config/configuration.ts',
  'settings/editor-config.json',
  'cache/cafe-green-graph.json',
  'src/main/ipc/file-api.ts',
  'src/renderer/ipc/file-api-client.ts',
  'docs/api-usage.md',
  'docs/capability-guide.md',
  'src/main/plugins/task/cron-parser.ts',
  'docs/scheduler/cron-contract.md',
  'README.md',
  'docs/ReadMe-Workspace.md',
  'papers/论文/方法比较.md',
  '研究/论文引文管理.csv',
  'docs/论文与数据.md',
  'research/café/summary.txt',
  'research/café/project-notes.md',
  'research/cafe-notes.md',
  'papers/résumé/model.txt',
  'docs/resume-style.md',
  'src/types/foo.bar.ts',
  'docs/foo-bar-guide.md',
  'src/main/index.ts',
  'src/renderer/index.ts',
  'src/renderer/workspace/index.ts',
  'src/renderer/workspace/file-index-panel.tsx',
  'src/main/services/file-index.ts',
  'projects/2025/experiments/longitudinal/studies/cohort-a/analysis-results.md',
  'src/main/research/analysis-summary.ts',
  'analysis/report.md',
  'analysis-notes.txt',
  'src/main/files/watcher-service.ts',
  'src/main/services/file-watcher.ts',
  'src/main/workspace/file-watcher-state.ts',
  'src/renderer/shared/use-async-action.ts',
  'src/main/plugins/agent/run-harness.ts',
  'src/main/plugins/agent/session-runner.ts',
  'src/main/services/file-search.ts',
  'docs/file-search-guide.md',
  'workspaces/current-project/file-search-settings.json',
  'src/main/plugins/task/task-runner.ts',
  'src/renderer/projects/project-list.tsx',
  'src/renderer/literature/literature-list.tsx',
  'src/shared/retry-policy.ts',
  'docs/重要研究计划.md',
  'papers/2024/引用/文献管理-系统.md'
];

const annotations = [
  { query: 'rpt', relevant: ['analysis/report.md', 'docs/weekly-report.md', 'docs/annual-project-report.md', 'reports/quarterly-report.md', 'docs/research-plan-template.md'], note: 'Short acronym can mean report or research-plan-template; arpot/retry-policy are distractors.' },
  { query: 'cfg', relevant: ['src/config/configuration.ts', 'settings/editor-config.json'], note: 'Abbreviation for configuration; unrelated c-f-g letter sequences are distractors.' },
  { query: 'api', relevant: ['src/main/ipc/file-api.ts', 'src/renderer/ipc/file-api-client.ts', 'docs/api-usage.md'], note: 'API service and documentation across main/renderer layers.' },
  { query: 'cron', relevant: ['src/main/plugins/task/cron-parser.ts', 'docs/scheduler/cron-contract.md'], note: 'Cron implementation and its contract.' },
  { query: 'readme', relevant: ['README.md', 'docs/ReadMe-Workspace.md'], note: 'Case-insensitive README lookup.' },
  { query: '论文', relevant: ['papers/论文/方法比较.md', '研究/论文引文管理.csv', 'docs/论文与数据.md'], note: 'CJK query across basename and path.' },
  { query: 'café', relevant: ['research/café/summary.txt', 'research/café/project-notes.md', 'research/cafe-notes.md'], note: 'Accent-insensitive café search; exact café names and the unaccented cafe variant are relevant.' },
  { query: 'résumé', relevant: ['papers/résumé/model.txt', 'docs/resume-style.md'], note: 'Accent-insensitive mixed-Unicode query.' },
  { query: 'foo.bar', relevant: ['src/types/foo.bar.ts'], note: 'Punctuation-sensitive source filename.' },
  { query: 'index', relevant: ['src/main/index.ts', 'src/renderer/index.ts', 'src/renderer/workspace/index.ts', 'src/main/services/file-index.ts', 'src/renderer/workspace/file-index-panel.tsx'], note: 'Duplicate basenames and path hits; all five index files are relevant.' },
  { query: 'analysis', relevant: ['projects/2025/experiments/longitudinal/studies/cohort-a/analysis-results.md', 'src/main/research/analysis-summary.ts', 'analysis/report.md', 'analysis-notes.txt'], note: 'Analysis notes plus a deep path hit and basename hits.' },
  { query: 'watcher', relevant: ['src/main/files/watcher-service.ts', 'src/main/services/file-watcher.ts', 'src/main/workspace/file-watcher-state.ts'], note: 'Duplicate concepts across service and workspace paths.' },
  { query: 'async action', relevant: ['src/renderer/shared/use-async-action.ts'], note: 'Word-separated query against punctuation-separated basename.' },
  { query: 'file search', relevant: ['src/main/services/file-search.ts', 'docs/file-search-guide.md', 'workspaces/current-project/file-search-settings.json'], note: 'Two-word mixed basename/path query.' },
  { query: '研究计划', relevant: ['docs/重要研究计划.md'], note: 'Mixed Chinese basename search.' }
];

function createService(workspacePath, paths) {
  const workspace = { path: workspacePath, id: `workspace:${workspacePath}` };
  const workspaceService = {
    getCurrentWorkspace: () => workspace,
    requireWorkspace: () => workspace,
    resolveInsideWorkspace: (relativePath) => join(workspace.path, relativePath)
  };
  const ripgrep = { isAvailable: () => false, search: async () => { throw new Error('unused'); } };
  const service = new fileServiceModule.FileService({}, { db: { prepare: () => ({ run() {} }) } }, workspaceService, ripgrep);
  service.visitFiles = async (_workspaceRoot, visit) => {
    for (const path of paths) {
      if (await visit(join(workspacePath, path))) return true;
    }
    return false;
  };
  return service;
}

function tieBreak(left, right) {
  if (left.obj.relativePath.length !== right.obj.relativePath.length) {
    return left.obj.relativePath.length - right.obj.relativePath.length;
  }
  return left.obj.relativePath.localeCompare(right.obj.relativePath);
}

function fuzzySearch(query, entries, basenameIndex, pathIndex, maxResults, snapshotTruncated = false) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    const matches = entries.slice(0, maxResults).map((entry) => ({ obj: entry, score: null, source: 'traversal' }));
    return { matches, truncated: snapshotTruncated || entries.length > maxResults, total: entries.length };
  }

  const basenameResults = fuzzysort.go(normalizedQuery, basenameIndex, { limit: maxResults, threshold: fuzzyThreshold });
  const basenameHits = [...basenameResults]
    .map((result) => ({ obj: result.obj, score: result.score, source: 'basename' }))
    .sort((left, right) => right.score - left.score || tieBreak(left, right));
  const basenamePaths = new Set(basenameHits.map(({ obj }) => obj.relativePath));

  const pathLimit = Math.min(entries.length, maxResults + basenameResults.total);
  const pathResults = fuzzysort.go(normalizedQuery, pathIndex, { limit: pathLimit, threshold: fuzzyThreshold });
  const pathOnlyHits = [...pathResults]
    .filter((result) => !basenamePaths.has(result.obj.relativePath))
    .map((result) => ({ obj: result.obj, score: result.score, source: 'path' }))
    .sort((left, right) => right.score - left.score || tieBreak(left, right));
  const unique = new Map();
  for (const hit of [...basenameHits, ...pathOnlyHits]) {
    if (!unique.has(hit.obj.relativePath)) unique.set(hit.obj.relativePath, hit);
  }
  const matches = [...unique.values()].slice(0, maxResults);
  const total = pathResults.total;
  assert.ok(total >= basenameResults.total, `basename fuzzy matches must also match full paths for ${JSON.stringify(query)}`);
  return { matches, truncated: snapshotTruncated || total > maxResults, total };
}

function metric(matches, relevant, k) {
  const selected = matches.slice(0, k);
  const hitCount = selected.filter(({ obj }) => relevant.has(obj.relativePath)).length;
  const dcg = selected.reduce((score, item, index) => score + (relevant.has(item.obj.relativePath) ? 1 / Math.log2(index + 2) : 0), 0);
  const idealHits = Math.min(k, relevant.size);
  const idcg = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return { precision: hitCount / k, recall: relevant.size === 0 ? 0 : hitCount / relevant.size, ndcg: idcg === 0 ? 0 : dcg / idcg };
}

try {
  const workspacePath = join(root, 'workspace-a');
  mkdirSync(workspacePath);
  const service = createService(workspacePath, filePaths);
  let snapshot;
  const originalBuilder = service.buildFileNamePathSnapshot.bind(service);
  service.buildFileNamePathSnapshot = async (path) => {
    snapshot = await originalBuilder(path);
    return snapshot;
  };
  await service.searchByName({ query: '__snapshot_warmup_miss__', maxResults: 20 });
  assert.ok(snapshot && snapshot.entries.length === filePaths.length);

  const basenameIndex = fuzzysort.snapshot(snapshot.entries, { key: 'normalizedName' });
  const pathIndex = fuzzysort.snapshot(snapshot.entries, { key: 'normalizedPath' });
  const checks = {};
  const baselineEmpty = await service.searchByName({ query: '', maxResults: 20 });
  const candidateEmpty = fuzzySearch('', snapshot.entries, basenameIndex, pathIndex, 20, snapshot.truncated);
  assert.deepEqual(candidateEmpty.matches.map(({ obj }) => obj.relativePath), baselineEmpty.matches.map((match) => match.relativePath));
  assert.equal(candidateEmpty.truncated, baselineEmpty.truncated);
  checks.emptyQueryOrderAndTruncation = true;
  const baselineLimited = await service.searchByName({ query: 'index', maxResults: 2 });
  const candidateLimited = fuzzySearch('index', snapshot.entries, basenameIndex, pathIndex, 2, snapshot.truncated);
  assert.equal(candidateLimited.truncated, baselineLimited.truncated);
  assert.equal(candidateLimited.matches.length, 2);
  checks.resultLimitTruncation = true;
  const capFlagCandidate = fuzzySearch('zzzzzzzzzzzzzzzzzzzzzzzz', snapshot.entries, basenameIndex, pathIndex, 20, true);
  assert.equal(capFlagCandidate.matches.length, 0);
  assert.equal(capFlagCandidate.truncated, true);
  checks.snapshotCapFlagWithoutMatches = true;
  const stableFirst = fuzzySearch('index', snapshot.entries, basenameIndex, pathIndex, 20, snapshot.truncated);
  const stableSecond = fuzzySearch('index', snapshot.entries, basenameIndex, pathIndex, 20, snapshot.truncated);
  assert.deepEqual(stableSecond.matches.map(({ obj }) => obj.relativePath), stableFirst.matches.map(({ obj }) => obj.relativePath));
  assert.equal(new Set(stableFirst.matches.map(({ obj }) => obj.relativePath)).size, stableFirst.matches.length);
  checks.stableTiesAndUniquePaths = true;
  const rows = [];
  const baselineMeans = { p5: [], p10: [], r5: [], r10: [], ndcg5: [], ndcg10: [] };
  const fuzzyMeans = { p5: [], p10: [], r5: [], r10: [], ndcg5: [], ndcg10: [] };

  for (const annotation of annotations) {
    const relevant = new Set(annotation.relevant);
    const baseline = await service.searchByName({ query: annotation.query, maxResults: 20 });
    const baselineMatches = baseline.matches.map((match) => ({ obj: { ...match }, score: null, source: 'baseline' }));
    const candidate = fuzzySearch(annotation.query, snapshot.entries, basenameIndex, pathIndex, 20, snapshot.truncated);
    const scores = (items, destination) => {
      for (const [k, prefix] of [[5, '5'], [10, '10']]) {
        const result = metric(items, relevant, k);
        destination[`p${prefix}`].push(result.precision);
        destination[`r${prefix}`].push(result.recall);
        destination[`ndcg${prefix}`].push(result.ndcg);
      }
    };
    scores(baselineMatches, baselineMeans);
    scores(candidate.matches, fuzzyMeans);
    rows.push({
      query: annotation.query,
      note: annotation.note,
      relevantPaths: annotation.relevant,
      baseline: {
        truncated: baseline.truncated,
        top5: baselineMatches.slice(0, 5).map(({ obj }) => ({ path: obj.relativePath, relevant: relevant.has(obj.relativePath) })),
        top10: baselineMatches.slice(0, 10).map(({ obj }) => ({ path: obj.relativePath, relevant: relevant.has(obj.relativePath) }))
      },
      fuzzysort: {
        truncated: candidate.truncated,
        total: candidate.total,
        top5: candidate.matches.slice(0, 5).map(({ obj, score, source }) => ({ path: obj.relativePath, score: Number(score.toFixed(4)), source, relevant: relevant.has(obj.relativePath) })),
        top10: candidate.matches.slice(0, 10).map(({ obj, score, source }) => ({ path: obj.relativePath, score: Number(score.toFixed(4)), source, relevant: relevant.has(obj.relativePath) }))
      },
      metrics: {
        baseline: { p5: metric(baselineMatches, relevant, 5), p10: metric(baselineMatches, relevant, 10) },
        fuzzysort: { p5: metric(candidate.matches, relevant, 5), p10: metric(candidate.matches, relevant, 10) }
      }
    });
  }

  const average = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
  const aggregate = (values) => Object.fromEntries(Object.entries(values).map(([key, items]) => [key, average(items)]));
  console.log(JSON.stringify({
    evaluator: 'offline-manual-top-k-v1',
    corpusFiles: filePaths.length,
    snapshotTruncated: snapshot.truncated,
    fuzzyVersion: '4.0.2',
    fuzzysortNormalization: 'library default NFKD/diacritic and punctuation remapping',
    fuzzyThreshold,
    contractChecks: checks,
    ranking: 'basename score group first; path-only group second; within each group score desc, then current path-length/localeCompare ties',
    aggregate: { baseline: aggregate(baselineMeans), fuzzysort: aggregate(fuzzyMeans) },
    queries: rows
  }, null, 2));
} finally {
  fuzzysort.cleanup();
  rmSync(root, { recursive: true, force: true });
}
