import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {build} from 'esbuild';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';
import {directory, hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';
import {verifyScientificDocumentReading} from '../evaluation/lib/scientific-document-reading.mjs';
import {defaultPublicScientificRoot, verifyPublicScientificSources} from '../evaluation/adapters/scientific-public/sources.mjs';

// Fixed complete successful public cohort, retained unchanged; no new OCR or invented labels.
const baselineRoot = join(ROOT, '.artifacts/scientific-rag/baselines/current-code-pair-01/public-pdf-2026-11-16T05-37-19.680Z-a15d7add');
const entries = ['src/main/plugins/research/pdf-document-reading.ts', 'src/main/plugins/research/paper-ir.ts'];
const compiled = await build({entryPoints: entries, bundle: true, outdir: 'in-memory', format: 'esm', platform: 'node',
  write: false, metafile: true, logLevel: 'silent'});
const paths = [...new Set([...Object.keys(compiled.metafile.inputs), 'scripts/benchmark-scientific-document-reading.mjs',
  'evaluation/lib/scientific-document-reading.mjs', 'pnpm-lock.yaml'])].sort();
const codeHashes = Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
const [{annotatePdfDocumentReading}, {paperBlocks}] = await Promise.all(entries.map(entry => importTypeScriptModule(entry, {platform: 'node'})));
const root = directory(resolve(process.argv[2]), 'document-reading');
const sources = verifyPublicScientificSources();
const inputs = Array.from({length: 45}, (_, i) => {
  const path = join(baselineRoot, `paper-${i}/output/artifacts/structured.json`), bytes = readFileSync(path);
  const receiptPath = join(baselineRoot, `paper-${i}/receipt.json`), receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes), resultPath = join(baselineRoot, receipt.result), resultBytes = readFileSync(resultPath);
  const result = JSON.parse(resultBytes), parsed = JSON.parse(bytes);
  assert.equal(receipt.status, 'parsed'); assert.equal(receipt.structured, `paper-${i}/output/artifacts/structured.json`);
  assert.deepEqual(result.blocks, parsed.blocks); assert.equal(result.parserFingerprint, receipt.parserFingerprint);
  assert.equal(result.sourceHash, receipt.sourceHash);
  const sourcePath = join(defaultPublicScientificRoot, receipt.source);
  assert.equal(sha256(readFileSync(sourcePath)), receipt.sourceHash);
  return {path, sha256: sha256(bytes), size: bytes.length, receiptPath, receiptSha256: sha256(receiptBytes),
    resultPath, resultSha256: sha256(resultBytes), sourcePath, sourceHash: receipt.sourceHash, paperId: receipt.paperId, parsed};
});
const runs = [];
for (let trial = 0; trial < 2; trial++) {
  const started = performance.now(), rows = [];
  mkdirSync(join(root, `trial-${trial}`), {recursive: true});
  for (const [index, input] of inputs.entries()) {
    const annotated = annotatePdfDocumentReading(input.parsed.blocks, input.parsed.pages);
    const result = verifyScientificDocumentReading(input.parsed.blocks, input.parsed.pages, annotated);
    const chunks = paperBlocks(annotated, {paperId: input.paperId, parseId: 'saved-baseline', sourceHash: input.sourceHash});
    assert.deepEqual(chunks.map(c => [c.semantic.blockId, c.content, c.locator]),
      annotated.filter(b => b.text.trim()).map(b => [b.id, b.text, b.locator]));
    for (const link of result.links) {
      assert.ok(chunks.find(c => c.semantic.blockId === link.from).semantic.relatedBlockIds.includes(link.to));
      assert.ok(chunks.find(c => c.semantic.blockId === link.to).semantic.relatedBlockIds.includes(link.from));
    }
    writeJson(join(root, `trial-${trial}/paper-${index}.json`), {sourcePath: input.path, sourceSha256: input.sha256,
      sourceHash: input.sourceHash, parserFingerprint: input.parsed.parserFingerprint, annotations: annotated.map(b => ({id: b.id, reading: b.reading})), result});
    rows.push({paper: index, pages: input.parsed.pages.length, ...result});
  }
  runs.push({elapsedMs: performance.now() - started, rows, deterministicHash: hash(rows)});
}
assert.equal(runs[0].deterministicHash, runs[1].deterministicHash);
for (const input of inputs) {
  for (const [path, digest] of [[input.path, input.sha256], [input.receiptPath, input.receiptSha256],
    [input.resultPath, input.resultSha256], [input.sourcePath, input.sourceHash]]) assert.equal(sha256(readFileSync(path)), digest);
}
const totals = runs[0].rows.reduce((all, row) => {
  all.pages += row.pages; all.blocks += row.blocks; all.links += row.links.length;
  for (const [role, n] of Object.entries(row.roles)) all.roles[role] = (all.roles[role] ?? 0) + n;
  return all;
}, {papers: 45, pages: 0, blocks: 0, links: 0, roles: {}});
writeJson(join(root, 'report.json'), {kind: 'scientific-public-document-reading-regression', status: 'verified-repeatable',
  workingDirectory: ROOT, command: process.argv, codeHashes, sourceLockHash: sources.sourceLockHash,
  inputs: inputs.map(({parsed: _parsed, ...input}) => input),
  runs, totals, limitations: ['Source/relationship replay of preserved complete public parse blocks, not a new inference.',
    'Caption/margin/continuation rules have heuristic strength, not probabilities; unknown text retained.',
    'No independently labelled cross-page paragraph recall, caption accuracy, CER/WER or downstream retrieval improvement is asserted.']});
console.log(JSON.stringify({root, status: 'verified-repeatable', totals}));
