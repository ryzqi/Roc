import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { materializeArchitectureCorpus } from '../tests/fixtures/architecture-repair/materialize.mjs';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';

const fileCounts = [1_000, 10_000, 50_000];
const query = 'file-0';
const maxResults = 20;
const outputPath = resolve(process.argv[2] ?? '.artifacts/pr3-file-name-search-benchmark.json');
const tempRoot = mkdtempSync(join(tmpdir(), 'roc-pr3-name-search-'));
const corpusRoot = join(tempRoot, 'corpus');
mkdirSync(corpusRoot);

try {
  const corpus = await materializeArchitectureCorpus(corpusRoot, { fileCounts });
  const { FileService } = await importTypeScriptModule('src/main/services/file-service.ts', { platform: 'node' });
  const results = [];

  for (let index = 0; index < fileCounts.length; index += 1) {
    const corpusFiles = fileCounts[index];
    const workspacePath = corpus.fileTree[index];
    const workspace = { path: workspacePath, id: `workspace:${workspacePath}` };
    const workspaceService = { getCurrentWorkspace: () => workspace, requireWorkspace: () => workspace };
    const ripgrep = { isAvailable: () => false, search: async () => { throw new Error('unused'); } };
    const service = new FileService({}, { db: null }, workspaceService, ripgrep);
    const buildSnapshot = service.buildFileNamePathSnapshot.bind(service);
    let indexedEntries = null;
    const buildSamplesMs = [];
    service.buildFileNamePathSnapshot = async (root) => {
      const started = performance.now();
      const snapshot = await buildSnapshot(root);
      buildSamplesMs.push(performance.now() - started);
      indexedEntries = snapshot.entries.length;
      return snapshot;
    };

    const firstStarted = performance.now();
    const firstResult = await service.searchByName({ query, maxResults });
    const firstQueryMs = performance.now() - firstStarted;

    const coldQuerySamplesMs = [];
    for (let sample = 0; sample < 10; sample += 1) {
      service.invalidateFileNameSnapshot(workspacePath);
      const started = performance.now();
      await service.searchByName({ query, maxResults });
      coldQuerySamplesMs.push(performance.now() - started);
    }
    for (let warmup = 0; warmup < 3; warmup += 1) {
      await service.searchByName({ query, maxResults });
    }

    const hotSamplesMs = [];
    for (let sample = 0; sample < 10; sample += 1) {
      const started = performance.now();
      await service.searchByName({ query, maxResults });
      hotSamplesMs.push(performance.now() - started);
    }
    hotSamplesMs.sort((left, right) => left - right);
    coldQuerySamplesMs.sort((left, right) => left - right);
    const snapshotBuildSamplesMs = buildSamplesMs.slice(1).sort((left, right) => left - right);

    results.push({
      corpusFiles,
      indexedEntries,
      snapshotVisitCapReached: corpusFiles > indexedEntries,
      resultTruncated: firstResult.truncated,
      firstSnapshotBuildMs: Number(buildSamplesMs[0].toFixed(3)),
      firstQueryMs: Number(firstQueryMs.toFixed(3)),
      snapshotBuildP50Ms: Number(snapshotBuildSamplesMs[Math.floor(snapshotBuildSamplesMs.length / 2)].toFixed(3)),
      snapshotBuildP95Ms: Number(snapshotBuildSamplesMs[Math.ceil(snapshotBuildSamplesMs.length * 0.95) - 1].toFixed(3)),
      coldQueryP50Ms: Number(coldQuerySamplesMs[Math.floor(coldQuerySamplesMs.length / 2)].toFixed(3)),
      coldQueryP95Ms: Number(coldQuerySamplesMs[Math.ceil(coldQuerySamplesMs.length * 0.95) - 1].toFixed(3)),
      hotQueryMedianMs: Number(hotSamplesMs[Math.floor(hotSamplesMs.length / 2)].toFixed(3)),
      hotQueryP95Ms: Number(hotSamplesMs[Math.ceil(hotSamplesMs.length * 0.95) - 1].toFixed(3)),
      returnedMatches: firstResult.matches.length
    });
  }

  const artifact = {
    measuredAt: new Date().toISOString(),
    command: `node scripts/benchmark-file-name-search-snapshot.mjs ${process.argv[2] ?? '.artifacts/pr3-file-name-search-benchmark.json'}`,
    workingDirectory: process.cwd(),
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
  rmSync(tempRoot, { recursive: true, force: true });
}
