import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdir, rm, readdir, realpath} from 'node:fs/promises';
import {resolve, join, relative, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {importTypeScriptModule} from '../lib/bundle-ts.mjs';
import {materializeOcrLayoutSource} from '../../tests/fixtures/research-ocr-layout-source.mjs';
import {makeReport, protocol, saveReport, sha256, summarizeRows} from './report-lib.mjs';
import {compareReports} from './compare-reports.mjs';

const baseline = '6c83e951';
const productionFiles = ['src/main/plugins/research/document-parser.ts', 'src/main/plugins/research/pdf-render.ts'];

async function measuredParser(mode, bundlePath) {
  await mkdir(dirname(bundlePath), {recursive: true});
  await build({entryPoints: [productionFiles[0]], outfile: bundlePath, bundle: true,
    format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent', packages: 'external',
    plugins: [{name: 'frozen-parser-and-session-observation', setup(builder) {
      builder.onLoad({filter: /\/(?:document-parser|pdf-render)\.ts$/}, async args => {
        const file = relative(process.cwd(), args.path);
        let contents = mode === 'before' ? execFileSync('git', ['show', `${baseline}:${file}`], {encoding: 'utf8'})
          : await readFile(args.path, 'utf8');
        if (file === productionFiles[0]) {
          assert.ok(contents.includes('const nativeSession = session;'));
          assert.ok(contents.includes('releasePromise ??= nativeSession.release();'));
          contents = contents.replace('const nativeSession = session;',
            'const nativeSession = session; globalThis.__rocOcrSessionObservation(1);')
            .replace('releasePromise ??= nativeSession.release();',
              'releasePromise ??= nativeSession.release().finally(() => globalThis.__rocOcrSessionObservation(-1));');
        }
        return {contents, loader: 'ts'};
      });
    }}]});
  return (await import(pathToFileURL(bundlePath).href)).parseResearchDocument;
}

async function worker(mode, root) {
  const source = await materializeOcrLayoutSource(join(root, 'corpus'));
  const {ResearchModelStore} = await importTypeScriptModule('src/main/plugins/research/model-store.ts',
    {platform: 'node', external: ['zod'], tempDir: '.runtime/performance'});
  const models = new ResearchModelStore(await realpath('.runtime/research-models'));
  const lease = await models.requireReady('complete');
  const bundlePath = resolve('.runtime/performance', `ocr-corpus-${mode}-${process.pid}.mjs`);
  const parse = await measuredParser(mode, bundlePath);
  let liveSessions = 0, sessionHighWater = 0, releasedSessions = 0;
  globalThis.__rocOcrSessionObservation = delta => {
    liveSessions += delta; sessionHighWater = Math.max(sessionHighWater, liveSessions);
    if (delta < 0) releasedSessions++;
  };
  const stages = [];
  const started = performance.now(), memory = process.memoryUsage();
  let peakRssBytes = memory.rss, peakExternalBytes = memory.external, peakArrayBuffersBytes = memory.arrayBuffers;
  const sample = event => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakExternalBytes = Math.max(peakExternalBytes, memory.external);
    peakArrayBuffersBytes = Math.max(peakArrayBuffersBytes, memory.arrayBuffers);
    stages.push({...event, rssBytes: memory.rss, externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers, liveSessions});
  };
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss); peakExternalBytes = Math.max(peakExternalBytes, memory.external);
    peakArrayBuffersBytes = Math.max(peakArrayBuffersBytes, memory.arrayBuffers);
  }, 20);
  try {
    const outputDir = join(root, 'job', 'output');
    const parsed = await parse({projectRoot: root, sourcePath: source.sourcePath, outputDir,
      modelFiles: lease.files, modelManifest: lease.manifest,
      options: {tier: 'complete', device: 'cpu', pageRange: '1-3'},
      signal: AbortSignal.timeout(300_000), onStage: sample});
    assert.equal(liveSessions, 0, 'all real ONNX sessions release before parser settlement');
    assert.ok(sessionHighWater > 0 && releasedSessions === sessionHighWater);
    assert.equal(parsed.sourceHash, source.truth.sourceHash);
    assert.equal(parsed.parseMode, 'ocr'); assert.equal(parsed.pageCount, 3);
    const structured = JSON.parse(await readFile(join(outputDir, 'artifacts', 'structured.json'), 'utf8'));
    assert.deepEqual(structured.pages.map(page => page.page), [1, 2, 3]);
    const artifacts = [];
    async function collect(directory) {
      for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else artifacts.push({path: relative(outputDir, path), sha256: sha256(await readFile(path))});
      }
    }
    await collect(outputDir);
    const behaviorSha256 = sha256(JSON.stringify({parsed, artifacts}));
    const rawText = parsed.content;
    const observations = [...source.truth.bilingualLines, ...source.truth.leftColumn, ...source.truth.rightColumn,
      ...source.truth.mixed].map(text => ({sourceText: text, exact: rawText.includes(text)}));
    await writeFile(join(root, 'actual-parser-result.json'), JSON.stringify(parsed, null, 2));
    await writeFile(join(root, 'stages-and-recognition.json'), JSON.stringify({stages, observations, artifacts}, null, 2));
    return {elapsedMs: performance.now() - started, peakRssBytes, peakExternalBytes, peakArrayBuffersBytes,
      sessionHighWater, releasedSessions, retainedSessions: liveSessions, blocks: parsed.blocks.length,
      behaviorSha256, sourceTruth: source.truth, modelManifest: parsed.modelManifest,
      parserFingerprint: parsed.parserFingerprint, observations};
  } finally {
    clearInterval(timer); models.release(lease.pack);
    await rm(bundlePath, {force: true});
    delete globalThis.__rocOcrSessionObservation;
  }
}

