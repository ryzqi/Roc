import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {verifyScientificPaperStructure} from '../evaluation/lib/scientific-paper-structure.mjs';
import {defaultPublicScientificRoot, verifyPublicScientificSources} from '../evaluation/adapters/scientific-public/sources.mjs';

// Preselected complete cohort; source-only replay, no new OCR inference or scientific gold.
const baselineRoot = join(ROOT, '.artifacts/scientific-rag/baselines/current-code-pair-01/public-pdf-2026-11-16T05-37-19.680Z-a15d7add');
const entries = ['src/main/plugins/research/paper-structure.ts', 'src/main/plugins/research/paper-ir.ts',
  'src/main/plugins/research/pdf-document-reading.ts'];
const compiled = await build({entryPoints: entries, bundle: true, outdir: 'in-memory', format: 'esm', platform: 'node',
  write: false, metafile: true, logLevel: 'silent'});
const paths = [...new Set([...Object.keys(compiled.metafile.inputs), 'scripts/benchmark-scientific-paper-structure.mjs',
  'evaluation/lib/scientific-paper-structure.mjs', 'evaluation/adapters/scientific-public/sources.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
const [{buildPaperStructure}, {paperBlocks}, {annotatePdfDocumentReading}] =
  await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
const root = directory(resolve(process.argv[2]), 'paper-structure'), sources = verifyPublicScientificSources();
const inputs = Array.from({length: 45}, (_, i) => {
  const path = join(baselineRoot, `paper-${i}/output/artifacts/structured.json`), bytes = readFileSync(path);
  const receiptPath = join(baselineRoot, `paper-${i}/receipt.json`), receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes), resultPath = join(baselineRoot, receipt.result), resultBytes = readFileSync(resultPath);
  const result = JSON.parse(resultBytes), parsed = JSON.parse(bytes), sourcePath = join(defaultPublicScientificRoot, receipt.source);
  assert.equal(receipt.status, 'parsed'); assert.equal(receipt.structured, `paper-${i}/output/artifacts/structured.json`);
  assert.deepEqual(result.blocks, parsed.blocks); assert.equal(result.parserFingerprint, receipt.parserFingerprint);
  assert.equal(result.sourceHash, receipt.sourceHash); assert.equal(sha256(readFileSync(sourcePath)), receipt.sourceHash);
  return {path, sha256: sha256(bytes), receiptPath, receiptSha256: sha256(receiptBytes),
    resultPath, resultSha256: sha256(resultBytes), sourcePath, sourceHash: receipt.sourceHash, paperId: receipt.paperId, parsed};
});
const runs = [];
for (let trial = 0; trial < 2; trial++) {
  const started = performance.now(), rows = [];
  mkdirSync(join(root, `trial-${trial}`), {recursive: true});
  for (const [i, input] of inputs.entries()) {
    const blocks = annotatePdfDocumentReading(input.parsed.blocks, input.parsed.pages);
    const structure = buildPaperStructure(blocks);
    const chunks = paperBlocks(blocks, {paperId: input.paperId, parseId: 'saved-baseline', sourceHash: input.sourceHash});
    const result = verifyScientificPaperStructure(blocks, structure, chunks);
    writeJson(join(root, `trial-${trial}/paper-${i}.json`), {sourceSha256: input.sha256, sourceHash: input.sourceHash, structure, result});
    rows.push({paper: i, pages: input.parsed.pages.length, ...result});
  }
  runs.push({elapsedMs: performance.now() - started, rows, deterministicHash: hash(rows)});
}
assert.equal(runs[0].deterministicHash, runs[1].deterministicHash);
for (const input of inputs) for (const [path, digest] of [[input.path, input.sha256], [input.receiptPath, input.receiptSha256],
  [input.resultPath, input.resultSha256], [input.sourcePath, input.sourceHash]]) assert.equal(sha256(readFileSync(path)), digest);
for (const [path, digest] of Object.entries(codeHashes)) assert.equal(sha256(readFileSync(join(ROOT, path))), digest);
const totals = runs[0].rows.reduce((all, row) => {
  all.pages += row.pages; all.blocks += row.blocks; all.sections += row.sections;
  for (const key of ['categories', 'roles', 'statuses']) for (const [label, n] of Object.entries(row[key])) all[key][label] = (all[key][label] ?? 0) + n;
  return all;
}, {papers: 45, pages: 0, blocks: 0, sections: 0, categories: {}, roles: {}, statuses: {}});
writeJson(join(root, 'report.json'), {kind: 'scientific-public-paper-structure-regression', status: 'verified-repeatable',
  workingDirectory: ROOT, command: process.argv, codeHashes, sourceLockHash: sources.sourceLockHash,
  sourceInventoryHash: hash(inputs.map(({parsed: _parsed, ...input}) => input)), inputs: inputs.map(({parsed: _parsed, ...input}) => input),
  runs, totals, limitations: ['Original saved-PDF block source/tree/role replay, not new OCR inference.',
    'Rule strengths are not calibrated probabilities; no independent section/semantic accuracy claim.',
    'Bounded model classification, complete Phase1 and Phase2-8 remain pending.']});
console.log(JSON.stringify({root, status: 'verified-repeatable', totals}));
