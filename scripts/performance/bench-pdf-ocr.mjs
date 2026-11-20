import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeReport, protocol, saveReport, summarizeRows } from './report-lib.mjs';

// Reuse the real, pinned OCR acceptance path. Model files are read-only inputs;
// each sample has a fresh, disposable corpus/job/database and retained raw output.
const output = process.argv[2] ?? '.artifacts/mac-performance/ocr-before.json';
const evidenceRoot = resolve('.artifacts/mac-performance/ocr-' + Date.now());
mkdirSync(evidenceRoot, { recursive: true });
const samples = [], evidence = [];
let report;
for (let iteration = 0; iteration < protocol.ocrSamples; iteration++) {
  const root = resolve(evidenceRoot, String(iteration));
  const cpu = process.cpuUsage(), started = performance.now();
  const child = spawn(process.execPath, ['scripts/verify-research-pdf-scanned.mjs',
    '--models-root', resolve('.runtime/research-models'), '--evidence-root', root],
  { stdio: 'inherit', shell: false });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  assert.equal(code, 0, 'actual_ocr_benchmark_failed');
  const actual = JSON.parse(readFileSync(resolve(root, 'native-acceptance.json'), 'utf8'));
  const raw = JSON.parse(readFileSync(resolve(root, 'actual-parser-result.json'), 'utf8'));
  assert.equal(raw.parseMode, 'ocr');
  assert.equal(raw.pageCount, 3);
  const used = process.cpuUsage(cpu);
  samples.push({ nativeJobMs: actual.elapsedMs, totalHarnessMs: performance.now() - started,
    harnessCpuUserMicros: used.user, harnessCpuSystemMicros: used.system, blockCount: raw.blocks.length });
  evidence.push({ root, sourceHash: actual.sourceTruth.sourceHash, parseHash: actual.parseHash,
    runtime: actual.runtime, modelManifest: actual.modelManifest, parserFingerprint: actual.parserFingerprint,
    observations: resolve(root, 'recognition-observations.json') });
  report ??= makeReport('pdf-ocr', { sourceTruth: actual.sourceTruth, modelManifest: actual.modelManifest,
    parserFingerprint: actual.parserFingerprint, samples: protocol.ocrSamples },
  ['src/main/plugins/research/document-parser.ts', 'src/main/plugins/research/pdf-render.ts',
    'src/main/plugins/research/ocr-session-scope.ts']);
  assert.equal(actual.sourceTruth.sourceHash, evidence[0].sourceHash);
  assert.equal(actual.modelManifest, evidence[0].modelManifest);
  report.scenarios = [{ id: 'scanned-text-table-formula', summary: summarizeRows(samples), samples }];
  report.evidence = evidence;
  saveReport(output, report);
}
report.limitations.push('Five samples of a controlled raster-only source; raw recognition is retained, not a calibrated accuracy claim.',
  'nativeJobMs includes the real worker, collector and validation. Per-page inference timings and native worker peak require PR-00B/PR-07 attribution.',
  'Harness CPU excludes OCR child CPU. Footprint/IOSurface/child peak are unavailable in this acceptance harness.');
console.log(saveReport(output, report));
