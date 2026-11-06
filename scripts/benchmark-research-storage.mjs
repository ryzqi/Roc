import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir, cpus, totalmem, platform, arch} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createResearchFixture, loadResearchTestApi} from '../tests/unit/fixtures/research-test-kit.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const protocol = {scales: [1000, 10_000], samples: 5, bytesPerFile: 256, filesPerDirectory: 100,
  scanP95TargetMs: 5000, percentile: 'nearest rank; five descriptive warm filesystem samples',
  recipe: 'isolated managed index source directories; deterministic bytes; real production schema and lstat'};
const files = ['src/main/plugins/research/storage-usage.ts', 'src/shared/schemas/research-storage.ts',
  'tests/unit/fixtures/research-test-kit.mjs', 'scripts/benchmark-research-storage.mjs'];
const api = await loadResearchTestApi();
const directory = await mkdtemp(join(tmpdir(), 'roc-storage-bench-'));
const report = {contractVersion: 1, protocol, protocolSha256: hash(JSON.stringify(protocol)),
  hardware: {cpu: cpus()[0].model, memoryBytes: totalmem(), platform: platform(), arch: arch(), node: process.version},
  sourceHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(file))]))), rows: []};
try {
  for (const count of protocol.scales) {
    const f = createResearchFixture(api);
    try {
      const root = join(directory, String(count)), prefix = join(root, 'sources', f.project.id);
      const payload = Buffer.alloc(protocol.bytesPerFile, 0x61);
      for (let batch = 0; batch < Math.ceil(count / protocol.filesPerDirectory); batch++) {
        const bucket = join(prefix, String(batch)); await mkdir(bucket, {recursive: true});
        for (let i = batch * 100; i < Math.min((batch + 1) * 100, count); i++) await writeFile(join(bucket, `${i}.txt`), payload);
      }
      const roots = {library: null, index: root, experiment: null, export: null, model: null, resource: null};
      const service = new api.ResearchStorageUsageService(f.db, f.repository, roots);
      const changes = f.db.prepare('SELECT total_changes()').pluck().get(), samples = [];
      for (let sample = 0; sample < protocol.samples; sample++) {
        const start = performance.now(), usage = await service.get({projectId: f.project.id}), elapsedMs = performance.now() - start;
        assert.equal(usage.groups.length, 1); assert.equal(usage.groups[0].files, count);
        assert.equal(usage.groups[0].bytes, count * protocol.bytesPerFile);
        assert.equal(usage.groups[0].retention, 'traceable_source'); assert.equal(usage.deletion, 'none');
        assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
        samples.push({elapsedMs, rssBytes: process.memoryUsage().rss, group: usage.groups[0]});
      }
      const p95Ms = [...samples.map(s => s.elapsedMs)].sort((a, b) => a - b).at(-1);
      const row = {files: count, corpusSha256: hash(JSON.stringify({count, bytes: protocol.bytesPerFile, fill: '61', buckets: 100})),
        samples, p95Ms, peakRssBytes: Math.max(...samples.map(s => s.rssBytes))};
      report.rows.push(row); assert.ok(p95Ms < protocol.scanP95TargetMs, `${count}: ${p95Ms}`);
      console.log(JSON.stringify({files: count, p95Ms, peakRssBytes: row.peakRssBytes}));
    } finally {f.close();}
  }
  const output = resolve(process.argv[2] ?? '.artifacts/research-optimization/storage-current.json');
  await mkdir(dirname(output), {recursive: true}); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
} finally {await rm(directory, {recursive: true, force: true}); api.dispose();}
