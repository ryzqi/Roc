import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeReport, saveReport, sha256, summarizeRows } from './report-lib.mjs';
import { createPerformancePdf } from '../lib/research-pdf-performance-fixture.mjs';

const output = process.argv[2] ?? '.artifacts/mac-performance/pdf-before.json';
const rawPath = resolve('.artifacts/mac-performance/pdf-raw-' + Date.now() + '.json');
mkdirSync(resolve('.artifacts/mac-performance'), { recursive: true });
const child = spawn(process.execPath, ['scripts/benchmark-pdf-document-parser.mjs', rawPath], { stdio: 'inherit', shell: false });
const exit = await new Promise((done, reject) => { child.on('error', reject); child.on('exit', done); });
if (exit !== 0) throw new Error(`pdf_benchmark_failed:${exit}`);
const bytes = readFileSync(rawPath), raw = JSON.parse(bytes);
const report = makeReport('pdf-parser', { pdfSha256: sha256(createPerformancePdf()), samples: raw.sampleCount,
  scenarios: raw.scenarios.map(scene => ({ id: scene.scenario, sourceSha256: scene.sourceSha256 })) },
  ['src/main/plugins/research/pdf-render.ts', 'src/main/plugins/research/document-parser.ts']);
report.raw = { path: rawPath, sha256: sha256(bytes) };
report.scenarios = raw.scenarios.map(scene => {
  const samples = scene.samples.map(sample => ({
    elapsedMs: sample.elapsedMs, peakRssBytes: sample.peakRssKb * 1024,
    mainThreadBlockingMaxMs: sample.mainThreadBlockingMaxMs, outputBytes: sample.outputBytes,
    ...(sample.firstExtractedPageMs === null ? {} : { firstExtractedPageMs: sample.firstExtractedPageMs }),
    ...(sample.firstReadableParseMs === null ? {} : { firstReadableParseMs: sample.firstReadableParseMs }),
    ...(sample.cancelResponseMs === null ? {} : { cancelResponseMs: sample.cancelResponseMs }),
    ...Object.fromEntries(Object.entries(sample.stageTotalsMs).map(([stage, value]) => [`stage/${stage}Ms`, value]))
  }));
  return { id: scene.scenario, parseMode: scene.parseMode, errorCode: scene.errorCode,
    sourceSha256: scene.sourceSha256, summary: summarizeRows(samples), samples };
});
report.limitations.push('Existing native parser benchmark retains its three-sample protocol; OCR/model-unavailable routes remain explicitly unmeasured.',
  'Native extraction is not browser first paint. This report does not measure renderer transport or OCR inference.');
console.log(saveReport(output, report));
