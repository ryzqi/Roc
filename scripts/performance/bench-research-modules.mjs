import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadResearchPluginApi, createResearchPluginFixture } from '../../tests/fixtures/research-plugin-fixture.mjs';
import { makeReport, protocol, readArguments, saveReport, sha256, summarize, summarizeRows } from './report-lib.mjs';

const options = readArguments('.artifacts/mac-performance/mac-research-modules.json');
const referenceGitSha = '2ffe8bd';
const sourceRoot = 'src/main/plugins/research';
const referenceIndex = execFileSync('git', ['show', `${referenceGitSha}:${sourceRoot}/index.ts`]);
const sources = ['index.ts', ...readdirSync(sourceRoot).filter(name => /^research-plugin-.*\.ts$/u.test(name))]
  .map(name => join(sourceRoot, name));
const fixture = {
  version: 1, referenceGitSha, referenceIndexSha256: sha256(referenceIndex),
  database: 'isolated generated native SQLite/agent databases',
  order: '20 or requested AB/BA pairs; no network/model calls',
  calls: ['research.reading.listReadingNotes', 'research.huggingfaceDownloads.history', 'research.reviewProtocol.list']
};
const report = makeReport('mac-research-module-split', fixture, [...sources,
  'tests/fixtures/research-plugin-fixture.mjs', 'scripts/performance/bench-research-modules.mjs']);
const jsFiles = directory => readdirSync(directory).filter(name => name.endsWith('.js'));
report.builtMain = Object.fromEntries([['before', '.artifacts/main'], ['after', 'dist/main']].map(([variant, directory]) =>
  [variant, {
    entryBytes: readFileSync(join(directory, 'index.js')).byteLength,
    entrySha256: sha256(readFileSync(join(directory, 'index.js'))),
    allJavaScriptBytes: jsFiles(directory).reduce((sum, file) => sum + readFileSync(join(directory, file)).byteLength, 0)
  }]));