if (process.argv[2] === '--worker') {
  const mode = process.argv[3], root = resolve(process.argv[4]);
  assert.ok(mode === 'before' || mode === 'after');
  console.log(JSON.stringify({performanceResult: await worker(mode, root)}));
} else {
  const evidenceRoot = resolve('.artifacts/mac-performance/ocr-layout-' + Date.now());
  const reports = {};
  for (const mode of ['before', 'after']) {
    const samples = [], evidence = [];
    for (let iteration = 0; iteration < protocol.ocrSamples; iteration++) {
      const root = join(evidenceRoot, mode, String(iteration));
      const child = spawn(process.execPath, [import.meta.filename, '--worker', mode, root], {stdio: ['ignore', 'pipe', 'pipe']});
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => {stdout += bytes;}); child.stderr.on('data', bytes => {stderr += bytes;});
      const code = await new Promise((done, reject) => {child.once('error', reject); child.once('exit', done);});
      assert.equal(code, 0, stderr);
      const result = JSON.parse(stdout.trim().split('\n').at(-1)).performanceResult;
      if (samples.length > 0) assert.equal(result.behaviorSha256, evidence[0].behaviorSha256);
      const {sourceTruth, modelManifest, parserFingerprint, behaviorSha256, observations, ...sample} = result;
      samples.push(sample); evidence.push({root, behaviorSha256, observations});
      reports[mode] ??= makeReport('pdf-ocr-layout', {sourceTruth, modelManifest, parserFingerprint, samples: protocol.ocrSamples},
        productionFiles);
      if (mode === 'before') {
        const hashes = Object.fromEntries(productionFiles.map(file => [file, sha256(execFileSync('git', ['show', `${baseline}:${file}`]))]));
        reports[mode].source = {...reports[mode].source, gitSha: baseline, trackedDirty: false,
          sourceHashes: hashes, sourceSha256: sha256(JSON.stringify(hashes))};
      }
      reports[mode].scenarios = [{id: 'bilingual-two-column-mixed', samples, summary: summarizeRows(samples), behaviorSha256}];
      reports[mode].evidence = evidence;
      console.log(JSON.stringify({mode, iteration: iteration + 1, elapsedMs: sample.elapsedMs,
        sessionHighWater: sample.sessionHighWater, retainedSessions: sample.retainedSessions}));
    }
    reports[mode].limitations.push('Real pinned CPU OCR on three controlled raster pages; original text/table/formula worker acceptance remains separate.',
      'Observed exact recognition and layout outputs, with full raw results; not a calibrated OCR accuracy score.',
      'Session hooks only count actual creation/release and do not replace native inference. Memory is sampled every 20 ms and at production stages.',
      'RSS/External/ArrayBuffers are process observations, not macOS private footprint. Five samples have limited statistical reliability.');
    saveReport(`.artifacts/mac-performance/mac-pdf-ocr-layout-${mode}.json`, reports[mode]);
  }
  const comparison = compareReports(reports.before, reports.after);
  await writeFile('.artifacts/mac-performance/mac-pdf-ocr-layout-comparison.json', JSON.stringify(comparison, null, 2) + '\n');
  assert.deepEqual(comparison.regressionCandidates, []);
  console.log(JSON.stringify({compatible: comparison.compatible, regressionCandidates: comparison.regressionCandidates}));
}
