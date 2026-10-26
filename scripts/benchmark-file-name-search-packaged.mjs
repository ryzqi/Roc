import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { materializeArchitectureCorpus } from '../tests/fixtures/architecture-repair/materialize.mjs';

const fileCounts = [1_000, 10_000, 50_000];
const query = 'file-0';
const maxResults = 20;
const packageRoot = resolve(process.argv[2] ?? '.artifacts/pr3-packaged-app/mac-arm64/Roc.app');
const executablePath = join(packageRoot, 'Contents', 'MacOS', 'Roc');
const outputPath = resolve(process.argv[3] ?? '.artifacts/pr3-file-name-search-packaged-benchmark.json');
if (!existsSync(executablePath)) throw new Error(`packaged_app_executable_missing:${executablePath}`);
if (existsSync(outputPath)) throw new Error(`benchmark_output_already_exists:${outputPath}`);

const tempRoot = mkdtempSync(join(tmpdir(), 'roc-pr3-packaged-search-'));
const corpusRoot = join(tempRoot, 'corpus');
const dataRoot = join(tempRoot, 'data');
mkdirSync(corpusRoot);
let app = null;

function percentile(sortedSamples, fraction) {
  return sortedSamples[Math.ceil(sortedSamples.length * fraction) - 1];
}

try {
  const corpus = await materializeArchitectureCorpus(corpusRoot, { fileCounts });
  app = await electron.launch({
    executablePath,
    args: [],
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key'
    }
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });

  const results = [];
  for (let index = 0; index < fileCounts.length; index += 1) {
    const corpusFiles = fileCounts[index];
    const workspacePath = corpus.fileTree[index];
    const coldQuerySamplesMs = [];
    let sampleResult = null;

    for (let sample = 0; sample < 10; sample += 1) {
      const result = await page.evaluate(async ({ workspacePath, query, maxResults }) => {
        const selected = await window.roc.workspace.select({ path: workspacePath });
        if (!selected.ok) throw new Error(`workspace_select_failed:${selected.error.code}`);
        const started = performance.now();
        const search = await window.roc.files.searchByName({ query, maxResults });
        const elapsedMs = performance.now() - started;
        if (!search.ok) throw new Error(`name_search_failed:${search.error.code}`);
        return { elapsedMs, result: search.data };
      }, { workspacePath, query, maxResults });
      coldQuerySamplesMs.push(result.elapsedMs);
      sampleResult = result.result;
    }

    for (let warmup = 0; warmup < 3; warmup += 1) {
      await page.evaluate(async ({ query, maxResults }) => {
        const result = await window.roc.files.searchByName({ query, maxResults });
        if (!result.ok) throw new Error(`name_search_failed:${result.error.code}`);
      }, { query, maxResults });
    }
    const hotQuerySamplesMs = await page.evaluate(async ({ query, maxResults }) => {
      const samples = [];
      for (let index = 0; index < 10; index += 1) {
        const started = performance.now();
        const result = await window.roc.files.searchByName({ query, maxResults });
        samples.push(performance.now() - started);
        if (!result.ok) throw new Error(`name_search_failed:${result.error.code}`);
      }
      return samples;
    }, { query, maxResults });

    coldQuerySamplesMs.sort((left, right) => left - right);
    hotQuerySamplesMs.sort((left, right) => left - right);
    results.push({
      corpusFiles,
      coldQueryP50Ms: Number(percentile(coldQuerySamplesMs, 0.5).toFixed(3)),
      coldQueryP95Ms: Number(percentile(coldQuerySamplesMs, 0.95).toFixed(3)),
      hotQueryP50Ms: Number(percentile(hotQuerySamplesMs, 0.5).toFixed(3)),
      hotQueryP95Ms: Number(percentile(hotQuerySamplesMs, 0.95).toFixed(3)),
      returnedMatches: sampleResult?.matches.length ?? 0,
      resultTruncated: sampleResult?.truncated ?? false
    });
  }

  const artifact = {
    measuredAt: new Date().toISOString(),
    command: `node scripts/benchmark-file-name-search-packaged.mjs ${process.argv[2] ?? '.artifacts/pr3-packaged-app/mac-arm64/Roc.app'} ${process.argv[3] ?? '.artifacts/pr3-file-name-search-packaged-benchmark.json'}`,
    workingDirectory: process.cwd(),
    appBundle: packageRoot,
    measurement: 'Packaged app IPC latency. Cold queries select the same workspace first, invalidating the snapshot; each cold sample includes snapshot build, matching, and IPC. Hot queries reuse the snapshot.',
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    query,
    maxResults,
    coldSamplesPerCorpus: 10,
    hotSamplesPerCorpus: 10,
    results
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, results }, null, 2));
} finally {
  try {
    if (app !== null) await app.close();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
