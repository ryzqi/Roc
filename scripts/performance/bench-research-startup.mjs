import assert from 'node:assert/strict';
import { loadResearchPluginApi, createResearchPluginFixture } from '../../tests/fixtures/research-plugin-fixture.mjs';
import { makeReport, readArguments, saveReport, sha256, summarizeRows } from './report-lib.mjs';

const options = readArguments('.artifacts/mac-performance/mac-research-startup-paired.json');
const fixture = {
  version: 2, database: 'empty generated research/agent schemas', order: 'alternating eager/lazy pairs from the current source',
  calls: ['research.reading.listReadingNotes', 'research.huggingfaceDownloads.history', 'research.reviewProtocol.list'],
  variants: {eager: {ROC_PERF_RESEARCH_LAZY_INIT: '0'}, lazy: {ROC_PERF_RESEARCH_LAZY_INIT: '1'}}
};
const report = makeReport('mac-research-eager-lazy-startup', fixture, [
  'src/main/plugins/research/index.ts', 'src/main/plugins/research/capability-provider.ts',
  'src/main/plugins/research/research-plugin-lifecycle.ts', 'tests/fixtures/research-plugin-fixture.mjs',
  'scripts/performance/bench-research-startup.mjs'
]);
report.limitations.push(
  'Both variants use the same current plugin and database schema. This isolates eager versus lazy initialization, not a historical implementation comparison.',
  'Memory fields are process snapshots after initialization, not allocation peaks, private footprint, or whole Electron application memory.',
  'Duration excludes esbuild, schema creation and fixture construction. CPU is process CPU time during plugin initialization.',
  'Calls run sequentially: first download includes HF metadata initialization; first systematic-review includes document initialization. No models or network are called.',
  'The 1s Wiki recovery and 5s navigation timers remain to preserve first writes from other SQLite connections.'
);

const api = await loadResearchPluginApi({observe: true});
const previousInitialization = process.env.ROC_PERF_RESEARCH_LAZY_INIT;
const rows = { eager: [], lazy: [] };
const work = { eager: [], lazy: [] };
let contractHash;
async function sample(variant) {
  globalThis.__rocResearchStartupConstructed = {};
  process.env.ROC_PERF_RESEARCH_LAZY_INIT = fixture.variants[variant].ROC_PERF_RESEARCH_LAZY_INIT;
  const f = await createResearchPluginFixture(api, { observe: true });
  try {
    const project = f.repository.createProject({
      title: 'Synthetic lazy startup', description: 'Isolated benchmark', workspacePath: f.directory
    });
    const manifest = f.plugin.manifest.capabilities.map(({ name, version, effectReceipt }) =>
      ({ name, version, effectReceipt }));
    const hash = sha256(JSON.stringify(manifest));
    contractHash ??= hash;
    assert.equal(hash, contractHash);
    const sqlBefore = f.sqlCalls(), cpuBefore = process.cpuUsage(), started = performance.now();
    await f.initialize();
    const elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuBefore);
    const counts = { ...globalThis.__rocResearchStartupConstructed };
    if (variant === 'lazy') assert.deepEqual(counts, {});
    else assert.ok(Object.keys(counts).length > 0 && Object.values(counts).every(count => count === 1));
    const memory = process.memoryUsage();
    const row = {
      initializeMs: elapsedMs, initializationSqlCalls: f.sqlCalls() - sqlBefore,
      constructedServices: Object.values(counts).reduce((sum, count) => sum + count, 0),
      initCpuMs: (cpu.user + cpu.system) / 1000,
      postInitRssBytes: memory.rss, postInitHeapUsedBytes: memory.heapUsed,
      postInitExternalBytes: memory.external, postInitArrayBuffersBytes: memory.arrayBuffers
    };
    const readyBeforeInvalid = f.observations.length;
    await assert.rejects(f.registry.invoke('research.reading.listReadingNotes', { projectId: 42 }));
    assert.equal(f.observations.length, readyBeforeInvalid);
    const inputs = [
      { projectId: project.id },
      { projectId: project.id, observationId: null, offset: 0, limit: 20 },
      { projectId: project.id, limit: 20 }
    ];
    const outputs = [];
    for (let i = 0; i < fixture.calls.length; i++) {
      const callStarted = performance.now();
      outputs.push(await f.registry.invoke(fixture.calls[i], inputs[i]));
      row[['firstReadingMs', 'firstDownloadMs', 'firstReviewMs'][i]] = performance.now() - callStarted;
    }
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await f.plugin.healthCheck(), { status: 'healthy' });
    assert.ok(Object.values(globalThis.__rocResearchStartupConstructed).every(count => count === 1));
    rows[variant].push({ ...row, outputSha256: sha256(JSON.stringify(outputs)) });
    work[variant].push(counts);
  } finally {
    await f.close();
  }
}
try {
  for (let i = 0; i < options.samples; i++) {
    for (const variant of i % 2 === 0 ? ['eager', 'lazy'] : ['lazy', 'eager']) await sample(variant);
    assert.equal(rows.eager[i].outputSha256, rows.lazy[i].outputSha256);
    console.log(`Research startup pair ${i + 1}/${options.samples}`);
  }
  report.contractSha256 = contractHash;
  report.constructorCounts = work;
  report.scenarios = Object.entries(rows).map(([id, samples]) => ({
    id, samples, summary: summarizeRows(samples), outputSha256: samples[0].outputSha256
  }));
  console.log(saveReport(options.outputPath, report));
} finally {
  delete globalThis.__rocResearchStartupConstructed;
  if (previousInitialization === undefined) delete process.env.ROC_PERF_RESEARCH_LAZY_INIT;
  else process.env.ROC_PERF_RESEARCH_LAZY_INIT = previousInitialization;
  await api.dispose();
}
