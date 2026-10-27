import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { importTypeScriptModule } from './lib/bundle-ts.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const fixturePath = resolve('tests/smoke/lib/assets/p5-paper.pdf');
const scenarios = ['native-text', 'scanned', 'mixed'];
const workerScenario = process.argv[2] === '--worker' ? process.argv[3] : null;

function pdfStream(stream) {
  return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
}

function buildPdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function generatedPdf(scenario) {
  const image = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream';
  if (scenario === 'scanned') {
    return buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
      pdfStream('q 72 0 0 72 0 0 cm /Im0 Do Q'),
      image
    ]);
  }
  const words = Array.from({ length: 100 }, (_, index) => `evidence${index}`);
  const lines = Array.from({ length: 10 }, (_, index) => words.slice(index * 10, index * 10 + 10).join(' '));
  const text = `BT\n/F1 8 Tf\n40 760 Td\n${lines.map((line) => `(${line}) Tj\n0 -12 Td`).join('\n')}\nET`;
  const content = `${text}\nq 72 0 0 72 0 0 cm /Im0 Do Q`;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 4 0 R >>',
    pdfStream(content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    image
  ]);
}

async function listFileBytes(root, relative = '') {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const output = {};
  for (const entry of entries) {
    const childPath = join(relative, entry.name);
    if (entry.isDirectory()) {
      Object.assign(output, await listFileBytes(root, childPath));
    } else if (entry.isFile()) {
      const fileStats = await stat(join(root, childPath));
      output[childPath] = fileStats.size;
    }
  }
  return output;
}

async function benchmarkScenario(scenario) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-pdf-baseline-'));
  try {
    const projectRoot = join(temporaryRoot, 'project');
    const outputDir = join(projectRoot, 'parsed');
    const sourcePath = join(projectRoot, `${scenario}.pdf`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectRoot);
    const bytes = scenario === 'native-text' ? await readFile(fixturePath) : generatedPdf(scenario);
    await writeFile(sourcePath, bytes);
    const missingModelFiles = {
      detection: join(temporaryRoot, 'missing', 'detection.onnx'),
      recognition: join(temporaryRoot, 'missing', 'recognition.onnx'),
      dictionary: join(temporaryRoot, 'missing', 'dictionary.txt'),
      layout: join(temporaryRoot, 'missing', 'layout.onnx'),
      table: join(temporaryRoot, 'missing', 'table.onnx')
    };
    const [{ parseResearchDocument }, { modelPackManifest }] = await Promise.all([
      importTypeScriptModule('src/main/plugins/research/document-parser.ts', {
        platform: 'node',
        external: ['@napi-rs/canvas', 'onnxruntime-node', 'paddleocr', 'pdfjs-dist/legacy/build/pdf.mjs'],
        tempDir: join(resolve('.runtime/tmp'))
      }),
      importTypeScriptModule('src/main/plugins/research/model-catalog.ts', {
        platform: 'node',
        tempDir: join(resolve('.runtime/tmp'))
      })
    ]);
    const stages = [];
    const started = performance.now();
    let parsed = null;
    let errorCode = null;
    try {
      parsed = await parseResearchDocument({
        projectRoot,
        sourcePath,
        outputDir,
        options: { tier: 'compact', device: 'cpu', pageRange: '1' },
        modelFiles: scenario === 'native-text' ? null : missingModelFiles,
        modelManifest: modelPackManifest('compact'),
        onStage: (event) => stages.push({ stage: event.stage, page: event.page, durationMs: Number(event.durationMs.toFixed(3)) })
      });
    } catch (error) {
      errorCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : String(error);
    }
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    let outputs = {};
    try {
      await access(outputDir);
      outputs = await listFileBytes(outputDir);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const stageNames = stages.map((event) => event.stage);
    if (scenario === 'native-text') {
      assert.equal(errorCode, null, 'native-text baseline must parse successfully');
      assert.equal(parsed?.parseMode, 'native-text', 'native-text baseline must use the native-text route');
      assert.ok((outputs['pages/page-1.png'] ?? 0) > 0, 'native-text baseline must preserve the page PNG');
      assert.ok((outputs['artifacts/middle.json'] ?? 0) > 0, 'native-text baseline must write middle.json');
      assert.ok((outputs['artifacts/structured.json'] ?? 0) > 0, 'native-text baseline must write structured.json');
    } else {
      assert.equal(errorCode, 'ENOENT', `${scenario} baseline must stop at missing-model validation`);
      assert.equal(parsed, null, `${scenario} baseline must not produce a parsed document`);
      for (const stage of ['page-render', 'page-png-encode', 'page-write', 'ocr-raster', 'model-validation']) {
        assert.ok(stageNames.includes(stage), `${scenario} baseline must reach ${stage}`);
      }
      assert.equal(stageNames.includes('ocr-inference'), false, `${scenario} baseline must not reach OCR inference`);
      if (scenario === 'mixed') {
        assert.ok(stageNames.includes('visual-inspection'), 'mixed baseline must identify visual content');
      }
      assert.equal(Object.keys(outputs).length, 0, `${scenario} output must be removed after model validation fails`);
    }
    const stageTotalsMs = {};
    for (const event of stages) stageTotalsMs[event.stage] = Number(((stageTotalsMs[event.stage] ?? 0) + event.durationMs).toFixed(3));
    return {
      scenario,
      inputBytes: bytes.byteLength,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      parseMode: parsed?.parseMode ?? null,
      errorCode,
      elapsedMs,
      peakRssKb: process.resourceUsage().maxRSS,
      stageTotalsMs,
      outputFiles: outputs,
      outputBytes: Object.values(outputs).reduce((total, value) => total + value, 0),
      stages
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (workerScenario !== null) {
  if (!scenarios.includes(workerScenario)) throw new Error(`unsupported PDF scenario: ${workerScenario}`);
  console.log(JSON.stringify(await benchmarkScenario(workerScenario)));
} else {
  const outputPath = resolve(process.argv[2] ?? '.artifacts/architecture-repair-pdf-baseline.json');
  const results = [];
  for (const scenario of scenarios) {
    const child = spawnSync(process.execPath, [scriptPath, '--worker', scenario], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || `PDF benchmark failed for ${scenario}`);
    let result;
    try {
      result = JSON.parse(child.stdout.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PDF benchmark returned invalid JSON for ${scenario}: ${message}`);
    }
    results.push(result);
  }
  const artifact = {
    measuredAt: new Date().toISOString(),
    command: `node scripts/benchmark-pdf-document-parser.mjs ${process.argv[2] ?? '.artifacts/architecture-repair-pdf-baseline.json'}`,
    workingDirectory: process.cwd(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    modelPacksPresent: false,
    scenarios: results
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, scenarios: results.map(({ scenario, parseMode, errorCode, elapsedMs, peakRssKb, outputBytes, stageTotalsMs }) => ({ scenario, parseMode, errorCode, elapsedMs, peakRssKb, outputBytes, stageTotalsMs })) }, null, 2));
}