report.sourceSize = {
  beforeIndexLines: referenceIndex.toString().trimEnd().split('\n').length,
  afterIndexLines: readFileSync(`${sourceRoot}/index.ts`, 'utf8').trimEnd().split('\n').length,
  productionRegistrationFiles: sources
};
report.limitations.push(
  'The before plugin freezes the exact pre-split index; shared dependencies are current. All production dependencies used by that index are unchanged except the additive lifecycle owner.',
  'This exercises the actual plugin/native SQLite under Node. Full Electron startup is measured separately.',
  'Initialization timing excludes bundling, schema creation and plugin construction. First-call timings include real domain initialization.',
  'RSS/heap/external fields are shared process snapshots, not allocation peaks or exclusive physical footprint.',
    'The paired bootstrap retains every sample and estimates P95 ratio uncertainty; it is a noise review, not an allocation profiler.',
  'The structural change targets ownership and maintainability; no capability, persistent schema or platform path was deleted without reachability evidence.'
);
const apis = {
  before: await loadResearchPluginApi({ referenceGitSha, observe: true }),
  after: await loadResearchPluginApi({ observe: true })
};
const rows = { before: [], after: [] }, constructors = { before: [], after: [] };
let contractHash;
async function sample(variant) {
  globalThis.__rocResearchStartupConstructed = {};
  const f = await createResearchPluginFixture(apis[variant], { observe: true });
  try {
    const p = f.repository.createProject({ title: 'Synthetic module study', description: 'Generated fixture', workspacePath: f.directory });
    const contract = { ...f.plugin.manifest, capabilities: f.plugin.manifest.capabilities.map(({ name, version, effectReceipt }) =>
      ({ name, version, effectReceipt })) };
    const hash = sha256(JSON.stringify(contract));
    contractHash ??= hash;
    assert.equal(hash, contractHash);
    const sqlBefore = f.sqlCalls(), cpuBefore = process.cpuUsage(), started = performance.now();
    await f.initialize();
    const initializeMs = performance.now() - started, cpu = process.cpuUsage(cpuBefore);
    const initCounts = { ...globalThis.__rocResearchStartupConstructed };
    assert.deepEqual(initCounts, {});
    const row = { initializeMs, initializationSqlCalls: f.sqlCalls() - sqlBefore, initCpuMs: (cpu.user + cpu.system) / 1000 };
    const requests = [
      { projectId: p.id }, { projectId: p.id, observationId: null, offset: 0, limit: 20 }, { projectId: p.id, limit: 20 }
    ], outputs = [];
    for (let i = 0; i < requests.length; i++) {
      const started = performance.now();
      outputs.push(await f.registry.invoke(fixture.calls[i], requests[i]));
      row[['firstReadingMs', 'firstDownloadMs', 'firstReviewMs'][i]] = performance.now() - started;
    }
    const counts = { ...globalThis.__rocResearchStartupConstructed };
    for (const name of ['ReadingRepository', 'RadarService', 'ReadingTranslationService', 'ReadingDiscoveryService',
      'HuggingFaceService', 'HuggingFaceDownloadService', 'ResearchDocumentService', 'ResearchReviewCorpusRepository',
      'ResearchReviewFullTextRepository', 'ResearchReviewQualityAssessmentRepository', 'ResearchReviewReportService']) {
      assert.equal(counts[name], 1, `exactly one ${name}`);
    }
    assert.ok(Object.values(counts).every(count => count === 1));
    assert.deepEqual(await f.plugin.healthCheck(), { status: 'healthy' });
    assert.equal(f.requests.length, 0);
    const memory = process.memoryUsage();
    rows[variant].push({ ...row, constructedServicesAfterCalls: Object.values(counts).reduce((sum, value) => sum + value, 0),
      postCallsRssBytes: memory.rss, postCallsHeapUsedBytes: memory.heapUsed, postCallsExternalBytes: memory.external,
      outputSha256: sha256(JSON.stringify(outputs)) });
    constructors[variant].push({ initialization: initCounts, afterCalls: counts });
  } finally { await f.close(); }
}
try {
  for (let i = 0; i < options.samples; i++) {
    for (const variant of i % 2 === 0 ? ['before', 'after'] : ['after', 'before']) await sample(variant);
    assert.equal(rows.before[i].outputSha256, rows.after[i].outputSha256);
    assert.deepEqual(constructors.before[i], constructors.after[i]);
    console.log(`Research module pair ${i + 1}/${options.samples}`);
  }
  report.contractSha256 = contractHash;
  const rawPath = '.artifacts/mac-performance/pr-15-module-pairs.json';
  const raw = `${JSON.stringify({ schemaVersion: 1, source: report.source, fixture,
    rows, constructors }, null, 2)}\n`;
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, raw);
  report.rawSamples = { path: rawPath, sha256: sha256(raw), samplesPerVariant: options.samples };
  report.constructorCounts = Object.fromEntries(Object.entries(constructors).map(([variant, samples]) =>
    [variant, { sampleCount: samples.length, firstSample: samples[0] }]));
  report.scenarios = Object.entries(rows).map(([id, samples]) => ({ id, summary: summarizeRows(samples) }));
  let randomState = 0x15a6ba;
  const nextIndex = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) % options.samples;
  };
  report.pairedP95Review = ['initializeMs', 'firstReadingMs', 'firstDownloadMs', 'firstReviewMs'].map(metric => {
    const percent = (before, after) => (summarize(after).p95 / summarize(before).p95 - 1) * 100;
    const before = rows.before.map(row => row[metric]), after = rows.after.map(row => row[metric]);
    const bootstrap = Array.from({ length: 5000 }, () => {
      const indices = Array.from({ length: options.samples }, nextIndex);
      return percent(indices.map(index => before[index]), indices.map(index => after[index]));
    }).sort((left, right) => left - right);
    const confidence95Percent = [bootstrap[125], bootstrap[4874]];
    return { metric, beforeP95: summarize(before).p95, afterP95: summarize(after).p95,
      p95ChangePercent: percent(before, after), confidence95Percent, bootstrapSamples: bootstrap.length,
      thresholdPercent: protocol.regressionPercent,
      confirmedRegression: confidence95Percent[0] > protocol.regressionPercent };
  });
  console.log(saveReport(options.outputPath, report));
  assert.ok(report.pairedP95Review.every(item => !item.confirmedRegression), 'research_module_performance_regression');
} finally {
  delete globalThis.__rocResearchStartupConstructed;
  await Promise.all(Object.values(apis).map(api => api.dispose()));
}
